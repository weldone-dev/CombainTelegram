/**
 * Relationships: score, nine stage presets, deterministic stage transitions and
 * the conflict automaton.
 *
 * The presets are behaviour frames, not starting values. A fresh relationship
 * starts at score 0 regardless of stage; presets supply fallback ignore/delay
 * numbers and prompt text.
 */

import { clampInt, toEpochMs } from './time';
import type {
  ConflictHistoryEntry,
  ConflictState,
  MoodDelta,
  RelationshipScore,
  Stage,
  StageDefaults,
  StagePreset,
} from './types';

export const STAGE_ORDER: Stage[] = [
  'met-irl-got-tg',
  'tg-given-cold',
  'tg-given-warming',
  'convinced',
  'first-date-done',
  'dating-early',
  'dating-stable',
  'long-term',
];

export const STAGE_PRESETS: StagePreset[] = [
  {
    id: 'met-irl-got-tg',
    num: 1,
    label: 'Познакомились вживую, дала телеграм',
    description: 'Вы виделись, она дала контакт, но близости пока нет.',
    defaults: {
      interest: 38,
      trust: 14,
      attraction: 30,
      annoyance: 0,
      cringeTolerance: 14,
      ignoreChance: 0.12,
      replyDelaySec: [15, 600],
    },
  },
  {
    id: 'tg-given-cold',
    num: 2,
    label: 'Дала телеграм, но холодна',
    description: 'Отвечает редко и сухо, интерес ещё не появился.',
    defaults: {
      interest: 5,
      trust: 0,
      attraction: 5,
      annoyance: 0,
      cringeTolerance: -10,
      ignoreChance: 0.65,
      replyDelaySec: [600, 14400],
    },
  },
  {
    id: 'tg-given-warming',
    num: 3,
    label: 'Дала телеграм, оттаивает',
    description: 'Отвечает осторожно, но уже с любопытством.',
    defaults: {
      interest: 30,
      trust: 15,
      attraction: 25,
      annoyance: 0,
      cringeTolerance: 5,
      ignoreChance: 0.18,
      replyDelaySec: [30, 1200],
    },
  },
  {
    id: 'convinced',
    num: 4,
    label: 'Убедил, что с тобой интересно',
    description: 'Переписка стала регулярной, появилось доверие.',
    defaults: {
      interest: 50,
      trust: 35,
      attraction: 45,
      annoyance: 0,
      cringeTolerance: 15,
      ignoreChance: 0.07,
      replyDelaySec: [10, 420],
    },
  },
  {
    id: 'first-date-done',
    num: 5,
    label: 'Сходили на одно свидание',
    description: 'У вас появилась общая история и личное.',
    defaults: {
      interest: 60,
      trust: 45,
      attraction: 55,
      annoyance: 0,
      cringeTolerance: 25,
      ignoreChance: 0.05,
      replyDelaySec: [8, 300],
    },
  },
  {
    id: 'dating-early',
    num: 6,
    label: 'Только начали встречаться',
    description: 'Вы пара недавно: много тепла и волнения.',
    defaults: {
      interest: 75,
      trust: 60,
      attraction: 70,
      annoyance: 0,
      cringeTolerance: 35,
      ignoreChance: 0.02,
      replyDelaySec: [3, 120],
    },
  },
  {
    id: 'dating-stable',
    num: 7,
    label: 'Стабильная пара',
    description: 'Вам спокойно и привычно друг с другом.',
    defaults: {
      interest: 80,
      trust: 80,
      attraction: 75,
      annoyance: 0,
      cringeTolerance: 50,
      ignoreChance: 0.03,
      replyDelaySec: [3, 240],
    },
  },
  {
    id: 'long-term',
    num: 8,
    label: 'Давно вместе',
    description: 'Долгие отношения с бытом, привычками и усталостью.',
    defaults: {
      interest: 70,
      trust: 90,
      attraction: 65,
      annoyance: 10,
      cringeTolerance: 60,
      ignoreChance: 0.05,
      replyDelaySec: [5, 900],
    },
  },
  {
    id: 'dumped',
    num: 9,
    label: 'Отшила',
    description: 'Отношения закончены, его сообщения игнорируются.',
    defaults: {
      interest: -50,
      trust: -30,
      attraction: -40,
      annoyance: 80,
      cringeTolerance: -50,
      ignoreChance: 1,
      replyDelaySec: [99999, 99999],
    },
  },
];

