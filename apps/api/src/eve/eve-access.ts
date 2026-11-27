import { apiError } from '../common/api-error.js';

/**
 * Small, dependency-free helpers shared by the Eve service, the event outbox
 * and the specs. Everything here throws `HttpException` bodies shaped as
 * `{ code, message }`, so the internal contract never leaks a raw Prisma error.
 */

/** A non-empty id from a body/query value. */
export function eveId(value: unknown, code: string, message: string): string {
  const parsed =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : '';
  if (!parsed) throw apiError(code, message);
  return parsed;
}

/** Telegram chat ids are non-zero safe integers; they are stored as BigInt. */
export function parseChatId(value: unknown): bigint {
  const numeric =
    typeof value === 'string' && value.trim() ? Number(value.trim()) : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric === 0) {
    throw apiError('EVE_CHAT_ID_INVALID', 'chatId must be a non-zero integer');
  }
  return BigInt(numeric);
}

/** `threadId = 0` means the whole chat, mirroring `AiChatAccess`. */
export function parseThreadId(value: unknown, fallback = 0): number {
  if (value === undefined || value === null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw apiError(
      'EVE_THREAD_ID_INVALID',
      'threadId must be a non-negative integer',
    );
  }
  return numeric;
}

/**
 * Optional chat id for telemetry payloads. A deleted chat arrives as `null`,
 * an inaccessible one as an unparseable value; both become `null` instead of
 * crashing the event writer on `BigInt(NaN)`.
 */
export function eventChatId(value: unknown): bigint | null {
  if (value === undefined || value === null || value === '') return null;
  const numeric =
    typeof value === 'string' && value.trim() ? Number(value.trim()) : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric === 0) return null;
  return BigInt(numeric);
}

export function eventThreadId(value: unknown): number {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

export interface EveAddress {
  personaId: string;
  accountId: string;
  chatId: bigint;
  threadId: number;
}

/**
 * Outward Eve responses are JSON: BigInt cannot be serialized, so every row
 * that carries a `chatId` is converted to a string at the service boundary.
 * BigInt stays inside the Prisma calls only.
 */
export type ChatIdString<T extends { chatId: bigint }> = Omit<T, 'chatId'> & {
  chatId: string;
};

export function withChatId<T extends { chatId: bigint }>(
  row: T,
): ChatIdString<T> {
  const { chatId, ...rest } = row;
  return { ...rest, chatId: chatId.toString() } as ChatIdString<T>;
}

export function withChatIds<T extends { chatId: bigint }>(
  rows: T[],
): ChatIdString<T>[] {
  return rows.map((row) => withChatId(row));
}

export interface EveEventCursor {
  createdAt: Date;
  /** Empty for a legacy `?cursor=<iso>` value written before Phase 0/1. */
  id: string;
}

/**
 * Stable event cursor: `createdAt|id`. The id breaks ties between rows created
 * in the same millisecond, which a timestamp-only cursor silently skipped.
 */
export function formatEventCursor(row: { createdAt: Date; id: string }): string {
  return `${row.createdAt.toISOString()}|${row.id}`;
}

export function parseEventCursor(raw: string | undefined): EveEventCursor | null {
  const value = raw?.trim();
  if (!value) return null;
  const separator = value.indexOf('|');
  const iso = separator === -1 ? value : value.slice(0, separator);
  const id = separator === -1 ? '' : value.slice(separator + 1).trim();
  const createdAt = new Date(iso);
  if (!Number.isFinite(createdAt.getTime()) || (separator !== -1 && !id)) {
    throw apiError(
      'EVE_CURSOR_INVALID',
      'cursor must be "<iso8601>|<eventId>"',
    );
  }
  return { createdAt, id };
}

/** Parses a date field; an unparseable value is a client error, not a 500. */
export function eveDate(value: unknown, code = 'EVE_DATE_INVALID'): Date {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : new Date(Number.NaN);
  if (!Number.isFinite(date.getTime())) {
    throw apiError(code, 'value must be a valid ISO date');
  }
  return date;
}

/**
 * Idempotency hint for Eve: the same realtime event replayed by the socket and
 * the REST cursor endpoint carries the same key. Absent ids leave it unset.
 */
export function eventDedupeKey(
  kind: string,
  payload: Record<string, unknown>,
  address: { accountId: string; chatId: bigint | null; threadId: number },
): string | null {
  if (address.chatId === null) return null;
  const message = payload.message;
  const messageId =
    message && typeof message === 'object'
      ? (message as Record<string, unknown>).id
      : undefined;
  const raw =
    messageId ??
    payload.maxId ??
    (Array.isArray(payload.messageIds) ? payload.messageIds.join(',') : undefined);
  const marker =
    typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'bigint'
      ? String(raw)
      : '';
  if (!marker) return null;
  return [
    kind,
    address.accountId,
    address.chatId.toString(),
    address.threadId,
    marker,
  ].join(':');
}

/** JSON stringify that survives BigInt values in realtime payloads. */
export function safeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
}
