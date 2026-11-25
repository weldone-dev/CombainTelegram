import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { Agent, fetch as httpFetch } from 'undici';
import type { RequestInit as UndiciRequestInit } from 'undici';
import type { IntegrationEventModel } from '@repo/database';
import { isPrivateHost } from '../../ai/speech.service.js';
import { parseLimit } from '../../messaging/params.js';
import type { MessageView } from '../../messaging/message-view.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RealtimeService } from '../../realtime/realtime.service.js';
import type { RealtimeEvent } from '../../realtime/realtime.service.js';
import { emitLog } from '../../logs/log-sink.js';
import { N8nContextService } from './n8n-context.service.js';
import type { N8nAccountBlock, N8nChatBlock } from './n8n-context.service.js';
import { N8N_TOKEN_HEADER } from './n8n-token.guard.js';

/** Who sees which events: an account with a workflow, or everybody. */
const WORKFLOW_TTL_MS = 15_000;
/** Long-poll polling step, milliseconds. */
const POLL_MS = 250;
/** Delivered rows older than this are dropped by the retention sweep. */
const DEFAULT_RETENTION_DAYS = 7;
/** How often the retention sweep runs, milliseconds (once an hour). */
const RETENTION_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

/** Push delivery: one POST per event, retried before the row stays pending. */
const PUSH_TIMEOUT_MS = 10_000;
const PUSH_ATTEMPTS = 3;
/** Delay before attempt 2, attempt 3 (a fourth would wait 3 s). */
const PUSH_BACKOFF_MS = [250, 1_000, 3_000];
/** Bounded queue: a flood drops the oldest pending pushes, never silently. */
const PUSH_QUEUE_LIMIT = 100;
/** Global send rate cap, events per second. */
const PUSH_MAX_PER_SECOND = 20;

/** Events the app hands to n8n; everything else on the bus is ignored. */
const MESSAGE_KINDS = new Set([
  'message.new',
  'message.edited',
  'message.deleted',
  'message.read',
]);

/** Public shape of one outbox row. */
export interface N8nEventView {
  id: string;
  kind: string;
  accountId: string | null;
  chatId: number | null;
  threadId: number;
  /** The old flat payload; kept verbatim for existing templates. */
  payload: unknown;
  createdAt: string;
  /** Who produced the event; `null` when the account row is gone. */
  account: N8nAccountBlock | null;
  /** Where it happened; `null` for events without a chat id. */
  chat: N8nChatBlock | null;
  /** Only `message.new` / `message.edited` carry a message block. */
  message?: N8nEventMessageBlock;
}

/** Media descriptor of a message block: metadata only, never bytes. */
export interface N8nEventMediaBlock {
  kind: string;
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  emoji: string | null;
}

export interface N8nEventMessageBlock {
  id: number;
  date: string | null;
  outgoing: boolean;
  senderId: number | null;
  senderName: string;
  text: string;
  transcript: string | null;
  mediaType: string | null;
  media: N8nEventMediaBlock | null;
  isVoice: boolean;
  replyToId: number | null;
}

export interface N8nEventPage {
  events: N8nEventView[];
  /** `id` of the last event; pass it back as `cursor`. */
  nextCursor: string | null;
}

export interface N8nEventQuery {
  cursor?: string;
  limit?: unknown;
  /** Already converted to milliseconds by the controller. */
  waitMs?: number;
}

/** `N8N_EVENTS_ALL=1` disables the "only workflow accounts" filter. */
function eventsForEveryone(): boolean {
  const value = process.env.N8N_EVENTS_ALL;
  return value === '1' || value?.toLowerCase() === 'true';
}

