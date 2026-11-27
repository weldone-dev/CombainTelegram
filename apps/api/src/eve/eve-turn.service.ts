import { Injectable } from '@nestjs/common';
import { notFound } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { eveId, parseChatId, parseThreadId } from './eve-access.js';
import { eveDryRunApplies } from './eve-dry-run.js';
import { EveService } from './eve.service.js';
import type { EveScope } from './eve.service.js';

/**
 * Server-side writeback for one persona turn.
 *
 * The deterministic engine (`apps/eve/agent/lib/persona`) decides *what* she
 * does; this service is the only place that turns that decision into durable
 * Nest state:
 *
 * - mood delta → `EveRelationship` counters (clamped −100..100);
 * - conflict escalation/softening → `EveConflict` + `EveConflictEvent`;
 * - stage counters → `EveSessionState.state` JSON, transition every 5 incoming;
 * - one `EveSessionLog` line for the incoming message and for the outcome.
 *
 * Every formula here mirrors `apps/eve/agent/lib/persona/relationship.ts`. The
 * engine is a separate process and `apps/api` must not import its sources, so
 * the pure parts are duplicated on purpose; the engine specs stay the source of
 * truth for the numbers. Keep both in sync when a threshold changes.
 */

const SCORE_KEYS = [
  'interest',
  'trust',
  'attraction',
  'annoyance',
  'cringe',
] as const;

type ScoreKey = (typeof SCORE_KEYS)[number];

export type EveTurnScore = Record<ScoreKey, number>;
export type EveTurnMoodDelta = Partial<Record<ScoreKey, number>>;

const STAGE_ORDER = [
  'met-irl-got-tg',
  'tg-given-cold',
  'tg-given-warming',
  'convinced',
  'first-date-done',
  'dating-early',
  'dating-stable',
  'long-term',
] as const;

type Stage = (typeof STAGE_ORDER)[number] | 'dumped';

const STAGE_IDS = new Set<string>([...STAGE_ORDER, 'dumped']);

/** Stages where she is already emotionally invested (D2 applies there). */
const WARM_STAGES = new Set<string>([
  'convinced',
  'first-date-done',
  'dating-early',
  'dating-stable',
  'long-term',
]);

const DEFAULT_STAGE: Stage = 'tg-given-warming';
const DUMPED_STAGE: Stage = 'dumped';

/** Intents that never produce a reply and count as an ignore for the stage
 * counter. Mirrors `countsAsIgnore` in the Eve engine
 * (`apps/eve/agent/lib/persona/behavior.ts`): `reaction-only` is a deliberate
 * silent outcome, not a reply. */
const IGNORE_INTENTS = new Set(['ignore', 'left-on-read', 'reaction-only']);

const KNOWN_INTENTS = new Set([
  'reply',
  'ignore',
  'short',
  'left-on-read',
  'leave-chat',
  'reaction-only',
]);

const MIN_HER_MESSAGES = 6;
const STAGE_CHECK_EVERY = 5;
const SESSION_DAY_START_HOUR = 5;
const MAX_LOG_TEXT = 1_000;

const HOUR_MS = 3_600_000;

/* ------------------------------------------------------------------ */
/* Small pure helpers                                                  */
/* ------------------------------------------------------------------ */

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textOf(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback;
}

function intOf(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : fallback;
}

function boolOf(value: unknown, fallback: boolean): boolean {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return fallback;
}

function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(Math.max(min, Math.min(max, value)));
  return rounded === 0 ? 0 : rounded;
}

function clampScoreValue(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return clampInt(n, -100, 100);
}

function applyMoodDelta(
  score: EveTurnScore,
  delta: EveTurnMoodDelta | null | undefined,
): EveTurnScore {
  const next: EveTurnScore = {
    interest: clampScoreValue(score.interest),
    trust: clampScoreValue(score.trust),
    attraction: clampScoreValue(score.attraction),
    annoyance: clampScoreValue(score.annoyance),
    cringe: clampScoreValue(score.cringe),
  };
  if (!delta) return next;
  for (const key of SCORE_KEYS) {
    const value = delta[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      next[key] = clampInt(next[key] + value, -100, 100);
    }
  }
  return next;
}

/** LLM/engine deltas are small; anything beyond ±20 is a bug, not a mood. */
function sanitizeMoodDelta(value: unknown): EveTurnMoodDelta {
  const raw = record(value);
  const out: EveTurnMoodDelta = {};
  for (const key of SCORE_KEYS) {
    const n = raw[key];
    if (typeof n === 'number' && Number.isFinite(n)) {
      out[key] = clampInt(n, -20, 20);
    }
  }
  return out;
}

function scoreOf(row: {
  interest: number;
  trust: number;
  attraction: number;
  annoyance: number;
  cringe: number;
}): EveTurnScore {
  return {
    interest: clampScoreValue(row.interest),
    trust: clampScoreValue(row.trust),
    attraction: clampScoreValue(row.attraction),
    annoyance: clampScoreValue(row.annoyance),
    cringe: clampScoreValue(row.cringe),
  };
}

function stageOf(value: unknown): Stage {
  const raw = typeof value === 'string' ? value.trim() : '';
  return STAGE_IDS.has(raw) ? (raw as Stage) : DEFAULT_STAGE;
}

