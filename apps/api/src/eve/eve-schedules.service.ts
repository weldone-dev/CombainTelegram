import { Injectable } from '@nestjs/common';
import type { EveDelayedActionModel as EveDelayedActionRow } from '@repo/database';
import type { Prisma } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { eveWebhookUrl } from './eve-push.js';

/**
 * Read-only overview of everything Eve has queued or scheduled.
 *
 * Two very different clocks are shown together:
 *
 * - **static schedules** are `defineSchedule()` files compiled into the Eve
 *   agent. `GET /eve/v1/info` lists them; `eve dev` never fires them on their
 *   cron, while `eve start` does.
 * - **delayed actions** are durable `EveDelayedAction` rows owned by Nest. The
 *   60-second tick dispatches them when `dueAt` passes, or when a state change
 *   releases a row that has `dueAt = null`.
 *
 * The endpoints stay read-only: scheduling, enqueueing and dispatching are
 * owned by the Eve channel and `EveDelayedService`.
 */

export const EVE_INFO_TIMEOUT_MS = 4_000;
export const DELAYED_OVERVIEW_LIMIT = 100;
export const DELAYED_OVERVIEW_MAX_LIMIT = 200;
export const DELAYED_STATES = ['pending', 'sent', 'failed', 'dropped'] as const;
const DEFAULT_STATES = ['pending'] as const;
const PREVIEW_CHARS = 200;

export interface EveStaticScheduleView {
  name: string;
  cron: string;
  path: string;
  hasRun: boolean;
  timezone: string | null;
}

/** A runtime schedule collection, when the running Eve exposes one. */
export interface EveDynamicScheduleView {
  name: string;
  cron: string | null;
  path: string;
  creator: string | null;
}

export interface EveDelayedActionSummary {
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
  /** First characters of `incoming`/`text`; never the whole payload. */
  preview: string;
}

export interface EveSchedulesCounts {
  pending: number;
  overdue: number;
  failed: number;
  dropped: number;
}

export interface EveSchedulesOverview {
  static: EveStaticScheduleView[];
  dynamic: EveDynamicScheduleView[];
  delayed: EveDelayedActionSummary[];
  counts: EveSchedulesCounts;
  /** Present when `GET /eve/v1/info` failed; schedules are then empty. */
  infoError?: string;
}

export interface EveSchedulesQuery {
  personaId?: string;
  accountId?: string;
  chatId?: string;
  /** Comma-separated states; defaults to `pending`. */
  states?: string;
  limit?: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parsePayload(value: string): Record<string, unknown> {
  try {
    return record(JSON.parse(value));
  } catch {
    return {};
  }
}

/**
 * Short human preview of the frozen payload. Delayed turns carry `incoming`
 * (and sometimes a `burst`); delayed sends/edits carry `text`; reactions carry
 * an emoji. Everything else falls back to the kind, so the row is never blank.
 */
export function delayedPreview(row: {
  kind: string;
  payload: string;
}): string {
  const payload = parsePayload(row.payload);
  const incoming = text(payload.incoming);
  const body = text(payload.text);
  const emoji = text(payload.emoji);
  const burst = Array.isArray(payload.burst)
    ? payload.burst.map((entry) => text(record(entry).text)).filter(Boolean)
    : [];
  const message = incoming || body || burst[burst.length - 1] || emoji;
  return (message || row.kind).slice(0, PREVIEW_CHARS);
}

/** Keeps only supported states; unknown values are ignored. */
export function parseStates(raw: string | undefined): string[] {
  const requested = text(raw)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (requested.length === 0) return [...DEFAULT_STATES];
  const allowed = new Set<string>(DELAYED_STATES);
  const states = requested.filter((state) => allowed.has(state));
  return states.length > 0 ? [...new Set(states)] : [...DEFAULT_STATES];
}

export function parseLimit(raw: string | undefined): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DELAYED_OVERVIEW_LIMIT;
  return Math.min(
    DELAYED_OVERVIEW_MAX_LIMIT,
    Math.max(1, Math.trunc(parsed)),
  );
}

