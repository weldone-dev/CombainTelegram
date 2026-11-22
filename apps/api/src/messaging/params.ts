import { apiError } from '../common/api-error.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TEXT_LENGTH = 4096;

function invalid(message: string): never {
  throw apiError('VALIDATION_ERROR', message);
}

function parseInteger(value: unknown, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) invalid(`${field} must be an integer`);
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return invalid(`${field} must be an integer`);
}

/** Telegram marked chat id (users/groups are positive, channels negative). */
export function parseChatId(value: unknown): number {
  const id = parseInteger(value, 'chatId');
  if (id === 0) invalid('chatId must not be zero');
  return id;
}

export function parseMessageId(value: unknown): number {
  const id = parseInteger(value, 'messageId');
  if (id <= 0) invalid('messageId must be a positive integer');
  return id;
}

/** `limit` query parameter: default 50, clamped to [1, 200]. */
export function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_LIMIT;
  }
  const limit = parseInteger(value, 'limit');
  if (limit <= 0) invalid('limit must be a positive integer');
  return Math.min(limit, MAX_LIMIT);
}

export function parseOffsetId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const offsetId = parseInteger(value, 'offsetId');
  if (offsetId <= 0) invalid('offsetId must be a positive integer');
  return offsetId;
}

export function parseOptionalSessionId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid('sessionId must be a string');
  const sessionId = value.trim();
  if (!sessionId) return undefined;
  if (sessionId.length > 64) invalid('sessionId must be at most 64 characters');
  return sessionId;
}

/** Message text: trimmed, non-empty, at most 4096 characters. */
export function parseMessageText(value: unknown): string {
  if (typeof value !== 'string') invalid('text is required');
  const text = value.trim();
  if (!text) invalid('text must not be empty');
  if (text.length > MAX_TEXT_LENGTH) {
    invalid(`text must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  return text;
}
