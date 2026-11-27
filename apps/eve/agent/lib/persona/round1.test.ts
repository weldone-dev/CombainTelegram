import { describe, expect, test } from 'bun:test';
import { quietBlockDecision } from './behavior';
import { personaConfigFromRow } from './config';
import { classifyDeletion, deletionPromptFragment } from './deletion';
import {
  reactionMoodAllowed,
  reactionMoodDelta,
  reactionPlan,
} from './reaction';
import type { DailyLife, PersonaConfig } from './types';

const CONFIG: PersonaConfig = {
  name: 'Ника',
  age: 23,
  timezone: 'UTC',
  stage: 'convinced',
};

const SCORE = {
  interest: 40,
  trust: 30,
  attraction: 25,
  annoyance: 0,
  cringe: 0,
};

function day(phoneAvailable: boolean): DailyLife {
  return {
    dateLocal: '2026-11-27',
    vibe: 'обычный день',
    blocks: [
      {
        fromHour: 9,
        toHour: 15,
        activity: 'пары',
        social: 'with-coworkers',
        phoneAvailable,
      },
    ],
    events: [],
    wants: [],
  };
}

function atNoon(): number {
  return Date.UTC(2026, 10, 27, 12, 0, 0);
}

describe('reaction-only', () => {
  test('plan survives a no-reply decision', () => {
    const plan = reactionPlan(
      { reaction: '❤', reactionTargetMessageId: 77 },
      10,
    );
    expect(plan).toEqual({ emoji: '❤', targetMessageId: 77 });
  });

  test('falls back to the incoming message id', () => {
    expect(reactionPlan({ reaction: '🔥' }, 42)).toEqual({
      emoji: '🔥',
      targetMessageId: 42,
    });
  });

  test('no reaction means no plan', () => {
    expect(reactionPlan({}, 42)).toBeNull();
  });
});

describe('toxic reaction mood', () => {
  test('toxic emoji carry a negative delta', () => {
    expect(reactionMoodDelta('💀')?.annoyance).toBeGreaterThan(0);
    expect(reactionMoodDelta('🤡')?.cringe).toBeGreaterThan(0);
    expect(reactionMoodDelta('👎')?.annoyance).toBeGreaterThan(0);
    expect(reactionMoodDelta('😐')?.annoyance).toBeGreaterThan(0);
    expect(reactionMoodDelta('😂')).toBeUndefined();
  });

  test('mood is throttled per window', () => {
    expect(reactionMoodAllowed(undefined, 0)).toBe(true);
    expect(reactionMoodAllowed(1_000, 30_000)).toBe(false);
    expect(reactionMoodAllowed(1_000, 200_000)).toBe(true);
  });
});

describe('busySchedule', () => {
  test('is parsed from the persona row and passed to the config', () => {
    const config = personaConfigFromRow({
      name: 'Ника',
      busySchedule: JSON.stringify([
        {
          label: 'пары',
          days: ['mon', 'wed'],
          from: '09:00',
          to: '15:00',
          checkAfterMin: [5, 15],
        },
      ]),
    });
    expect(config?.busySchedule).toEqual([
      {
        label: 'пары',
        days: ['mon', 'wed'],
        from: '09:00',
        to: '15:00',
        checkAfterMin: [5, 15],
      },
    ]);
  });

  test('a broken schedule degrades to no routine', () => {
    const config = personaConfigFromRow({
      name: 'Ника',
      busySchedule: '{broken',
    });
    expect(config?.busySchedule).toBeUndefined();
  });
});

describe('daily-life in behavior', () => {
  test('phone-unavailable block makes her leave it on read or react', () => {
    const decision = quietBlockDecision(
      {
        config: CONFIG,
        score: SCORE,
        dailyLife: day(false),
        now: atNoon(),
        rand: () => 0,
      },
      () => 0,
    );
    expect(decision?.shouldReply).toBe(false);
    const intent = decision?.intent;
    expect(intent === 'left-on-read' || intent === 'reaction-only').toBe(true);
    expect(decision?.ignoreReason).toContain('phone-unavailable');
  });

  test('the other roll answers when the block ends', () => {
    const decision = quietBlockDecision(
      {
        config: CONFIG,
        score: SCORE,
        dailyLife: day(false),
        now: atNoon(),
      },
      () => 0.99,
    );
    expect(decision?.shouldReply).toBe(true);
    expect(decision?.delaySec).toBeGreaterThanOrEqual(15 * 60);
  });

  test('an available phone never creates a quiet-block decision', () => {
    expect(
      quietBlockDecision({
        config: CONFIG,
        score: SCORE,
        dailyLife: day(true),
        now: atNoon(),
      }),
    ).toBeNull();
  });
});

describe('deletion awareness', () => {
  test('classifies the three branches', () => {
    const now = 10_000_000;
    expect(
      classifyDeletion({ receivedAt: now - 10 * 60_000, now }),
    ).toBe('saw-not-read');
    expect(
      classifyDeletion({
        receivedAt: now - 10 * 60_000,
        lastHerMessageAt: now - 5 * 60_000,
        now,
      }),
    ).toBe('saw-and-read');
    expect(
      classifyDeletion({ receivedAt: now - 60 * 60_000, now }),
    ).toBe('missed');
  });

  test('missed deletions have no prompt fragment', () => {
    expect(deletionPromptFragment('missed', 'текст')).toBe('');
    expect(deletionPromptFragment('saw-and-read', 'текст')).toContain('текст');
  });
});
