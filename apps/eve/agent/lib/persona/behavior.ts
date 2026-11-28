/**
 * Behavior tick: decide *what to do* without writing the reply text.
 *
 * The core pipeline is deterministic and pure. An optional async callback may
 * be supplied for the one LLM decision call; everything else (active dialog,
 * conflict cold, sleep, night wake, fallback, post-processing) is local.
 */

import {
  DEFAULT_COMMUNICATION,
  ignoreTendencyPrompt,
  normalizeCommunicationProfile,
  normalizeIgnoreTendency,
  communicationPromptFragment,
} from './communication';
import { computePresenceProfile } from './presence';
import { blockAtHour } from './daily-life';
import {
  applyMoodDelta,
  clampScore,
  coldRemainingMs,
  findStage,
  isWarmStage,
} from './relationship';
import { clamp, clampInt, finiteNumber, localParts } from './time';
import type {
  BehaviorContext,
  BehaviorDecision,
  BehaviorIntent,
  CommunicationProfile,
  ConversationTurn,
  HormoneState,
  MoodDelta,
  PresenceState,
  RelationshipScore,
  Stage,
} from './types';

export const COLD_IGNORE_CHANCE = 0.8;
export const SLEEP_IGNORE_BASE = 0.85;
export const NIGHT_FELL_ASLEEP_CHANCE = 0.15;
export const NIGHT_ANNOYANCE = 5;

const NON_REPLY_INTENTS = new Set<BehaviorIntent>([
  'ignore',
  'left-on-read',
  'reaction-only',
]);

const KNOWN_INTENTS: BehaviorIntent[] = [
  'reply',
  'ignore',
  'short',
  'left-on-read',
  'leave-chat',
  'reaction-only',
];

export interface BehaviorLlmRequest {
  system: string;
  user: string;
  temperature: number;
  maxTokens: number;
  json: true;
}

/** May return a parsed object or a raw JSON string. */
export type BehaviorLlmDecider = (request: BehaviorLlmRequest) => Promise<unknown>;

export const BEHAVIOR_SYSTEM_PROMPT =
  'Ты — внутренний decision-layer симуляции живой девушки. ' +
  'По состоянию реши, как она отреагирует на новое сообщение. ' +
  'Только JSON, без пояснений и текста ответа.';

function getRand(ctx: BehaviorContext): () => number {
  return ctx.rand ?? Math.random;
}

function getPresence(ctx: BehaviorContext): PresenceState {
  if (ctx.presence) return ctx.presence;
  const now = ctx.now ?? Date.now();
  return {
    online: true,
    asleep: false,
    nightAwake: false,
    nextCheckSec: 0,
    localHour: Math.floor((now / 3_600_000) % 24),
    hint: '',
    pattern: computePresenceProfile(ctx.config).pattern,
    coldActive: false,
    forcedWake: false,
  };
}

function isCold(ctx: BehaviorContext, now: number): boolean {
  if (typeof ctx.conflictColdActive === 'boolean') return ctx.conflictColdActive;
  return coldRemainingMs(ctx.conflict, now) > 0;
}

function getStage(ctx: BehaviorContext): Stage {
  return ctx.stage ?? ctx.config.stage;
}

function getScore(ctx: BehaviorContext): RelationshipScore {
  return clampScore(ctx.score);
}

function getCommunication(ctx: BehaviorContext): CommunicationProfile {
  return normalizeCommunicationProfile(ctx.config);
}

type HormoneMultiplierKey =
  | 'replyChanceMultiplier'
  | 'ignoreChanceMultiplier'
  | 'delayMultiplier'
  | 'bubbleMultiplier';

/**
 * Read one cycle multiplier. Absent hormones mean `1`, so behavior without a
 * `HormoneState` stays exactly what it was before the mechanic existed.
 */
export function hormoneMultiplier(
  hormones: HormoneState | undefined,
  key: HormoneMultiplierKey,
): number {
  if (!hormones) return 1;
  const value = hormones[key];
  return Number.isFinite(value) ? clamp(value, 0.2, 3) : 1;
}

/** Apply the cycle's bubble multiplier, never returning less than one bubble. */
export function applyHormoneBubbles(
  count: number,
  hormones?: HormoneState,
): number {
  if (!hormones) return count;
  return Math.max(
    1,
    Math.round(count * hormoneMultiplier(hormones, 'bubbleMultiplier')),
  );
}

/* ------------------------------------------------------------------ */
/* Small deterministic helpers                                         */
/* ------------------------------------------------------------------ */

