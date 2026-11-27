/**
 * Agenda: proactive pings.
 *
 * Two sources share one queue: events he mentioned (user-event) and her own
 * reasons to text first (proactive-life). The tick is deliberately conservative:
 * exactly one item per tick, a 10-minute dialog cooldown, quiet-hours and sleep
 * checks, and a reschedule instead of a send when she is offline.
 */

import {
  isHourInRange,
  localDateKey,
  localParts,
  toEpochMs,
  clampInt,
} from './time';
import { isQuietBlock } from './daily-life';
import { activeConflict } from './relationship';
import type {
  AgendaImportance,
  AgendaItem,
  ConflictState,
  DailyLife,
  InitiativeLevel,
  PersonaConfig,
  PresenceState,
  Stage,
} from './types';

export const AGENDA_TICK_MS = 60_000;
export const AUTONOMOUS_HORIZON_MS = 18 * 3_600_000;
export const AUTONOMOUS_MIN_LEAD_MS = 5 * 60_000;
export const AUTONOMOUS_MIN_GAP_MS = 45 * 60_000;
export const DIALOG_COOLDOWN_MS = 10 * 60_000;
export const PROACTIVE_RESPONSE_WINDOW_MS = 30 * 60_000;
export const AGENDA_ABOUT_MIN_LENGTH = 3;
export const AGENDA_ABOUT_MAX_LENGTH = 120;
export const AGENDA_REASON_MAX_LENGTH = 160;

const AUTONOMOUS_BASE: Record<Stage, number> = {
  'tg-given-cold': 0,
  'met-irl-got-tg': 1,
  'tg-given-warming': 1,
  convinced: 2,
  'first-date-done': 2,
  'dating-early': 3,
  'dating-stable': 4,
  'long-term': 4,
  dumped: 0,
};

/** Daily autonomous limit from the stage + initiative adjustment. */
export function maxAutonomousItems(stage: Stage, initiative: InitiativeLevel): number {
  if (stage === 'dumped') return 0;
  const base = AUTONOMOUS_BASE[stage] ?? 0;
  const adjusted = initiative === 'low' ? base - 1 : initiative === 'high' ? base + 1 : base;
  return Math.max(0, adjusted);
}

export interface AutonomousGate {
  stage: Stage;
  conflictLevel: number;
  hasDailyLife: boolean;
  initiative: InitiativeLevel;
  /** Pending items already scheduled within the 18-hour horizon. */
  pendingSoon: number;
  alreadyGeneratedToday: boolean;
}

export interface AutonomousAllowance {
  allowed: boolean;
  limit: number;
  remaining: number;
  reason?: 'dumped' | 'no-daily-life' | 'conflict' | 'already-generated' | 'limit';
}

export function canGenerateAutonomous(gate: AutonomousGate): AutonomousAllowance {
  const limit = maxAutonomousItems(gate.stage, gate.initiative);
  const remaining = Math.max(0, limit - gate.pendingSoon);
  const deny = (reason: AutonomousAllowance['reason']): AutonomousAllowance => ({
    allowed: false,
    limit,
    remaining,
    reason,
  });
  if (gate.stage === 'dumped') return deny('dumped');
  if (!gate.hasDailyLife) return deny('no-daily-life');
  if (gate.conflictLevel >= 2) return deny('conflict');
  if (gate.alreadyGeneratedToday) return deny('already-generated');
  if (remaining <= 0) return deny('limit');
  return { allowed: true, limit, remaining };
}

export function countPendingSoon(
  items: AgendaItem[],
  now: number,
  horizonMs = AUTONOMOUS_HORIZON_MS,
): number {
  return items.filter(
    (item) =>
      item.state === 'pending' && item.pingAt > now && item.pingAt <= now + horizonMs,
  ).length;
}

export function normalizePingAt(
  raw: unknown,
  now: number,
  horizonMs = AUTONOMOUS_HORIZON_MS,
  minLeadMs = AUTONOMOUS_MIN_LEAD_MS,
): number | null {
  const ms = toEpochMs(raw);
  if (ms === null) return null;
  if (ms <= now + minLeadMs) return null;
  if (ms > now + horizonMs) return null;
  return ms;
}

export function isDuringSleep(
  config: Pick<PersonaConfig, 'timezone' | 'sleepFrom' | 'sleepTo'>,
  whenMs: number,
): boolean {
  const hour = localParts(whenMs, config.timezone).hour;
  return isHourInRange(hour, config.sleepFrom ?? 23, config.sleepTo ?? 8);
}

