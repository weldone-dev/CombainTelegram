import { describe, expect, test } from 'bun:test';
import {
  decideBehavior,
  fallbackDecision,
  pickReactionOnly,
  quietBlockDecision,
} from './behavior';
import { personaConfigFromRow } from './config';
import type {
  DailyLife,
  PersonaConfig,
  PresenceState,
  RelationshipScore,
} from './types';

const SCORE: RelationshipScore = {
  interest: 55,
  trust: 40,
  attraction: 45,
  annoyance: 0,
  cringe: 0,
};

function config(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    // Warm stage and a high ignore tendency: reactions must be reachable here.
    name: 'Ника',
    age: 23,
    timezone: 'UTC',
    stage: 'convinced',
    ignoreTendency: 60,
    ...overrides,
  };
}

function busyPresence(checkAfterMin: number): PresenceState {
  return {
    online: false,
    asleep: false,
    nightAwake: false,
    nextCheckSec: checkAfterMin * 60,
    localHour: 12,
    hint: 'занята',
    busy: { label: 'пары', until: '15:00', checkAfterMin },
    pattern: 'burst-checker',
    coldActive: false,
    forcedWake: false,
  };
}

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

describe('reaction-only is reachable without an LLM', () => {
  test('a warm-stage ignore becomes a reaction', () => {
    const decision = fallbackDecision({
      config: config(),
      score: SCORE,
      presence: { ...busyPresence(5), busy: undefined },
      activeDialog: false,
      recentIncomingIds: [{ messageId: 77, text: 'привет' }],
      rand: () => 0,
      now: Date.UTC(2026, 10, 27, 12),
    });
    expect(decision.shouldReply).toBe(false);
    expect(decision.intent).toBe('reaction-only');
    expect(decision.reaction).toBeTruthy();
    expect(decision.reactionTargetMessageId).toBe(77);
  });

  test('cold stage never reacts', () => {
    const plan = pickReactionOnly(
      {
        config: config({ stage: 'tg-given-cold' }),
        score: { ...SCORE, annoyance: 10 },
        rand: () => 0,
        now: Date.UTC(2026, 10, 27, 12),
      },
      () => 0,
    );
    expect(plan).toBeNull();
  });

  test('quiet block can react instead of pure silence', () => {
    const decision = quietBlockDecision(
      {
        config: config(),
        score: SCORE,
        dailyLife: day(false),
        now: Date.UTC(2026, 10, 27, 12),
        rand: () => 0,
      },
      () => 0,
    );
    expect(decision?.shouldReply).toBe(false);
    expect(decision?.intent).toBe('reaction-only');
    expect(decision?.reaction).toBeTruthy();
  });
});

describe('busy is a real delay, not only a hint', () => {
  test('busy without an active dialog waits checkAfterMin', () => {
    const decision = fallbackDecision({
      config: config(),
      score: SCORE,
      presence: busyPresence(20),
      activeDialog: false,
      rand: () => 0.9,
      now: Date.UTC(2026, 10, 27, 12),
    });
    expect(decision.shouldReply).toBe(true);
    expect(decision.delaySec).toBeGreaterThanOrEqual(20 * 60);
  });

  test('busy inside an active dialog still answers quickly', async () => {
    const decision = await decideBehavior({
      config: config(),
      score: SCORE,
      presence: busyPresence(20),
      activeDialog: true,
      rand: () => 0.9,
      now: Date.UTC(2026, 10, 27, 12),
    });
    expect(decision.shouldReply).toBe(true);
    expect(decision.delaySec).toBeLessThanOrEqual(180);
  });
});

describe('sleep beats the active-dialog shortcut', () => {
  test('a reply two minutes ago does not answer instantly at 03:00', async () => {
    const decision = await decideBehavior({
      config: config(),
      score: SCORE,
      presence: {
        online: false,
        asleep: true,
        nightAwake: false,
        nextCheckSec: 3600,
        localHour: 3,
        hint: 'спит',
        pattern: 'burst-checker',
        coldActive: false,
        forcedWake: false,
      },
      activeDialog: true,
      rand: () => 0.9,
      now: Date.UTC(2026, 10, 27, 3),
    });
    expect(decision.source).not.toBe('active-dialog');
    if (decision.shouldReply) {
      expect(decision.delaySec).toBeGreaterThanOrEqual(60);
    }
  });
});

describe('stress formula is shared', () => {
  test('the prompt and the decision use one function', async () => {
    const { stressLoadOf } = await import('./hormones');
    expect(
      stressLoadOf({ annoyance: 100, cringe: 0 }, 0),
    ).toBeCloseTo(0.4, 5);
    expect(stressLoadOf({ annoyance: 0, cringe: 100 }, 4)).toBeCloseTo(0.6, 5);
  });
});

describe('persona config parsing still accepts busySchedule', () => {
  test('busy schedule rows survive the row mapper', () => {
    const parsed = personaConfigFromRow({
      name: 'Ника',
      busySchedule: JSON.stringify([
        { label: 'пары', from: '09:00', to: '15:00', checkAfterMin: [5, 15] },
      ]),
    });
    expect(parsed?.busySchedule?.[0]?.label).toBe('пары');
  });
});