/** Explicit multiplier from the communication style (textbook table). */
export function sleepIgnoreMultiplier(config: BehaviorContext['config']): number {
  const notifications = normalizeCommunicationProfile(config).notifications;
  return notifications === 'priority' ? 0.8 : notifications === 'muted' ? 1 : 0.9;
}

/** Final sleep-ignore probability: 68% / 76.5% / 85%. */
export function sleepIgnoreChance(config: BehaviorContext['config']): number {
  return clamp(SLEEP_IGNORE_BASE * sleepIgnoreMultiplier(config), 0, 1);
}

/**
 * Delay while actively texting, 2–8 s total: priority 2–5, normal 3–7,
 * muted 5–8. A live dialogue should feel like a phone call, not a queue.
 */
export function activeDialogDelay(
  config: BehaviorContext['config'],
  rand: () => number,
): number {
  const comm = normalizeCommunicationProfile(config);
  const [min, max] =
    comm.notifications === 'priority'
      ? [2, 5]
      : comm.notifications === 'muted'
        ? [5, 8]
        : [3, 7];
  return min + rand() * (max - min);
}

export function sampleBubbles(
  communication: CommunicationProfile,
  activeDialog: boolean,
  rand: () => number,
): number {
  switch (communication.messageStyle) {
    case 'one-liners':
      return activeDialog && rand() > 0.82 ? 2 : 1;
    case 'bursty':
      return activeDialog
        ? 2 + Math.floor(rand() * 4)
        : rand() < 0.18
          ? 1
          : 2 + Math.floor(rand() * 3);
    case 'longform':
      return activeDialog
        ? rand() < 0.2
          ? 1
          : 2 + Math.floor(rand() * 2)
        : rand() < 0.45
          ? 1
          : 2;
    case 'balanced':
    default:
      if (activeDialog) {
        const r = rand();
        return r < 0.3 ? 1 : r < 0.82 ? 2 : 3;
      }
      const r = rand();
      return r < 0.55 ? 1 : r < 0.9 ? 2 : 3;
  }
}

export function normalizeBubbles(
  value: unknown,
  communication: CommunicationProfile,
  intent: BehaviorIntent,
  activeDialog: boolean,
  rand: () => number,
): number {
  if (NON_REPLY_INTENTS.has(intent) || intent === 'short') return 1;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return sampleBubbles(communication, activeDialog, rand);
  const max =
    communication.messageStyle === 'one-liners'
      ? activeDialog
        ? 2
        : 1
      : communication.messageStyle === 'bursty'
        ? 6
        : communication.messageStyle === 'longform'
          ? 4
          : 3;
  return clampInt(n, 1, max);
}

export function ignoreMultiplier(
  config: BehaviorContext['config'],
  tendency: number,
): number {
  const comm = normalizeCommunicationProfile(config);
  let value = comm.notifications === 'priority' ? 0.3 : comm.notifications === 'muted' ? 1.15 : 0.75;
  if (comm.initiative === 'high') value *= 0.75;
  if (comm.lifeSharing === 'high') value *= 0.85;
  if (comm.messageStyle === 'one-liners' && comm.initiative === 'low') value *= 1.15;
  value *= 0.35 + normalizeIgnoreTendency(tendency) / 35;
  return value;
}

export function adjustDelay(
  delaySec: number,
  config: BehaviorContext['config'],
  ctx: Pick<BehaviorContext, 'presence' | 'activeDialog'>,
  rand: () => number,
): number {
  const comm = normalizeCommunicationProfile(config);
  let delay = Number.isFinite(delaySec) ? delaySec : 30;
  if (comm.notifications === 'priority') delay *= 0.45;
  else if (comm.notifications === 'muted') delay *= 1.15;
  else delay *= 0.8;
  if (comm.initiative === 'high') delay *= 0.85;

  if (ctx.activeDialog && ctx.presence?.asleep !== true) {
    // A live dialogue overrides the stage/presence pause instead of merely
    // capping it: 2–8 seconds by communication style, no +20 s slack. This is
    // also the dueAt of a deferred turn that a new message superseded while
    // the dialogue was open. Sleep still wins: a 03:00 answer stays sleepy.
    delay = activeDialogDelay(config, rand);
  }
  if (ctx.presence?.online) {
    delay = Math.min(delay, comm.notifications === 'priority' ? 120 : 240);
  }
  if (ctx.presence?.notificationSeen) {
    delay = Math.min(delay, comm.notifications === 'priority' ? 300 : 900);
  }
  return Math.round(clamp(delay, 0, 3600));
}