const DUMPED = STAGE_PRESETS[8]!;
const COLD = STAGE_PRESETS[1]!;

const WARM_STAGES = new Set<Stage>([
  'convinced',
  'first-date-done',
  'dating-early',
  'dating-stable',
  'long-term',
]);

export const STAGE_AFTER_RESET: Stage = 'tg-given-cold';

/** Unknown ids deliberately fall back to `tg-given-cold` (stage #2). */
export function findStage(id: string | number | null | undefined): StagePreset {
  if (id === null || id === undefined) return COLD;
  const numeric = typeof id === 'number' || /^\d+$/.test(String(id).trim());
  if (numeric) {
    const num = Number(id);
    return STAGE_PRESETS.find((preset) => preset.num === num) ?? COLD;
  }
  return STAGE_PRESETS.find((preset) => preset.id === id) ?? COLD;
}

export function stageDefaults(stage: Stage): StageDefaults {
  return findStage(stage).defaults;
}

export function stageIndex(stage: Stage): number {
  return STAGE_ORDER.indexOf(stage);
}

export function isWarmStage(stage: Stage): boolean {
  return WARM_STAGES.has(stage);
}

/** `dating-early+` means "officially taken" for stranger boundaries. */
export function isCommittedStage(stage: Stage): boolean {
  return stage === 'dating-early' || stage === 'dating-stable' || stage === 'long-term';
}

export function clampScoreValue(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return clampInt(n, -100, 100);
}

export function clampScore(score: Partial<RelationshipScore> | null | undefined): RelationshipScore {
  return {
    interest: clampScoreValue(score?.interest),
    trust: clampScoreValue(score?.trust),
    attraction: clampScoreValue(score?.attraction),
    annoyance: clampScoreValue(score?.annoyance),
    cringe: clampScoreValue(score?.cringe),
  };
}

const SCORE_KEYS: (keyof RelationshipScore)[] = [
  'interest',
  'trust',
  'attraction',
  'annoyance',
  'cringe',
];

/** Apply deltas, round each counter and clamp to −100..100. */
export function applyMoodDelta(
  score: RelationshipScore,
  delta: MoodDelta | null | undefined,
): RelationshipScore {
  const next = clampScore(score);
  if (!delta) return next;
  for (const key of SCORE_KEYS) {
    const value = delta[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      next[key] = clampInt(next[key] + value, -100, 100);
    }
  }
  return next;
}

/**
 * The only automatic break-up rule: maximum annoyance together with active
 * dislike. Cancelling agenda items is the caller's responsibility.
 */
export function autoDumped(score: RelationshipScore): boolean {
  return score.annoyance > 80 && score.interest < -30;
}

export interface StageTransitionContext {
  currentStage: Stage;
  score: RelationshipScore;
  /** Her messages sent during the current stage. */
  herMessagesInStage: number;
  /** His messages received during the current stage. */
  hisMessagesInStage: number;
  /**
   * Ignored incoming messages during the current stage. Unlike the reference
   * runtime, this counter is really used: increment it for every decision with
   * intent `ignore` or `left-on-read`.
   */
  ignoresInStage: number;
  hasActiveConflict?: boolean;
}

export interface StageTransitionResult {
  next: Stage;
  reason: string;
  direction: 'up' | 'down';
}

const MIN_HER = 6;

