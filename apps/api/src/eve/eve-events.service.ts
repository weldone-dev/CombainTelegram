import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { EveDelayedService } from './eve-delayed.service.js';
import type { EveBurstEntry } from './eve-delayed.service.js';
import { EveGateway } from './eve.gateway.js';
import {
  eventChatId,
  eventDedupeKey,
  eventThreadId,
  formatEventCursor,
  parseEventCursor,
  safeJson,
} from './eve-access.js';
import { eveToken } from './eve-token.js';
import { eveWebhookUrl, pushEveEvent } from './eve-push.js';
import type { EvePushOptions } from './eve-push.js';

const KINDS = new Set([
  'message.new',
  'message.edited',
  'message.deleted',
  'message.reaction',
  'message.read',
]);

interface EventPayload {
  accountId?: unknown;
  chatId?: unknown;
  threadId?: unknown;
  message?: unknown;
  maxId?: unknown;
  messageIds?: unknown;
  messageId?: unknown;
  emoji?: unknown;
  fromId?: unknown;
  outgoing?: unknown;
  targetIsMine?: unknown;
  date?: unknown;
  /** Enriched per-id facts of a `message.deleted` payload. */
  messages?: unknown;
}

export interface EveEventView {
  id: string;
  kind: string;
  personaId: string | null;
  accountId: string | null;
  chatId: string | null;
  threadId: number;
  allowed: boolean;
  dedupeKey: string | null;
  payload: unknown;
  createdAt: string;
}