export function recoverDelay(
  config: BehaviorContext['config'],
  ctx: Pick<BehaviorContext, 'presence' | 'activeDialog'>,
  rand: () => number,
): number {
  const comm = normalizeCommunicationProfile(config);
  if (ctx.activeDialog) {
    return Math.round(activeDialogDelay(config, rand));
  }
  if (ctx.presence?.online) {
    return Math.round(
      comm.notifications === 'priority' ? 5 + rand() * 55 : 15 + rand() * 120,
    );
  }
  if (ctx.presence?.notificationSeen) {
    return Math.round(
      comm.notifications === 'priority' ? 30 + rand() * 210 : 120 + rand() * 600,
    );
  }
  return Math.round(
    comm.notifications === 'priority' ? 180 + rand() * 600 : 300 + rand() * 1500,
  );
}

export interface ReactionPalette {
  allowed: string[];
  forbidden: string[];
  replacements: string[];
}

export function reactionPalette(stage: Stage, score: RelationshipScore): ReactionPalette {
  const warm = score.attraction > 30 || isWarmStage(stage);
  const cold = score.annoyance > 40 || stage === 'tg-given-cold';
  // Warm wins when both flags are true, matching the reference.
  if (warm) {
    return {
      allowed: ['❤', '🥰', '🥹', '😂', '🤭', '🔥', '👀', '🥺', '😅'],
      forbidden: ['🤡', '💀', '🤮', '🖕', '😐', '🙄'],
      replacements: ['😂', '❤', '🥹'],
    };
  }
  if (cold) {
    return {
      allowed: ['👍', '👌', '😐', '🙄', '🤡', '💀', '🤔'],
      forbidden: ['❤', '❤️', '🥰', '🥹', '🥺', '🔥'],
      replacements: ['👍', '😐', '🤔'],
    };
  }
  return {
    allowed: ['👍', '😂', '🤔', '👀', '😅', '🙂'],
    forbidden: [],
    replacements: ['👍', '😂', '🤔'],
  };
}

export function sanitizeReaction(
  value: unknown,
  stage: Stage,
  score: RelationshipScore,
  rand: () => number = Math.random,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const emoji = value.trim();
  const chars = [...emoji];
  if (chars.length < 1 || chars.length > 4) return undefined;
  const palette = reactionPalette(stage, score);
  if (palette.forbidden.includes(emoji)) {
    return palette.replacements[Math.floor(rand() * palette.replacements.length)];
  }
  return emoji;
}

/** Probability that a refusal turns into a reaction instead of silence. */
export const BUSY_LEFT_ON_READ_CHANCE = 0.35;

export interface ReactionOnlyPlan {
  reaction: string;
  reactionTargetMessageId?: number;
}

/**
 * Deterministic "react instead of replying". The reference gets this from an
 * LLM behavior-tick; here it is derived from the same inputs the fallback
 * already has: warm stage, no active conflict, and the persona's ignore
 * tendency. Silence plus a heart is a real conversational move, and unlike an
 * LLM call it costs nothing and works without a provider.
 */
export function reactionOnlyChance(ctx: BehaviorContext): number {
  const stage = getStage(ctx);
  if (!isWarmStage(stage)) return 0;
  const score = getScore(ctx);
  if (score.annoyance > 45 || score.cringe > 45) return 0;
  if (isCold(ctx, ctx.now ?? Date.now())) return 0;
  if (reactionPalette(stage, score).allowed.length === 0) return 0;
  const tendency = normalizeIgnoreTendency(ctx.config.ignoreTendency);
  return clamp(0.12 + tendency / 220, 0.08, 0.55);
}

/** Picks a palette emoji and the newest incoming id when the roll succeeds. */
export function pickReactionOnly(
  ctx: BehaviorContext,
  rand: () => number = getRand(ctx),
): ReactionOnlyPlan | null {
  const chance = reactionOnlyChance(ctx);
  if (chance <= 0 || rand() >= chance) return null;
  const palette = reactionPalette(getStage(ctx), getScore(ctx));
  const emoji =
    palette.allowed[Math.floor(rand() * palette.allowed.length)] ??
    palette.allowed[0];
  if (!emoji) return null;
  const target = ctx.recentIncomingIds?.[ctx.recentIncomingIds.length - 1];
  return {
    reaction: emoji,
    ...(target && Number.isSafeInteger(target.messageId) && target.messageId > 0
      ? { reactionTargetMessageId: target.messageId }
      : {}),
  };
}