export function isDuringUnavailableBlock(
  dailyLife: DailyLife | undefined,
  config: Pick<PersonaConfig, 'timezone'>,
  whenMs: number,
): boolean {
  if (!dailyLife) return false;
  return isQuietBlock(dailyLife, localParts(whenMs, config.timezone).hour);
}

/** Sleep or a `phoneAvailable=false` life block. */
export function isQuietTime(
  config: Pick<PersonaConfig, 'timezone' | 'sleepFrom' | 'sleepTo'>,
  dailyLife: DailyLife | undefined,
  whenMs: number,
): boolean {
  return isDuringSleep(config, whenMs) || isDuringUnavailableBlock(dailyLife, config, whenMs);
}

/**
 * First non-quiet time at or after `fromMs`, scanning in 5-minute steps up to
 * 72 hours. Used both for validation and for reschedules.
 */
export function nextAllowedTime(
  config: Pick<PersonaConfig, 'timezone' | 'sleepFrom' | 'sleepTo'>,
  dailyLife: DailyLife | undefined,
  fromMs: number,
  stepMs = 5 * 60_000,
): number {
  const start = Math.ceil(fromMs / stepMs) * stepMs;
  const limit = start + 72 * 3_600_000;
  for (let at = start; at <= limit; at += stepMs) {
    if (!isQuietTime(config, dailyLife, at)) return at;
  }
  // A 72-hour quiet period is impossible with hour-granular schedules; this is
  // only a safe fallback that still moves the item forward.
  return start + 24 * 3_600_000;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function aboutText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function isDuplicateAbout(about: string, pool: string[]): boolean {
  const needle = about.toLowerCase();
  return pool.some((existing) => {
    const hay = existing.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
}

function normalizeImportance(value: unknown): AgendaImportance {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 1;
  return clampInt(n, 1, 3) as AgendaImportance;
}

function pushHistory(item: AgendaItem, line: string): string[] {
  return [...item.history, line].slice(-30);
}

export interface AutonomousSanitizeOptions {
  now: number;
  config: PersonaConfig;
  dailyLife?: DailyLife;
  /** Existing queue, including fired/cancelled items, for duplicate checks. */
  existing?: AgendaItem[];
  /** How many new items are still allowed today. */
  limit: number;
  chatId?: string;
  horizonMs?: number;
}

export interface RejectedAgendaItem {
  about: string;
  reason:
    | 'about-too-short'
    | 'duplicate'
    | 'bad-ping-at'
    | 'quiet-hours'
    | 'too-close'
    | 'limit';
}

export interface AutonomousSanitizeResult {
  items: AgendaItem[];
  rejected: RejectedAgendaItem[];
}

/**
 * Validate LLM-proposed autonomous pings: text limits, dedupe, future window,
 * sleep/phone-unavailable blocks and the 45-minute spacing rule.
 */
export function sanitizeAutonomousItems(
  raw: unknown,
  options: AutonomousSanitizeOptions,
): AutonomousSanitizeResult {
  const record = asRecord(raw);
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(record?.items)
      ? (record.items as unknown[])
      : [];
  const existing = (options.existing ?? []).map((item) => item.about);
  const accepted: AgendaItem[] = [];
  const rejected: RejectedAgendaItem[] = [];
  const horizon = options.horizonMs ?? AUTONOMOUS_HORIZON_MS;
  const dateKey = localDateKey(options.now, options.config.timezone);

  for (const entry of list) {
    const item = asRecord(entry);
    if (!item) continue;
    const about = aboutText(item.about);
    if (about.length < AGENDA_ABOUT_MIN_LENGTH) {
      rejected.push({ about, reason: 'about-too-short' });
      continue;
    }
    if (accepted.length >= Math.max(0, options.limit)) {
      rejected.push({ about, reason: 'limit' });
      continue;
    }
    const clipped = about.slice(0, AGENDA_ABOUT_MAX_LENGTH);
    if (
      isDuplicateAbout(clipped, existing) ||
      isDuplicateAbout(
        clipped,
        accepted.map((candidate) => candidate.about),
      )
    ) {
      rejected.push({ about: clipped, reason: 'duplicate' });
      continue;
    }

    const pingAt = normalizePingAt(item.pingAt, options.now, horizon);
    if (pingAt === null) {
      rejected.push({ about: clipped, reason: 'bad-ping-at' });
      continue;
    }
    if (isQuietTime(options.config, options.dailyLife, pingAt)) {
      rejected.push({ about: clipped, reason: 'quiet-hours' });
      continue;
    }
    if (
      accepted.some(
        (candidate) => Math.abs(candidate.pingAt - pingAt) < AUTONOMOUS_MIN_GAP_MS,
      )
    ) {
      rejected.push({ about: clipped, reason: 'too-close' });
      continue;
    }

    accepted.push({
      id:
        typeof item.id === 'string' && item.id.trim()
          ? item.id.trim()
          : `auto_${options.now.toString(36)}_${accepted.length}`,
      about: clipped,
      reason:
        typeof item.reason === 'string' && item.reason.trim()
          ? item.reason.trim().slice(0, AGENDA_REASON_MAX_LENGTH)
          : 'самой захотелось написать',
      ...(toEpochMs(item.userEventTime) !== null
        ? { userEventTime: toEpochMs(item.userEventTime)! }
        : {}),
      pingAt,
      kind: 'proactive-life',
      state: 'pending',
      attempts: 0,
      history: [`autonomous:${dateKey}`],
      importance: normalizeImportance(item.importance),
      createdAt: options.now,
      ...(options.chatId ? { chatId: options.chatId } : {}),
    });
  }

  return { items: accepted, rejected };
}

/** Due pending items, oldest first; deterministic tie-break by id. */
export function dueAgendaItems(items: AgendaItem[], now: number): AgendaItem[] {
  return items
    .filter((item) => item.state === 'pending' && item.pingAt <= now)
    .sort((a, b) => a.pingAt - b.pingAt || a.id.localeCompare(b.id));
}

export function selectDueItem(items: AgendaItem[], now: number): AgendaItem | null {
  return dueAgendaItems(items, now)[0] ?? null;
}

export interface AgendaTickContext {
  now: number;
  config: PersonaConfig;
  stage: Stage;
  presence: PresenceState;
  conflict?: ConflictState | null;
  dailyLife?: DailyLife;
  /** Epoch ms of the last message in this chat (his or hers). */
  lastMessageAt?: number;
}

export type AgendaTickPlan =
  | { action: 'none'; reason: 'no-due' | 'dumped' }
  | { action: 'wait'; item: AgendaItem; reason: 'dialog-cooldown' }
  | {
      action: 'reschedule';
      item: AgendaItem;
      pingAt: number;
      reason: 'offline' | 'quiet-hours' | 'conflict';
    }
  | { action: 'fire'; item: AgendaItem };

/**
 * One tick: choose at most one item and either fire, reschedule or wait.
 * A blocked item deliberately blocks the queue until the next tick ("due[0]
 * bottleneck" is kept because it prevents a burst of stale pings).
 */
export function planAgendaTick(
  items: AgendaItem[],
  ctx: AgendaTickContext,
): AgendaTickPlan {
  if (ctx.stage === 'dumped') return { action: 'none', reason: 'dumped' };

  const item = selectDueItem(items, ctx.now);
  if (!item) return { action: 'none', reason: 'no-due' };

  const conflict = activeConflict(ctx.conflict, ctx.now);
  if (conflict.level >= 2) {
    const coldEnd = toEpochMs(ctx.conflict?.coldUntil) ?? 0;
    const afterCold = coldEnd > ctx.now ? nextAllowedTime(ctx.config, ctx.dailyLife, coldEnd) : 0;
    const waitMs = Math.max(
      afterCold ? afterCold - ctx.now : 0,
      conflict.level >= 3 ? 12 * 3_600_000 : 6 * 3_600_000,
    );
    return {
      action: 'reschedule',
      item,
      pingAt: nextAllowedTime(ctx.config, ctx.dailyLife, ctx.now + waitMs),
      reason: 'conflict',
    };
  }

  if (isQuietTime(ctx.config, ctx.dailyLife, ctx.now)) {
    return {
      action: 'reschedule',
      item,
      pingAt: nextAllowedTime(ctx.config, ctx.dailyLife, ctx.now + 5 * 60_000),
      reason: 'quiet-hours',
    };
  }

  if (!ctx.presence.online && !ctx.presence.nightAwake) {
    const delayMs = Math.max(60, ctx.presence.nextCheckSec) * 1000;
    return {
      action: 'reschedule',
      item,
      pingAt: nextAllowedTime(ctx.config, ctx.dailyLife, ctx.now + delayMs),
      reason: 'offline',
    };
  }

  if (
    typeof ctx.lastMessageAt === 'number' &&
    ctx.lastMessageAt > 0 &&
    ctx.now - ctx.lastMessageAt < DIALOG_COOLDOWN_MS
  ) {
    return { action: 'wait', item, reason: 'dialog-cooldown' };
  }

  return { action: 'fire', item };
}

export function rescheduleItem(
  item: AgendaItem,
  pingAt: number,
  note: string,
  now: number,
): AgendaItem {
  return {
    ...item,
    pingAt,
    state: 'pending',
    history: pushHistory(item, `rescheduled to ${new Date(pingAt).toISOString()}: ${note}`),
    // Keep createdAt untouched; the reschedule timestamp lives in history.
    createdAt: item.createdAt || now,
  };
}

export function markAgendaFired(item: AgendaItem, now: number): AgendaItem {
  return {
    ...item,
    state: 'fired',
    attempts: item.attempts + 1,
    history: pushHistory(item, `fired at ${new Date(now).toISOString()}`),
  };
}

export function cancelItem(item: AgendaItem, note: string, now: number): AgendaItem {
  return {
    ...item,
    state: 'cancelled',
    history: pushHistory(item, `cancelled at ${new Date(now).toISOString()}: ${note}`),
  };
}

export function cancelAllPending(items: AgendaItem[], note: string, now: number): AgendaItem[] {
  return items.map((item) =>
    item.state === 'pending' ? cancelItem(item, note, now) : item,
  );
}

export interface ConflictReconcileResult {
  items: AgendaItem[];
  cancelled: number;
  rescheduled: number;
}

/**
 * Apply a conflict level increase to pending pings:
 * - level ≥ 3 (or importance 1): cancel;
 * - level ≥ 2 and importance 2: move 12–36 hours ahead;
 * - importance 3 at level 2: leave alone.
 */
export function reconcileAfterConflict(
  items: AgendaItem[],
  conflict: ConflictState,
  previousLevel: number,
  now: number,
  rand: () => number = Math.random,
): ConflictReconcileResult {
  const level = conflict.level;
  if (level <= 0 || level <= previousLevel) {
    return { items, cancelled: 0, rescheduled: 0 };
  }

  let cancelled = 0;
  let rescheduled = 0;
  const next = items.map((item) => {
    if (item.state !== 'pending') return item;
    if (level >= 3 || item.importance === 1) {
      cancelled += 1;
      return cancelItem(item, `conflict level ${level}`, now);
    }
    if (level >= 2 && item.importance === 2) {
      const pingAt = now + (12 + rand() * 24) * 3_600_000;
      rescheduled += 1;
      return rescheduleItem(item, pingAt, `conflict level ${level}`, now);
    }
    return item;
  });

  return { items: next, cancelled, rescheduled };
}

export type ProactiveResponseOutcome = 'satisfied' | 'reschedule' | 'give-up';

export interface ProactiveResponseDecision {
  decision: ProactiveResponseOutcome;
  newPingAt?: number;
  note?: string;
}

/**
 * Apply the classification of his answer to a proactive ping. A reschedule
 * with an invalid/past timestamp degrades to cancellation instead of firing
 * immediately on the next tick.
 */
export function applyProactiveResponse(
  item: AgendaItem,
  decision: ProactiveResponseDecision,
  now: number,
): AgendaItem {
  if (decision.decision === 'reschedule') {
    const normalized = normalizePingAt(
      decision.newPingAt,
      now,
      7 * 24 * 3_600_000,
      AUTONOMOUS_MIN_LEAD_MS,
    );
    if (normalized !== null) {
      return rescheduleItem(item, normalized, decision.note || 'ответ на пинг', now);
    }
  }
  return cancelItem(
    item,
    decision.note || `proactive response: ${decision.decision}`,
    now,
  );
}

export function isProactiveResponseRecent(sentAt: number | undefined, now: number): boolean {
  return typeof sentAt === 'number' && sentAt > 0 && now - sentAt < PROACTIVE_RESPONSE_WINDOW_MS;
}

export function dialogCooldownActive(lastMessageAt: number | undefined, now: number): boolean {
  return (
    typeof lastMessageAt === 'number' &&
    lastMessageAt > 0 &&
    now - lastMessageAt < DIALOG_COOLDOWN_MS
  );
}

/** Clamp helper is exported for the tool adapter/tests that build delays. */
export const AGENDA_LIMITS = {
  minDialogGapMs: DIALOG_COOLDOWN_MS,
  responseWindowMs: PROACTIVE_RESPONSE_WINDOW_MS,
  minGapMs: AUTONOMOUS_MIN_GAP_MS,
} as const;
