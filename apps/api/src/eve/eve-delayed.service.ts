import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { EveDelayedActionModel as EveDelayedActionRow } from '@repo/database';
import { apiError, notFound } from '../common/api-error.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DefaultUserService } from '../user-context/default-user.service.js';
import { eveId, parseChatId, parseThreadId } from './eve-access.js';
import {
  dryRunKindOf,
  eveDryRunRequested,
  noteEveDryRunOutbound,
} from './eve-dry-run.js';
import { eveTurnUrl } from './eve-push.js';
import { eveToken } from './eve-token.js';
import { EveService, isSleeping, localHour } from './eve.service.js';
import { EveTurnService } from './eve-turn.service.js';

/**
 * Durable deferral for the Eve channel.
 *
 * Eve used to keep a `setTimeout` per delayed reply and per delayed reaction.
 * That timer died with the process: an Eve restart inside the delay window lost
 * the reply, and a 120 s cap clipped every presence/cold-stage delay. Nest now
 * owns the clock instead:
 *
 * - the channel posts `POST /internal/eve/actions` instead of scheduling;
 * - the row lives in SQLite with a `dueAt`;
 * - one short tick (5 s by default) dispatches whatever is due:
 *   - `turn` re-enters Eve at `POST /eve/v1/nest/turn`, so the model answer is
 *     generated later in the *same* session (no second behavior decision);
 *   - `send`/`edit`/`delete`/`react`/`read` go straight to the transport, with
 *     no model and no Eve process involved.
 *
 * A row with `dueAt = null` waits for a state change (asleep/busy/offline)
 * rather than for the clock. The presence tick releases it once she is awake.
 */

/**
 * How often the durable queue is swept. Five seconds keeps a due reply close to
 * its `dueAt` without a timer per row; `EVE_DELAYED_TICK_MS` overrides it
 * inside the 1–60 s clamp.
 */
export const DELAYED_TICK_MS = 5_000;
export const DELAYED_TICK_MIN_MS = 1_000;
export const DELAYED_TICK_MAX_MS = 60_000;

/** Resolves `EVE_DELAYED_TICK_MS`, falling back to {@link DELAYED_TICK_MS}. */
export function delayedTickMs(
  raw: string | undefined = process.env.EVE_DELAYED_TICK_MS,
): number {
  const parsed = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(parsed) || parsed <= 0) {
    return DELAYED_TICK_MS;
  }
  return Math.min(
    DELAYED_TICK_MAX_MS,
    Math.max(DELAYED_TICK_MIN_MS, Math.round(parsed)),
  );
}

/** girl-agent runtime cap for a normal delayed reply. */
export const MAX_TURN_DELAY_SEC = 3_600;
/** girl-agent runtime cap for a busy/offline action. */
export const MAX_ACTION_DELAY_SEC = 24 * 3_600;
export const MAX_DELAYED_ATTEMPTS = 5;
export const DELAYED_PUSH_TIMEOUT_MS = 10_000;
export const DELAYED_BATCH = 20;

export const DELAYED_KINDS = [
  'turn',
  'send',
  'edit',
  'delete',
  'react',
  'read',
] as const;

export type EveDelayedKind = (typeof DELAYED_KINDS)[number];
export type EveDelayedOutcome = 'sent' | 'retried' | 'failed' | 'dropped';

/** Reasons that mean "wait for a state change", not for a clock. */
const NO_CLOCK_REASONS = new Set(['sleep', 'busy', 'offline']);

export interface EveDelayedTickResult {
  released: number;
  picked: number;
  sent: number;
  retried: number;
  failed: number;
  dropped: number;
}