/** Busy slot the caller already detected in `computePresenceState`. */
export function busyDelaySec(ctx: BehaviorContext): number | null {
  const busy = ctx.presence?.busy;
  if (!busy || ctx.activeDialog === true) return null;
  return Math.round(clamp(busy.checkAfterMin * 60, 30, 3600));
}

export function canRecoverReply(
  stage: Stage,
  score: RelationshipScore,
  ctx: Pick<BehaviorContext, 'presence' | 'conflictColdActive' | 'conflict'>,
  now = Date.now(),
): boolean {
  if (stage === 'dumped') return false;
  if (ctx.conflictColdActive || coldRemainingMs(ctx.conflict, now) > 0) return false;
  if (ctx.presence?.asleep && !ctx.presence.nightAwake) return false;
  if (score.annoyance > 65) return false;
  if (stage === 'tg-given-cold' && score.interest < 20 && score.attraction < 20) {
    return false;
  }
  return true;
}

export function recoverReplyChance(
  config: BehaviorContext['config'],
  score: RelationshipScore,
  tendency: number,
): number {
  const comm = normalizeCommunicationProfile(config);
  let chance =
    comm.notifications === 'priority' ? 0.72 : comm.notifications === 'muted' ? 0.16 : 0.38;
  if (comm.initiative === 'high') chance += 0.16;
  if (comm.initiative === 'low') chance -= 0.1;
  if (comm.lifeSharing === 'high') chance += 0.08;
  chance -= (normalizeIgnoreTendency(tendency) - 35) / 100;
  if (score.interest > 40) chance += 0.12;
  if (score.attraction > 50) chance += 0.1;
  if (score.annoyance > 30) chance -= 0.2;
  return clamp(chance, 0.03, 0.95);
}

function sanitizeIntent(value: unknown): BehaviorIntent {
  return typeof value === 'string' && (KNOWN_INTENTS as string[]).includes(value)
    ? (value as BehaviorIntent)
    : 'reply';
}

function sanitizeMoodDelta(value: unknown): MoodDelta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const out: MoodDelta = {};
  for (const key of ['interest', 'trust', 'attraction', 'annoyance', 'cringe'] as const) {
    const n = raw[key];
    if (typeof n === 'number' && Number.isFinite(n)) {
      out[key] = clampInt(n, -20, 20);
    }
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function parseDecisionPayload(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    const text = raw
      .replace(/^\s*```(?:json)?/i, '')
      .replace(/```\s*$/, '')
      .trim();
    if (!text) return null;
    try {
      return asRecord(JSON.parse(text));
    } catch {
      const match = /\{[\s\S]*\}/.exec(text);
      if (!match) return null;
      try {
        return asRecord(JSON.parse(match[0]));
      } catch {
        return null;
      }
    }
  }
  return asRecord(raw);
}

/* ------------------------------------------------------------------ */
/* Fallback + post-processing                                          */
/* ------------------------------------------------------------------ */

export function fallbackDecision(ctx: BehaviorContext): BehaviorDecision {
  const rand = getRand(ctx);
  const stage = getStage(ctx);
  const preset = findStage(stage).defaults;
  const comm = getCommunication(ctx);
  const tendency = ctx.config.ignoreTendency ?? 35;
  const ignoreChance = clamp(
    preset.ignoreChance *
      ignoreMultiplier(ctx.config, tendency) *
      hormoneMultiplier(ctx.hormones, 'ignoreChanceMultiplier'),
    0,
    1,
  );
  const ignore = rand() < ignoreChance;
  const [lo, hi] = preset.replyDelaySec;
  const rawDelay =
    (lo + rand() * (hi - lo)) *
    hormoneMultiplier(ctx.hormones, 'delayMultiplier');
  let delaySec = adjustDelay(rawDelay, ctx.config, ctx, rand);

  // Ignoring a message is a decision, not always silence: on a warm stage a
  // piece of the refusals becomes a reaction-only turn. This is the live
  // producer for `decision.reaction` that the channel already knows how to send.
  if (ignore) {
    const reaction = pickReactionOnly(ctx, rand);
    if (reaction) {
      return {
        intent: 'reaction-only',
        shouldReply: false,
        shouldRead: true,
        delaySec: 0,
        bubbles: 1,
        typing: false,
        ignoreReason: 'reaction-only',
        moodDelta: { interest: 1 },
        source: 'fallback',
        ...reaction,
      };
    }
  }

  // Busy outside an active dialog: "phone in the bag" has to cost time or the
  // message itself, not only a hint line. An active dialog always wins.
  const busyDelay = busyDelaySec(ctx);
  if (!ignore && busyDelay !== null) {
    if (rand() < BUSY_LEFT_ON_READ_CHANCE) {
      return {
        intent: 'left-on-read',
        shouldReply: false,
        shouldRead: false,
        delaySec: 0,
        bubbles: 1,
        typing: false,
        ignoreReason: `busy: ${ctx.presence?.busy?.label ?? 'занята'}`,
        moodDelta: {},
        source: 'fallback',
      };
    }
    delaySec = Math.max(delaySec, busyDelay);
  }

  // Period/PMS flag: one dry bubble instead of a normal answer.
  const intent: BehaviorIntent = ignore
    ? 'ignore'
    : ctx.hormones?.shortReplies
      ? 'short'
      : 'reply';

  return {
    intent,
    shouldReply: !ignore,
    shouldRead: true,
    delaySec,
    bubbles:
      ignore || intent === 'short'
        ? 1
        : applyHormoneBubbles(
            sampleBubbles(comm, ctx.activeDialog === true, rand),
            ctx.hormones,
          ),
    typing: !ignore,
    ignoreReason: ignore ? 'fallback' : undefined,
    moodDelta: {},
    source: 'fallback',
  };
}

