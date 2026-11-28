import type { MessageView } from '../messaging/message-view.js';

/**
 * Dry-run: the persona goes through the whole turn (behavior, LLM, bubbles,
 * delays, memory, turn/apply) but no outbound action reaches Telegram.
 *
 * The switch is **per request**, not per chat: a test/manual turn carries
 * `dryRun: true` and every outbound call of that turn forwards the flag to the
 * API process, which is the only process that owns Telegram. A real Telegram
 * `message.new` never sets it, so live traffic is delivered normally.
 *
 * `EVE_DRY_RUN` remains as a global kill-switch: when it is one of
 * `true/1/yes/on`, every outbound action is suppressed regardless of the
 * per-request flag. The flag travels with the turn; there is no chat/account
 * scope.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function enabledByEnv(): boolean {
  const raw = (process.env.EVE_DRY_RUN ?? '').trim().toLowerCase();
  return TRUE_VALUES.has(raw);
}

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    return TRUE_VALUES.has(value.trim().toLowerCase());
  }
  return false;
}

export function eveDryRunEnabled(): boolean {
  return enabledByEnv();
}

/**
 * Whether an outbound action is suppressed: the global kill-switch or the
 * `dryRun` field of this request/payload. Accepts a body (`{ dryRun: true }`)
 * or the raw flag, so callers do not repeat the shape check.
 *
 * The env is read on every call instead of being cached: it is cheap to parse
 * and a test (or an operator restarting with a new `.env`) sees the change.
 */
export function eveDryRunRequested(raw: unknown): boolean {
  if (enabledByEnv()) return true;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return truthy((raw as Record<string, unknown>).dryRun);
  }
  return truthy(raw);
}

/** Logged once when the API boots. */
export function logEveDryRunStartup(): void {
  if (!enabledByEnv()) return;
  console.warn(
    '[eve][dry-run] WARNING: global EVE_DRY_RUN is enabled — every outbound action is suppressed regardless of the per-turn flag; no Telegram message, reaction, typing, read or presence leaves the API',
  );
}

/* ------------------------------------------------------------------ */
/* Structured log + synthetic ids                                      */
/* ------------------------------------------------------------------ */

export type EveDryRunOutboundKind =
  | 'send'
  | 'media'
  | 'voice'
  | 'sticker'
  | 'react'
  | 'edit'
  | 'delete'
  | 'typing'
  | 'read'
  | 'presence'
  | 'block'
  | 'unblock';

export interface EveDryRunEntry {
  kind: EveDryRunOutboundKind;
  text: string;
  at: string;
}

/** Per-chat buffer of suppressed actions, attached to the next snapshot. */
const suppressed = new Map<string, EveDryRunEntry[]>();
const MAX_SUPPRESSED_PER_CHAT = 20;
const MAX_SUPPRESSED_CHATS = 200;

/** Negative ids are never real Telegram ids; Eve only needs a non-empty list. */
let syntheticId = 0;

function chatKey(
  personaId: string | undefined,
  accountId: string,
  chatId: string | number | bigint,
): string {
  return `${personaId ?? ''}:${accountId}:${String(chatId)}`;
}

/**
 * Records one suppressed action: a `[eve][dry-run]` log line plus a buffer
 * entry for the context snapshot (`meta.suppressedOutbound`).
 */
export function noteEveDryRunOutbound(
  kind: EveDryRunOutboundKind,
  accountId: string,
  chatId: string | number | bigint,
  detail: string,
  personaId?: string,
): void {
  const text = detail.length > 500 ? `${detail.slice(0, 499)}…` : detail;
  console.log(
    `[eve][dry-run] ${kind} chat=${String(chatId)} account=${accountId} ${text}`,
  );
  const key = chatKey(personaId, accountId, chatId);
  const previous = suppressed.get(key) ?? [];
  suppressed.set(
    key,
    [...previous, { kind, text, at: new Date().toISOString() }].slice(
      -MAX_SUPPRESSED_PER_CHAT,
    ),
  );
  if (suppressed.size > MAX_SUPPRESSED_CHATS) {
    const oldest = suppressed.keys().next().value;
    if (oldest) suppressed.delete(oldest);
  }
}

/**
 * Returns the suppressed actions of this chat and clears them. The snapshot of
 * the turn that just ran is the natural place: the UI shows which replies were
 * generated but not delivered.
 */
export function takeEveDryRunOutbound(
  accountId: string,
  chatId: string | number | bigint,
  personaId?: string,
): EveDryRunEntry[] {
  const key = chatKey(personaId, accountId, chatId);
  const entries = suppressed.get(key) ?? [];
  suppressed.delete(key);
  return entries;
}

/** Test hook: the buffer is module state. */
export function resetEveDryRunState(): void {
  suppressed.clear();
  syntheticId = 0;
}

export function dryRunMessageId(): number {
  syntheticId -= 1;
  return syntheticId;
}

/** Maps a durable action kind to the dry-run log kind. */
export function dryRunKindOf(kind: string): EveDryRunOutboundKind {
  switch (kind) {
    case 'send':
    case 'media':
    case 'voice':
    case 'sticker':
    case 'react':
    case 'edit':
    case 'delete':
    case 'typing':
    case 'read':
    case 'presence':
    case 'block':
    case 'unblock':
      return kind;
    default:
      return 'send';
  }
}

/** A `MessageView`-shaped result for a suppressed send. */
export function dryRunMessageView(chatId: bigint, text: string): MessageView {
  return {
    id: dryRunMessageId(),
    chatId: Number(chatId),
    text,
    date: new Date().toISOString(),
    outgoing: true,
    edited: false,
    senderId: 0,
    senderName: 'dry-run',
    replyToId: null,
    replyToText: null,
    forwardedFrom: null,
    mediaType: null,
    media: null,
    reactions: [],
    poll: null,
    isVoice: false,
    service: false,
    thread: null,
    sendingState: null,
  };
}