function stageIndex(stage: Stage): number {
  return STAGE_ORDER.indexOf(stage as (typeof STAGE_ORDER)[number]);
}

function isDumped(score: EveTurnScore): boolean {
  return score.annoyance > 80 && score.interest < -30;
}

function oneLine(value: string, max = MAX_LOG_TEXT): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* ------------------------------------------------------------------ */
/* Conflict automaton (mirrors persona/relationship.ts)                */
/* ------------------------------------------------------------------ */

type ConflictLevel = 0 | 1 | 2 | 3 | 4;

interface ConflictEntry {
  ts: string;
  note: string;
  deltaLevel: number;
}

interface ConflictSnapshot {
  level: ConflictLevel;
  /** ISO timestamp; undefined when there is no active cold period. */
  coldUntil?: string;
  reason?: string;
  history: ConflictEntry[];
}

/** One history column append; broken JSON starts a new list. */
function appendHistory(raw: string, line: string): string {
  let list: string[] = [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      list = parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    list = [];
  }
  return JSON.stringify([...list, line].slice(-30));
}

function normalizeLevel(value: unknown): ConflictLevel {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return clampInt(n, 0, 4) as ConflictLevel;
}

function toEpochMs(value: unknown): number | null {
  const date =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  if (!date) return null;
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function coldRemainingMs(conflict: ConflictSnapshot, now: number): number {
  const until = toEpochMs(conflict.coldUntil);
  return until === null ? 0 : Math.max(0, until - now);
}

function parseHistory(raw: string): ConflictEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        const item = record(entry);
        return {
          ts: textOf(item.ts),
          note: textOf(item.note),
          deltaLevel: intOf(item.deltaLevel, 0),
        };
      })
      .filter((entry) => entry.ts || entry.note);
  } catch {
    return [];
  }
}

function conflictFromRow(row: {
  level: number;
  coldUntil: Date | null;
  reason: string | null;
  history: string;
}): ConflictSnapshot {
  return {
    level: normalizeLevel(row.level),
    coldUntil: row.coldUntil ? row.coldUntil.toISOString() : undefined,
    reason: row.reason ?? undefined,
    history: parseHistory(row.history),
  };
}

function pushHistory(
  state: ConflictSnapshot,
  entry: ConflictEntry,
): ConflictEntry[] {
  return [...state.history, entry].slice(-50);
}

interface MoodClock {
  now: number;
  rand: () => number;
}

/**
 * Escalation from a single mood delta.
 *
 * `trigger = Δannoyance + Δcringe − Δinterest`; thresholds 8/15/25 plus the
 * level-4 "about to break up" rule. The level never decreases here, and a cold
 * period is only ever extended.
 */
function escalateFromMood(
  current: ConflictSnapshot,
  delta: EveTurnMoodDelta,
  score: EveTurnScore,
  incomingText: string,
  clock: MoodClock,
): ConflictSnapshot {
  const trigger =
    (delta.annoyance ?? 0) + (delta.cringe ?? 0) - (delta.interest ?? 0);

  let candidateLevel = 0;
  let candidateReason = '';
  let coldHours = 0;

  if (trigger >= 25 || score.annoyance > 70) {
    candidateLevel = 3;
    candidateReason = 'сильный негатив';
    coldHours = 24 + clock.rand() * 24;
  } else if (trigger >= 15) {
    candidateLevel = 2;
    candidateReason = 'обижена';
    coldHours = 4 + clock.rand() * 12;
  } else if (trigger >= 8) {
    candidateLevel = 1;
    candidateReason = 'немного дуется';
    coldHours = 0.5 + clock.rand() * 2;
  }

  let level = Math.max(normalizeLevel(current.level), candidateLevel);
  let reason = candidateLevel > 0 ? candidateReason : (current.reason ?? '');

  if (score.annoyance > 85 && score.cringe > 70 && score.interest < -30) {
    level = 4;
    reason = 'на грани разрыва';
    coldHours = Math.max(coldHours, 48 + clock.rand() * 48);
  }

  if (level === 0) return current;

  const existingCold = toEpochMs(current.coldUntil);
  let coldUntil = current.coldUntil;
  if (coldHours > 0) {
    const candidateUntil = clock.now + coldHours * HOUR_MS;
    const existingUntil = existingCold ?? 0;
    if (candidateUntil > existingUntil) {
      coldUntil = new Date(candidateUntil).toISOString();
    }
  }

  const changed =
    level !== normalizeLevel(current.level) || coldUntil !== current.coldUntil;
  if (!changed) return current;

  return {
    level: level as ConflictLevel,
    coldUntil,
    reason,
    history: pushHistory(current, {
      ts: new Date(clock.now).toISOString(),
      note: `level ${normalizeLevel(current.level)}→${level}: ${reason}${
        incomingText ? ` | "${oneLine(incomingText, 60)}"` : ''
      }`,
      deltaLevel: level - normalizeLevel(current.level),
    }),
  };
}

/**
 * Softening: `attraction + trust + interest ≥ 12` lowers the level by exactly
 * one and halves the remaining cold period.
 */
