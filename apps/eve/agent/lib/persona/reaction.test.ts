import { describe, expect, test } from 'bun:test';
import {
  REACTION_COOLDOWN_MS,
  decideReaction,
  normalizeReactionEmoji,
} from './reaction';
import type { ReactionPolicyInput } from './reaction';

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);

const WARM_SCORE = {
  interest: 70,
  trust: 50,
  attraction: 30,
  annoyance: 0,
  cringe: 0,
};

function input(overrides: Partial<ReactionPolicyInput> = {}): ReactionPolicyInput {
  return {
    emoji: '👍',
    targetIsMine: true,
    stage: 'convinced',
    score: WARM_SCORE,
    now: NOW,
    ...overrides,
  };
}

describe('normalizeReactionEmoji', () => {
  test('strips the variation selector Telegram sends with ❤️', () => {
    expect(normalizeReactionEmoji('❤️')).toBe('❤');
    expect(normalizeReactionEmoji(' 🔥 ')).toBe('🔥');
    expect(normalizeReactionEmoji('')).toBe('');
  });
});

describe('decideReaction', () => {
  test('ignores a reaction on his own message', () => {
    expect(decideReaction(input({ targetIsMine: false }))).toEqual({
      action: 'ignore',
      reason: 'not-mine',
    });
    expect(decideReaction(input({ targetIsMine: undefined }))).toEqual({
      action: 'ignore',
      reason: 'not-mine',
    });
  });

  test('ignores negative or unknown emoji', () => {
    for (const emoji of ['👎', '🤮', '😡', '💀', '😐', '🤡', '']) {
      const decision = decideReaction(input({ emoji }));
      expect(decision.action).toBe('ignore');
      if (!emoji) expect(decision.reason).toBe('no-emoji');
      else if (['👎', '🤮', '💀', '😐', '🤡'].includes(emoji)) {
        expect(decision.reason).toBe('toxic');
        expect(decision.moodDelta).toBeDefined();
      } else {
        expect(decision.reason).toBe('not-positive');
        expect(decision.moodDelta).toBeUndefined();
      }
    }
  });

  test('toxic reactions move mood silently', () => {
    const decision = decideReaction(input({ emoji: '💀' }));
    expect(decision.moodDelta?.annoyance).toBeGreaterThan(0);
    expect(decision.moodDelta?.cringe).toBeGreaterThan(0);
    expect(decision.moodDelta?.attraction).toBeLessThan(0);
  });

  test('ignores a positive reaction while the relationship is cold', () => {
    for (const stage of ['met-irl-got-tg', 'tg-given-cold', 'tg-given-warming', 'dumped'] as const) {
      expect(decideReaction(input({ stage, emoji: '❤️' }))).toEqual({
        action: 'ignore',
        reason: 'cold-stage',
      });
    }
  });

  test('ignores a reaction during an active conflict, even in a warm stage', () => {
    expect(
      decideReaction(
        input({
          emoji: '🔥',
          stage: 'dating-stable',
          conflict: {
            level: 2,
            coldUntil: new Date(NOW + 60 * 60 * 1000).toISOString(),
            history: [],
          },
        }),
      ),
    ).toEqual({ action: 'ignore', reason: 'conflict' });
  });

  test('allows a reaction again after the conflict is resolved', () => {
    const decision = decideReaction(
      input({
        emoji: '👍',
        stage: 'dating-stable',
        conflict: {
          level: 0,
          coldUntil: new Date(NOW - 60 * 60 * 1000).toISOString(),
          history: [],
        },
      }),
    );
    expect(decision.action).toBe('react');
  });

  test('ignores while the cooldown is running', () => {
    expect(
      decideReaction(input({ lastHerMessageAt: NOW - 60 * 1000 })),
    ).toEqual({ action: 'ignore', reason: 'cooldown' });
    expect(
      decideReaction(input({ lastReactionAt: NOW - REACTION_COOLDOWN_MS + 1 })),
    ).toEqual({ action: 'ignore', reason: 'cooldown' });
  });

  test('engages once the cooldown has passed', () => {
    const decision = decideReaction(
      input({ lastHerMessageAt: NOW - REACTION_COOLDOWN_MS }),
    );
    expect(decision.action).not.toBe('ignore');
  });

  test('answers a strong emoji with a short reply when the bond is warm', () => {
    for (const emoji of ['❤️', '🔥', '😍', '🥰', '😘']) {
      expect(
        decideReaction(
          input({ emoji, stage: 'dating-early', score: WARM_SCORE }),
        ),
      ).toEqual({ action: 'reply', reason: 'warm-strong' });
    }
  });

  test('keeps a strong emoji as a reaction when the score is not warm enough', () => {
    expect(
      decideReaction(
        input({
          emoji: '❤️',
          score: { interest: 20, trust: 10, attraction: 10, annoyance: 0, cringe: 0 },
        }),
      ),
    ).toEqual({ action: 'react', reason: 'warm', emoji: '❤' });
  });

  test('answers a mild positive emoji with a reaction, not a turn', () => {
    for (const emoji of ['👍', '😂', '🎉']) {
      expect(
        decideReaction(input({ emoji, stage: 'long-term', score: WARM_SCORE })),
      ).toEqual({ action: 'react', reason: 'warm', emoji });
    }
  });
});
