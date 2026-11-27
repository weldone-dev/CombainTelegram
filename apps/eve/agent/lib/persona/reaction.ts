/**
 * Deterministic policy for an incoming Telegram reaction to her own message.
 *
 * This is deliberately a pure function: the Eve channel supplies the frozen
 * relationship/conflict/history snapshot and this module decides whether the
 * reaction deserves a model turn, a reaction back, or silence. No randomness
 * and no I/O, so the same state always produces the same answer (and the table
 * tests stay stable).
 */

import { activeConflict, isWarmStage } from './relationship';
import type {
  BehaviorDecision,
  ConflictState,
  MoodDelta,
  RelationshipScore,
  Stage,
} from './types';

/**
 * Emoji that count as positive. Anything outside this whitelist (👎, 🤮, 💀,
 * 😐, …) is ignored as a *reply trigger*: the persona never guesses hostility
 * from an unknown reaction. Toxic emoji still move her mood, though — see
 * `reactionMoodDelta`.
 */
export const POSITIVE_REACTIONS: ReadonlySet<string> = new Set([
  '❤',
  '♥',
  '💕',
  '💖',
  '💋',
  '👍',
  '👏',
  '🙌',
  '🙏',
  '🔥',
  '✨',
  '🎉',
  '💯',
  '😍',
  '🥰',
  '😘',
  '😻',
  '🤗',
  '🤩',
  '😁',
  '😊',
  '😂',
  '🥳',
  '😌',
]);

/** Strong emoji that can carry a short reply when the bond is warm. */
export const STRONG_POSITIVE_REACTIONS: ReadonlySet<string> = new Set([
  '❤',
  '♥',
  '💕',
  '💖',
  '💋',
  '🔥',
  '😍',
  '🥰',
  '😘',
  '😻',
]);

/** Do not turn every reaction into a message: 5 minutes between reactions. */
export const REACTION_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Toxic/negative emoji. They never produce an answer, they only nudge the
 * relationship counters — like a real person silently registering that a joke
 * did not land.
 */
export const TOXIC_REACTIONS: ReadonlySet<string> = new Set([
  '💀',
  '🤡',
  '👎',
  '😐',
  '🙄',
  '🤮',
  '💩',
  '🖕',
]);

/** Mood changes are throttled, so a burst of emoji is not a burst of damage. */
export const REACTION_MOOD_COOLDOWN_MS = 2 * 60 * 1000;

const TOXIC_MOOD: Record<string, MoodDelta> = {
  '💀': { annoyance: 5, cringe: 3, attraction: -1, interest: -1 },
  '🤡': { annoyance: 4, cringe: 4, interest: -1 },
  '👎': { annoyance: 3, cringe: 2, interest: -1 },
  '😐': { annoyance: 2, cringe: 1 },
  '🙄': { annoyance: 3, cringe: 2 },
  '🤮': { annoyance: 5, cringe: 3, attraction: -2 },
  '💩': { annoyance: 4, cringe: 3, attraction: -1 },
  '🖕': { annoyance: 6, cringe: 2, attraction: -2, interest: -2 },
};

/** Mood delta for a negative reaction; `undefined` for unknown/neutral ones. */
export function reactionMoodDelta(emoji: string): MoodDelta | undefined {
  const normalized = normalizeReactionEmoji(emoji);
  const delta = TOXIC_MOOD[normalized];
  return delta ? { ...delta } : undefined;
}

/** True when a mood change may be applied: one change per short window. */
export function reactionMoodAllowed(
  lastMoodAt: number | undefined,
  now: number,
  cooldownMs = REACTION_MOOD_COOLDOWN_MS,
): boolean {
  if (typeof lastMoodAt !== 'number' || !Number.isFinite(lastMoodAt)) {
    return true;
  }
  return now - lastMoodAt >= cooldownMs;
}

/**
 * Reaction the channel must send for a behavior decision, regardless of
 * whether the decision also starts a reply. Keeping this pure makes the
 * "reaction-only stays a reaction" rule testable without an Eve session.
 */
export interface ReactionPlan {
  emoji: string;
  targetMessageId?: number;
}

export function reactionPlan(
  decision: Pick<BehaviorDecision, 'reaction' | 'reactionTargetMessageId'>,
  fallbackMessageId?: number,
): ReactionPlan | null {
  if (!decision.reaction) return null;
  const target =
    typeof decision.reactionTargetMessageId === 'number' &&
    Number.isFinite(decision.reactionTargetMessageId)
      ? Math.trunc(decision.reactionTargetMessageId)
      : fallbackMessageId;
  return {
    emoji: decision.reaction,
    ...(typeof target === 'number' && target > 0
      ? { targetMessageId: target }
      : {}),
  };
}

