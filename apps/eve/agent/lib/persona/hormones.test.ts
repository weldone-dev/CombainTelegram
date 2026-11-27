import { describe, expect, test } from 'bun:test';
import { decideBehavior } from './behavior';
import {
  CYCLE_MAX_LENGTH,
  CYCLE_MIN_LENGTH,
  computeHormones,
  cycleLengthFor,
  hormonesPromptFragment,
  phaseForCycleDay,
} from './hormones';
import {
  computePresenceProfile,
  computePresenceState,
  nightWakeRoll,
} from './presence';
import type {
  BehaviorContext,
  CyclePhase,
  HormoneState,
  PersonaConfig,
  PresenceState,
  RelationshipScore,
} from './types';

const SEED = 4242;
const AGE = 22;
const DAY_MS = 86_400_000;
const SCAN_START = Date.UTC(2026, 0, 1, 12, 0, 0);
const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);
const NIGHT = Date.UTC(2026, 10, 27, 21, 30, 0); // 00:30 Europe/Moscow

const ZERO: RelationshipScore = {
  interest: 0,
  trust: 0,
  attraction: 0,
  annoyance: 0,
  cringe: 0,
};

function dayForPhase(phase: CyclePhase, seed = SEED): Date {
  for (let i = 0; i < 400; i += 1) {
    const date = new Date(SCAN_START + i * DAY_MS);
    if (computeHormones(seed, AGE, date, 0).phase === phase) return date;
  }
  throw new Error(`no ${phase} day found for seed ${seed}`);
}