function softenFromMood(
  current: ConflictSnapshot,
  delta: EveTurnMoodDelta,
  now: number,
): ConflictSnapshot {
  const level = normalizeLevel(current.level);
  if (level === 0) return current;

  const positive =
    (delta.attraction ?? 0) + (delta.trust ?? 0) + (delta.interest ?? 0);
  if (positive < 12) return current;

  const nextLevel = (level - 1) as ConflictLevel;
  const coldUntil =
    nextLevel === 0
      ? undefined
      : (() => {
          const remaining = coldRemainingMs(current, now);
          return remaining > 0
            ? new Date(now + remaining / 2).toISOString()
            : undefined;
        })();

  return {
    level: nextLevel,
    coldUntil,
    reason: nextLevel === 0 ? undefined : current.reason,
    history: pushHistory(current, {
      ts: new Date(now).toISOString(),
      note: `softened to level ${nextLevel} (positive ${positive})`,
      deltaLevel: -1,
    }),
  };
}

/** Reference order: escalate first, then soften. */
function updateConflictFromMood(
  current: ConflictSnapshot,
  delta: EveTurnMoodDelta,
  score: EveTurnScore,
  incomingText: string,
  clock: MoodClock,
): ConflictSnapshot {
  const escalated = escalateFromMood(
    current,
    delta,
    score,
    incomingText,
    clock,
  );
  return softenFromMood(escalated, delta, clock.now);
}

function conflictChanged(
  before: ConflictSnapshot,
  after: ConflictSnapshot,
): boolean {
  return (
    before.level !== after.level ||
    before.coldUntil !== after.coldUntil ||
    (before.reason ?? '') !== (after.reason ?? '') ||
    JSON.stringify(before.history) !== JSON.stringify(after.history)
  );
}

/* ------------------------------------------------------------------ */
/* Stage transitions (mirrors persona/relationship.ts)                 */
/* ------------------------------------------------------------------ */

interface StageTransitionContext {
  currentStage: Stage;
  score: EveTurnScore;
  herMessagesInStage: number;
  hisMessagesInStage: number;
  ignoresInStage: number;
  hasActiveConflict: boolean;
}

interface StageTransitionResult {
  next: Stage;
  reason: string;
  direction: 'up' | 'down';
}

function decideStageTransition(
  ctx: StageTransitionContext,
): StageTransitionResult | null {
  const current = ctx.currentStage;
  if (current === DUMPED_STAGE) return null;
  const idx = stageIndex(current);
  if (idx < 0) return null;

  const down = wantsDowngrade(ctx, current, ctx.score);
  if (down && idx > 0) {
    return { next: STAGE_ORDER[idx - 1]!, reason: down, direction: 'down' };
  }

  // A live conflict blocks growth (the reference runtime hardcoded `false`
  // here, which made this guard dead).
  if (ctx.hasActiveConflict) return null;

  if (ctx.herMessagesInStage < MIN_HER_MESSAGES) return null;
  const up = wantsUpgrade(ctx, current, ctx.score);
  if (up && idx < STAGE_ORDER.length - 1) {
    return { next: STAGE_ORDER[idx + 1]!, reason: up, direction: 'up' };
  }
  return null;
}

function wantsDowngrade(
  ctx: StageTransitionContext,
  current: Stage,
  score: EveTurnScore,
): string | null {
  // D1: the relationship is regressing.
  if (
    score.annoyance >= 60 &&
    score.interest <= -10 &&
    score.trust <= 10 &&
    ctx.herMessagesInStage >= 8
  ) {
    return `annoyance ${score.annoyance}, interest ${score.interest}, trust ${score.trust} — отношения регрессируют`;
  }

  // D2: she is losing interest (warm stages only).
  if (
    WARM_STAGES.has(current) &&
    ctx.ignoresInStage >= 12 &&
    ctx.ignoresInStage >= ctx.hisMessagesInStage * 0.7 &&
    score.interest < 20
  ) {
    return `${ctx.ignoresInStage} игноров за стадию из ${ctx.hisMessagesInStage} его сообщений — теряет интерес`;
  }

  return null;
}

