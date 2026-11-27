import { describe, expect, test } from 'bun:test';
import {
  adjustDelay,
  canRecoverReply,
  decideBehavior,
  normalizeBubbles,
  postProcessDecision,
  recoverReplyChance,
  sanitizeReaction,
  sleepIgnoreChance,
} from './behavior';
import { normalizeCommunicationProfile } from './communication';
import type {
  BehaviorContext,
  NotificationMode,
  PersonaConfig,
  PresenceState,
  RelationshipScore,
} from './types';

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);

const ZERO: RelationshipScore = {
  interest: 0,
  trust: 0,
  attraction: 0,
  annoyance: 0,
  cringe: 0,
};

function config(
  notifications: NotificationMode = 'normal',
  overrides: Partial<PersonaConfig> = {},
): PersonaConfig {
  return {
    name: 'Аня',
    age: 22,
    timezone: 'Europe/Moscow',
    stage: 'tg-given-warming',
    communication: {
      notifications,
      messageStyle: 'balanced',
      initiative: 'medium',
      lifeSharing: 'medium',
    },
    ignoreTendency: 35,
    ...overrides,
  };
}

function presence(overrides: Partial<PresenceState> = {}): PresenceState {
  return {
    online: true,
    asleep: false,
    nightAwake: false,
    nextCheckSec: 0,
    localHour: 12,
    hint: '',
    pattern: 'burst-checker',
    coldActive: false,
    forcedWake: false,
    ...overrides,
  };
}

function ctx(overrides: Partial<BehaviorContext> = {}): BehaviorContext {
  return {
    config: config(),
    stage: 'tg-given-warming',
    score: ZERO,
    presence: presence(),
    now: NOW,
    ...overrides,
  };
}

function seq(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0.5;
}

describe('sleep ignore probability', () => {
  const cases: Array<[NotificationMode, number]> = [
    ['priority', 0.68],
    ['normal', 0.765],
    ['muted', 0.85],
  ];

  for (const [notifications, probability] of cases) {
    test(`${notifications}: ignores just below ${probability}, answers above`, async () => {
      const cfg = config(notifications);
      expect(sleepIgnoreChance(cfg)).toBeCloseTo(probability, 5);
      const asleep = presence({ asleep: true, nightAwake: false, online: false });

      const ignored = await decideBehavior({
        config: cfg,
        score: ZERO,
        presence: asleep,
        now: NOW,
        rand: () => probability - 0.0001,
      });
      expect(ignored.intent).toBe('left-on-read');
      expect(ignored.ignoreReason).toBe('asleep');
      expect(ignored.shouldRead).toBe(false);

      const answered = await decideBehavior({
        config: cfg,
        score: ZERO,
        presence: asleep,
        now: NOW,
        rand: () => probability + 0.0001,
      });
      expect(answered.ignoreReason).not.toBe('asleep');
    });
  }
});

describe('cold conflict and night wake', () => {
  test('cold conflict ignores with 80% probability', async () => {
    const conflict = {
      level: 2 as const,
      coldUntil: new Date(NOW + 3_600_000).toISOString(),
      history: [],
    };
    const coldCtx = ctx({
      presence: presence({ coldActive: true }),
      conflict,
      conflictColdActive: true,
    });

    const ignored = await decideBehavior({ ...coldCtx, rand: () => 0.1 });
    expect(ignored.intent).toBe('ignore');
    expect(ignored.ignoreReason).toBe('conflict-cold');
    expect(ignored.shouldRead).toBe(false);
    expect(ignored.source).toBe('conflict-cold');

    const passed = await decideBehavior({
      ...coldCtx,
      rand: () => 0.81,
    });
    expect(passed.source).not.toBe('conflict-cold');
  });

  test('night wake: 15% falls asleep again, otherwise one short bubble', async () => {
    const night = presence({ asleep: true, nightAwake: true, online: false });

    const slept = await decideBehavior({
      config: config(),
      score: ZERO,
      presence: night,
      now: NOW,
      rand: () => 0.149,
    });
    expect(slept.intent).toBe('ignore');
    expect(slept.ignoreReason).toBe('night-fell-asleep');
    expect(slept.moodDelta.annoyance).toBe(5);

    const awake = await decideBehavior({
      config: config(),
      score: ZERO,
      presence: night,
      now: NOW,
      rand: seq([0.151, 0.5]),
    });
    expect(awake.intent).toBe('short');
    expect(awake.bubbles).toBe(1);
    expect(awake.delaySec).toBeGreaterThanOrEqual(10);
    expect(awake.delaySec).toBeLessThanOrEqual(120);
    expect(awake.source).toBe('night-wake');

    const llm = await decideBehavior(
      {
        config: config(),
        score: ZERO,
        presence: night,
        now: NOW,
        rand: () => 0.151,
      },
      async () => ({ delaySec: 999, bubbles: 5, moodDelta: { interest: 2 } }),
    );
    expect(llm.intent).toBe('short');
    expect(llm.delaySec).toBe(120);
    expect(llm.bubbles).toBe(1);
    expect(llm.moodDelta.interest).toBe(2);
  });
});

