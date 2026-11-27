import { describe, expect, test } from 'bun:test';
import {
  applyMoodDelta,
  autoDumped,
  clampScore,
  coldRemainingMs,
  decideStageTransition,
  emptyConflict,
  escalateFromMood,
  findStage,
  shouldRunStageTransitionCheck,
  softenFromMood,
  updateConflictFromMood,
} from './relationship';
import type { ConflictState, RelationshipScore, Stage } from './types';

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);
const HOUR = 3_600_000;

function score(overrides: Partial<RelationshipScore> = {}): RelationshipScore {
  return {
    interest: 0,
    trust: 0,
    attraction: 0,
    annoyance: 0,
    cringe: 0,
    ...overrides,
  };
}

describe('score', () => {
  test('clamps and rounds every counter', () => {
    expect(
      clampScore({
        interest: 200,
        trust: -300,
        attraction: 12.6,
        annoyance: -0.4,
        cringe: Number.NaN,
      }),
    ).toEqual({ interest: 100, trust: -100, attraction: 13, annoyance: 0, cringe: 0 });
  });

  test('applies deltas cumulatively with clamps', () => {
    const next = applyMoodDelta(score({ interest: 95, annoyance: 3 }), {
      interest: 20,
      annoyance: 5,
      trust: -10,
    });
    expect(next.interest).toBe(100);
    expect(next.annoyance).toBe(8);
    expect(next.trust).toBe(-10);
  });

  test('automatic dump uses strict thresholds', () => {
    expect(autoDumped(score({ annoyance: 81, interest: -31 }))).toBe(true);
    expect(autoDumped(score({ annoyance: 80, interest: -31 }))).toBe(false);
    expect(autoDumped(score({ annoyance: 81, interest: -30 }))).toBe(false);
  });
});

describe('stage transitions', () => {
  test('unknown stage ids fall back to tg-given-cold', () => {
    expect(findStage('nope').id).toBe('tg-given-cold');
    expect(findStage(3).id).toBe('tg-given-warming');
    expect(findStage('dating-stable').id).toBe('dating-stable');
  });

  test('D1 downgrades one step when the relationship regresses', () => {
    const result = decideStageTransition({
      currentStage: 'convinced',
      score: score({ annoyance: 60, interest: -10, trust: 10 }),
      herMessagesInStage: 8,
      hisMessagesInStage: 10,
      ignoresInStage: 0,
    });
    expect(result?.direction).toBe('down');
    expect(result?.next).toBe('tg-given-warming');
    expect(result?.reason).toContain('регрессируют');
  });

  test('D1 needs her >= 8 messages', () => {
    expect(
      decideStageTransition({
        currentStage: 'convinced',
        score: score({ annoyance: 60, interest: -10, trust: 10 }),
        herMessagesInStage: 7,
        hisMessagesInStage: 10,
        ignoresInStage: 0,
      }),
    ).toBeNull();
  });

  test('D2 really uses ignores and can downgrade warm stages', () => {
    const base = {
      currentStage: 'dating-stable' as Stage,
      score: score({ interest: 10 }),
      herMessagesInStage: 6,
      hisMessagesInStage: 10,
    };
    const active = decideStageTransition({ ...base, ignoresInStage: 12 });
    expect(active?.direction).toBe('down');
    expect(active?.next).toBe('dating-early');
    expect(active?.reason).toContain('игноров');

    // 11 ignores is below the absolute threshold.
    expect(decideStageTransition({ ...base, ignoresInStage: 11 })).toBeNull();
    // 12 ignores is below 70% of a large incoming volume.
    expect(
      decideStageTransition({
        ...base,
        hisMessagesInStage: 20,
        ignoresInStage: 12,
      }),
    ).toBeNull();
  });

  test('upgrades one step after the minimum reply count', () => {
    const result = decideStageTransition({
      currentStage: 'met-irl-got-tg',
      score: score({ interest: 30, attraction: 20 }),
      herMessagesInStage: 6,
      hisMessagesInStage: 6,
      ignoresInStage: 0,
    });
    expect(result?.direction).toBe('up');
    expect(result?.next).toBe('tg-given-cold');

    expect(
      decideStageTransition({
        currentStage: 'met-irl-got-tg',
        score: score({ interest: 30, attraction: 20 }),
        herMessagesInStage: 5,
        hisMessagesInStage: 6,
        ignoresInStage: 0,
      }),
    ).toBeNull();
  });

  test('an active conflict blocks upgrades but not downgrades', () => {
    expect(
      decideStageTransition({
        currentStage: 'met-irl-got-tg',
        score: score({ interest: 30, attraction: 20 }),
        herMessagesInStage: 6,
        hisMessagesInStage: 6,
        ignoresInStage: 0,
        hasActiveConflict: true,
      }),
    ).toBeNull();

    const down = decideStageTransition({
      currentStage: 'convinced',
      score: score({ annoyance: 60, interest: -10, trust: 10 }),
      herMessagesInStage: 8,
      hisMessagesInStage: 10,
      ignoresInStage: 0,
      hasActiveConflict: true,
    });
    expect(down?.direction).toBe('down');
  });

  test('never jumps more than one stage', () => {
    const result = decideStageTransition({
      currentStage: 'tg-given-cold',
      score: score({ interest: 100, trust: 100, attraction: 100 }),
      herMessagesInStage: 100,
      hisMessagesInStage: 100,
      ignoresInStage: 0,
    });
    expect(result?.next).toBe('tg-given-warming');
  });

  test('long-term and dumped never upgrade', () => {
    expect(
      decideStageTransition({
        currentStage: 'long-term',
        score: score({ interest: 100, trust: 100, attraction: 100 }),
        herMessagesInStage: 100,
        hisMessagesInStage: 100,
        ignoresInStage: 0,
      }),
    ).toBeNull();
    expect(
      decideStageTransition({
        currentStage: 'dumped',
        score: score({ interest: 100, trust: 100, attraction: 100 }),
        herMessagesInStage: 100,
        hisMessagesInStage: 100,
        ignoresInStage: 0,
      }),
    ).toBeNull();
  });

  test('stage checks run every fifth incoming message', () => {
    expect(shouldRunStageTransitionCheck(5)).toBe(true);
    expect(shouldRunStageTransitionCheck(10)).toBe(true);
    expect(shouldRunStageTransitionCheck(4)).toBe(false);
    expect(shouldRunStageTransitionCheck(0)).toBe(false);
  });
});

