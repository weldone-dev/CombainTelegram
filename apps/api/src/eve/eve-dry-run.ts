import type { MessageView } from '../messaging/message-view.js';

/**
 * Dry-run: the persona goes through the whole turn (behavior, LLM, bubbles,
 * delays, memory, turn/apply) but no outbound action reaches Telegram.
 *
 * The switch lives in the API process because that is the only process that
 * owns Telegram. Eve does not need to know about it: the replies it sends to
 * `/internal/eve/messages/*` get a synthetic success and a structured log
 * line, so the turn completes and the next context is realistic.
 *
 * The flag is deliberately opt-in only: `EVE_DRY_RUN` must be one of
 * `true/1/yes/on`. A misspelled value keeps real sending enabled instead of
 * silently suppressing (or, worse, delivering) messages.
 */

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

function enabledByEnv(): boolean {
  const raw = (process.env.EVE_DRY_RUN ?? '').trim().toLowerCase();
  return TRUE_VALUES.has(raw);
}

function idSet(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

/** Chat ids (`EVE_DRY_RUN_CHATS`) this process suppresses; empty = all. */
export function eveDryRunChats(): Set<string> {
  return idSet(process.env.EVE_DRY_RUN_CHATS);
}

/** Account ids (`EVE_DRY_RUN_ACCOUNTS`) this process suppresses; empty = all. */
export function eveDryRunAccounts(): Set<string> {
  return idSet(process.env.EVE_DRY_RUN_ACCOUNTS);
}

export function eveDryRunEnabled(): boolean {
  return enabledByEnv();
}

/**
 * Whether an outbound action for this exact chat is suppressed.
 *
 * Read on every call instead of caching the env: the flag is cheap to parse
 * and a test (or an operator restarting with a new `.env`) sees the change.
 */
export function eveDryRunApplies(
  accountId: string,
  chatId: string | number | bigint,
): boolean {
  if (!enabledByEnv()) return false;
  const accounts = eveDryRunAccounts();
  if (accounts.size > 0 && !accounts.has(accountId)) return false;
  const chats = eveDryRunChats();
  if (chats.size > 0 && !chats.has(String(chatId))) return false;
  return true;
}

/** Human-readable target of the switch, for the startup warning. */
export function eveDryRunTarget(): string {
  const chats = [...eveDryRunChats()];
  const accounts = [...eveDryRunAccounts()];
  const parts: string[] = [];
  if (accounts.length > 0) parts.push(`accounts=${accounts.join(',')}`);
  if (chats.length > 0) parts.push(`chats=${chats.join(',')}`);
  return parts.length > 0 ? parts.join(' ') : 'all Eve chats';
}

/** Logged once when the API boots. */
export function logEveDryRunStartup(): void {
  if (!enabledByEnv()) return;
  console.warn(
    `[eve][dry-run] WARNING: EVE DRY RUN enabled — outbound suppressed for ${eveDryRunTarget()}; no Telegram message, reaction, typing, read or presence leaves the API`,
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