export function shouldRunStageTransitionCheck(messagesSinceLastCheck: number): boolean {
  return messagesSinceLastCheck > 0 && messagesSinceLastCheck % 5 === 0;
}

export function decideStageTransition(
  ctx: StageTransitionContext,
): StageTransitionResult | null {
  const current = ctx.currentStage;
  if (current === 'dumped') return null;
  const idx = stageIndex(current);
  if (idx < 0) return null;
  const score = clampScore(ctx.score);

  const down = wantsDowngrade(ctx, current, score);
  if (down && idx > 0) {
    return { next: STAGE_ORDER[idx - 1]!, reason: down, direction: 'down' };
  }

  // A live conflict blocks growth. (The reference runtime hardcoded `false`
  // here, which made this guard dead; keeping it real is intentional.)
  if (ctx.hasActiveConflict) return null;

  if (ctx.herMessagesInStage < MIN_HER) return null;
  const up = wantsUpgrade(ctx, current, score);
  if (up && idx < STAGE_ORDER.length - 1) {
    return { next: STAGE_ORDER[idx + 1]!, reason: up, direction: 'up' };
  }
  return null;
}

function wantsDowngrade(
  ctx: StageTransitionContext,
  current: Stage,
  score: RelationshipScore,
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
  score: RelationshipScore,
): string | null {
  const her = ctx.herMessagesInStage;
  const suffix = `her ${her}, interest ${score.interest}, trust ${score.trust}, attraction ${score.attraction}`;

  switch (current) {
    case 'met-irl-got-tg':
      return score.interest >= 30 && score.attraction >= 20 && score.annoyance < 20
        ? `появился интерес и влечение (${suffix})`
        : null;
    case 'tg-given-cold':
      return score.interest >= 25 && score.trust >= 10 && score.annoyance < 25
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
/* Conflict                                                            */
/* ------------------------------------------------------------------ */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export function emptyConflict(): ConflictState {
  return { level: 0, history: [] };
}

function normalizeLevel(value: unknown): ConflictState['level'] {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return clampInt(n, 0, 4) as ConflictState['level'];
}

export function coldRemainingMs(conflict: ConflictState | null | undefined, now: number): number {
  const until = toEpochMs(conflict?.coldUntil);
  return until === null ? 0 : Math.max(0, until - now);
}

export function activeConflict(
  conflict: ConflictState | null | undefined,
  now = Date.now(),
): { active: boolean; coldActive: boolean; level: ConflictState['level'] } {
  const level = normalizeLevel(conflict?.level ?? 0);
  return {
    active: level > 0,
    coldActive: coldRemainingMs(conflict, now) > 0,
    level,
  };
}

function truncate(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function pushHistory(state: ConflictState, entry: ConflictHistoryEntry): ConflictHistoryEntry[] {
  return [...state.history, entry].slice(-50);
}

export interface ConflictClock {
  now?: number;
  rand?: () => number;
}

/**
 * Escalation from a single mood delta.
 *
 * `trigger = Δannoyance + Δcringe − Δinterest`. Thresholds are intentionally
 * sensitive: one really rude message can jump straight to level 3.
 * The level never decreases here, and a cold period is only ever extended.
 */
export function escalateFromMood(
  current: ConflictState,
  delta: MoodDelta | null | undefined,
  score: RelationshipScore,
  incomingText = '',
  clock: ConflictClock = {},
): ConflictState {
  const now = clock.now ?? Date.now();
  const rand = clock.rand ?? Math.random;
  const d = delta ?? {};
  const trigger =
    (d.annoyance ?? 0) + (d.cringe ?? 0) - (d.interest ?? 0);

  let candidateLevel = 0;
  let candidateReason = '';
  let coldHours = 0;

  if (trigger >= 25 || score.annoyance > 70) {
    candidateLevel = 3;
    candidateReason = 'сильный негатив';
    coldHours = 24 + rand() * 24;
  } else if (trigger >= 15) {
    candidateLevel = 2;
    candidateReason = 'обижена';
    coldHours = 4 + rand() * 12;
  } else if (trigger >= 8) {
    candidateLevel = 1;
    candidateReason = 'немного дуется';
    coldHours = 0.5 + rand() * 2;
  }

  let level = Math.max(normalizeLevel(current.level), candidateLevel);
  let reason = candidateLevel > 0 ? candidateReason : current.reason ?? '';

  if (score.annoyance > 85 && score.cringe > 70 && score.interest < -30) {
    level = 4;
    reason = 'на грани разрыва';
    coldHours = Math.max(coldHours, 48 + rand() * 48);
  }

  if (level === 0) return current;

  const existingCold = toEpochMs(current.coldUntil);
  let coldUntil = current.coldUntil;
  if (coldHours > 0) {
    const candidateUntil = now + coldHours * HOUR_MS;
    const existingUntil = existingCold ?? 0;
    if (candidateUntil > existingUntil) {
      coldUntil = new Date(candidateUntil).toISOString();
    }
  }

  const changed = level !== normalizeLevel(current.level) || coldUntil !== current.coldUntil;
  if (!changed) return current;

  const since =
    current.since && normalizeLevel(current.level) > 0
      ? current.since
      : new Date(now).toISOString();

  const history = pushHistory(current, {
    ts: new Date(now).toISOString(),
    note: `level ${normalizeLevel(current.level)}→${level}: ${reason}${
      incomingText ? ` | "${truncate(incomingText, 60)}"` : ''
    }`,
    deltaLevel: level - normalizeLevel(current.level),
  });

  return {
    level: level as ConflictState['level'],
    coldUntil,
    reason,
    since,
    history,
  };
}

/**
 * Softening: enough positive movement (attraction + trust + interest ≥ 12)
 * lowers the level by exactly one and halves the remaining cold period.
 */
export function softenFromMood(
  current: ConflictState,
  delta: MoodDelta | null | undefined,
  now = Date.now(),
): ConflictState {
  const level = normalizeLevel(current.level);
  if (level === 0) return current;

  const positive =
    (delta?.attraction ?? 0) + (delta?.trust ?? 0) + (delta?.interest ?? 0);
  if (positive < 12) return current;

  const nextLevel = (level - 1) as ConflictState['level'];
  const coldUntil =
    nextLevel === 0
      ? undefined
      : (() => {
          const remaining = coldRemainingMs(current, now);
          return remaining > 0 ? new Date(now + remaining / 2).toISOString() : undefined;
        })();

  return {
    level: nextLevel,
    coldUntil,
    reason: nextLevel === 0 ? undefined : current.reason,
    since: nextLevel === 0 ? undefined : current.since,
    history: pushHistory(current, {
      ts: new Date(now).toISOString(),
      note: `softened to level ${nextLevel} (positive ${positive})`,
      deltaLevel: -1,
    }),
  };
}

/** The runtime order from the reference: escalate first, then soften. */
export function updateConflictFromMood(
  current: ConflictState,
  delta: MoodDelta,
  score: RelationshipScore,
  incomingText = '',
  clock: ConflictClock = {},
): ConflictState {
  const now = clock.now ?? Date.now();
  const escalated = escalateFromMood(current, delta, score, incomingText, {
    now,
    rand: clock.rand,
  });
  return softenFromMood(escalated, delta, now);
}

/** Small helper for `spoiled` minutes in a prompt: ceil, never negative. */
export function coldHoursLeft(conflict: ConflictState | null, now = Date.now()): number {
  return Math.ceil(coldRemainingMs(conflict, now) / HOUR_MS);
}

export const RELATIONSHIP_LIMITS = { min: -100, max: 100 } as const;
export const CONFLICT_COLD_MIN_MS = MINUTE_MS;
export const DUMPED_PRESET = DUMPED;