function retentionMs(): number {
  const parsed = Number(process.env.N8N_EVENT_RETENTION_DAYS);
  const days =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

/** Forum topic / comment thread id, read from whichever field the engine set. */
function threadIdOf(
  payload: Record<string, unknown>,
  message: Partial<MessageView> | null,
): number {
  const candidates: unknown[] = [
    payload.threadId,
    payload.messageThreadId,
    (message as { threadId?: unknown } | null)?.threadId,
    (message as { messageThreadId?: unknown } | null)?.messageThreadId,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

/**
 * Message payload minus media bytes: everything a workflow needs to decide
 * what to do, and nothing that would have to be downloaded.
 */
function messagePayload(
  message: Partial<MessageView>,
  chatId: number | null,
  threadId: number,
): Record<string, unknown> {
  const transcript = (message as { transcript?: unknown }).transcript;
  const media = message.media ?? null;
  return {
    messageId: message.id ?? null,
    chatId,
    threadId,
    text: message.text ?? '',
    mediaType: message.mediaType ?? null,
    media: media
      ? {
          kind: media.kind,
          mimeType: media.mimeType,
          fileName: media.fileName,
          size: media.size,
          emoji: media.emoji ?? null,
          downloadable: media.downloadable,
        }
      : null,
    transcript: typeof transcript === 'string' ? transcript : null,
    outgoing: message.outgoing === true,
    senderId: message.senderId ?? null,
    senderName: message.senderName ?? '',
    replyToId: message.replyToId ?? null,
    date: message.date ?? null,
    edited: message.edited === true,
    isVoice: message.isVoice === true,
    service: message.service === true,
  };
}

function parsePayload(row: IntegrationEventModel): unknown {
  try {
    return JSON.parse(row.payload) as unknown;
  } catch {
    return row.payload;
  }
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Media metadata only: `payload.media` never contains bytes. */
function mediaBlock(value: unknown): N8nEventMediaBlock | null {
  const media = asRecord(value);
  if (Object.keys(media).length === 0) return null;
  const size = Number(media.size);
  return {
    kind: text(media.kind) || 'other',
    mimeType: optionalText(media.mimeType),
    fileName: optionalText(media.fileName),
    size: Number.isSafeInteger(size) ? size : null,
    emoji: optionalText(media.emoji),
  };
}

/**
 * Message block of an event, rebuilt from the stored flat payload so a row read
 * back through `GET /events` looks exactly like the pushed event.
 */
function messageBlock(
  kind: string,
  payload: Record<string, unknown>,
): N8nEventMessageBlock | undefined {
  if (kind !== 'message.new' && kind !== 'message.edited') return undefined;
  const id = numberOrNull(payload.messageId);
  if (id === null) return undefined;
  return {
    id,
    date: optionalText(payload.date),
    outgoing: payload.outgoing === true,
    senderId: numberOrNull(payload.senderId),
    senderName: text(payload.senderName),
    text: text(payload.text),
    transcript: optionalText(payload.transcript),
    mediaType: optionalText(payload.mediaType),
    media: mediaBlock(payload.media),
    isVoice: payload.isVoice === true,
    replyToId: numberOrNull(payload.replyToId),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Destination of the push webhook; `null` when pushing is switched off. */
export interface N8nWebhookConfig {
  url: string;
  /** Sent as `x-combain-token`; `null` when neither token is configured. */
  token: string | null;
}

function truthyFlag(value: string | undefined): boolean {
  if (value === undefined) return true;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

/**
 * Push webhook settings, read per send so a restart-free change applies:
 *
 * - `N8N_WEBHOOK_URL` — full URL of the n8n Webhook node (e.g.
 *   `http://127.0.0.1:5678/webhook/<random-path>`); unset = pushing off.
 * - `N8N_WEBHOOK_ENABLED` — `0`/`false`/`off` disables an otherwise
 *   configured URL; anything else (including unset) keeps it on.
 * - `N8N_WEBHOOK_TOKEN` — shared secret for `x-combain-token`, falling back to
 *   `N8N_ACTION_TOKEN` so one secret can secure both directions.
 */
export function n8nWebhookConfig(
  env: NodeJS.ProcessEnv = process.env,
): N8nWebhookConfig | null {
  const url = (env.N8N_WEBHOOK_URL ?? '').trim();
  if (!url) return null;
  if (!truthyFlag(env.N8N_WEBHOOK_ENABLED)) return null;
  const token =
    (env.N8N_WEBHOOK_TOKEN ?? '').trim() ||
    (env.N8N_ACTION_TOKEN ?? '').trim();
  return { url, token: token || null };
}

let directAgent: Agent | null = null;

/**
 * Proxy-free dispatcher for loopback/LAN n8n, same rule as the n8n API client:
 * the workstation's `HTTP(S)_PROXY` answers 503 for the LAN, so a local webhook
 * must bypass it explicitly. Public URLs keep the default path.
 */
function directDispatcher(): Agent {
  directAgent ??= new Agent({ connect: { timeout: 10_000 } });
  return directAgent;
}

interface PushOutcome {
  ok: boolean;
  status: number | null;
  errorCode?: string;
}

/**
 * Bridge between the realtime bus and n8n.
 *
 * Every `message.*` event (and every AI access/block change) for an account
 * assigned to a workflow is written as an `IntegrationEvent` row and then
 * pushed to `N8N_WEBHOOK_URL`, so a workflow starts on the event itself
 * instead of polling. A failed push leaves `deliveredAt` null: the row is
 * still readable through `GET /integrations/n8n/events` (manual debugging /
 * replay), which is no longer the primary path and needs no n8n schedule.
 * Delivered rows are pruned after {@link DEFAULT_RETENTION_DAYS} days.
 *
 * Accounts without a workflow are skipped unless `N8N_EVENTS_ALL=1`: the feed
 * only carries traffic the workflow engine is responsible for.
 */
@Injectable()
export class N8nEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(N8nEventsService.name);
  private subscription?: Subscription;
  /** Serialises writes so the feed keeps the order the bus delivered. */
  private chain: Promise<void> = Promise.resolve();
  private retentionTimer?: ReturnType<typeof setInterval>;
  private readonly workflows = new Map<
    string,
    { at: number; workflowId: string | null }
  >();
  /** Pending webhook pushes, oldest first; bounded by {@link PUSH_QUEUE_LIMIT}. */
  private readonly pushQueue: N8nEventView[] = [];
  /** One drain loop at a time keeps delivery ordered. */
  private pushing = false;
  /** Send timestamps of the last second, for {@link PUSH_MAX_PER_SECOND}. */
  private readonly pushTimestamps: number[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly context: N8nContextService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.realtime.events$.subscribe((event) => {
      if (!this.interesting(event)) return;
      this.enqueue(event);
    });

    void this.pruneDelivered();
    const timer = setInterval(() => {
      void this.pruneDelivered();
    }, RETENTION_INTERVAL_MS);
    timer.unref?.();
    this.retentionTimer = timer;
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = undefined;
    this.pushQueue.length = 0;
  }

  /**
   * Reads the outbox page (oldest first). Kept for manual debugging and replay
   * after a failed push; the n8n workflow itself is triggered by the webhook.
   * `wait` long-polls up to 25 s, exactly like the old trigger node expected.
   */
  async list(userId: string, query: N8nEventQuery = {}): Promise<N8nEventPage> {
    const limit =
      query.limit === undefined || query.limit === null || query.limit === ''
        ? DEFAULT_LIMIT
        : parseLimit(query.limit, MAX_LIMIT);
    const wait = Math.min(
      Math.max(0, Math.round(query.waitMs ?? 0)),
      25_000,
    );
    const deadline = Date.now() + wait;
    const cursorRow = query.cursor
      ? await this.cursorRow(userId, query.cursor)
      : null;

    for (;;) {
      const rows = (await this.prisma.integrationEvent.findMany({
        where: this.where(userId, cursorRow),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      })) as IntegrationEventModel[];

      if (rows.length > 0) {
        await this.markDelivered(rows.map((row) => row.id));
        return {
          events: await Promise.all(rows.map((row) => this.view(row))),
          nextCursor: rows[rows.length - 1]?.id ?? query.cursor ?? null,
        };
      }
      const left = deadline - Date.now();
      if (left <= 0) {
        return { events: [], nextCursor: query.cursor ?? null };
      }
      await sleep(Math.min(POLL_MS, left));
    }
  }

  /** Deletes delivered rows older than the retention window. */
  async pruneDelivered(now = Date.now()): Promise<number> {
    try {
      const { count } = await this.prisma.integrationEvent.deleteMany({
        where: {
          deliveredAt: { not: null, lt: new Date(now - retentionMs()) },
        },
      });
      return count;
    } catch (error) {
      // A missing migration must not take the API down; readers will surface
      // the real error if they need the table.
      this.logger.warn(
        `Could not prune delivered integration events: ${(error as Error).message}`,
      );
      return 0;
    }
  }

  private interesting(event: RealtimeEvent): boolean {
    if (MESSAGE_KINDS.has(event.event)) return true;
    if (event.event === 'access.changed') return true;
    return false;
  }

  private enqueue(event: RealtimeEvent): void {
    this.chain = this.chain
      .then(() => this.record(event))
      .catch((error: unknown) => {
        this.logger.warn(
          `Could not record a ${event.event} integration event: ${(error as Error).message}`,
        );
      });
  }

  private async record(event: RealtimeEvent): Promise<void> {
    const payload = asRecord(event.payload);
    const accountId = text(payload.accountId);
    if (!accountId) return;
    if (!(await this.wanted(accountId))) return;

    const message = (payload.message ?? null) as Partial<MessageView> | null;
    const chatId =
      numberOrNull(payload.chatId) ?? numberOrNull(message?.chatId);
    const threadId = threadIdOf(payload, message);
    // The access/tags row changed a moment ago: the cached chat block is stale
    // by definition, so this event must carry the new state.
    if (event.event === 'access.changed') {
      this.context.invalidateChat(accountId, chatId);
    }

    if (event.event === 'message.new' || event.event === 'message.edited') {
      if (!message) return;
      await this.create({
        userId: event.userId,
        kind: event.event,
        accountId,
        chatId,
        threadId,
        payload: messagePayload(message, chatId, threadId),
      });
      return;
    }

    if (event.event === 'message.deleted') {
      const messageIds = Array.isArray(payload.messageIds)
        ? payload.messageIds.filter(
            (id): id is number => typeof id === 'number',
          )
        : [];
      await this.create({
        userId: event.userId,
        kind: event.event,
        accountId,
        chatId,
        threadId,
        payload: { chatId, messageIds },
      });
      return;
    }

    if (event.event === 'message.read') {
      await this.create({
        userId: event.userId,
        kind: event.event,
        accountId,
        chatId,
        threadId,
        payload: {
          chatId,
          maxId: numberOrNull(payload.maxId),
          outbox: payload.outbox === true,
          unread: numberOrNull(payload.unread) ?? 0,
        },
      });
      return;
    }

    // `access.changed` from `AiChatEventsService`: access edits and the whole
    // warning/block lifecycle share one bus event; the row kind says which.
    const action = text(payload.action) || 'access';
    await this.create({
      userId: event.userId,
      kind: action === 'access' ? 'access.changed' : 'block.changed',
      accountId,
      chatId,
      threadId,
      payload: {
        chatId,
        threadId,
        action,
        reason: typeof payload.reason === 'string' ? payload.reason : null,
        warnings:
          typeof payload.warnings === 'number' ? payload.warnings : 0,
        actor: typeof payload.actor === 'string' ? payload.actor : 'user',
      },
    });
  }

  private async create(input: {
    userId: string;
    kind: string;
    accountId: string;
    chatId: number | null;
    threadId: number;
    payload: Record<string, unknown>;
  }): Promise<void> {
    const row = (await this.prisma.integrationEvent.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        accountId: input.accountId,
        chatId: input.chatId === null ? null : BigInt(input.chatId),
        threadId: input.threadId,
        payload: JSON.stringify(input.payload),
      },
    })) as IntegrationEventModel;
    emitLog({
      level: 'debug',
      source: 'app',
      action: 'n8n.event.record',
      message: `Queued ${input.kind} for the n8n feed`,
      status: 'ok',
      userId: input.userId,
      accountId: input.accountId,
      chatId: input.chatId ?? undefined,
      details: { kind: input.kind, threadId: input.threadId },
    });
    // The workflow is triggered by the push, not by reading the row back.
    this.enqueuePush(await this.view(row));
  }

  /**
   * Public event shape: the stored row plus the account/chat/message blocks.
   * Enrichment is cached by `N8nContextService`, so a paged read costs one
   * query per account and one per chat, not one per row.
   */
  private async view(row: IntegrationEventModel): Promise<N8nEventView> {
    const payload = parsePayload(row);
    const record = asRecord(payload);
    const chatId = row.chatId === null ? null : Number(row.chatId);
    const [account, chat] = await Promise.all([
      row.accountId ? this.context.account(row.accountId) : null,
      row.accountId && chatId !== null
        ? this.context.chat(row.userId, row.accountId, chatId, row.threadId)
        : null,
    ]);
    // Account/chat ids only: message text never belongs in a log line.
    emitLog({
      level: 'debug',
      source: 'app',
      action: 'n8n.event.enrich',
      message: `Enriched ${row.kind} for the n8n feed`,
      status: 'ok',
      userId: row.userId,
      accountId: row.accountId ?? undefined,
      chatId: chatId ?? undefined,
      details: { kind: row.kind, threadId: row.threadId },
    });
    const event: N8nEventView = {
      id: row.id,
      kind: row.kind,
      accountId: row.accountId,
      chatId,
      threadId: row.threadId,
      payload,
      createdAt: row.createdAt.toISOString(),
      account,
      chat,
    };
    const message = messageBlock(row.kind, record);
    if (message) event.message = message;
    return event;
  }

  /**
   * Adds one event to the bounded push queue and starts the drain loop.
   * On overflow the oldest pending item is dropped with a warning, so a flood
   * delays nothing and never discards silently.
   */
  private enqueuePush(event: N8nEventView): void {
    if (!n8nWebhookConfig()) return;
    if (this.pushQueue.length >= PUSH_QUEUE_LIMIT) {
      const dropped = this.pushQueue.shift();
      const message = `n8n push queue is full (${PUSH_QUEUE_LIMIT}); dropped ${dropped?.kind ?? 'event'} ${dropped?.id ?? ''}`.trim();
      this.logger.warn(message);
      emitLog({
        level: 'warn',
        source: 'app',
        action: 'n8n.event.push',
        message,
        status: 'failed',
        accountId: dropped?.accountId ?? undefined,
        chatId: dropped?.chatId ?? undefined,
        errorCode: 'QUEUE_OVERFLOW',
        details: { kind: dropped?.kind, id: dropped?.id, dropped: true },
      });
    }
    this.pushQueue.push(event);
    void this.drainPushes().catch((error: unknown) => {
      // A DB error while marking delivery must not surface as an unhandled
      // rejection; the row keeps `deliveredAt: null` and stays replayable.
      this.logger.warn(
        `n8n push loop stopped: ${(error as Error).message}`,
      );
    });
  }

  /** Delivers queued pushes one by one; a single loop keeps them ordered. */
  private async drainPushes(): Promise<void> {
    if (this.pushing) return;
    this.pushing = true;
    try {
      for (;;) {
        const event = this.pushQueue.shift();
        if (!event) break;
        const config = n8nWebhookConfig();
        if (!config) {
          // Disabled between enqueue and send: nothing to deliver to.
          this.pushQueue.length = 0;
          break;
        }
        await this.deliverPush(config, event);
      }
    } finally {
      this.pushing = false;
    }
  }

  /** Waits for a free slot so the webhook never sees more than 20 events/s. */
  private async throttlePush(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (
        this.pushTimestamps.length > 0 &&
        now - (this.pushTimestamps[0] as number) >= 1000
      ) {
        this.pushTimestamps.shift();
      }
      if (this.pushTimestamps.length < PUSH_MAX_PER_SECOND) break;
      const wait = 1000 - (now - (this.pushTimestamps[0] as number));
      await sleep(Math.max(1, wait));
    }
    this.pushTimestamps.push(Date.now());
  }

  /**
   * POSTs one event with retries. A 2xx marks the row delivered; exhaustion
   * leaves `deliveredAt` null for the retention sweep and manual replay.
   */
  private async deliverPush(
    config: N8nWebhookConfig,
    event: N8nEventView,
  ): Promise<void> {
    let outcome: PushOutcome = { ok: false, status: null };
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
      await this.throttlePush();
      outcome = await this.postEvent(config, event);
      if (outcome.ok) {
        await this.markDelivered([event.id]);
        emitLog({
          level: 'debug',
          source: 'app',
          action: 'n8n.event.push',
          message: `Pushed ${event.kind} to n8n`,
          status: 'ok',
          accountId: event.accountId ?? undefined,
          chatId: event.chatId ?? undefined,
          details: { kind: event.kind, attempts: attempt },
        });
        return;
      }
      if (attempt < PUSH_ATTEMPTS) {
        await sleep(PUSH_BACKOFF_MS[attempt - 1] ?? 3_000);
      }
    }

    const statusText = outcome.status === null ? '' : ` (last status ${outcome.status})`;
    const message = `Could not push ${event.kind} to n8n after ${PUSH_ATTEMPTS} attempts${statusText}`;
    this.logger.warn(message);
    emitLog({
      level: 'warn',
      source: 'app',
      action: 'n8n.event.push',
      message,
      status: 'failed',
      accountId: event.accountId ?? undefined,
      chatId: event.chatId ?? undefined,
      errorCode: outcome.errorCode,
      // No payload bodies in logs: chat text never belongs in a log line.
      details: {
        kind: event.kind,
        status: outcome.status,
        attempts: PUSH_ATTEMPTS,
      },
    });
  }

  /** One POST to the webhook URL; the event JSON is the whole body. */
  private async postEvent(
    config: N8nWebhookConfig,
    event: N8nEventView,
  ): Promise<PushOutcome> {
    const init: UndiciRequestInit = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(config.token ? { [N8N_TOKEN_HEADER]: config.token } : {}),
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    };
    try {
      if (isPrivateHost(new URL(config.url).hostname)) {
        init.dispatcher = directDispatcher();
      }
    } catch {
      // A malformed URL fails at fetch() with a readable error.
    }
    try {
      const response = await httpFetch(config.url, init);
      // Drain the answer so the socket is reused; its content is irrelevant.
      await response.text().catch(() => '');
      const ok = response.status >= 200 && response.status < 300;
      return { ok, status: response.status };
    } catch (error) {
      return {
        ok: false,
        status: null,
        errorCode: (error as Error)?.name || 'NETWORK',
      };
    }
  }

  /**
   * Only accounts assigned to a workflow feed n8n, unless
   * `N8N_EVENTS_ALL=1`. Cached briefly so a busy chat does not hit the DB for
   * every message while an assignment change still lands within 15 s.
   */
  private async wanted(accountId: string): Promise<boolean> {
    if (eventsForEveryone()) return true;
    const cached = this.workflows.get(accountId);
    if (cached && Date.now() - cached.at < WORKFLOW_TTL_MS) {
      return cached.workflowId !== null;
    }
    const row = (await this.prisma.telegramAccount.findUnique({
      where: { id: accountId },
      select: { workflowId: true },
    })) as { workflowId: string | null } | null;
    const workflowId = row?.workflowId ?? null;
    this.workflows.set(accountId, { at: Date.now(), workflowId });
    if (this.workflows.size > 500) {
      const oldest = this.workflows.keys().next().value;
      if (oldest) this.workflows.delete(oldest);
    }
    return workflowId !== null;
  }

  private async cursorRow(
    userId: string,
    cursor: string,
  ): Promise<IntegrationEventModel | null> {
    const row = (await this.prisma.integrationEvent.findFirst({
      where: { id: cursor, userId },
    })) as IntegrationEventModel | null;
    // A cursor pruned by retention simply replays from the oldest kept row.
    return row;
  }

  private where(
    userId: string,
    cursorRow: IntegrationEventModel | null,
  ): Record<string, unknown> {
    if (!cursorRow) return { userId };
    return {
      userId,
      OR: [
        { createdAt: { gt: cursorRow.createdAt } },
        { createdAt: cursorRow.createdAt, id: { gt: cursorRow.id } },
      ],
    };
  }

  private async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.prisma.integrationEvent.updateMany({
      where: { id: { in: ids }, deliveredAt: null },
      data: { deliveredAt: new Date() },
    });
  }
}
