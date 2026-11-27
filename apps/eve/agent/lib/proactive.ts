/**
 * Nest internal tick calls used by the Eve schedules.
 *
 * The schedules are pure heartbeat clients: they never start a model turn and
 * never touch Telegram. Nest owns the agenda, the daily-life cache and the
 * presence state; Eve only asks it to run one tick.
 */

export interface TickCallOptions {
  /** Default 15 s; a tick is cheap and must not pile up. */
  timeoutMs?: number;
  /** Injectable fetch for tests. Defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export interface TickCallResult {
  ok: boolean;
  /** 0 when the request never reached Nest (network error/timeout). */
  status: number;
  /** The route is not implemented yet (404/405/501); callers treat it as a no-op. */
  skipped: boolean;
  body?: unknown;
  error?: string;
}

export const DEFAULT_TICK_TIMEOUT_MS = 15_000;

export function nestBase(): string {
  return (process.env.EVE_NEST_URL ?? 'http://127.0.0.1:4001').replace(
    /\/+$/,
    '',
  );
}

export function eveToken(): string {
  return process.env.EVE_TOKEN ?? '';
}

function isMissingRoute(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

/**
 * POSTs one `/internal/eve/*` tick. Never throws: a failed heartbeat must not
 * fail the cron run, and a missing route is an explicit no-op so the schedule
 * can ship before the Nest endpoint does.
 */
export async function postNestTick(
  path: string,
  options: TickCallOptions = {},
): Promise<TickCallResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TICK_TIMEOUT_MS;
  try {
    const response = await doFetch(
      `${nestBase()}/internal/eve${path.startsWith('/') ? path : `/${path}`}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-token': eveToken(),
        },
        body: '{}',
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return {
      ok: response.ok,
      status: response.status,
      skipped: isMissingRoute(response.status),
      body,
      ...(response.ok
        ? {}
        : { error: `HTTP ${response.status}` }),
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      skipped: false,
      error: (error as Error).message,
    };
  }
}

/** Nest `POST /internal/eve/proactive/tick`: agenda + autonomous top-up. */
export function proactiveTick(
  options?: TickCallOptions,
): Promise<TickCallResult> {
  return postNestTick('/proactive/tick', options);
}

/**
 * Nest `POST /internal/eve/presence/tick`. Not implemented in T9; the schedule
 * is wired already and becomes a no-op while Nest answers 404/405/501.
 */
export function presenceTick(
  options?: TickCallOptions,
): Promise<TickCallResult> {
  return postNestTick('/presence/tick', options);
}