function persona(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    name: 'Аня',
    age: AGE,
    timezone: 'Europe/Moscow',
    stage: 'tg-given-cold',
    communication: {
      notifications: 'normal',
      messageStyle: 'balanced',
      initiative: 'medium',
      lifeSharing: 'medium',
    },
    ignoreTendency: 35,
    nightWakeChance: 0.05,
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

function ctx(
  hormones: HormoneState,
  overrides: Partial<BehaviorContext> = {},
): BehaviorContext {
  return {
    config: persona(),
    stage: 'tg-given-cold',
    score: ZERO,
    presence: presence(),
    now: NOW,
    rand: () => 0.8,
    hormones,
    ...overrides,
  };
}

describe('cycle determinism and shape', () => {
  test('same inputs give the same snapshot, no Math.random involved', () => {
    const now = new Date(NOW);
    const first = computeHormones(SEED, AGE, now, 0.3);
    const second = computeHormones(SEED, AGE, new Date(NOW), 0.3);
    expect(first).toEqual(second);

    // A fresh call after other work must not have drifted.
    computeHormones(SEED + 1, 30, new Date(0), 1);
    expect(computeHormones(SEED, AGE, now, 0.3)).toEqual(first);

    expect(first.cycleLength).toBeGreaterThanOrEqual(CYCLE_MIN_LENGTH);
    expect(first.cycleLength).toBeLessThanOrEqual(CYCLE_MAX_LENGTH);
    expect(first.cycleDay).toBeGreaterThanOrEqual(1);
    expect(first.cycleDay).toBeLessThanOrEqual(first.cycleLength);
    expect(first.replyChanceMultiplier).toBeGreaterThan(0);
    expect(first.ignoreChanceMultiplier).toBeGreaterThan(0);
    expect(first.delayMultiplier).toBeGreaterThan(0);
  });

  test('personal cycle length stays inside 26..32 for every seed', () => {
    for (const seed of [0, 1, 2, 7, 42, 999, 12_345]) {
      const length = cycleLengthFor(seed, 22);
      expect(length).toBeGreaterThanOrEqual(26);
      expect(length).toBeLessThanOrEqual(32);
      expect(cycleLengthFor(seed, 22)).toBe(length);
    }
  });

  test('one full cycle covers all five phases', () => {
    const seen = new Set<CyclePhase>();
    const sample = computeHormones(SEED, AGE, new Date(NOW), 0);
    for (let offset = 0; offset < sample.cycleLength; offset += 1) {
      const date = new Date(NOW + offset * DAY_MS);
      seen.add(computeHormones(SEED, AGE, date, 0).phase);
    }
    expect([...seen].sort()).toEqual([
      'follicular',
      'luteal',
      'menstrual',
      'ovulation',
      'pms',
    ]);
  });
});

describe('phase boundaries', () => {
  test('28-day cycle: 1-4 menstrual, 5-13 follicular, 14-15 ovulation, 16-22 luteal, 23-28 PMS', () => {
    const expected: Array<[number, CyclePhase]> = [
      [1, 'menstrual'],
      [4, 'menstrual'],
      [5, 'follicular'],
      [13, 'follicular'],
      [14, 'ovulation'],
      [15, 'ovulation'],
      [16, 'luteal'],
      [22, 'luteal'],
      [23, 'pms'],
      [28, 'pms'],
    ];
    for (const [day, phase] of expected) {
      expect(phaseForCycleDay(day, 28)).toBe(phase);
    }
  });

  test('phase boundaries scale with a shorter personal cycle', () => {
    // 26-day cycle: ovulation at 12..13, luteal 14..20, PMS 21..26.
    expect(phaseForCycleDay(11, 26)).toBe('follicular');
    expect(phaseForCycleDay(12, 26)).toBe('ovulation');
    expect(phaseForCycleDay(13, 26)).toBe('ovulation');
    expect(phaseForCycleDay(14, 26)).toBe('luteal');
    expect(phaseForCycleDay(20, 26)).toBe('luteal');
    expect(phaseForCycleDay(21, 26)).toBe('pms');
    expect(phaseForCycleDay(26, 26)).toBe('pms');
    // Out-of-range days wrap instead of throwing.
    expect(phaseForCycleDay(27, 26)).toBe('menstrual');
  });
});

describe('stress load', () => {
  test('delays the cycle by up to three days and raises irritability', () => {
    const now = new Date(NOW);
    const calm = computeHormones(SEED, AGE, now, 0);
    const stressed = computeHormones(SEED, AGE, now, 0.9);

    expect(calm.stressDelayDays).toBe(0);
    expect(stressed.stressDelayDays).toBe(3);

    const dayShift =
      (calm.cycleDay - stressed.cycleDay + calm.cycleLength) % calm.cycleLength;
    expect(dayShift).toBe(3);

    expect(stressed.irritability).toBeGreaterThan(calm.irritability);
    expect(stressed.replyChanceMultiplier).toBeLessThan(
      calm.replyChanceMultiplier,
    );
    expect(stressed.ignoreChanceMultiplier).toBeGreaterThan(
      calm.ignoreChanceMultiplier,
    );
    expect(stressed.delayMultiplier).toBeGreaterThan(calm.delayMultiplier);
  });

  test('stress input is clamped to 0..1', () => {
    const now = new Date(NOW);
    expect(computeHormones(SEED, AGE, now, 5).stressLoad).toBe(1);
    expect(computeHormones(SEED, AGE, now, -3).stressLoad).toBe(0);
    expect(computeHormones(SEED, AGE, now, Number.NaN).stressLoad).toBe(0);
  });
});

describe('effects consumed by behavior', () => {
  const ovulation = computeHormones(SEED, AGE, dayForPhase('ovulation'), 0);
  const pms = computeHormones(SEED, AGE, dayForPhase('pms'), 0);

  test('phase flags drive the tone', () => {
    expect(ovulation.flirt).toBe(true);
    expect(ovulation.shortReplies).toBe(false);
    expect(pms.flirt).toBe(false);
    expect(pms.shortReplies).toBe(true);
    expect(ovulation.replyChanceMultiplier).toBeGreaterThan(
      pms.replyChanceMultiplier,
    );
  });

  test('PMS lowers the reply probability, ovulation raises it', async () => {
    const ovulationDecision = await decideBehavior(ctx(ovulation));
    const pmsDecision = await decideBehavior(ctx(pms));

    expect(ovulationDecision.shouldReply).toBe(true);
    expect(ovulationDecision.intent).not.toBe('ignore');
    expect(pmsDecision.shouldReply).toBe(false);
    expect(pmsDecision.intent).toBe('ignore');
  });

  test('PMS delays the reply and shortens it compared to ovulation', async () => {
    const warm = persona({ stage: 'tg-given-warming' });
    const ovulationDecision = await decideBehavior(
      ctx(ovulation, {
        config: warm,
        stage: 'tg-given-warming',
        presence: presence({ online: false }),
      }),
    );
    const pmsDecision = await decideBehavior(
      ctx(pms, {
        config: warm,
        stage: 'tg-given-warming',
        presence: presence({ online: false }),
      }),
    );

    expect(ovulationDecision.shouldReply).toBe(true);
    expect(ovulationDecision.intent).toBe('reply');
    expect(pmsDecision.shouldReply).toBe(true);
    expect(pmsDecision.intent).toBe('short');
    expect(pmsDecision.delaySec).toBeGreaterThan(ovulationDecision.delaySec);
    expect(pmsDecision.bubbles).toBeLessThanOrEqual(ovulationDecision.bubbles);
    expect(pmsDecision.bubbles).toBe(1);
  });

  test('flirt flag warms the active-dialog mood', async () => {
    const flirty = await decideBehavior(
      ctx(ovulation, { activeDialog: true }),
    );
    const flat = await decideBehavior(ctx(pms, { activeDialog: true }));
    expect(flirty.moodDelta.interest).toBe(2);
    expect(flat.moodDelta.interest).toBe(1);
  });
});

describe('night wake chance', () => {
  test('0 never wakes, 1 always wakes', () => {
    const never = persona({ nightWakeChance: 0 });
    const neverProfile = computePresenceProfile(never);
    expect(neverProfile.nightWakeChance).toBe(0);
    const neverState = computePresenceState(never, neverProfile, {
      now: NIGHT,
      rand: () => 0.999,
    });
    expect(neverState.asleep).toBe(true);
    expect(neverState.nightAwake).toBe(false);

    const always = persona({ nightWakeChance: 1 });
    const alwaysProfile = computePresenceProfile(always);
    expect(alwaysProfile.nightWakeChance).toBe(1);
    const alwaysState = computePresenceState(always, alwaysProfile, {
      now: NIGHT,
      rand: () => 0.999,
    });
    expect(alwaysState.asleep).toBe(true);
    expect(alwaysState.nightAwake).toBe(true);
  });

  test('without an injected PRNG the roll is seeded per persona and night', () => {
    const half = persona({ nightWakeChance: 0.5 });
    const profile = computePresenceProfile(half);
    const first = computePresenceState(half, profile, { now: NIGHT });
    const second = computePresenceState(half, profile, { now: NIGHT });

    expect(nightWakeRoll(half, NIGHT)).toBe(nightWakeRoll(half, NIGHT));
    expect(first.nightAwake).toBe(
      nightWakeRoll(half, NIGHT) < profile.nightWakeChance,
    );
    expect(second.nightAwake).toBe(first.nightAwake);
  });
});

describe('prompt fragment', () => {
  test('mentions the phase, the tone and the early-stage secrecy rule', () => {
    const ovulation = computeHormones(SEED, AGE, dayForPhase('ovulation'), 0);
    const text = hormonesPromptFragment(ovulation);

    expect(text).toContain('# Гормоны');
    expect(text).toContain('овуляция');
    expect(text).toContain(`${ovulation.cycleDay}/${ovulation.cycleLength}`);
    expect(text).toContain('флирт');
    expect(text).toContain(
      'об этом не говори прямо на ранних стадиях',
    );

    const pms = computeHormones(SEED, AGE, dayForPhase('pms'), 0);
    expect(hormonesPromptFragment(pms)).toContain('ПМС');
    expect(hormonesPromptFragment(pms)).toContain('раздражительность');

    const stressed = computeHormones(SEED, AGE, new Date(NOW), 0.9);
    expect(hormonesPromptFragment(stressed)).toContain('напряжение');
  });
});