/**
 * Daily-life block: `phoneAvailable=false` means she is in class, at work, in
 * the shower or asleep. Like the reference `blockHint`, the day is a real gate,
 * not a prompt ornament: she either leaves it on read or answers when the block
 * ends. An active dialog always wins, otherwise a person would vanish mid
 * conversation for no reason.
 */
export function quietBlockDecision(
  ctx: BehaviorContext,
  rand: () => number = getRand(ctx),
): BehaviorDecision | null {
  if (!ctx.dailyLife) return null;
  if (ctx.activeDialog === true) return null;
  const presence = ctx.presence;
  if (presence?.nightAwake || presence?.forcedWake) return null;
  if (presence?.asleep) return null;
  if (isCold(ctx, ctx.now ?? Date.now())) return null;

  const now = ctx.now ?? Date.now();
  const hour = localParts(now, ctx.config.timezone).hour;
  const block = blockAtHour(ctx.dailyLife, hour);
  if (!block || block.phoneAvailable) return null;

  const minutesLeft =
    block.toHour > block.fromHour
      ? (block.toHour - hour) * 60
      : ((block.toHour + 24 - hour) % 24) * 60;
  // A glance at the phone inside the block still happens; the rest of the time
  // the message waits. 70% silence keeps "занята" believable without turning
  // her into a brick wall. A reaction is the cheapest "I saw it" signal.
  if (rand() < 0.7) {
    const reaction = pickReactionOnly(ctx, rand);
    return {
      intent: reaction ? 'reaction-only' : 'left-on-read',
      shouldReply: false,
      shouldRead: !reaction,
      delaySec: 0,
      bubbles: 1,
      typing: false,
      ignoreReason: `phone-unavailable: ${block.activity}`,
      moodDelta: {},
      source: 'fallback',
      ...(reaction ?? {}),
    };
  }

  const busyDelay = busyDelaySec(ctx);
  const delaySec = Math.round(
    clamp(
      Math.max(
        15 * 60,
        minutesLeft * 60,
        busyDelay ?? 0,
      ) * hormoneMultiplier(ctx.hormones, 'delayMultiplier'),
      60,
      3600,
    ),
  );
  const bubbles = applyHormoneBubbles(1, ctx.hormones);
  return {
    intent: ctx.hormones?.shortReplies ? 'short' : 'reply',
    shouldReply: true,
    shouldRead: true,
    delaySec,
    bubbles: Math.max(1, bubbles),
    typing: true,
    ignoreReason: undefined,
    moodDelta: {},
    source: 'fallback',
  };
}

function nightFallback(ctx: BehaviorContext): BehaviorDecision {
  const rand = getRand(ctx);
  const delaySec = Math.round(
    clamp(
      (10 + rand() * 110) *
        hormoneMultiplier(ctx.hormones, 'delayMultiplier'),
      10,
      120,
    ),
  );
  return {
    intent: 'short',
    shouldReply: true,
    shouldRead: true,
    delaySec,
    bubbles: 1,
    typing: true,
    moodDelta: { annoyance: 3 },
    source: 'night-wake',
  };
}