function wantsUpgrade(
  ctx: StageTransitionContext,
  current: Stage,
  score: EveTurnScore,
): string | null {
  const her = ctx.herMessagesInStage;
  const suffix = `her ${her}, interest ${score.interest}, trust ${score.trust}, attraction ${score.attraction}`;

  switch (current) {
    case 'met-irl-got-tg':
      return score.interest >= 30 &&
        score.attraction >= 20 &&
        score.annoyance < 20
        ? `появился интерес и влечение (${suffix})`
        : null;
    case 'tg-given-cold':
      return score.interest >= 25 &&
        score.trust >= 10 &&
        score.annoyance < 25
        ? `начала отвечать теплее (${suffix})`
        : null;
    case 'tg-given-warming':
      return score.interest >= 40 &&
        score.trust >= 25 &&
        score.attraction >= 30 &&
        score.annoyance < 20
        ? `уже не просто вежливость (${suffix})`
        : null;
    case 'convinced':
      return her >= 10 &&
        score.attraction >= 50 &&
        score.trust >= 35 &&
        score.interest >= 50
        ? `регулярная переписка переросла в симпатию (${suffix})`
        : null;
    case 'first-date-done':
      return her >= 12 &&
        score.attraction >= 65 &&
        score.trust >= 50 &&
        score.interest >= 60
        ? `после свидания тянет ближе (${suffix})`
        : null;
    case 'dating-early':
      return her >= 25 &&
        score.trust >= 70 &&
        score.attraction >= 65 &&
        score.annoyance < 15
        ? `отношения стали устойчивыми (${suffix})`
        : null;
    case 'dating-stable':
      return her >= 60 && score.trust >= 80 && score.interest >= 55
        ? `давно и прочно вместе (${suffix})`
        : null;
    case 'long-term':
    case 'dumped':
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ */
/* Public contract                                                     */
/* ------------------------------------------------------------------ */

export interface EveTurnDecision {
  intent: string;
  shouldReply: boolean;
  shouldRead: boolean;
  ignoreReason?: string;
  moodDelta: EveTurnMoodDelta;
  bubbles: number;
  reaction?: string;
}

export interface EveTurnInput {
  personaId: string;
  accountId: string;
  chatId: bigint | number | string;
  threadId?: number;
  messageId?: number | null;
  /** Every message of the answered series; empty for a legacy single-message call. */
  messageIds?: number[];
  /**
   * Identity of this turn (`inbound:<event>`, `deferred:<action>`, ...
   * generated by the Eve channel). A retry of the same turn is a no-op; a
   * different key whose series is already applied still writes its outcome.
   */
  turnKey?: string;
  /** The same series with texts, used for one session-log line per message. */
  messages?: Array<{ id: number | null; text: string }>;
  /** Incoming message text. */
  text?: string;
  /** Generated reply text, when the turn produced one. */
  reply?: string | null;
  decision: EveTurnDecision;
  /** Epoch ms; injectable for deterministic specs. */
  now?: number;
  /** Injectable PRNG for cold-period lengths. */
  rand?: () => number;
}

export interface EveTurnCounters {
  /** His incoming messages during the current stage. */
  hisMsgs: number;
  /** Her outgoing messages during the current stage. */
  herMsgs: number;
  /** Ignores (intent `ignore` / `left-on-read`) during the current stage. */
  ignoresInStage: number;
  /** Global trigger counter: a stage check runs every 5 incoming messages. */
  msgsSinceStageCheck: number;
  /**
   * Highest message id already counted. A burst can contain a message that a
   * previous turn (an ignore, or a reply that was already in flight) applied,
   * so ids at or below this value are never counted twice.
   */
  lastHisMessageId: number;
  /**
   * The turn whose writeback was applied last. Retries of the same turn are a
   * full no-op, while a late reply that belongs to a series already counted by
   * an ignore is still allowed to write its own outcome exactly once.
   */
  lastAppliedTurnKey?: string;
  stage: string;
}

export interface EveTurnStageChange {
  from: string;
  to: string;
  direction: 'up' | 'down';
  reason: string;
}

export interface EveRelationshipView {
  id: string;
  personaId: string;
  scopeKey: string;
  stage: string;
  interest: number;
  trust: number;
  attraction: number;
  annoyance: number;
  cringe: number;
  notes: string;
  updatedAt: Date;
}

export interface EveConflictView {
  id: string;
  relationshipId: string;
  level: number;
  coldUntil: Date | null;
  reason: string | null;
  history: string;
  updatedAt: Date;
}

export interface EveTurnResult {
  relationship: EveRelationshipView;
  conflict: EveConflictView;
  stage: string;
  counters: EveTurnCounters;
  agendaCancelled?: number;
  agendaRescheduled?: number;
  stageChanged?: EveTurnStageChange;
  /**
   * The whole answered series was already applied by an earlier call: nothing
   * was written (no mood, no counters, no log). Lets a caller/tests tell a
   * deduplicated replay from a real turn.
   */
  replayed?: boolean;
}

/* ------------------------------------------------------------------ */
/* Body parsing                                                        */
/* ------------------------------------------------------------------ */

/**
 * Normalises the `/internal/eve/turn/apply` body.
 *
 * The Eve channel may send the decision nested under `decision` or flattened
 * into the body; both shapes are accepted. Unknown intents degrade to `reply`,
 * missing mood fields to `{}`, so a partially written payload can never create
 * a bogus conflict.
 */
export function parseTurnInput(raw: unknown): EveTurnInput {
  const body = record(raw);

  const personaId = eveId(
    body.personaId,
    'EVE_PERSONA_REQUIRED',
    'personaId is required',
  );
  const accountId = eveId(
    body.accountId,
    'EVE_ACCOUNT_REQUIRED',
    'accountId is required',
  );
  const chatId = parseChatId(body.chatId);

  const message = record(body.message);
  const incoming = record(body.incoming);
  const messageIdRaw = body.messageId ?? incoming.messageId ?? message.id;
  const messageId =
    messageIdRaw === undefined ||
    messageIdRaw === null ||
    messageIdRaw === ''
      ? null
      : intOf(messageIdRaw, 0) || null;

  const incomingText =
    textOf(body.text) ||
    textOf(body.incomingText) ||
    (typeof body.incoming === 'string' ? textOf(body.incoming) : '') ||
    textOf(incoming.text) ||
    textOf(message.text);

  // A turn may answer several of his messages at once (the unanswered series
  // behind a superseded deferred turn). `messageIds`/`messages` are optional:
  // without them the body is the old single-message shape.
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages: Array<{ id: number | null; text: string }> = [];
  for (const entry of rawMessages) {
    const row = record(entry);
    const idRaw = Number(row.id);
    const id =
      Number.isSafeInteger(idRaw) && idRaw > 0 ? Math.trunc(idRaw) : null;
    const line = textOf(row.text);
    if (!line) continue;
    messages.push({ id, text: line });
  }
  const idSet = new Set<number>();
  const rawIds = Array.isArray(body.messageIds) ? body.messageIds : [];
  for (const value of rawIds) {
    const id = intOf(value, 0);
    if (id > 0) idSet.add(id);
  }
  for (const entry of messages) {
    if (entry.id !== null) idSet.add(entry.id);
  }
  const messageIds = [...idSet].sort((a, b) => a - b);

  const replyRaw = body.reply ?? body.replyText ?? body.outgoing ?? incoming.reply;
  const reply = Array.isArray(replyRaw)
    ? replyRaw.map((part) => textOf(part)).filter(Boolean).join(' / ')
    : textOf(replyRaw);

  const decisionRaw = record(body.decision ?? body);
  const intentRaw = textOf(decisionRaw.intent, 'reply');
  const intent = KNOWN_INTENTS.has(intentRaw) ? intentRaw : 'reply';
  const replyIntent = !IGNORE_INTENTS.has(intent);

  return {
    personaId,
    accountId,
    chatId,
    threadId: parseThreadId(body.threadId),
    messageId,
    messageIds,
    turnKey: textOf(body.turnKey).slice(0, 256) || undefined,
    messages,
    text: incomingText,
    reply: reply || null,
    decision: {
      intent,
      shouldReply: boolOf(decisionRaw.shouldReply, replyIntent),
      shouldRead: boolOf(decisionRaw.shouldRead, true),
      ignoreReason: textOf(decisionRaw.ignoreReason) || undefined,
      moodDelta: sanitizeMoodDelta(decisionRaw.moodDelta ?? body.moodDelta),
      bubbles: clampInt(intOf(decisionRaw.bubbles, 1), 1, 6),
      reaction: textOf(decisionRaw.reaction) || undefined,
    },
    now: typeof body.now === 'number' && Number.isFinite(body.now)
      ? body.now
      : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* Service                                                             */
/* ------------------------------------------------------------------ */

const COUNTER_KEYS = [
  'hisMsgs',
  'herMsgs',
  'ignoresInStage',
  'msgsSinceStageCheck',
] as const;

function emptyCounters(stage: string): EveTurnCounters {
  return {
    hisMsgs: 0,
    herMsgs: 0,
    ignoresInStage: 0,
    msgsSinceStageCheck: 0,
    lastHisMessageId: 0,
    stage,
  };
}

function parseCounters(raw: string, stage: string): EveTurnCounters {
  const counters = emptyCounters(stage);
  let parsed: Record<string, unknown> = {};
  try {
    parsed = record(JSON.parse(raw) as unknown);
  } catch {
    return counters;
  }
  for (const key of COUNTER_KEYS) {
    const n = Number(parsed[key]);
    counters[key] = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
  }
  const lastHisMessageId = Number(parsed.lastHisMessageId);
  counters.lastHisMessageId =
    Number.isFinite(lastHisMessageId) && lastHisMessageId > 0
      ? Math.trunc(lastHisMessageId)
      : 0;
  const lastAppliedTurnKey = textOf(parsed.lastAppliedTurnKey).slice(0, 256);
  if (lastAppliedTurnKey) counters.lastAppliedTurnKey = lastAppliedTurnKey;
  // `relationship.stage` stays authoritative; the JSON copy is informational.
  counters.stage = stage;
  return counters;
}

/** Session day boundary is 05:00 local time, so night chats stay in one day. */
function sessionDay(now: number, timezone: string): string {
  const shifted = new Date(now - SESSION_DAY_START_HOUR * HOUR_MS);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(shifted);
  } catch {
    return shifted.toISOString().slice(0, 10);
  }
}

@Injectable()
export class EveTurnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eve: EveService,
  ) {}

  /**
   * Applies one persona turn: mood, conflict, stage counters and the session
   * log. Idempotency is the caller's job (one call per real incoming message).
   */
  async applyTurn(input: EveTurnInput): Promise<EveTurnResult> {
    const now = input.now ?? Date.now();
    const rand = input.rand ?? Math.random;
    const persona = await this.loadPersona(input.personaId);
    const scope = await this.eve.scope(
      input.personaId,
      input.accountId,
      input.chatId,
      input.threadId ?? 0,
    );
    await this.eve.requireAllowed({
      personaId: scope.personaId,
      accountId: scope.accountId,
      chatId: scope.chatId,
      threadId: scope.threadId,
    });

    const relationship = await this.eve.relationshipFor(scope);
    const currentStage = stageOf(relationship.stage);
    const score = scoreOf(relationship);
    const counters = parseCounters(
      await this.loadStateJson(scope),
      currentStage,
    );

    // 1. Incoming messages of the answered series: only ids newer than the last
    // applied one are counted. A burst can repeat a message that an earlier
    // ignore (or an answer that was already in flight) already applied, and a
    // replayed `turn/apply` must not move the counters again.
    const seriesIds =
      input.messageIds && input.messageIds.length > 0
        ? input.messageIds
        : input.messageId !== null && input.messageId !== undefined
          ? [input.messageId]
          : [];
    const freshIds = seriesIds.filter((id) => id > counters.lastHisMessageId);
    const turnKey = textOf(input.turnKey);
    // A retried writeback of the same turn must be a full no-op: the mood, the
    // outcome counters and the log line were already written for it.
    if (turnKey && counters.lastAppliedTurnKey === turnKey) {
      return this.replayedTurn(relationship, counters, currentStage);
    }
    const seriesApplied = seriesIds.length > 0 && freshIds.length === 0;
    // A legacy payload without a turn key keeps the old series-based guard:
    // there is no way to tell a retry from a late reply. With a key the series
    // can be fully applied and the turn still be new: an ignore that ran while
    // this reply was generating counted its messages, but this turn's own
    // outcome (herMsgs + `-> она`) was never written. In that case the messages
    // are not counted again and the turn continues with `counted = 0`, so only
    // its outcome, mood and log line are applied.
    if (seriesApplied && !turnKey) {
      return this.replayedTurn(relationship, counters, currentStage);
    }
    const counted = seriesIds.length > 0 ? freshIds.length : 1;
    const msgsBefore = counters.msgsSinceStageCheck;
    counters.hisMsgs += counted;
    counters.msgsSinceStageCheck += counted;
    for (const id of seriesIds) {
      if (id > counters.lastHisMessageId) counters.lastHisMessageId = id;
    }

    // 2. Mood delta, clamped.
    const delta = sanitizeMoodDelta(input.decision.moodDelta);
    const nextScore = applyMoodDelta(score, delta);

    // 3. Conflict: escalate, then soften.
    const conflictRow = await this.prisma.eveConflict.upsert({
      where: { relationshipId: relationship.id },
      create: { relationshipId: relationship.id },
      update: {},
    });
    const before = conflictFromRow(conflictRow);
    const after = updateConflictFromMood(
      before,
      delta,
      nextScore,
      input.text ?? '',
      { now, rand },
    );
    const conflictMoved = conflictChanged(before, after);

    // A growing conflict also moves the queue: pings do not arrive during a
    // fight. Mirrors `reconcileAfterConflict` in the Eve engine.
    let agendaConflictCancelled = 0;
    let agendaConflictRescheduled = 0;
    const beforeLevel = normalizeLevel(before.level);
    const afterLevel = normalizeLevel(after.level);
    if (afterLevel > beforeLevel) {
      const pending = await this.prisma.eveAgendaItem.findMany({
        where: {
          personaId: scope.personaId,
          accountId: scope.accountId,
          chatId: scope.chatId,
          state: 'pending',
        },
        select: { id: true, importance: true, history: true },
      });
      for (const item of pending) {
        if (afterLevel >= 3 || item.importance <= 1) {
          await this.prisma.eveAgendaItem.update({
            where: { id: item.id },
            data: {
              state: 'cancelled',
              history: appendHistory(
                item.history,
                `cancelled due to conflict level ${afterLevel}`,
              ),
            },
          });
          agendaConflictCancelled += 1;
          continue;
        }
        if (afterLevel >= 2 && item.importance === 2) {
          const pingAt = new Date(
            now + (12 + rand() * 24) * 3_600_000,
          );
          await this.prisma.eveAgendaItem.update({
            where: { id: item.id },
            data: {
              pingAt,
              history: appendHistory(
                item.history,
                `rescheduled due to conflict level ${afterLevel}`,
              ),
            },
          });
          agendaConflictRescheduled += 1;
        }
      }
    }

    // 4. Auto-dump beats a stage check: terminal and irreversible here.
    let stage: Stage = currentStage;
    let stageChanged: EveTurnStageChange | undefined;
    let agendaCancelled = false;

    if (currentStage !== DUMPED_STAGE && isDumped(nextScore)) {
      stage = DUMPED_STAGE;
      stageChanged = {
        from: currentStage,
        to: DUMPED_STAGE,
        direction: 'down',
        reason: `annoyance ${nextScore.annoyance}, interest ${nextScore.interest} — авто-dump`,
      };
      resetStageCounters(counters);
      agendaCancelled = true;
    } else if (
      currentStage !== DUMPED_STAGE &&
      counted > 0 &&
      counters.msgsSinceStageCheck > 0 &&
      // A burst can add two or three messages at once; a stage check belongs
      // every fifth message even when the counter jumped over the multiple.
      Math.floor(counters.msgsSinceStageCheck / STAGE_CHECK_EVERY) >
        Math.floor(msgsBefore / STAGE_CHECK_EVERY)
    ) {
      const transition = decideStageTransition({
        currentStage,
        score: nextScore,
        herMessagesInStage: counters.herMsgs,
        hisMessagesInStage: counters.hisMsgs,
        ignoresInStage: counters.ignoresInStage,
        hasActiveConflict: normalizeLevel(after.level) > 0,
      });
      if (transition) {
        stage = transition.next;
        stageChanged = {
          from: currentStage,
          to: transition.next,
          direction: transition.direction,
          reason: transition.reason,
        };
        resetStageCounters(counters);
      }
    }

    // 5. Outcome counters.
    if (IGNORE_INTENTS.has(input.decision.intent)) {
      counters.ignoresInStage += 1;
    } else if (input.decision.shouldReply) {
      counters.herMsgs += 1;
    }
    counters.stage = stage;
    // The outcome of this turn is written below; a retry with the same key
    // stops at the replay guard above, a late reply under a new key no longer
    // looks like a replay of the ignore that consumed its series.
    if (turnKey) counters.lastAppliedTurnKey = turnKey;

    // 6. Persist relationship (scores + stage) only when something moved.
    const scoreMoved = SCORE_KEYS.some((key) => nextScore[key] !== score[key]);
    let relationshipRow = relationship;
    if (scoreMoved || stage !== relationship.stage) {
      relationshipRow = await this.prisma.eveRelationship.update({
        where: { id: relationship.id },
        data: {
          interest: nextScore.interest,
          trust: nextScore.trust,
          attraction: nextScore.attraction,
          annoyance: nextScore.annoyance,
          cringe: nextScore.cringe,
          stage,
        },
      });
    }

    // 7. Persist conflict + its event log.
    let conflictView: EveConflictView = {
      id: conflictRow.id,
      relationshipId: conflictRow.relationshipId,
      level: before.level,
      coldUntil: conflictRow.coldUntil,
      reason: conflictRow.reason,
      history: conflictRow.history,
      updatedAt: conflictRow.updatedAt,
    };
    if (conflictMoved) {
      const last = after.history[after.history.length - 1];
      const updated = await this.prisma.eveConflict.update({
        where: { id: conflictRow.id },
        data: {
          level: after.level,
          coldUntil: after.coldUntil ? new Date(after.coldUntil) : null,
          reason: after.reason ?? null,
          history: JSON.stringify(after.history),
        },
      });
      conflictView = {
        id: updated.id,
        relationshipId: updated.relationshipId,
        level: updated.level,
        coldUntil: updated.coldUntil,
        reason: updated.reason,
        history: updated.history,
        updatedAt: updated.updatedAt,
      };
      if (after.level !== before.level) {
        await this.prisma.eveConflictEvent.create({
          data: {
            conflictId: conflictRow.id,
            eveConflictId: conflictRow.id,
            level: after.level,
            note: last?.note ?? `level ${before.level}→${after.level}`,
          },
        });
      }
    }

    // 8. Stage audit trail and agenda cleanup on a break-up.
    if (stageChanged) {
      await this.prisma.eveRelationshipEvent.create({
        data: {
          relationshipId: relationshipRow.id,
          kind: 'stage',
          text: `stage: ${stageChanged.from} → ${stageChanged.to} (${stageChanged.direction}): ${stageChanged.reason}`,
        },
      });
    }
    if (agendaCancelled) {
      await this.prisma.eveAgendaItem.updateMany({
        where: {
          personaId: scope.personaId,
          accountId: scope.accountId,
          chatId: scope.chatId,
          state: 'pending',
        },
        data: { state: 'cancelled' },
      });
    }

    // 9. Stage counters JSON (one row per persona+account+chat).
    const stateJson = JSON.stringify(counters);
    await this.prisma.eveSessionState.upsert({
      where: {
        personaId_accountId_chatId: {
          personaId: scope.personaId,
          accountId: scope.accountId,
          chatId: scope.chatId,
        },
      },
      create: {
        personaId: scope.personaId,
        accountId: scope.accountId,
        chatId: scope.chatId,
        state: stateJson,
      },
      update: { state: stateJson },
    });

    // 10. Session log: one incoming line per newly applied message plus the
    // outcome line.
    const lines = this.turnLogLines(input, now, new Set(freshIds));
    if (lines.length > 0) {
      const day = sessionDay(now, persona.timezone);
      await this.prisma.eveSessionLog.createMany({
        data: lines.map((line) => ({
          personaId: scope.personaId,
          accountId: scope.accountId,
          chatId: scope.chatId,
          day,
          line,
        })),
      });
    }

    return {
      relationship: {
        id: relationshipRow.id,
        personaId: relationshipRow.personaId,
        scopeKey: relationshipRow.scopeKey,
        stage,
        interest: nextScore.interest,
        trust: nextScore.trust,
        attraction: nextScore.attraction,
        annoyance: nextScore.annoyance,
        cringe: nextScore.cringe,
        notes: relationshipRow.notes,
        updatedAt: relationshipRow.updatedAt,
      },
      conflict: conflictView,
      stage,
      counters,
      ...(agendaConflictCancelled > 0
        ? { agendaCancelled: agendaConflictCancelled }
        : {}),
      ...(agendaConflictRescheduled > 0
        ? { agendaRescheduled: agendaConflictRescheduled }
        : {}),
      ...(stageChanged ? { stageChanged } : {}),
    };
  }

  /**
   * Highest message id already applied for this chat, without touching mood,
   * conflict or the log. The deferred-turn dispatch puts it into the `/turn`
   * payload so a message answered while the turn was waiting is not answered
   * again.
   */
  async lastAppliedMessageId(
    personaId: string,
    accountId: string,
    chatId: bigint | number | string,
  ): Promise<number> {
    const scope = await this.eve.scope(personaId, accountId, chatId);
    const counters = parseCounters(await this.loadStateJson(scope), '');
    return counters.lastHisMessageId;
  }

  /**
   * Result of a deduplicated replay: the stored state, built without a single
   * write. A missing conflict row degrades to the empty level-0 view.
   */
  private async replayedTurn(
    relationship: Awaited<ReturnType<EveService['relationshipFor']>>,
    counters: EveTurnCounters,
    stage: string,
  ): Promise<EveTurnResult> {
    const conflictRow = await this.prisma.eveConflict.findUnique({
      where: { relationshipId: relationship.id },
    });
    return {
      relationship: {
        id: relationship.id,
        personaId: relationship.personaId,
        scopeKey: relationship.scopeKey,
        stage,
        interest: relationship.interest,
        trust: relationship.trust,
        attraction: relationship.attraction,
        annoyance: relationship.annoyance,
        cringe: relationship.cringe,
        notes: relationship.notes,
        updatedAt: relationship.updatedAt,
      },
      conflict: conflictRow
        ? {
            id: conflictRow.id,
            relationshipId: conflictRow.relationshipId,
            level: conflictRow.level,
            coldUntil: conflictRow.coldUntil,
            reason: conflictRow.reason,
            history: conflictRow.history,
            updatedAt: conflictRow.updatedAt,
          }
        : {
            id: '',
            relationshipId: relationship.id,
            level: 0,
            coldUntil: null,
            reason: null,
            history: '[]',
            updatedAt: relationship.updatedAt,
          },
      stage,
      counters,
      replayed: true,
    };
  }

  /** Read-only view of the counters for one chat. */
  async getState(
    rawPersonaId: string,
    rawAccountId: string,
    rawChatId: unknown,
  ): Promise<Omit<EveTurnResult, 'stageChanged'>> {
    const personaId = eveId(
      rawPersonaId,
      'EVE_PERSONA_REQUIRED',
      'personaId is required',
    );
    const accountId = eveId(
      rawAccountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    await this.loadPersona(personaId);
    const scope = await this.eve.scope(personaId, accountId, rawChatId);
    const relationship = await this.eve.relationshipFor(scope);
    const stage = stageOf(relationship.stage);
    const conflictRow = await this.prisma.eveConflict.upsert({
      where: { relationshipId: relationship.id },
      create: { relationshipId: relationship.id },
      update: {},
    });
    const counters = parseCounters(await this.loadStateJson(scope), stage);

    return {
      relationship: {
        id: relationship.id,
        personaId: relationship.personaId,
        scopeKey: relationship.scopeKey,
        stage,
        interest: relationship.interest,
        trust: relationship.trust,
        attraction: relationship.attraction,
        annoyance: relationship.annoyance,
        cringe: relationship.cringe,
        notes: relationship.notes,
        updatedAt: relationship.updatedAt,
      },
      conflict: {
        id: conflictRow.id,
        relationshipId: conflictRow.relationshipId,
        level: conflictRow.level,
        coldUntil: conflictRow.coldUntil,
        reason: conflictRow.reason,
        history: conflictRow.history,
        updatedAt: conflictRow.updatedAt,
      },
      stage,
      counters,
    };
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private async loadPersona(
    personaId: string,
  ): Promise<{ id: string; timezone: string }> {
    const persona = await this.prisma.evePersona.findUnique({
      where: { id: personaId },
      select: { id: true, timezone: true },
    });
    if (!persona) {
      throw notFound('EVE_PERSONA_NOT_FOUND', 'Eve persona not found');
    }
    return {
      id: persona.id,
      timezone: textOf(persona.timezone, 'Europe/Moscow'),
    };
  }

  private async loadStateJson(scope: EveScope): Promise<string> {
    const row = await this.prisma.eveSessionState.findUnique({
      where: {
        personaId_accountId_chatId: {
          personaId: scope.personaId,
          accountId: scope.accountId,
          chatId: scope.chatId,
        },
      },
      select: { state: true },
    });
    return row?.state ?? '{}';
  }

  /**
   * Session log lines for one turn, in the reference format:
   * `[ts] он(123): text`, `-> она: text`, `-> ignored (reason)`.
   * The outgoing line is written only when the turn carries reply text.
   */
  private turnLogLines(
    input: EveTurnInput,
    now: number,
    freshIds: Set<number> = new Set(),
  ): string[] {
    const ts = new Date(now).toISOString();
    const lines: string[] = [];
    // One line per message of the answered series. A legacy body without
    // `messages` keeps the old single line.
    const rows =
      input.messages && input.messages.length > 0
        ? input.messages
        : [
            {
              id: input.messageId ?? null,
              text: input.text ?? '',
            },
          ];
    const seriesMode =
      (input.messageIds?.length ?? 0) > 0 || (input.messages?.length ?? 0) > 0;
    for (const row of rows) {
      if (seriesMode && row.id !== null && !freshIds.has(row.id)) continue;
      const incoming = oneLine(row.text);
      if (!incoming) continue;
      lines.push(
        row.id === null || row.id === undefined
          ? `[${ts}] user: ${incoming}`
          : `[${ts}] он(${row.id}): ${incoming}`,
      );
    }

    if (!input.decision.shouldReply) {
      const reason =
        textOf(input.decision.ignoreReason) ||
        textOf(input.decision.intent) ||
        'no-reply';
      lines.push(`  -> ignored (${reason})`);
    } else {
      const reply = oneLine(input.reply ?? '');
      if (reply) {
        const dryRun = eveDryRunApplies(input.accountId, input.chatId);
        lines.push(`  -> она${dryRun ? ' (dry-run)' : ''}: ${reply}`);
      }
    }
    return lines;
  }
}

function resetStageCounters(counters: EveTurnCounters): void {
  counters.hisMsgs = 0;
  counters.herMsgs = 0;
  counters.ignoresInStage = 0;
  counters.msgsSinceStageCheck = 0;
}