/**
 * `interest + trust + attraction` required for a strong emoji to become a
 * short reply instead of a reaction back. The scale is -100..100 per counter.
 */
export const REACTION_REPLY_WARMTH = 90;

const VARIATION_SELECTORS = /[\uFE0E\uFE0F]/g;
const ZERO_WIDTH_JOINER = /[\u200D]/g;

export type ReactionAction = 'ignore' | 'react' | 'reply';

export interface ReactionDecision {
  action: ReactionAction;
  /** Stable reason code, used in logs and the channel response. */
  reason: string;
  /** Emoji to send back when `action === 'react'`. */
  emoji?: string;
  /** Silent mood change for a toxic reaction (never answered). */
  moodDelta?: MoodDelta;
}

export interface ReactionPolicyInput {
  emoji: string;
  /** True only when the reacted-to message is hers. */
  targetIsMine?: boolean;
  stage: Stage;
  conflict?: ConflictState | null;
  score?: Partial<RelationshipScore>;
  /** Epoch ms; defaults to `Date.now()`. */
  now?: number;
  /** Timestamp of her latest outgoing message, if any. */
  lastHerMessageAt?: number;
  /** Timestamp of her last reaction answer, if the caller tracks it. */
  lastReactionAt?: number;
  cooldownMs?: number;
}

/**
 * Telegram sends `❤️` (U+2764 U+FE0F) while its reaction API uses `❤`; strip
 * variation selectors so both spellings hit the same whitelist entry.
 */
export function normalizeReactionEmoji(value: string): string {
  return value
    .replace(VARIATION_SELECTORS, '')
    .replace(ZERO_WIDTH_JOINER, '')
    .trim();
}

function warmthOf(score: Partial<RelationshipScore> | undefined): number {
  const value = (input: unknown): number => {
    const numeric = Number(input);
    return Number.isFinite(numeric) ? numeric : 0;
  };
  return (
    value(score?.interest) + value(score?.trust) + value(score?.attraction)
  );
}

function isRecent(
  at: number | undefined,
  now: number,
  cooldownMs: number,
): boolean {
  if (typeof at !== 'number' || !Number.isFinite(at)) return false;
  const delta = now - at;
  return delta >= 0 && delta < cooldownMs;
}

/**
 * Decides what she does with one reaction. The order is intentional: cheap
 * identity checks first, then relationship gates, then cooldown, then the
 * reply/react choice.
 */
export function decideReaction(input: ReactionPolicyInput): ReactionDecision {
  const now = input.now ?? Date.now();
  const emoji = normalizeReactionEmoji(input.emoji);
  if (!emoji) return { action: 'ignore', reason: 'no-emoji' };
  if (input.targetIsMine !== true) return { action: 'ignore', reason: 'not-mine' };
  // A negative reaction is never answered. It is not ignored either: the mood
  // moves, but only when the caller's throttle allows it (the channel keeps
  // the timestamp). Cold stages simply have less to lose.
  const toxicDelta = reactionMoodDelta(emoji);
  if (toxicDelta) {
    return {
      action: 'ignore',
      reason: 'toxic',
      ...(input.stage === 'dumped' ? {} : { moodDelta: toxicDelta }),
    };
  }
  if (!POSITIVE_REACTIONS.has(emoji)) {
    return { action: 'ignore', reason: 'not-positive' };
  }
  // `isWarmStage` is convinced and above; cold stages never engage.
  if (!isWarmStage(input.stage)) {
    return { action: 'ignore', reason: 'cold-stage' };
  }
  if (activeConflict(input.conflict ?? null, now).active) {
    return { action: 'ignore', reason: 'conflict' };
  }
  const cooldown = Math.max(0, input.cooldownMs ?? REACTION_COOLDOWN_MS);
  if (
    isRecent(input.lastHerMessageAt, now, cooldown) ||
    isRecent(input.lastReactionAt, now, cooldown)
  ) {
    return { action: 'ignore', reason: 'cooldown' };
  }

  if (STRONG_POSITIVE_REACTIONS.has(emoji) && warmthOf(input.score) >= REACTION_REPLY_WARMTH) {
    return { action: 'reply', reason: 'warm-strong' };
  }
  return { action: 'react', reason: 'warm', emoji };
}