export function postProcessDecision(raw: unknown, ctx: BehaviorContext): BehaviorDecision {
  const parsed = parseDecisionPayload(raw);
  if (!parsed) return fallbackDecision(ctx);

  const rand = getRand(ctx);
  const now = ctx.now ?? Date.now();
  const stage = getStage(ctx);
  const score = getScore(ctx);
  const comm = getCommunication(ctx);

  let intent = sanitizeIntent(parsed.intent);
  let shouldReply =
    parsed.shouldReply === true && !NON_REPLY_INTENTS.has(intent);
  let shouldRead =
    parsed.shouldRead === true ? true : parsed.shouldRead === false ? false : true;
  let typing = parsed.typing === true ? true : parsed.typing === false ? false : true;
  let ignoreReason =
    typeof parsed.ignoreReason === 'string' && parsed.ignoreReason.trim()
      ? parsed.ignoreReason.trim().slice(0, 120)
      : undefined;

  const reaction = sanitizeReaction(parsed.reaction, stage, score, rand);
  const targetRaw = finiteNumber(parsed.reactionTargetMessageId, Number.NaN);
  const reactionTargetMessageId = reaction && Number.isFinite(targetRaw)
    ? Math.floor(targetRaw)
    : undefined;

  let delaySec = finiteNumber(parsed.delaySec, 30);
  let bubbles = normalizeBubbles(
    parsed.bubbles,
    comm,
    intent,
    ctx.activeDialog === true,
    rand,
  );
  const moodDelta = sanitizeMoodDelta(parsed.moodDelta);

  const tendency = ctx.config.ignoreTendency ?? 35;
  if (
    !shouldReply &&
    canRecoverReply(stage, score, ctx, now) &&
    rand() <
      clamp(
        recoverReplyChance(ctx.config, score, tendency) *
          hormoneMultiplier(ctx.hormones, 'replyChanceMultiplier'),
        0.03,
        0.98,
      )
  ) {
    shouldReply = true;
    shouldRead = true;
    typing = true;
    ignoreReason = undefined;
    intent = comm.messageStyle === 'one-liners' ? 'short' : 'reply';
    delaySec = recoverDelay(ctx.config, ctx, rand);
    bubbles = sampleBubbles(comm, ctx.activeDialog === true, rand);
  }

  delaySec = adjustDelay(
    delaySec * hormoneMultiplier(ctx.hormones, 'delayMultiplier'),
    ctx.config,
    ctx,
    rand,
  );
  bubbles = applyHormoneBubbles(
    normalizeBubbles(bubbles, comm, intent, ctx.activeDialog === true, rand),
    ctx.hormones,
  );
  if (shouldReply && ctx.hormones?.shortReplies && intent === 'reply' && bubbles === 1) {
    intent = 'short';
  }

  return {
    intent,
    shouldReply,
    shouldRead,
    delaySec,
    bubbles,
    typing,
    ignoreReason,
    moodDelta,
    reaction,
    reactionTargetMessageId,
    source: 'llm',
  };
}

/* ------------------------------------------------------------------ */
/* Prompt for the optional LLM decision call                           */
/* ------------------------------------------------------------------ */

function historyLines(history: ConversationTurn[] | undefined): string {
  if (!history || history.length === 0) return '(нет истории)';
  return history
    .slice(-8)
    .map((turn) => `${turn.role === 'user' ? 'он' : 'она'}: ${turn.content}`)
    .join('\n');
}

function formatIds(ids: BehaviorContext['recentIncomingIds']): string {
  if (!ids || ids.length === 0) return '(нет)';
  return ids
    .slice(-10)
    .map((ref) => `${ref.messageId}: "${ref.text.slice(0, 60)}"`)
    .join('\n');
}

