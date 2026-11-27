import { apiError } from '../common/api-error.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_TEXT_LENGTH = 4096;
/** Longest reply quote the API keeps; longer excerpts are clamped. */
const MAX_QUOTE_LENGTH = 200;
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

/** `limit` query parameter: default 50, clamped to [1, max] (default 200). */
export function parseLimit(value: unknown, max = MAX_LIMIT): number {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_LIMIT;
  }
  const limit = parseInteger(value, 'limit');
  if (limit <= 0) invalid('limit must be a positive integer');
  return Math.min(limit, max);
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

/** Optional media caption: trimmed, at most 4096 characters. */
export function parseOptionalCaption(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid('caption must be a string');
  const caption = value.trim();
  if (!caption) return undefined;
  if (caption.length > MAX_TEXT_LENGTH) {
    invalid(`caption must be at most ${MAX_TEXT_LENGTH} characters`);
  }
  return caption;
}

/**
 * Optional reply quote: a short excerpt of the replied message. Trimmed and
 * clamped to 200 characters; empty means "reply without a quote".
 */
export function parseOptionalQuote(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid('quote must be a string');
  const quote = value.trim();
  if (!quote) return undefined;
  return Array.from(quote).slice(0, MAX_QUOTE_LENGTH).join('');
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

/** Explicit typing mode of one outgoing message. */
export type TypingSendOption = 'auto' | 'off' | number;

/**
 * `typing` of a send: `auto` applies the persona's typing policy, `off` sends
 * instantly, and a number is an explicit simulation in milliseconds. A missing
 * value keeps the historical behaviour (no typing at all).
 */
export function parseTypingSendOption(
  value: unknown,
): TypingSendOption | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'auto' || value === 'off') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('typing must be auto, off or ms');
    return Math.min(60_000, Math.max(0, Math.round(value)));
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Math.min(60_000, Number.parseInt(value.trim(), 10));
  }
  return invalid('typing must be auto, off or milliseconds');
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

/**
 * `DELETE /chats/:id` options. Both default to `false`: a bare delete only
 * removes the chat for this account, and `revoke=true` is the explicit
 * "delete for everyone".
 */
export function parseDeleteOptions(
  query: { revoke?: unknown; clearHistory?: unknown } = {},
): { revoke: boolean; clearHistory: boolean } {
  return {
    revoke: parseOptionalBoolean(query.revoke, 'revoke') ?? false,
    clearHistory:
      parseOptionalBoolean(query.clearHistory, 'clearHistory') ?? false,
  };
}

/**
 * `DELETE .../messages/:messageId` options. `revoke` defaults to `true`, so a
 * bare delete removes the message for everyone. `revoke=false` is still
 * accepted for compatibility (delete only this account's copy).
 */
export function parseDeleteMessageOptions(
  query: { revoke?: unknown } = {},
): { revoke: boolean } {
  return { revoke: parseOptionalBoolean(query.revoke, 'revoke') ?? true };
}

export type ChatInfoKind = 'media' | 'links' | 'polls';

/** `thumb=1|true` on the media endpoint: serve a small preview thumbnail. */
export function parseThumbFlag(value: unknown): boolean {
  return parseOptionalBoolean(value, 'thumb') === true;
}

/**
 * Reaction emoji of `POST .../reaction`: an emoji string, or `null`/empty to
 * remove the current reaction.
 */
export function parseReactionEmoji(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid('emoji must be a string or null');
  const emoji = value.trim();
  if (!emoji) return null;
  // Custom emoji can be long surrogate pairs, but an unbounded string would
  // end up in the TL payload; 64 code units is far above any real emoji.
  if (emoji.length > 64) invalid('emoji must be at most 64 characters');
  return emoji;
}

/** Vote payload: `null` retracts the vote, otherwise answer indexes. */
export function parsePollOptions(value: unknown): number[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) invalid('options must be an array or null');
  if (value.length > 100) invalid('options must contain at most 100 answers');
  const options = value.map((option) => {
    const index = parseInteger(option, 'options');
    if (index < 0) invalid('options must be non-negative answer indexes');
    return index;
  });
  return options;
}

/** Target language of a translation: a two-letter ISO 639-1 code (`ru`). */
export function parseTranslateLanguage(value: unknown): string {
  if (value === undefined || value === null || value === '') return 'ru';
  if (typeof value !== 'string' || !/^[a-zA-Z]{2}$/.test(value.trim())) {
    invalid('to must be a two-letter language code');
  }
  return value.trim().toLowerCase();
}

const CHAT_INFO_KINDS: ChatInfoKind[] = ['media', 'links', 'polls'];

/**
 * `kind` of the chat-info tabs. An unknown/missing value is a clear
 * `VALIDATION_ERROR` instead of silently falling back to `media`.
 */
export function parseChatInfoKind(value: unknown): ChatInfoKind {
  if (
    typeof value === 'string' &&
    (CHAT_INFO_KINDS as string[]).includes(value)
  ) {
    return value as ChatInfoKind;
  }
  throw apiError(
    'VALIDATION_ERROR',
    'kind must be one of media, links, polls',
    400,
    { details: { allowed: CHAT_INFO_KINDS } },
  );
}

const URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/i;

/**
 * First URL in a message text, without trailing punctuation. Used by the
 * `links` tab, where Telegram's URL filter guarantees there is at least one
 * link but the text may still be prose around it.
 */
export function extractFirstUrl(text: string): string | null {
  if (typeof text !== 'string') return null;
  const match = URL_PATTERN.exec(text);
  if (!match) return null;
  let url = match[0].replace(/[.,;:!?…]+$/, '');
  // Prose often wraps a link in parentheses: "(see https://t.me/x)".
  while (
    url.endsWith(')') &&
    (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)
  ) {
    url = url.slice(0, -1).replace(/[.,;:!?…]+$/, '');
  }
  return url || null;
}