export interface EveDelayedActionView {
  id: string;
  personaId: string;
  accountId: string;
  chatId: string;
  threadId: number;
  kind: string;
  reason: string;
  key: string | null;
  payload: unknown;
  dueAt: string | null;
  state: string;
  attempts: number;
  lastError: string | null;
  firedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Outcome of "reply now" for one queued row. */
export interface EveDelayedFireResult {
  /** `true` only when the row was accepted by the transport/Eve turn route. */
  ok: boolean;
  /** `not-pending`, `in-flight` or the dispatch outcome when `ok` is false. */
  reason?: string;
  outcome?: EveDelayedOutcome;
  /** Row after the attempt (state/attempts/firedAt are fresh). */
  action: EveDelayedActionView;
}

/** Outcome of "reply now" for every queued turn of one chat. */
export interface EveDelayedFireChatResult {
  /** Rows accepted for immediate delivery. */
  fired: number;
  results: Array<{
    id: string;
    ok: boolean;
    outcome?: EveDelayedOutcome;
    reason?: string;
  }>;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

/** One message of the unanswered series; mirrors the Eve channel shape. */
export interface EveBurstEntry {
  id: number;
  text: string;
}

const MAX_BURST = 10;
const MAX_BURST_TEXT = 1_000;

/**
 * The series a stored turn payload carries, in order. An older payload (or one
 * written before bursts existed) only has `incoming`/`messageId`.
 */
function burstOfPayload(payload: Record<string, unknown>): EveBurstEntry[] {
  const entries: EveBurstEntry[] = [];
  const raw = Array.isArray(payload.burst) ? payload.burst : [];
  for (const value of raw) {
    const row = record(value);
    const id = Number(row.id);
    const line = text(row.text);
    if (!Number.isSafeInteger(id) || id <= 0 || !line) continue;
    entries.push({ id, text: line.slice(0, MAX_BURST_TEXT) });
  }
  if (entries.length === 0) {
    const id = Number(payload.messageId);
    const line = text(payload.incoming);
    if (Number.isSafeInteger(id) && id > 0 && line) {
      entries.push({ id, text: line.slice(0, MAX_BURST_TEXT) });
    }
  }
  return entries;
}

/**
 * Concatenates the series of the turns that are being superseded with the
 * series of the new one. The new turn answers every message, so no text is
 * lost when a deferred answer is dropped.
 */
function mergeBurst(
  superseded: Array<Record<string, unknown>>,
  current: EveBurstEntry[],
): EveBurstEntry[] {
  const byId = new Map<number, EveBurstEntry>();
  for (const payload of superseded) {
    for (const entry of burstOfPayload(payload)) byId.set(entry.id, entry);
  }
  for (const entry of current) byId.set(entry.id, entry);
  return [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_BURST);
}

export function delayedKind(value: unknown): EveDelayedKind {
  const kind = text(value);
  if ((DELAYED_KINDS as readonly string[]).includes(kind)) {
    return kind as EveDelayedKind;
  }
  throw apiError(
    'EVE_ACTION_KIND_INVALID',
    `kind must be one of ${DELAYED_KINDS.join(', ')}`,
  );
}

/**
 * Clamps a requested delay. The cap is girl-agent parity: 1 h for a normal
 * reply, 24 h for anything queued because she was busy or offline.
 */
export function clampDelaySec(kind: EveDelayedKind, value: unknown): number {
  const parsed = Number(value);
  const raw = Number.isFinite(parsed) ? Math.round(parsed) : 0;
  const cap = kind === 'turn' ? MAX_TURN_DELAY_SEC : MAX_ACTION_DELAY_SEC;
  return Math.max(0, Math.min(raw, cap));
}

export function delayedDueAt(
  kind: EveDelayedKind,
  reason: string,
  delaySec: number,
  now: Date,
): Date | null {
  if (delaySec > 0) return new Date(now.getTime() + delaySec * 1_000);
  if (NO_CLOCK_REASONS.has(reason) && kind === 'turn') return null;
  return now;
}

function toView(row: EveDelayedActionRow): EveDelayedActionView {
  return {
    id: row.id,
    personaId: row.personaId,
    accountId: row.accountId,
    chatId: row.chatId.toString(),
    threadId: row.threadId,
    kind: row.kind,
    reason: row.reason,
    key: row.key,
    payload: parseJson(row.payload),
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    state: row.state,
    attempts: row.attempts,
    lastError: row.lastError,
    firedAt: row.firedAt ? row.firedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class EveDelayedService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EveDelayedService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  /**
   * Rows currently being dispatched by a manual "reply now". The periodic tick
   * must not pick the same row again: `fire` moves `dueAt` to now before the
   * push, so a tick running in parallel would see it as due and duplicate it.
   * This is a single-process guard, which matches the one-process deployment.
   */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly users: DefaultUserService,
    private readonly eve: EveService,
    private readonly turns: EveTurnService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.runTick();
    }, delayedTickMs());
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  // ---------------------------------------------------------------------
  // HTTP entry points
  // ---------------------------------------------------------------------