export function behaviorDecisionPrompt(ctx: BehaviorContext): BehaviorLlmRequest {
  const stage = getStage(ctx);
  const preset = findStage(stage);
  const score = getScore(ctx);
  const comm = getCommunication(ctx);
  const tendency = ctx.config.ignoreTendency ?? 35;
  const presence = getPresence(ctx);
  const now = ctx.now ?? Date.now();
  const conflict = ctx.conflict ?? null;
  const coldMs = coldRemainingMs(conflict, now);
  const palette = reactionPalette(stage, score);

  const user = [
    `стадия=${stage} (${preset.label})`,
    `score=${JSON.stringify(score)}`,
    `base_ignore=${preset.defaults.ignoreChance}`,
    `base_delay=${preset.defaults.replyDelaySec[0]}..${preset.defaults.replyDelaySec[1]}`,
    communicationPromptFragment(comm),
    ignoreTendencyPrompt(tendency),
    `присутствие: online=${presence.online}, asleep=${presence.asleep}, nightAwake=${presence.nightAwake}, localHour=${presence.localHour}`,
    `подсказка присутствия: ${presence.hint || '(нет)'}`,
    ctx.hormones
      ? `цикл: фаза ${ctx.hormones.phase}, день ${ctx.hormones.cycleDay}/${ctx.hormones.cycleLength}, раздражительность ${ctx.hormones.irritability.toFixed(2)}, теплота ${ctx.hormones.affection.toFixed(2)}`
      : 'цикл: без особенностей',
    `чем занята: ${ctx.blockHint || '(неизвестно)'}`,
    ctx.activeDialog ? 'активный диалог: да, отвечает быстро' : 'активный диалог: нет',
    conflict && conflict.level > 0
      ? `конфликт: уровень ${conflict.level}${coldMs > 0 ? `, холод ещё ${Math.ceil(coldMs / 3_600_000)} ч` : ', холод истёк, но осадок остался'}; причина: ${conflict.reason ?? '—'}`
      : 'конфликт: нет',
    'последние сообщения:',
    historyLines(ctx.history),
    `новое сообщение: """${ctx.incoming ?? ''}"""`,
    `допустимые реакции: ${palette.allowed.join(' ')}`,
    `запрещённые реакции: ${palette.forbidden.join(' ') || '(нет)'}`,
    'последние message id:',
    formatIds(ctx.recentIncomingIds),
    '',
    'Верни строго JSON:',
    '{"intent":"reply|ignore|short|left-on-read|leave-chat|reaction-only",',
    ' "shouldReply":true,"shouldRead":true,"delaySec":30,"bubbles":1,',
    ' "typing":true,"reaction":"","reactionTargetMessageId":null,',
    ' "ignoreReason":"","moodDelta":{"interest":0,"trust":0,"attraction":0,"annoyance":0,"cringe":0}}',
    '',
    'Правила:',
    '- холод: почти всегда ignore или сухой short;',
    '- сон: ignore или left-on-read с shouldRead=false;',
    '- занята: shouldReply=true и большая задержка, не игнор;',
    '- офлайн: задержка 300–2400 с или ignore с shouldRead=true;',
    '- priority: не превращай каждое офлайн-состояние в игнор;',
    '- bursty: 2–5 пузырей, one-liners: чаще 1;',
    '- moodDelta: маленькие целые числа −10..+10;',
    '- реакция — один эмодзи из разрешённых, иначе пустая строка;',
    '- если он просто улыбнулся скобкой, это не повод расти annoyance/cringe;',
    '- грубость и кринж повышают annoyance, возможен leave-chat.',
  ].join('\n');

  return {
    system: BEHAVIOR_SYSTEM_PROMPT,
    user,
    temperature: 0.7,
    maxTokens: 1200,
    json: true,
  };
}

