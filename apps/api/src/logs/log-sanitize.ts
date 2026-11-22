const REDACTED = "[redacted]";
const MAX_STRING = 2000;
const MAX_ITEMS = 50;
const MAX_DEPTH = 5;

const SECRET_EXACT =
  /^(code|phone|phone_number|password|passcode|secret|token|api[_-]?hash|cipher|nonce|dekwrapped|deknonce|dektag|dek)$/i;
const SECRET_PART =
  /pass(word)?|secret|token|passcode|api[_-]?hash|session[_-]?string/i;

/**
 * JSON-safe, size-bounded copy of arbitrary metadata. Values under sensitive
 * keys (passwords, codes, tokens, session keys, phone numbers) are replaced,
 * so logs can be shown in a browser and read by agents without leaking them.
 */
export function sanitizeDetails(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }
  if (depth >= MAX_DEPTH) return "[truncated]";
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ITEMS)
      .map((item) => sanitizeDetails(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] =
        SECRET_EXACT.test(key) || SECRET_PART.test(key)
          ? REDACTED
          : sanitizeDetails(item, depth + 1);
    }
    return result;
  }
  return String(value);
}

/** Search queries are useful for debugging but are stored truncated. */
export const MAX_QUERY_LENGTH = 64;

const MESSAGE_BODY_KEYS = ["text", "caption"] as const;

function cloneSanitizedObject(
  original: unknown,
  sanitized: unknown,
): Record<string, unknown> | null {
  if (!original || typeof original !== "object" || Array.isArray(original)) {
    return null;
  }
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return null;
  }
  return { ...(sanitized as Record<string, unknown>) };
}

/**
 * Request bodies may carry message text/captions. Those are not stored: the
 * log keeps only the length, so `/logs` can be shared with an agent without
 * leaking private conversations.
 */
export function redactMessageBody(body: unknown): unknown {
  const sanitized = sanitizeDetails(body);
  const copy = cloneSanitizedObject(body, sanitized);
  if (!copy) return sanitized;
  for (const key of MESSAGE_BODY_KEYS) {
    const original = (body as Record<string, unknown>)[key];
    if (typeof original === "string") {
      copy[key] = `[redacted, ${original.length} chars]`;
    }
  }
  return copy;
}

/** Truncates `q` (search text) to `MAX_QUERY_LENGTH` chars for logs. */
export function sanitizeQueryForLog(query: unknown): unknown {
  const sanitized = sanitizeDetails(query);
  const copy = cloneSanitizedObject(query, sanitized);
  if (!copy) return sanitized;
  const q = (query as Record<string, unknown>).q;
  if (typeof q === "string" && q.length > MAX_QUERY_LENGTH) {
    copy.q = `${q.slice(0, MAX_QUERY_LENGTH)}…`;
  }
  return copy;
}

/** Serializes sanitized metadata for a TEXT column. */
export function serializeJson(value: unknown): string {
  try {
    return JSON.stringify(sanitizeDetails(value) ?? {});
  } catch {
    return "{}";
  }
}

/** Parses a JSON column back, returning `null` on malformed content. */
export function parseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