  /** `POST /internal/eve/actions`: the channel replaces `setTimeout`. */
  async enqueue(raw: unknown): Promise<EveDelayedActionView> {
    const body = record(raw);
    const kind = delayedKind(body.kind);
    const reason = text(body.reason, 'delay');
    // Reuses the exact immediate-action gate: account, persona binding and the
    // explicit allowlist are all checked before anything is stored.
    const address = await this.eve.resolveWriteAddress(body);
    const delaySec = clampDelaySec(kind, body.delaySec);
    const now = new Date();
    const key = text(body.key) || null;

    if (key) {
      const existing = await this.prisma.eveDelayedAction.findFirst({
        where: { personaId: address.personaId, key },
      });
      // A replayed event must not queue the same turn twice.
      if (existing) return toView(existing);
    }

    try {
      const bodyPayload = record(body.payload);
      let payload = bodyPayload;
      // A newer inbound supersedes questions that are still waiting for a
      // clock or for her presence: answering both would send two replies to
      // one burst of silence. Only one pending deferred turn per chat stays.
      if (kind === 'turn') {
        // Read the rows before dropping them: their texts are the unanswered
        // part of the series and must reach the model with the new turn.
        const superseded = await this.prisma.eveDelayedAction.findMany({
          where: {
            personaId: address.personaId,
            accountId: address.accountId,
            chatId: address.chatId,
            threadId: address.threadId,
            kind: 'turn',
            state: 'pending',
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: MAX_BURST,
        });
        await this.prisma.eveDelayedAction.updateMany({
          where: {
            personaId: address.personaId,
            accountId: address.accountId,
            chatId: address.chatId,
            threadId: address.threadId,
            kind: 'turn',
            state: 'pending',
          },
          data: { state: 'dropped', lastError: 'superseded' },
        });
        const series = mergeBurst(
          superseded.map((row) => parseJson(row.payload)),
          burstOfPayload(bodyPayload),
        );
        payload = series.length > 0 ? { ...bodyPayload, burst: series } : bodyPayload;
      }
      // Persist the per-request flag with the row so a test-triggered delay
      // stays suppressed after a restart. An old row without it is live
      // (the global kill-switch is re-read on every dispatch, not stored).
      const requestedDryRun =
        body.dryRun === true || bodyPayload.dryRun === true;
      if (requestedDryRun && payload.dryRun !== true) {
        payload = { ...payload, dryRun: true };
      }
      const row = await this.prisma.eveDelayedAction.create({
        data: {
          personaId: address.personaId,
          accountId: address.accountId,
          chatId: address.chatId,
          threadId: address.threadId,
          kind,
          reason,
          key,
          payload: JSON.stringify(payload),
          dueAt: delayedDueAt(kind, reason, delaySec, now),
        },
      });
      return toView(row);
    } catch (error) {
      // Lost the insert race: return the row the other writer created.
      if (key) {
        const existing = await this.prisma.eveDelayedAction.findFirst({
          where: { personaId: address.personaId, key },
        });
        if (existing) return toView(existing);
      }
      throw error;
    }
  }

  /**
   * Cancels deferred answers that a newer inbound has made stale. Called when
   * the new event is recorded, before Eve decides ignore/delay/reply, so a
   * queued answer to the previous message cannot arrive after the new one.
   *
   * Returns the unanswered series those turns carried: the new turn has to
   * answer those messages too, so the caller forwards the texts to Eve.
   */
  async supersedePendingTurns(address: {
    personaId: string;
    accountId: string;
    chatId: bigint;
    threadId: number;
  }): Promise<EveBurstEntry[]> {
    const rows = await this.prisma.eveDelayedAction.findMany({
      where: {
        personaId: address.personaId,
        accountId: address.accountId,
        chatId: address.chatId,
        threadId: address.threadId,
        kind: 'turn',
        state: 'pending',
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: MAX_BURST,
    });
    await this.prisma.eveDelayedAction.updateMany({
      where: {
        personaId: address.personaId,
        accountId: address.accountId,
        chatId: address.chatId,
        threadId: address.threadId,
        kind: 'turn',
        state: 'pending',
      },
      data: { state: 'dropped', lastError: 'superseded' },
    });
    return mergeBurst(
      rows.map((row) => parseJson(row.payload)),
      [],
    );
  }

  /** `GET /internal/eve/actions`: queue inspection for the dashboard/logs. */
  async list(query: {
    personaId?: string;
    accountId?: string;
    chatId?: string;
    threadId?: string;
    kind?: string;
    state?: string;
    limit?: string;
  }): Promise<{ actions: EveDelayedActionView[] }> {
    const personaId = text(query.personaId);
    const accountId = text(query.accountId);
    const kind = text(query.kind);
    const state = text(query.state);
    const chatId = text(query.chatId) ? parseChatId(query.chatId) : null;
    const threadId = text(query.threadId)
      ? parseThreadId(query.threadId)
      : null;
    const parsed = Number(query.limit);
    const limit = Math.min(
      200,
      Math.max(1, Number.isFinite(parsed) ? Math.trunc(parsed) : 50),
    );
    const rows = await this.prisma.eveDelayedAction.findMany({
      where: {
        ...(personaId ? { personaId } : {}),
        ...(accountId ? { accountId } : {}),
        ...(chatId !== null ? { chatId } : {}),
        ...(threadId !== null ? { threadId } : {}),
        ...(kind ? { kind } : {}),
        ...(state ? { state } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return { actions: rows.map(toView) };
  }

  /**
   * `POST /internal/eve/actions/:id/fire`: send one queued action now.
   *
   * The row keeps its state until the dispatch settles, so a failed push is
   * retried by the regular tick; only a non-pending row is refused outright.
   */
  async fire(id: string): Promise<EveDelayedFireResult> {
    const actionId = text(id);
    if (!actionId) {
      throw apiError('EVE_ACTION_ID_REQUIRED', 'action id is required');
    }
    const row = await this.prisma.eveDelayedAction.findUnique({
      where: { id: actionId },
    });
    if (!row) {
      throw notFound(
        'EVE_ACTION_NOT_FOUND',
        `Eve action ${actionId} does not exist`,
      );
    }
    return this.fireRow(row);
  }

  /**
   * `POST /internal/eve/actions/fire`: every pending turn of one chat goes out
   * now, one after another. Only `turn` rows are fired: reactions, reads and
   * edits keep their own clocks.
   */
  async fireChat(raw: unknown): Promise<EveDelayedFireChatResult> {
    const body = record(raw);
    const personaId = eveId(
      body.personaId,
      'EVE_PERSONA_REQUIRED',
      'personaId is required',
    );
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(body.chatId);
    const threadId = parseThreadId(body.threadId);

    const rows = await this.prisma.eveDelayedAction.findMany({
      where: {
        personaId,
        accountId,
        chatId,
        threadId,
        kind: 'turn',
        state: 'pending',
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: DELAYED_BATCH,
    });

    const results: EveDelayedFireChatResult['results'] = [];
    // Sequential on purpose: two turns of one chat must not race the writeback
    // counters or reach Telegram out of order.
    for (const row of rows) {
      const result = await this.fireRow(row);
      results.push({
        id: row.id,
        ok: result.ok,
        ...(result.outcome ? { outcome: result.outcome } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      });
    }
    return { fired: results.filter((item) => item.ok).length, results };
  }

  private async fireRow(row: EveDelayedActionRow): Promise<EveDelayedFireResult> {
    if (row.state !== 'pending') {
      return {
        ok: false,
        reason: 'not-pending',
        action: toView(row),
      };
    }
    if (this.inFlight.has(row.id)) {
      return { ok: false, reason: 'in-flight', action: toView(row) };
    }

    const now = new Date();
    this.inFlight.add(row.id);
    try {
      // The row is due from this moment on: if the push fails and the row stays
      // pending, the next tick retries it immediately instead of waiting out the
      // original delay.
      await this.prisma.eveDelayedAction.update({
        where: { id: row.id },
        data: { dueAt: now },
      });
      const current = { ...row, dueAt: now };
      const outcome = await this.dispatch(current, now);
      const fresh = await this.prisma.eveDelayedAction.findUnique({
        where: { id: row.id },
      });
      return {
        ok: outcome === 'sent',
        ...(outcome === 'sent' ? {} : { reason: outcome }),
        outcome,
        action: toView(fresh ?? current),
      };
    } finally {
      this.inFlight.delete(row.id);
    }
  }

  /** `POST /internal/eve/actions/tick`: one dispatch pass, for tests/dev. */
  async tickRequest(body: unknown): Promise<EveDelayedTickResult> {
    const raw = record(body).now;
    const now =
      typeof raw === 'string' || typeof raw === 'number'
        ? new Date(raw)
        : new Date();
    if (!Number.isFinite(now.getTime())) {
      throw apiError('EVE_NOW_INVALID', 'now must be a valid ISO date');
    }
    return this.tick(now);
  }

  // ---------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------

  async tick(now: Date = new Date()): Promise<EveDelayedTickResult> {
    const released = await this.releaseAwaiting(now);
    const rows = await this.prisma.eveDelayedAction.findMany({
      where: { state: 'pending', dueAt: { lte: now } },
      orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
      take: DELAYED_BATCH,
    });

    const result: EveDelayedTickResult = {
      released,
      picked: rows.length,
      sent: 0,
      retried: 0,
      failed: 0,
      dropped: 0,
    };
    for (const row of rows) {
      // A manual "reply now" is already dispatching this row; the tick must not
      // send it a second time.
      if (this.inFlight.has(row.id)) continue;
      const outcome = await this.dispatch(row, now);
      result[outcome === 'retried' ? 'retried' : outcome] += 1;
    }
    return result;
  }

  private async runTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.tick(new Date());
      if (result.sent > 0 || result.failed > 0 || result.dropped > 0) {
        this.logger.log(
          `Eve delayed tick: sent=${result.sent} retried=${result.retried} failed=${result.failed} dropped=${result.dropped} released=${result.released}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Eve delayed tick failed: ${(error as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Rows with `dueAt = null` wait for her to come back. Waking up makes them
   * due; a row that waited more than the busy cap is dropped instead of
   * replying to a day-old message.
   */
  private async releaseAwaiting(now: Date): Promise<number> {
    const rows = await this.prisma.eveDelayedAction.findMany({
      where: { state: 'pending', dueAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    if (rows.length === 0) return 0;

    const personaIds = [...new Set(rows.map((row) => row.personaId))];
    const personas = await this.prisma.evePersona.findMany({
      where: { id: { in: personaIds } },
      select: { id: true, timezone: true, sleepFrom: true, sleepTo: true },
    });
    const awake = new Map(
      personas.map((persona) => [
        persona.id,
        !isSleeping(
          localHour(persona.timezone),
          persona.sleepFrom,
          persona.sleepTo,
        ),
      ]),
    );

    let released = 0;
    for (const row of rows) {
      const waitedMs = now.getTime() - row.createdAt.getTime();
      if (waitedMs > MAX_ACTION_DELAY_SEC * 1_000) {
        await this.drop(row, 'expired');
        continue;
      }
      if (awake.get(row.personaId) !== true) continue;
      await this.prisma.eveDelayedAction.update({
        where: { id: row.id },
        data: { dueAt: now },
      });
      released += 1;
    }
    return released;
  }

  private async dispatch(
    row: EveDelayedActionRow,
    now: Date,
  ): Promise<EveDelayedOutcome> {
    // The allowlist can change while the row waits. Dropping is safer than
    // texting a chat the user removed from Eve.
    const [link, binding] = await Promise.all([
      this.prisma.evePersonaAccount.findUnique({
        where: {
          personaId_accountId: {
            personaId: row.personaId,
            accountId: row.accountId,
          },
        },
        select: { enabled: true },
      }),
      this.prisma.eveChatBinding.findUnique({
        where: {
          personaId_accountId_chatId_threadId: {
            personaId: row.personaId,
            accountId: row.accountId,
            chatId: row.chatId,
            threadId: row.threadId,
          },
        },
        select: { allowed: true },
      }),
    ]);
    if (link?.enabled !== true || binding?.allowed !== true) {
      return this.drop(row, 'address-not-allowed');
    }

    // The flag was frozen into the payload when the action was queued. An old
    // row without it is live; the global kill-switch is applied at dispatch.
    const payload = parseJson(row.payload);
    if (row.kind === 'turn') return this.dispatchTurn(row, now, payload);

    const chatId = row.chatId.toString();
    const messageId =
      payload.messageId === undefined || payload.messageId === null
        ? ''
        : String(payload.messageId);
    const user = await this.users.get();

    try {
      if (eveDryRunRequested(payload)) {
        noteEveDryRunOutbound(
          dryRunKindOf(row.kind),
          row.accountId,
          row.chatId,
          `deferred ${row.kind} payload=${row.payload.slice(0, 300)}`,
          row.personaId,
        );
        await this.markSent(row, now);
        return 'sent';
      }
      switch (row.kind) {
        case 'send': {
          const value = text(payload.text);
          if (!value) return this.drop(row, 'missing-text');
          await this.messaging.sendMessage(user.id, row.accountId, chatId, {
            text: value,
            typing: 'auto',
          });
          break;
        }
        case 'edit': {
          const value = text(payload.text);
          if (!messageId) return this.drop(row, 'missing-message-id');
          if (!value) return this.drop(row, 'missing-text');
          await this.messaging.editMessage(
            user.id,
            row.accountId,
            chatId,
            messageId,
            { text: value },
          );
          break;
        }
        case 'delete': {
          if (!messageId) return this.drop(row, 'missing-message-id');
          await this.messaging.deleteMessage(
            user.id,
            row.accountId,
            chatId,
            messageId,
            { revoke: payload.revoke !== false },
          );
          break;
        }
        case 'react': {
          if (!messageId) return this.drop(row, 'missing-message-id');
          await this.messaging.sendReaction(
            user.id,
            row.accountId,
            chatId,
            messageId,
            { emoji: payload.emoji },
          );
          break;
        }
        case 'read': {
          await this.messaging.markRead(user.id, row.accountId, chatId, {
            maxId: payload.maxId,
          });
          break;
        }
        default:
          return this.drop(row, 'unknown-kind');
      }
    } catch (error) {
      return this.retry(row, (error as Error).message);
    }

    await this.markSent(row, now);
    return 'sent';
  }

  /**
   * A deferred reply is a deferred *turn*: the text is not written yet, so the
   * model runs at `dueAt` in the same Eve session, with the behavior decision
   * captured when the message arrived.
   */
  private async dispatchTurn(
    row: EveDelayedActionRow,
    now: Date,
    payload: Record<string, unknown>,
  ): Promise<EveDelayedOutcome> {
    const url = eveTurnUrl();
    if (!url) return this.retry(row, 'turn-endpoint-disabled');

    // A deferred turn inherits the flag of the turn that queued it; the global
    // kill-switch forces it on for this dispatch only.
    const dryRun = eveDryRunRequested(payload);
    // The payload froze the series when the message arrived. Read the counter
    // right before the push: a message of that series may have been answered
    // or deliberately ignored while this turn waited, and the channel must not
    // answer it again. A read failure keeps the old behaviour (0 = no filter).
    const lastHisMessageId = await this.turns
      .lastAppliedMessageId(
        row.personaId,
        row.accountId,
        row.chatId.toString(),
      )
      .catch(() => 0);
    const body = {
      ...payload,
      actionId: row.id,
      personaId: row.personaId,
      accountId: row.accountId,
      chatId: row.chatId.toString(),
      threadId: row.threadId,
      lastHisMessageId,
      dryRun,
    };
    const result = await this.postTurn(url, body);
    if (!result.ok) {
      return this.retry(
        row,
        result.error ?? `HTTP ${result.status ?? 'unknown'}`,
      );
    }
    await this.markSent(row, now);
    return 'sent';
  }

  private async postTurn(
    url: string,
    payload: unknown,
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-token': eveToken(),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(DELAYED_PUSH_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, status: response.status };
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private async markSent(
    row: EveDelayedActionRow,
    now: Date,
  ): Promise<void> {
    await this.prisma.eveDelayedAction.update({
      where: { id: row.id },
      data: { state: 'sent', firedAt: now, lastError: null },
    });
  }

  private async retry(
    row: EveDelayedActionRow,
    error: string,
  ): Promise<EveDelayedOutcome> {
    const attempts = row.attempts + 1;
    const failed = attempts >= MAX_DELAYED_ATTEMPTS;
    await this.prisma.eveDelayedAction.update({
      where: { id: row.id },
      data: {
        attempts,
        state: failed ? 'failed' : 'pending',
        lastError: error.slice(0, 500),
      },
    });
    return failed ? 'failed' : 'retried';
  }

  private async drop(
    row: EveDelayedActionRow,
    reason: string,
  ): Promise<EveDelayedOutcome> {
    await this.prisma.eveDelayedAction.update({
      where: { id: row.id },
      data: { state: 'dropped', lastError: reason },
    });
    return 'dropped';
  }
}
