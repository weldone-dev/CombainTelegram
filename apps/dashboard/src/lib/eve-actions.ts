import { eveFetch } from "./eve-api";

/**
 * Client for the durable deferred-action queue (`GET /internal/eve/actions`).
 *
 * A delayed turn is not a model call yet: the channel decides "reply in 3 min",
 * Nest stores the row and re-enters Eve when `dueAt` passes. Until then nothing
 * appears in the context snapshots, which is why the context page renders this
 * queue separately.
 */

export interface EveDelayedActionView {
  id: string;
  personaId: string;
  accountId: string;
  /** Telegram ids exceed 2^53, so Nest serialises this as a string. */
  chatId: string;
  threadId: number;
  /** turn | send | edit | delete | react | read */
  kind: string;
  /** delay | sleep | busy | offline | followup */
  reason: string;
  key: string | null;
  /** Frozen event payload: incoming/burst/behavior/hint/… */
  payload: Record<string, unknown>;
  /** ISO timestamp; `null` = waiting for a state change, not for the clock. */
  dueAt: string | null;
  state: string;
  attempts: number;
  lastError: string | null;
  firedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EveDelayedActionQuery {
  personaId?: string;
  accountId?: string;
  /** Filter by chat; Nest parses it into the BigInt column. */
  chatId?: string;
  threadId?: number;
  /** turn | send | edit | delete | react | read */
  kind?: string;
  state?: string;
  limit?: number;
}

/** `POST /internal/eve/actions/:id/fire`. */
export interface EveDelayedFireResult {
  ok: boolean;
  /** `not-pending`, `in-flight`, `retried`… when `ok` is false. */
  reason: string | null;
  outcome: string | null;
  action: EveDelayedActionView | null;
}

/** `POST /internal/eve/actions/fire` for one chat. */
export interface EveFireChatResult {
  fired: number;
  results: Array<{
    id: string;
    ok: boolean;
    outcome: string | null;
    reason: string | null;
  }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asIso(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Drops rows that cannot be rendered instead of failing the whole list. */
export function normalizeDelayedAction(
  value: unknown,
): EveDelayedActionView | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;

  const chatId = asFiniteNumber(value.chatId);
  const threadId = asFiniteNumber(value.threadId);
  const attempts = asFiniteNumber(value.attempts);

  return {
    id,
    personaId: asString(value.personaId),
    accountId: asString(value.accountId),
    chatId:
      typeof value.chatId === "string" && value.chatId.trim()
        ? value.chatId
        : chatId !== undefined
          ? String(chatId)
          : "",
    threadId: threadId !== undefined ? Math.trunc(threadId) : 0,
    kind: asString(value.kind),
    reason: asString(value.reason),
    key: typeof value.key === "string" ? value.key : null,
    payload: isRecord(value.payload) ? value.payload : {},
    dueAt: asIso(value.dueAt),
    state: asString(value.state, "pending"),
    attempts: attempts !== undefined ? Math.max(0, Math.trunc(attempts)) : 0,
    lastError: asIso(value.lastError),
    firedAt: asIso(value.firedAt),
    createdAt: asString(value.createdAt),
    updatedAt: asString(value.updatedAt),
  };
}

/** `GET /internal/eve/actions` — queue rows in creation order. */
export async function listDelayedActions(
  query: EveDelayedActionQuery = {},
): Promise<EveDelayedActionView[]> {
  const params = new URLSearchParams();
  if (query.personaId) params.set("personaId", query.personaId);
  if (query.accountId) params.set("accountId", query.accountId);
  if (query.chatId) params.set("chatId", query.chatId);
  if (query.threadId !== undefined) {
    params.set("threadId", String(query.threadId));
  }
  if (query.kind) params.set("kind", query.kind);
  if (query.state) params.set("state", query.state);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";

  const data = await eveFetch<unknown>(`actions${suffix}`);
  const rows = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.actions)
      ? data.actions
      : [];

  return rows
    .map((row) => normalizeDelayedAction(row))
    .filter((row): row is EveDelayedActionView => row !== null);
}

/**
 * `POST /internal/eve/actions/:id/fire` — deliver one queued row now. Nest
 * refuses a row that is no longer pending instead of sending it twice.
 */
export async function fireDelayedAction(
  id: string,
): Promise<EveDelayedFireResult> {
  const data = await eveFetch<unknown>(
    `actions/${encodeURIComponent(id)}/fire`,
    { method: "POST", body: {} },
  );
  const payload = isRecord(data) ? data : {};
  return {
    ok: payload.ok === true,
    reason: typeof payload.reason === "string" ? payload.reason : null,
    outcome: typeof payload.outcome === "string" ? payload.outcome : null,
    action: normalizeDelayedAction(payload.action),
  };
}

/**
 * `POST /internal/eve/actions/fire` — every pending turn of one chat goes out
 * now, in order. `threadId` limits the call to one topic.
 */
export async function fireChatDelayedTurns(query: {
  personaId: string;
  accountId: string;
  chatId: string;
  threadId?: number;
}): Promise<EveFireChatResult> {
  const data = await eveFetch<unknown>("actions/fire", {
    method: "POST",
    body: {
      personaId: query.personaId,
      accountId: query.accountId,
      chatId: query.chatId,
      threadId: query.threadId ?? 0,
    },
  });
  const payload = isRecord(data) ? data : {};
  const results = Array.isArray(payload.results)
    ? payload.results.filter(isRecord).map((row) => ({
        id: asString(row.id),
        ok: row.ok === true,
        outcome: typeof row.outcome === "string" ? row.outcome : null,
        reason: typeof row.reason === "string" ? row.reason : null,
      }))
    : [];
  return {
    fired: asFiniteNumber(payload.fired) ?? 0,
    results,
  };
}