export interface EveEventList {
  events: EveEventView[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Dedupe hint for a reaction. The shared `eventDedupeKey` reads
 * `message.id`/`maxId`/`messageIds`; a reaction carries `messageId`, so it gets
 * its own key that also names the emoji and the author. Two different
 * reactions to the same message stay distinct, a replayed update does not.
 */
function reactionDedupeKey(
  accountId: string,
  chatId: bigint | null,
  threadId: number,
  payload: EventPayload,
): string | null {
  if (chatId === null) return null;
  const marker = payload.messageId;
  if (typeof marker !== 'number' && typeof marker !== 'string') return null;
  const messageId = String(marker).trim();
  if (!messageId) return null;
  const emoji = typeof payload.emoji === 'string' ? payload.emoji.trim() : '';
  const fromId =
    typeof payload.fromId === 'number' || typeof payload.fromId === 'string'
      ? String(payload.fromId)
      : '';
  const date =
    typeof payload.date === 'number' || typeof payload.date === 'string'
      ? String(payload.date)
      : '';
  return [
    'message.reaction',
    accountId,
    chatId.toString(),
    threadId,
    messageId,
    emoji,
    fromId,
    date,
  ].join(':');
}

/**
 * Cheap deletion policy shared by the outbox writer and (as a second line of
 * defence) the Eve channel.
 *
 * - `bulk`: Telegram replayed a history cleanup / cache eviction list, not a
 *   single fresh deletion.
 * - `author-unknown`: without `outgoing === false` for at least one id there is
 *   no proof that his message was deleted; silence is safer than guessing.
 * - `stale`: the newest deleted message is already older than 10 minutes, so a
 *   comment now would answer yesterday's conversation.
 */
function deletionGate(
  payload: EventPayload,
  now: number,
): 'bulk' | 'author-unknown' | 'stale' | null {
  const ids = Array.isArray(payload.messageIds) ? payload.messageIds : [];
  if (ids.length > 5) return 'bulk';

  const list = Array.isArray(payload.messages)
    ? payload.messages
    : payload.message && typeof payload.message === 'object'
      ? [payload.message]
      : [];
  const rows = list
    .map((entry) =>
      entry && typeof entry === 'object'
        ? (entry as Record<string, unknown>)
        : null,
    )
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  // `outgoing` is only set for ids the process has seen; an unknown author is
  // not enough to start a "he deleted it" turn (own deletions and restarts
  // would otherwise be answered).
  const his = rows.filter((row) => row.outgoing === false);
  // Older payloads carry the aggregate flag only; that is still a confirmed
  // "his message was deleted".
  if (his.length === 0 && payload.outgoing !== false) return 'author-unknown';

  const dates = his
    .map((row) => Date.parse(typeof row.date === 'string' ? row.date : ''))
    .filter((date) => Number.isFinite(date));
  if (dates.length > 0) {
    const newest = Math.max(...dates);
    if (now - newest > 10 * 60 * 1000) return 'stale';
  }
  return null;
}

/**
 * Writes every relevant realtime event into `EveEvent` for the bound persona,
 * then broadcasts the same row over the `/internal/eve` namespace.
 *
 * Delivery is at-least-once: the cursor endpoint is the source of truth, and
 * the socket is only a latency optimisation. Eve must dedupe by `id` (or the
 * `dedupeKey` hint, which survives a replay of the same realtime event).
 */
@Injectable()
export class EveEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EveEventsService.name);
  private subscription?: Subscription;
  /**
   * Recently recorded dedupe keys. The realtime bus already dedupes for 10 s,
   * but the cursor endpoint may replay an older row and an aggregate reaction
   * update can repeat; without this, the same reaction would become a second
   * `EveEvent` (and a second persona turn). Bounded and TTL-based, so a long
   * running process cannot leak memory.
   */
  private readonly recentKeys = new Map<string, number>();
  private static readonly DEDUPE_TTL_MS = 10 * 60 * 1000;
  private static readonly DEDUPE_MAX_KEYS = 5_000;
  /**
   * Durable keys live much longer than the in-memory window: a replayed
   * Telegram update can arrive minutes or hours later (restart, reconnect,
   * cursor replay). Rows are pruned lazily, so the table stays bounded.
   */
  private static readonly DEDUPE_DB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  private static readonly DEDUPE_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
  private lastDedupePruneAt = 0;
  /**
   * A single `message.deleted` carrying more ids than this is a history
   * cleanup / cache eviction, not "he deleted one message". Commenting on it
   * (or on every growing replay of the same list) is noise.
   */
  private static readonly DELETION_BULK_IDS = 5;
  /** Deletions of messages older than this are history, not a live reaction. */
  private static readonly DELETION_STALE_MS = 10 * 60 * 1000;
  /** At most one deletion turn per chat in this window. */
  private static readonly DELETION_THROTTLE_MS = 15 * 60 * 1000;
  /**
   * Deleting a message extends the list of ids Telegram replays. A key made of
   * the whole list therefore changes on every replay. Bucket by time instead:
   * all deletion batches inside one bucket share a key, so a growing superset
   * cannot create a second event (and a second turn).
   */
  private static readonly DELETION_WINDOW_MS = 10 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly gateway: EveGateway,
    /** Optional so the event-mapping specs can build the service alone. */
    @Optional() private readonly delayed?: EveDelayedService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.realtime.events$.subscribe((event) => {
      if (!KINDS.has(event.event)) return;
      void this.record(event.event, event.payload).catch((error) => {
        this.logger.warn(
          `Eve event ${event.event} failed: ${(error as Error).message}`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    this.recentKeys.clear();
  }

  /**
   * Persist one realtime event. Public so the subscription and the specs share
   * exactly one code path.
   */
  async record(kind: string, raw: unknown): Promise<void> {
    // Read receipts never start a turn (the Eve route ignores them too), and
    // her own outgoing message marks the chat read a second after every send.
    if (kind === 'message.read') return;
    const payload = (raw ?? {}) as EventPayload;
    const accountId =
      typeof payload.accountId === 'string' ? payload.accountId.trim() : '';
    if (!accountId) return;

    // Only incoming private messages may start a persona turn. Without this,
    // every reply sent through Nest comes back as `message.new` (outgoing) and
    // triggers another reply: an infinite loop.
    if (kind === 'message.new' || kind === 'message.edited') {
      const message =
        payload.message && typeof payload.message === 'object'
          ? (payload.message as Record<string, unknown>)
          : null;
      if (!message) return;
      // Only a confirmed incoming message may start a turn. `outgoing`
      // unknown (an echo without author facts) is not enough evidence.
      if (message.outgoing !== false || message.service === true) return;
      const numericChat = Number(payload.chatId);
      if (Number.isFinite(numericChat) && numericChat <= 0) return;
    }

    // A reaction the persona sent is her own echo (or another session of the
    // same account): recording it would let her react to herself in a loop.
    // Reactions in groups/channels never start a persona turn either.
    if (kind === 'message.reaction') {
      if (payload.outgoing === true) return;
      const numericChat = Number(payload.chatId);
      if (Number.isFinite(numericChat) && numericChat <= 0) return;
    }

    const binding = await this.prisma.evePersonaAccount.findFirst({
      where: { accountId, enabled: true },
      orderBy: { createdAt: 'asc' },
      select: { personaId: true },
    });
    if (!binding) return;

    // A deleted chat arrives as `null`; an unexpected value becomes `null`
    // instead of throwing on `BigInt(NaN)`.
    const chatId = eventChatId(payload.chatId);
    const threadId = eventThreadId(payload.threadId);

    let allowed = false;
    if (chatId !== null) {
      const chat = await this.prisma.eveChatBinding.findUnique({
        where: {
          personaId_accountId_chatId_threadId: {
            personaId: binding.personaId,
            accountId,
            chatId,
            threadId,
          },
        },
        select: { allowed: true },
      });
      allowed = chat?.allowed === true;
    }

    if (kind === 'message.deleted' && chatId !== null) {
      const gate = deletionGate(payload, Date.now());
      if (gate !== null) {
        this.logger.debug(`Dropped message.deleted (${gate})`);
        return;
      }
    }

    const dedupeKey =
      kind === 'message.reaction'
        ? reactionDedupeKey(accountId, chatId, threadId, payload)
        : kind === 'message.deleted' && chatId !== null
          ? [
              'message.deleted',
              accountId,
              chatId.toString(),
              threadId,
              'window',
              Math.floor(Date.now() / EveEventsService.DELETION_WINDOW_MS),
            ].join(':')
          : eventDedupeKey(kind, payload as Record<string, unknown>, {
              accountId,
              chatId,
              threadId,
            });

    // A replayed realtime event or a repeated aggregate reaction update must
    // not create a second row (and therefore a second turn). The in-memory
    // claim is the fast path; the durable row makes the same guarantee after a
    // restart, when `recentKeys` is empty again.
    if (dedupeKey !== null) {
      if (!this.claim(dedupeKey)) return;
      if (!(await this.claimDurable(dedupeKey))) return;
    }

    // Even a fresh, small deletion is not worth a comment every minute: one
    // deletion turn per chat/window. The durable row survives a restart.
    if (
      kind === 'message.deleted' &&
      allowed &&
      chatId !== null &&
      !(await this.claimDeletionThrottle(accountId, chatId, threadId, Date.now()))
    ) {
      this.logger.debug('Dropped message.deleted (throttled)');
      return;
    }

    const stored = {
      ...(payload as Record<string, unknown>),
      personaId: binding.personaId,
      allowed,
      dedupeKey,
    };

    let row: {
      id: string;
      kind: string;
      personaId: string | null;
      accountId: string | null;
      chatId: bigint | null;
      threadId: number;
      payload: string;
      createdAt: Date;
    };
    try {
      row = await this.prisma.eveEvent.create({
        data: {
          kind,
          personaId: binding.personaId,
          accountId,
          chatId,
          threadId,
          payload: safeJson(stored),
        },
      });
    } catch (error) {
      // Never let a failed write burn the dedupe key: a later retry of the
      // same event must still be able to create its row.
      if (dedupeKey !== null) await this.releaseDurable(dedupeKey);
      throw error;
    }
    if (dedupeKey !== null) this.pruneDedupe();

    // A new message makes any still-queued answer to an older message stale:
    // drop it before Eve decides, so a busy/sleep delay cannot deliver a
    // second reply after this one. Its text is not lost: the dropped turn's
    // series is attached to this event so the next turn answers it too.
    let superseded: EveBurstEntry[] = [];
    if (kind === 'message.new' && allowed && chatId !== null) {
      try {
        superseded =
          (await this.delayed?.supersedePendingTurns({
            personaId: binding.personaId,
            accountId,
            chatId,
            threadId,
          })) ?? [];
      } catch (error) {
        this.logger.warn(
          `Could not supersede pending Eve turns: ${(error as Error).message}`,
        );
      }
    }

    let view: EveEventView;
    if (superseded.length > 0) {
      const enriched = { ...stored, supersededBurst: superseded };
      view = { ...this.toView(row), payload: enriched };
      // The row is already durable; this only enriches its payload. A failed
      // update still keeps the event (Eve recomputes the series from context).
      try {
        await this.prisma.eveEvent.update({
          where: { id: row.id },
          data: { payload: safeJson(enriched) },
        });
      } catch (error) {
        this.logger.warn(
          `Could not attach the superseded series to ${row.id}: ${(error as Error).message}`,
        );
      }
    } else {
      view = this.toView(row);
    }

    // The socket is a latency optimisation; the push wakes Eve when it is not
    // connected. Never block the realtime bus on it.
    this.gateway.broadcast(view);
    if (view.allowed) {
      void this.pushEvent(view).catch((error) => {
        this.logger.warn(
          `Eve push ${view.id} failed: ${(error as Error).message}`,
        );
      });
    }
  }

  /**
   * Pushes one stored event to the local Eve process and marks it delivered on
   * success. `allowed: false` events stay durable for the dashboard/log but do
   * not wake Eve.
   *
   * Retries reuse the same `event.id`, which Eve passes as its
   * `idempotencyKey`, so a replay cannot produce a second turn.
   */
  async pushEvent(
    view: EveEventView,
    options: EvePushOptions = {},
  ): Promise<boolean> {
    if (!view.allowed) return false;
    const url = eveWebhookUrl();
    if (!url) return false;

    const payload =
      view.payload && typeof view.payload === 'object' && !Array.isArray(view.payload)
        ? (view.payload as Record<string, unknown>)
        : {};
    // The Eve channel route reads `message`, `personaId`, `accountId`,
    // `chatId`, `threadId` and `allowed` at the top level; keep the full view
    // too, so a log consumer sees the same shape as the cursor endpoint.
    const body: Record<string, unknown> = {
      ...payload,
      id: view.id,
      kind: view.kind,
      personaId: view.personaId,
      accountId: view.accountId,
      chatId: view.chatId,
      threadId: view.threadId,
      allowed: view.allowed,
      dedupeKey: view.dedupeKey,
      createdAt: view.createdAt,
      payload: view.payload,
    };

    const result = await pushEveEvent(url, body, {
      token: eveToken(),
      ...options,
    });
    if (!result.ok) {
      this.logger.warn(
        `Eve push ${view.id} failed after ${result.attempts} attempt(s): ${
          result.error ?? `HTTP ${result.status ?? 'unknown'}`
        }`,
      );
      return false;
    }

    try {
      await this.prisma.eveEvent.update({
        where: { id: view.id },
        data: { deliveredAt: new Date() },
      });
    } catch (error) {
      // A failed mark only means the heartbeat sweep may replay the row; the
      // push itself already succeeded.
      this.logger.warn(
        `Eve delivery mark failed for ${view.id}: ${(error as Error).message}`,
      );
    }
    return true;
  }

  async list(cursorRaw: string | undefined, rawLimit: unknown): Promise<EveEventList> {
    const cursor = parseEventCursor(cursorRaw);
    const parsedLimit = Number(rawLimit);
    const limit = Math.min(
      200,
      Math.max(1, Number.isFinite(parsedLimit) ? Math.trunc(parsedLimit) : 50),
    );
    const rows = await this.prisma.eveEvent.findMany({
      where: cursor
        ? cursor.id
          ? {
              OR: [
                { createdAt: { gt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { gt: cursor.id } },
              ],
            }
          : { createdAt: { gt: cursor.createdAt } }
        : undefined,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    if (rows.length > 0) {
      try {
        await this.prisma.eveEvent.updateMany({
          where: { id: { in: rows.map((row) => row.id) } },
          data: { deliveredAt: new Date() },
        });
      } catch (error) {
        // Delivery bookkeeping is best-effort; the cursor still moves forward.
        this.logger.warn(
          `Eve delivery mark failed: ${(error as Error).message}`,
        );
      }
    }

    return {
      events: rows.map((row) => this.toView(row)),
      nextCursor: rows.length > 0 ? formatEventCursor(rows[rows.length - 1]!) : null,
      hasMore: rows.length === limit,
    };
  }

  /**
   * In-process dedupe for recently recorded keys. Returns `false` when the key
   * was claimed inside the TTL (i.e. this is a replay). The map is pruned by
   * insertion order, so it cannot grow without bound.
   */
  private claim(key: string): boolean {
    const now = Date.now();
    const ttl = EveEventsService.DEDUPE_TTL_MS;
    for (const [existing, at] of this.recentKeys) {
      if (now - at < ttl) break;
      this.recentKeys.delete(existing);
    }
    const seen = this.recentKeys.get(key);
    if (seen !== undefined && now - seen < ttl) return false;
    this.recentKeys.delete(key);
    this.recentKeys.set(key, now);
    while (this.recentKeys.size > EveEventsService.DEDUPE_MAX_KEYS) {
      const oldest = this.recentKeys.keys().next().value;
      if (oldest === undefined) break;
      this.recentKeys.delete(oldest);
    }
    return true;
  }

  /**
   * Durable half of {@link claim}. The primary key makes the insert the
   * atomic test-and-set, so two concurrent replays (or two Nest instances
   * sharing the DB) cannot both win. A DB failure must not swallow a real
   * event: only a unique-constraint violation counts as a replay.
   */
  private async claimDurable(key: string): Promise<boolean> {
    try {
      await this.prisma.eveEventDedupe.create({ data: { key } });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return false;
      this.logger.warn(
        `Eve dedupe claim ${key} failed, falling back to memory: ${(error as Error).message}`,
      );
      return true;
    }
  }

  private async releaseDurable(key: string): Promise<void> {
    try {
      await this.prisma.eveEventDedupe.delete({ where: { key } });
    } catch {
      // Best effort: the row only blocks this event until the TTL prune.
    }
  }

  /**
   * One deletion turn per chat per `DELETION_THROTTLE_MS`, durably. The same
   * `EveEventDedupe` table is reused with a separate key namespace: the first
   * insert wins; an existing row inside the window rejects the event, an older
   * row is refreshed. Survives a restart, so a `nest --watch` reload cannot
   * resume the minute-by-minute deletion spam.
   */
  private async claimDeletionThrottle(
    accountId: string,
    chatId: bigint,
    threadId: number,
    now: number,
  ): Promise<boolean> {
    const key = `message.deleted:throttle:${accountId}:${chatId.toString()}:${threadId}`;
    try {
      await this.prisma.eveEventDedupe.create({ data: { key } });
      return true;
    } catch (error) {
      if ((error as { code?: string }).code !== 'P2002') return true;
    }

    try {
      const row = await this.prisma.eveEventDedupe.findUnique({
        where: { key },
      });
      if (!row) return true;
      if (now - row.createdAt.getTime() < EveEventsService.DELETION_THROTTLE_MS) {
        return false;
      }
      await this.prisma.eveEventDedupe.update({
        where: { key },
        data: { createdAt: new Date(now) },
      });
      return true;
    } catch (error) {
      this.logger.warn(
        `Eve deletion throttle ${key} failed, allowing event: ${(error as Error).message}`,
      );
      return true;
    }
  }

  /** Drops expired durable claims at most once an hour. */
  private pruneDedupe(): void {
    const now = Date.now();
    if (now - this.lastDedupePruneAt < EveEventsService.DEDUPE_PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastDedupePruneAt = now;
    const cutoff = new Date(now - EveEventsService.DEDUPE_DB_TTL_MS);
    void this.prisma.eveEventDedupe
      .deleteMany({ where: { createdAt: { lt: cutoff } } })
      .catch((error: unknown) => {
        this.logger.warn(
          `Eve dedupe prune failed: ${(error as Error).message}`,
        );
      });
  }

  private toView(row: {
    id: string;
    kind: string;
    personaId: string | null;
    accountId: string | null;
    chatId: bigint | null;
    threadId: number;
    payload: string;
    createdAt: Date;
  }): EveEventView {
    let parsed: Record<string, unknown> = {};
    try {
      const value = JSON.parse(row.payload) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
    return {
      id: row.id,
      kind: row.kind,
      personaId: row.personaId,
      accountId: row.accountId,
      chatId: row.chatId === null ? null : row.chatId.toString(),
      threadId: row.threadId,
      allowed: parsed.allowed === true,
      dedupeKey:
        typeof parsed.dedupeKey === 'string' ? parsed.dedupeKey : null,
      payload: parsed,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