/** Parses a Telegram chat id without losing precision; invalid ids are ignored. */
export function parseChatId(raw: string | undefined): bigint | null {
  const value = text(raw);
  if (!/^-?\d+$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Where `GET /eve/v1/info` lives, derived from the same host as pushes. */
export function eveInfoUrl(): string | null {
  const webhook = eveWebhookUrl();
  if (!webhook) return null;
  try {
    return new URL('/eve/v1/info', webhook).toString();
  } catch {
    return null;
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function scheduleOf(value: unknown): EveStaticScheduleView | null {
  const row = record(value);
  const name = readString(row.name);
  if (!name) return null;
  return {
    name,
    cron: readString(row.cron),
    path: readString(row.logicalPath),
    hasRun: row.hasRun === true,
    timezone: readString(row.timezone) || null,
  };
}

function collectionOf(value: unknown): EveDynamicScheduleView | null {
  const row = record(value);
  const name = readString(row.name);
  if (!name) return null;
  return {
    name,
    cron: readString(row.cron) || null,
    path: readString(row.logicalPath),
    creator:
      readString(row.application) ||
      readString(row.creator) ||
      readString(record(row.owner).kind) ||
      null,
  };
}

/**
 * Splits the info payload into static and dynamic schedules.
 *
 * Eve 1.5 lists only compiled static schedules under `schedules`; runtime
 * collections are not part of the public info document. The `scheduleCollections`
 * key is read when a future Eve exposes it, and schedules flagged `dynamic` are
 * moved out of the static list.
 */
export function splitSchedules(info: unknown): {
  static: EveStaticScheduleView[];
  dynamic: EveDynamicScheduleView[];
} {
  const payload = record(info);
  const staticSchedules: EveStaticScheduleView[] = [];
  const dynamicSchedules: EveDynamicScheduleView[] = [];

  for (const value of Array.isArray(payload.schedules) ? payload.schedules : []) {
    const row = record(value);
    if (row.dynamic === true || readString(record(row.owner).kind) === 'dynamic') {
      const dynamic = collectionOf(row);
      if (dynamic) dynamicSchedules.push(dynamic);
      continue;
    }
    const schedule = scheduleOf(row);
    if (schedule) staticSchedules.push(schedule);
  }

  const collections = Array.isArray(payload.scheduleCollections)
    ? payload.scheduleCollections
    : [];
  for (const value of collections) {
    const dynamic = collectionOf(value);
    if (dynamic) dynamicSchedules.push(dynamic);
  }

  return { static: staticSchedules, dynamic: dynamicSchedules };
}

function toSummary(row: EveDelayedActionRow): EveDelayedActionSummary {
  return {
    id: row.id,
    personaId: row.personaId,
    accountId: row.accountId,
    chatId: row.chatId.toString(),
    threadId: row.threadId,
    kind: row.kind,
    reason: row.reason,
    state: row.state,
    dueAt: row.dueAt ? row.dueAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    attempts: row.attempts,
    lastError: row.lastError,
    preview: delayedPreview({ kind: row.kind, payload: row.payload }),
  };
}

@Injectable()
export class EveSchedulesService {
  constructor(private readonly prisma: PrismaService) {}

  /** `GET /internal/eve/schedules` — schedules plus the deferred queue. */
  async overview(query: EveSchedulesQuery): Promise<EveSchedulesOverview> {
    const personaId = text(query.personaId);
    const accountId = text(query.accountId);
    const chatId = parseChatId(query.chatId);
    const states = parseStates(query.states);
    const limit = parseLimit(query.limit);

    const where: Prisma.EveDelayedActionWhereInput = {
      ...(personaId ? { personaId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(chatId !== null ? { chatId } : {}),
    };
    const now = new Date();

    const [infoResult, rows, grouped, overdue] = await Promise.all([
      this.fetchInfo(),
      this.prisma.eveDelayedAction.findMany({
        where: { ...where, state: { in: states } },
        // `nulls: 'last'` keeps rows waiting for a state change at the bottom
        // instead of treating "no clock" as the most urgent work.
        orderBy: [
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
          { id: 'asc' },
        ],
        take: limit,
      }),
      this.prisma.eveDelayedAction.groupBy({
        by: ['state'],
        where,
        _count: { _all: true },
      }),
      this.prisma.eveDelayedAction.count({
        where: { ...where, state: 'pending', dueAt: { lt: now } },
      }),
    ]);

    const byState = new Map(
      grouped.map((entry) => [entry.state, entry._count._all]),
    );

    return {
      static: infoResult.static,
      dynamic: infoResult.dynamic,
      delayed: rows.map(toSummary),
      counts: {
        pending: byState.get('pending') ?? 0,
        overdue,
        failed: byState.get('failed') ?? 0,
        dropped: byState.get('dropped') ?? 0,
      },
      ...(infoResult.infoError ? { infoError: infoResult.infoError } : {}),
    };
  }

  /**
   * Reads the running Eve process. A stopped `eve dev` is normal, so a failed
   * request becomes an `infoError` and an empty schedule list, never a 5xx.
   */
  private async fetchInfo(): Promise<{
    static: EveStaticScheduleView[];
    dynamic: EveDynamicScheduleView[];
    infoError?: string;
  }> {
    const url = eveInfoUrl();
    if (!url) {
      return {
        static: [],
        dynamic: [],
        infoError: 'Eve не настроен (EVE_WEBHOOK_URL/EVE_TOKEN пусты)',
      };
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(EVE_INFO_TIMEOUT_MS),
        cache: 'no-store',
      });
      if (!response.ok) {
        return {
          static: [],
          dynamic: [],
          infoError: `Eve /eve/v1/info ответил HTTP ${response.status}`,
        };
      }
      const parsed = splitSchedules(await response.json());
      return { static: parsed.static, dynamic: parsed.dynamic };
    } catch (error) {
      const message = (error as Error).message || 'unknown error';
      return {
        static: [],
        dynamic: [],
        infoError: `Eve недоступен: ${message}`,
      };
    }
  }
}
