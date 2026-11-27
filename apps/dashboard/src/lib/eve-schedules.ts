import { eveFetch } from "./eve-api";

/**
 * Client for `GET /internal/eve/schedules` (through the dashboard proxy).
 *
 * The response joins two sources the dashboard cannot see anywhere else:
 * compiled Eve schedules (`eve/v1/info`) and Nest's durable delayed-action
 * queue. Normalisation is defensive: one malformed row must not blank the
 * whole page.
 */

export interface EveStaticSchedule {
  name: string;
  cron: string;
  path: string;
  hasRun: boolean;
  timezone: string | null;
}

export interface EveDynamicSchedule {
  name: string;
  cron: string | null;
  path: string;
  creator: string | null;
}

export interface EveScheduleDelayedAction {
  id: string;
  personaId: string;
  accountId: string;
  chatId: string;
  threadId: number;
  kind: string;
  reason: string;
  state: string;
  dueAt: string | null;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  preview: string;
}

export interface EveSchedulesCounts {
  pending: number;
  overdue: number;
  failed: number;
  dropped: number;
}

export interface EveSchedulesOverview {
  static: EveStaticSchedule[];
  dynamic: EveDynamicSchedule[];
  delayed: EveScheduleDelayedAction[];
  counts: EveSchedulesCounts;
  infoError?: string;
}

export interface EveSchedulesQuery {
  personaId?: string;
  accountId?: string;
  chatId?: string;
  /** Comma-separated states; Nest defaults to `pending`. */
  states?: string;
  limit?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function asCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }
  return 0;
}

function normalizeStatic(value: unknown): EveStaticSchedule | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  if (!name) return null;
  return {
    name,
    cron: asString(value.cron),
    path: asString(value.path),
    hasRun: value.hasRun === true,
    timezone: asNullableString(value.timezone),
  };
}

function normalizeDynamic(value: unknown): EveDynamicSchedule | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  if (!name) return null;
  return {
    name,
    cron: asNullableString(value.cron),
    path: asString(value.path),
    creator: asNullableString(value.creator),
  };
}

function normalizeDelayed(
  value: unknown,
): EveScheduleDelayedAction | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;
  return {
    id,
    personaId: asString(value.personaId),
    accountId: asString(value.accountId),
    chatId:
      typeof value.chatId === "string"
        ? value.chatId
        : typeof value.chatId === "number" && Number.isFinite(value.chatId)
          ? String(value.chatId)
          : "",
    threadId: asCount(value.threadId),
    kind: asString(value.kind),
    reason: asString(value.reason),
    state: asString(value.state, "pending"),
    dueAt: asNullableString(value.dueAt),
    createdAt: asString(value.createdAt),
    attempts: asCount(value.attempts),
    lastError: asNullableString(value.lastError),
    preview: asString(value.preview),
  };
}

export function normalizeSchedulesOverview(
  value: unknown,
): EveSchedulesOverview {
  const payload = isRecord(value) ? value : {};
  const counts = isRecord(payload.counts) ? payload.counts : {};
  return {
    static: (Array.isArray(payload.static) ? payload.static : [])
      .map(normalizeStatic)
      .filter((row): row is EveStaticSchedule => row !== null),
    dynamic: (Array.isArray(payload.dynamic) ? payload.dynamic : [])
      .map(normalizeDynamic)
      .filter((row): row is EveDynamicSchedule => row !== null),
    delayed: (Array.isArray(payload.delayed) ? payload.delayed : [])
      .map(normalizeDelayed)
      .filter((row): row is EveScheduleDelayedAction => row !== null),
    counts: {
      pending: asCount(counts.pending),
      overdue: asCount(counts.overdue),
      failed: asCount(counts.failed),
      dropped: asCount(counts.dropped),
    },
    ...(asNullableString(payload.infoError)
      ? { infoError: asString(payload.infoError) }
      : {}),
  };
}

export async function getSchedulesOverview(
  query: EveSchedulesQuery = {},
): Promise<EveSchedulesOverview> {
  const params = new URLSearchParams();
  if (query.personaId) params.set("personaId", query.personaId);
  if (query.accountId) params.set("accountId", query.accountId);
  if (query.chatId) params.set("chatId", query.chatId);
  if (query.states) params.set("states", query.states);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  const suffix = params.size > 0 ? `?${params.toString()}` : "";

  return normalizeSchedulesOverview(await eveFetch<unknown>(`schedules${suffix}`));
}