describe('active dialog shortcut', () => {
  test('answers immediately without an LLM call', async () => {
    let called = false;
    const decision = await decideBehavior(
      ctx({ activeDialog: true, rand: () => 0 }),
      async () => {
        called = true;
        return {};
      },
    );
    expect(called).toBe(false);
    expect(decision.source).toBe('active-dialog');
    expect(decision.shouldReply).toBe(true);
    expect(decision.typing).toBe(true);
    expect(decision.delaySec).toBeGreaterThanOrEqual(2);
    expect(decision.delaySec).toBeLessThanOrEqual(180);
    expect(decision.moodDelta.interest).toBe(1);
  });

  test('dumped stage ignores even during an active dialog', async () => {
    const decision = await decideBehavior(
      ctx({
        stage: 'dumped',
        config: config('normal', { stage: 'dumped' }),
        activeDialog: true,
      }),
    );
    expect(decision.intent).toBe('ignore');
    expect(decision.shouldReply).toBe(false);
    expect(decision.source).toBe('dumped');
  });
});

describe('LLM post-processing', () => {
  test('caps delay/bubbles, sanitizes reactions and clamps mood', async () => {
    const cfg = config('normal', { stage: 'dating-stable' });
    const score: RelationshipScore = { ...ZERO, attraction: 80, interest: 70 };
    const decision = await decideBehavior(
      {
        config: cfg,
        stage: 'dating-stable',
        score,
        presence: presence({ online: true }),
        now: NOW,
        rand: () => 0.1,
      },
      async () => ({
        intent: 'reply',
        shouldReply: true,
        shouldRead: true,
        delaySec: 99_999,
        bubbles: 99,
        typing: true,
        reaction: '🤡',
        moodDelta: { annoyance: 400, interest: -300 },
      }),
    );
    expect(decision.source).toBe('llm');
    expect(decision.delaySec).toBeLessThanOrEqual(240);
    expect(decision.bubbles).toBeLessThanOrEqual(3);
    expect(decision.reaction).not.toBe('🤡');
    expect(decision.moodDelta.annoyance).toBe(20);
    expect(decision.moodDelta.interest).toBe(-20);
  });

  test('offline delay is capped at one hour', async () => {
    const decision = await decideBehavior(
      {
        config: config('normal', { stage: 'dating-stable' }),
        stage: 'dating-stable',
        score: ZERO,
        presence: presence({ online: false, notificationSeen: false }),
        now: NOW,
        rand: () => 0.9,
      },
      async () => ({ intent: 'reply', shouldReply: true, delaySec: 99_999 }),
    );
    expect(decision.delaySec).toBe(3600);
  });

  test('recovery flips a silent decision into a reply', async () => {
    const cfg = config('normal');
    const score: RelationshipScore = {
      interest: 50,
      trust: 30,
      attraction: 60,
      annoyance: 0,
      cringe: 0,
    };
    expect(canRecoverReply('tg-given-warming', score, { presence: presence() })).toBe(
      true,
    );
    expect(recoverReplyChance(cfg, score, 35)).toBeGreaterThan(0.5);

    const decision = await decideBehavior(
      {
        config: cfg,
        score,
        presence: presence({ online: true }),
        now: NOW,
        rand: () => 0,
      },
      async () => ({ intent: 'ignore', shouldReply: false, shouldRead: false }),
    );
    expect(decision.shouldReply).toBe(true);
    expect(decision.intent).toBe('reply');
    expect(decision.shouldRead).toBe(true);
    expect(decision.ignoreReason).toBeUndefined();
  });

  test('broken JSON falls back to stage defaults', async () => {
    const decision = await decideBehavior(
      ctx({
        config: config('normal', { stage: 'dating-early' }),
        stage: 'dating-early',
        // Deterministic: the fallback rolls ignore with Math.random otherwise
        // (~2 % chance of typing=false, which made this test flaky).
        rand: () => 0.99,
      }),
      async () => 'not a json at all',
    );
    expect(decision.source).toBe('fallback');
    expect(decision.typing).toBe(true);
    expect(decision.shouldRead).toBe(true);
  });

  test('cold stage with high ignore tendency always ignores in fallback', async () => {
    const decision = await decideBehavior({
      config: config('muted', { stage: 'tg-given-cold', ignoreTendency: 100 }),
      stage: 'tg-given-cold',
      score: ZERO,
      presence: presence({ online: true }),
      now: NOW,
      rand: () => 0.99,
    });
    expect(decision.intent).toBe('ignore');
    expect(decision.source).toBe('fallback');
  });
});