describe('conflict escalation', () => {
  test('thresholds 8 / 15 / 25 create levels 1 / 2 / 3', () => {
    const level1 = escalateFromMood(emptyConflict(), { annoyance: 8 }, score(), '', {
      now: NOW,
      rand: () => 0,
    });
    expect(level1.level).toBe(1);
    expect(coldRemainingMs(level1, NOW)).toBe(30 * 60_000);

    const level2 = escalateFromMood(
      emptyConflict(),
      { annoyance: 10, cringe: 5 },
      score(),
      '',
      { now: NOW, rand: () => 0 },
    );
    expect(level2.level).toBe(2);
    expect(coldRemainingMs(level2, NOW)).toBe(4 * HOUR);

    const level3 = escalateFromMood(
      emptyConflict(),
      { annoyance: 10, cringe: 10, interest: -5 },
      score(),
      '',
      { now: NOW, rand: () => 0 },
    );
    expect(level3.level).toBe(3);
    expect(coldRemainingMs(level3, NOW)).toBe(24 * HOUR);
  });

  test('one rude message can jump straight to level 3', () => {
    const state = escalateFromMood(
      emptyConflict(),
      { annoyance: 10, cringe: 10, interest: -10 },
      score({ interest: -10 }),
      'ты меня задолбал',
      { now: NOW, rand: () => 0 },
    );
    expect(state.level).toBe(3);
    expect(state.history[0]?.note).toContain('level 0→3');
    expect(state.history[0]?.note).toContain('задолбал');
  });

  test('high annoyance alone escalates to level 3', () => {
    const state = escalateFromMood(
      emptyConflict(),
      {},
      score({ annoyance: 71 }),
      '',
      { now: NOW, rand: () => 0 },
    );
    expect(state.level).toBe(3);
  });

  test('extreme score reaches level 4 with a long cold period', () => {
    const state = escalateFromMood(
      emptyConflict(),
      {},
      score({ annoyance: 86, cringe: 71, interest: -31 }),
      '',
      { now: NOW, rand: () => 0 },
    );
    expect(state.level).toBe(4);
    expect(coldRemainingMs(state, NOW)).toBe(48 * HOUR);
  });

  test('below threshold returns the same object, cold only ever extends', () => {
    const current = emptyConflict();
    expect(escalateFromMood(current, { annoyance: 7 }, score(), '', { now: NOW })).toBe(
      current,
    );

    const longCold: ConflictState = {
      level: 3,
      coldUntil: new Date(NOW + 30 * HOUR).toISOString(),
      reason: 'сильный негатив',
      since: new Date(NOW - HOUR).toISOString(),
      history: [],
    };
    // A weaker threshold would give 4h, which must not shorten the 30h cold.
    expect(
      escalateFromMood(longCold, { annoyance: 10, cringe: 5 }, score(), '', {
        now: NOW,
        rand: () => 0,
      }),
    ).toBe(longCold);
  });
});

describe('conflict softening', () => {
  function level2(): ConflictState {
    return {
      level: 2,
      coldUntil: new Date(NOW + 4 * HOUR).toISOString(),
      reason: 'обижена',
      since: new Date(NOW - HOUR).toISOString(),
      history: [],
    };
  }

  test('enough positive movement lowers one level and halves the cold', () => {
    const next = softenFromMood(
      level2(),
      { attraction: 5, trust: 5, interest: 5 },
      NOW,
    );
    expect(next.level).toBe(1);
    expect(coldRemainingMs(next, NOW)).toBe(2 * HOUR);
    expect(next.reason).toBe('обижена');
  });

  test('positive movement below 12 changes nothing', () => {
    const current = level2();
    expect(
      softenFromMood(current, { attraction: 4, trust: 4, interest: 3 }, NOW),
    ).toBe(current);
  });

  test('reaching level 0 clears cold, reason and since', () => {
    const next = softenFromMood(
      {
        level: 1,
        coldUntil: new Date(NOW + HOUR).toISOString(),
        reason: 'немного дуется',
        since: new Date(NOW - HOUR).toISOString(),
        history: [],
      },
      { attraction: 6, trust: 6, interest: 6 },
      NOW,
    );
    expect(next.level).toBe(0);
    expect(next.coldUntil).toBeUndefined();
    expect(next.reason).toBeUndefined();
    expect(next.since).toBeUndefined();
  });

  test('one turn cannot soften more than one level', () => {
    const next = softenFromMood(
      {
        level: 3,
        coldUntil: new Date(NOW + 6 * HOUR).toISOString(),
        history: [],
      },
      { attraction: 50, trust: 50, interest: 50 },
      NOW,
    );
    expect(next.level).toBe(2);
  });

  test('combined update escalates first, then softens', () => {
    const next = updateConflictFromMood(
      emptyConflict(),
      { annoyance: 8, attraction: 10, trust: 10, interest: 10 },
      score({ annoyance: 8 }),
      'ну извини',
      { now: NOW, rand: () => 0 },
    );
    // trigger is negative (8 - 10), so no escalation and no softening.
    expect(next.level).toBe(0);
  });
});
