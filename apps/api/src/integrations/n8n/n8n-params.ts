import { apiError } from '../../common/api-error.js';
import { parseChatId, parseMessageId } from '../../messaging/params.js';

/** Telegram's own message length limit; one outbound part never exceeds it. */
export const MAX_PART_CHARS = 4096;
/** Safety valve: one `send-text` call never becomes an unbounded burst. */
export const MAX_PARTS = 20;

function invalid(message: string): never {
  throw apiError('VALIDATION_ERROR', message);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Request body of an action, or an empty object when it is missing. */
export function bodyOf(value: unknown): Record<string, unknown> {
  return asRecord(value);
}

/** Required non-empty string, trimmed and capped. */
export function requireText(
  value: unknown,
  field: string,
  max = 4000,
): string {
  if (typeof value !== 'string') invalid(`${field} is required`);
  const text = value.trim();
  if (!text) invalid(`${field} must not be empty`);
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/** Optional string: absent/blank stays `undefined`. */
export function optionalText(value: unknown, field: string, max = 400): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid(`${field} must be a string`);
  const text = value.trim();
  if (!text) return undefined;
  return [...text].length > max ? [...text].slice(0, max).join('') : text;
}

/** Required Telegram chat id (positive users/groups, negative channels). */
export function requireChatId(value: unknown): number {
  return parseChatId(value);
}

/** `0`/absent = whole chat, positive = forum topic / comment thread. */
export function optionalThreadId(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    invalid('threadId must be a non-negative integer');
  }
  return parsed;
}

/** Positive message id, or `undefined` when absent. */
export function optionalMessageId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseMessageId(value);
}

/** Optional chat id (channels are negative), or `null` when absent. */
export function optionalChatId(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  return parseChatId(value);
}

/** Positive message id, or `null` when absent (for nullable API fields). */
export function optionalMessageIdOrNull(value: unknown): number | null {
  return optionalMessageId(value) ?? null;
}

/** Integer clamped into `[min, max]`; absent returns `undefined`. */
export function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) invalid(`${field} must be an integer`);
  return Math.min(max, Math.max(min, parsed));
}

/** Boolean flag that also accepts `"1"`, `"true"`, `"yes"` and `"on"`. */
export function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  }
  invalid(`${field} must be a boolean`);
}

/** Required boolean flag (`true`/`false`, also `1`/`0`, `"1"`/`"0"`). */
export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  invalid(`${field} must be a boolean`);
}

/** `status` of the typing action: `typing` starts, `cancel` stops it. */
export function requireTypingStatus(value: unknown): 'typing' | 'cancel' {
  if (value === 'typing' || value === 'cancel') return value;
  invalid('status must be typing or cancel');
}

/** Upper bound for `GET /events` long polls, milliseconds. */
export const MAX_WAIT_MS = 25_000;

/** `wait` query parameter in seconds (0–25), as milliseconds. */
export function waitMs(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    invalid('wait must be a non-negative number of seconds');
  }
  return Math.min(MAX_WAIT_MS, Math.round(parsed * 1000));
}

/** Truncates by code points so an emoji is never split in half. */
function capChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/**
 * Explicit `parts` of a `send-text` call: ready bubbles, each at most 4096
 * characters. Absent/`null` returns `undefined` so the caller can fall back to
 * splitting `text`. Empty entries are dropped; an array without text is a
 * validation error.
 */
export function outgoingParts(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) invalid('parts must be an array of strings');
  const parts: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') invalid('parts must be an array of strings');
    const trimmed = item.trim();
    if (!trimmed) continue;
    if ([...trimmed].length > MAX_PART_CHARS) {
      invalid(`each part must be at most ${MAX_PART_CHARS} characters`);
    }
    parts.push(trimmed);
  }
  if (parts.length === 0) {
    invalid('parts must contain at least one non-empty message');
  }
  if (parts.length > MAX_PARTS) {
    invalid(`parts must contain at most ${MAX_PARTS} messages`);
  }
  return parts;
}

/**
 * Splits an outbound text into Telegram-sized parts.
 *
 * A line that is exactly `---` separates two messages (the same marker the
 * autopilot uses for its bubbles); every resulting block is additionally cut
 * into chunks of at most {@link MAX_PART_CHARS} characters, so a workflow can
 * forward a long text without knowing Telegram's limit.
 */
export function splitOutgoingText(raw: string): string[] {
  const normalized = raw.replace(/\r\n?/g, '\n');
  const blocks = normalized
    .split(/^[ \t]*---[ \t]*$/m)
    .map((block) => block.trim())
    .filter(Boolean);
  const parts: string[] = [];
  for (const block of blocks) {
    let rest = block;
    while (rest) {
      const chars = [...rest];
      if (chars.length <= MAX_PART_CHARS) {
        parts.push(rest);
        break;
      }
      const head = chars.slice(0, MAX_PART_CHARS).join('');
      parts.push(head.trimEnd());
      rest = chars.slice(MAX_PART_CHARS).join('').trimStart();
    }
  }
  if (parts.length === 0) {
    invalid('text must contain at least one non-empty message');
  }
  if (parts.length > MAX_PARTS) {
    invalid(`text must produce at most ${MAX_PARTS} messages`);
  }
  return parts.map((part) => capChars(part, MAX_PART_CHARS));
}
