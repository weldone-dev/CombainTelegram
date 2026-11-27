import { safeJson } from './eve-access.js';

/** Where a local Eve process listens for Nest pushes by default. */
export const DEFAULT_EVE_WEBHOOK_URL =
  'http://127.0.0.1:4020/eve/v1/nest/events';

/** Where a local Eve process accepts a deferred turn (durable delayed reply). */
export const DEFAULT_EVE_TURN_URL = 'http://127.0.0.1:4020/eve/v1/nest/turn';

export const EVE_PUSH_ATTEMPTS = 3;
export const EVE_PUSH_TIMEOUT_MS = 10_000;
export const EVE_PUSH_BACKOFF_MS = [250, 1000, 3000] as const;

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test((value ?? '').trim());
}

/**
 * Resolves the push target.
 *
 * - `EVE_WEBHOOK_URL` wins when it is defined; an empty value disables push.
 * - With the variable unset, the default local URL is used only when Eve is
 *   configured at all (`EVE_ENABLED` truthy or a non-empty `EVE_TOKEN`).
 */
export function eveWebhookUrl(): string | null {
  const explicit = process.env.EVE_WEBHOOK_URL;
  if (explicit !== undefined) return explicit.trim() || null;
  const configured =
    flag(process.env.EVE_ENABLED) ||
    (process.env.EVE_TOKEN ?? '').trim().length > 0;
  return configured ? DEFAULT_EVE_WEBHOOK_URL : null;
}

/**
 * Resolves the deferred-turn target.
 *
 * - `EVE_TURN_URL` wins when it is defined; an empty value disables turns.
 * - Otherwise a configured Eve process gets the default local URL, matching
 *   `eveWebhookUrl()`.
 */
export function eveTurnUrl(): string | null {
  const explicit = process.env.EVE_TURN_URL;
  if (explicit !== undefined) return explicit.trim() || null;
  return eveWebhookUrl() === null ? null : DEFAULT_EVE_TURN_URL;
}

export interface EvePushOptions {
  token?: string;
  attempts?: number;
  timeoutMs?: number;
  delaysMs?: readonly number[];
  fetchImpl?: typeof fetch;
}

export interface EvePushResult {
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
}

/**
 * POSTs one event to Eve. Retries are deliberately simple (3 attempts,
 * 250/1000/3000 ms) because this is a loopback call; the durable cursor
 * endpoint is the real recovery path when all attempts fail.
 */
export async function pushEveEvent(
  url: string,
  event: unknown,
  options: EvePushOptions = {},
): Promise<EvePushResult> {
  const attempts = options.attempts ?? EVE_PUSH_ATTEMPTS;
  const timeoutMs = options.timeoutMs ?? EVE_PUSH_TIMEOUT_MS;
  const delays = options.delaysMs ?? EVE_PUSH_BACKOFF_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (options.token) headers['x-eve-token'] = options.token;
  const body = safeJson(event);

  let result: EvePushResult = { ok: false, attempts: 0 };
  for (let attempt = 0; attempt < attempts; attempt++) {
    result = { ok: false, attempts: attempt + 1 };
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.ok) {
        return { ok: true, attempts: attempt + 1, status: response.status };
      }
      result.status = response.status;
      result.error = `HTTP ${response.status}`;
    } catch (error) {
      result.error = (error as Error).message;
    }
    await sleep(delays[attempt] ?? 0);
  }
  return result;
}