export function behaviorHint(decision: BehaviorDecision): string {
  if (!decision.shouldReply) return '';
  const lines = [
    `подсказка поведения: intent=${decision.intent}, пузырей=${decision.bubbles}`,
    decision.bubbles > 1
      ? 'разделяй пузыри строкой --- (каждый пузырь с новой строки, без нумерации)'
      : 'ответь одним сообщением',
  ];
  if (decision.intent === 'short') {
    lines.push('отвечай односложно: "ок", "ясно", "и?", "ну ок", "хм"');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Main entry                                                          */
/* ------------------------------------------------------------------ */

/**
 * The only async entry point. Without `decideWithLlm` the main path degrades
 * to the stage fallback; all shortcut branches stay token-free either way.
 */
export async function decideBehavior(
  ctx: BehaviorContext,
  decideWithLlm?: BehaviorLlmDecider,
): Promise<BehaviorDecision> {
  const rand = getRand(ctx);
  const now = ctx.now ?? Date.now();
  const stage = getStage(ctx);
  const presence = getPresence(ctx);
  const comm = getCommunication(ctx);
  const cold = isCold(ctx, now);

  // 0. Terminal stage: ignore everything until an explicit reset.
  if (stage === 'dumped') {
    return {
      intent: 'ignore',
      shouldReply: false,
      shouldRead: false,
      delaySec: 0,
      bubbles: 1,
      typing: false,
      ignoreReason: 'dumped',
      moodDelta: {},
      source: 'dumped',
    };
  }

  // 1. Active dialog: cheapest and liveliest mode, never calls the LLM.
  // Asleep beats it: a reply two minutes ago is not a reason to answer
  // instantly at 03:00. `nightAwake` keeps its own sleepy branch below.
  if (ctx.activeDialog === true && !cold && !presence.asleep) {
    const delaySec = Math.round(
      clamp(
        activeDialogDelay(ctx.config, rand) *
          hormoneMultiplier(ctx.hormones, 'delayMultiplier'),
        2,
        8,
      ),
    );
    const bubbles = applyHormoneBubbles(
      sampleBubbles(comm, true, rand),
      ctx.hormones,
    );
    const intent: BehaviorIntent =
      bubbles > 1 || comm.messageStyle !== 'one-liners' ? 'reply' : 'short';
    return {
      intent,
      shouldReply: true,
      shouldRead: true,
      delaySec,
      bubbles,
      typing: true,
      // Warm cycle phases make her enjoy the dialog a little more.
      moodDelta: { interest: ctx.hormones?.flirt ? 2 : 1 },
      source: 'active-dialog',
    };
  }

  // 2. Cold conflict: 80% instant silence, no read receipt.
  if (cold && rand() < COLD_IGNORE_CHANCE) {
    return {
      intent: 'ignore',
      shouldReply: false,
      shouldRead: false,
      delaySec: 0,
      bubbles: 1,
      typing: false,
      ignoreReason: 'conflict-cold',
      moodDelta: {},
      source: 'conflict-cold',
    };
  }

  // 3. Asleep without a night wake: left on read with style-dependent odds.
  if (presence.asleep && !presence.nightAwake && !presence.forcedWake) {
    const chance = clamp(
      sleepIgnoreChance(ctx.config) *
        hormoneMultiplier(ctx.hormones, 'ignoreChanceMultiplier'),
      0,
      1,
    );
    if (rand() < chance) {
      return {
        intent: 'left-on-read',
        shouldReply: false,
        shouldRead: false,
        delaySec: 0,
        bubbles: 1,
        typing: false,
        ignoreReason: 'asleep',
        moodDelta: {},
        source: 'asleep',
      };
    }
  }

  // 4. Night wake: usually falls back asleep, otherwise a forced short reply.
  if (presence.nightAwake && !presence.forcedWake && presence.asleep) {
    if (
      rand() <
      clamp(
        NIGHT_FELL_ASLEEP_CHANCE *
          hormoneMultiplier(ctx.hormones, 'ignoreChanceMultiplier'),
        0,
        1,
      )
    ) {
      return {
        intent: 'ignore',
        shouldReply: false,
        shouldRead: false,
        delaySec: 0,
        bubbles: 1,
        typing: false,
        ignoreReason: 'night-fell-asleep',
        moodDelta: { annoyance: NIGHT_ANNOYANCE },
        source: 'night-wake',
      };
    }
    if (!decideWithLlm) return nightFallback(ctx);
    try {
      const raw = await decideWithLlm(behaviorDecisionPrompt(ctx));
      const parsed = parseDecisionPayload(raw);
      if (!parsed) return nightFallback(ctx);
      const delay = Math.round(clamp(finiteNumber(parsed.delaySec, 20), 10, 120));
      return {
        intent: 'short',
        shouldReply: true,
        shouldRead: true,
        delaySec: delay,
        bubbles: 1,
        typing: true,
        ignoreReason: undefined,
        reaction: undefined,
        moodDelta:
          parsed.moodDelta && typeof parsed.moodDelta === 'object'
            ? sanitizeMoodDelta(parsed.moodDelta)
            : { annoyance: 3 },
        source: 'night-wake',
      };
    } catch {
      return nightFallback(ctx);
    }
  }

  // 5. Daily-life quiet block: phone unavailable, so she either reads later or
  // answers when the block ends. Deterministic, before any model call.
  const quietBlock = quietBlockDecision(ctx, rand);
  if (quietBlock) return quietBlock;

  // 6. Main LLM path or the stage fallback.
  if (!decideWithLlm) return fallbackDecision(ctx);
  try {
    const raw = await decideWithLlm(behaviorDecisionPrompt(ctx));
    return postProcessDecision(raw, ctx);
  } catch {
    return fallbackDecision(ctx);
  }
}

/** Convenience for callers that apply the decision: which intents count as an
 * ignore for the stage D2 counter. */
export function countsAsIgnore(intent: BehaviorIntent): boolean {
  return intent === 'ignore' || intent === 'left-on-read' || intent === 'reaction-only';
}

/** Apply a decision's mood delta and expose whether it triggered auto-dump. */
export function applyDecisionMood(
  score: RelationshipScore,
  decision: BehaviorDecision,
): { score: RelationshipScore; dumped: boolean } {
  const next = applyMoodDelta(score, decision.moodDelta);
  return {
    score: next,
    dumped: next.annoyance > 80 && next.interest < -30,
  };
}

export const DEFAULT_COMMUNICATION_PROFILE = DEFAULT_COMMUNICATION;