describe('reaction and bubble helpers', () => {
  test('warm stage replaces hostile reactions, cold stage replaces hearts', () => {
    const warmScore: RelationshipScore = { ...ZERO, attraction: 60 };
    const replacedWarm = sanitizeReaction('🤡', 'dating-stable', warmScore, () => 0);
    expect(replacedWarm).toBe('😂');

    const coldScore: RelationshipScore = { ...ZERO, annoyance: 50 };
    expect(sanitizeReaction('❤', 'tg-given-cold', coldScore, () => 0)).toBe('👍');
    expect(sanitizeReaction('🤡', 'tg-given-cold', coldScore)).toBe('🤡');
    expect(sanitizeReaction('слишком длинная реакция', 'dating-stable', warmScore)).toBe(
      undefined,
    );
  });

  test('bubble caps depend on message style', () => {
    const balanced = config('normal', {
      communication: { messageStyle: 'balanced' },
    });
    const oneLiners = config('normal', {
      communication: { messageStyle: 'one-liners' },
    });
    const bursty = config('normal', {
      communication: { messageStyle: 'bursty' },
    });
    expect(normalizeBubbles(99, normalizeCommunicationProfile(balanced), 'reply', false, () => 0)).toBe(3);
    expect(
      normalizeBubbles(
        99,
        normalizeCommunicationProfile(oneLiners),
        'reply',
        false,
        () => 0,
      ),
    ).toBe(1);
    expect(
      normalizeBubbles(99, normalizeCommunicationProfile(bursty), 'reply', false, () => 0),
    ).toBe(6);
    expect(
      normalizeBubbles(99, normalizeCommunicationProfile(bursty), 'short', false, () => 0),
    ).toBe(1);
  });

  test('adjustDelay applies style multipliers and notification caps', () => {
    const base = adjustDelay(1000, config('normal'), { presence: presence({ online: false }) }, () => 0);
    expect(base).toBe(800);

    const online = adjustDelay(
      1000,
      config('normal'),
      { presence: presence({ online: true }) },
      () => 0,
    );
    expect(online).toBe(240);

    const priority = adjustDelay(1000, config('priority'), { presence: presence() }, () => 0);
    expect(priority).toBeLessThan(base);
  });
});

test('postProcessDecision keeps a per-message reaction target only with a reaction', () => {
  const decision = postProcessDecision(
    {
      intent: 'reply',
      shouldReply: true,
      reaction: '🔥',
      reactionTargetMessageId: 42.9,
    },
    {
      config: config('normal', { stage: 'dating-stable' }),
      stage: 'dating-stable',
      score: { ...ZERO, attraction: 60 },
      presence: presence(),
      now: NOW,
      rand: () => 0,
    },
  );
  expect(decision.reactionTargetMessageId).toBe(42);

  const withoutReaction = postProcessDecision(
    { intent: 'reply', shouldReply: true, reaction: 'toolong', reactionTargetMessageId: 42 },
    ctx(),
  );
  expect(withoutReaction.reactionTargetMessageId).toBeUndefined();
});
