import { apiError } from '../common/api-error.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TEXT_LENGTH = 4096;
const MAX_SEARCH_QUERY_LENGTH = 256;
const MAX_FORWARD_MESSAGES = 100;
const USERNAME_PATTERN = /^[a-zA-Z0-9_]{1,64}$/;

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
export function parseChatId(value: unknown, field = 'chatId'): number {
  const id = parseInteger(value, field);
  if (id === 0) invalid(`${field} must not be zero`);
  return id;
}

export function parseMessageId(value: unknown, field = 'messageId'): number {
  const id = parseInteger(value, field);
  if (id <= 0) invalid(`${field} must be a positive integer`);
  return id;
}

export function parseOptionalMessageId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseMessageId(value);
}

/** `messageIds` of a forward request: 1..100 positive message ids. */
export function parseMessageIds(value: unknown): number[] {
  if (!Array.isArray(value)) invalid('messageIds must be an array');
  if (value.length === 0) invalid('messageIds must not be empty');
  if (value.length > MAX_FORWARD_MESSAGES) {
    invalid(`messageIds must contain at most ${MAX_FORWARD_MESSAGES} ids`);
  }
  return value.map((id) => parseMessageId(id, 'messageIds'));
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

/** Search query: trimmed, 1..256 characters. */
export function parseSearchQuery(value: unknown): string {
  if (typeof value !== 'string') invalid('q is required');
  const query = value.trim();
  if (!query) invalid('q must not be empty');
  if (query.length > MAX_SEARCH_QUERY_LENGTH) {
    invalid(`q must be at most ${MAX_SEARCH_QUERY_LENGTH} characters`);
  }
  return query;
}

/**
 * Username or public link: accepts `@name`, `name`, `t.me/name`,
 * `https://t.me/name` (trailing path, query and hash are dropped).
 */
export function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string') invalid('username is required');
  let username = value.trim();
  if (!username) invalid('username must not be empty');

  username = username.replace(/^https?:\/\//i, '').replace(/^\/\//, '');
  const lower = username.toLowerCase();
  for (const host of ['t.me/', 'telegram.me/', 'telegram.dog/']) {
    if (lower.startsWith(host)) {
      username = username.slice(host.length);
      break;
    }
  }

  username = username.split(/[/?#]/)[0] ?? '';
  if (username.startsWith('@')) username = username.slice(1);
  username = username.trim();
  if (!username) invalid('username must not be empty');
  if (!USERNAME_PATTERN.test(username)) {
    invalid('username contains invalid characters');
  }
  return username;
}

/** `folderId` query parameter: a non-negative integer folder id. */
export function parseFolderId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const id = parseInteger(value, 'folderId');
  if (id < 0) invalid('folderId must not be negative');
  return id;
}

/** Optional boolean from a query string or JSON body (`true`/`false`/`1`/`0`). */
export function parseOptionalBoolean(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return invalid(`${field} must be a boolean`);
}
