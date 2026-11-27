import { describe, expect, test } from 'bun:test';
import {
  PATTERN_DEFAULTS,
  activeBusySlot,
  computePresenceProfile,
  computePresenceState,
  isEvening,
  isHourInRange,
  isNightWindow,
  presenceSeed,
  prng,
} from './presence';
import type { PersonaConfig, PresencePattern } from './types';

const MSK_NOON = Date.UTC(2026, 10, 27, 9, 0, 0); // 12:00 Europe/Moscow
const HOUR = 3_600_000;

function baseConfig(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    name: 'Аня',
    age: 22,
    timezone: 'Europe/Moscow',
    stage: 'tg-given-warming',
    sleepFrom: 23,
    sleepTo: 8,
    ...overrides,
  };
}

function configWithPattern(pattern: PresencePattern): PersonaConfig {
  for (let i = 0; i < 5000; i += 1) {
    const config = baseConfig({
      name: `Тест${i}`,
      age: 19 + (i % 7),
      stage: 'tg-given-cold',
    });
    if (computePresenceProfile(config).pattern === pattern) return config;
  }
  throw new Error(`cannot find seeded pattern ${pattern}`);
}

describe('presence profile', () => {
  test('seed and PRNG are deterministic and bounded', () => {
    expect(presenceSeed('Аня', 22)).toBe(presenceSeed('Аня', 22));
    for (let n = 1; n < 10; n += 1) {
      const value = prng(presenceSeed('Аня', 22), n);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(computePresenceProfile(baseConfig())).toEqual(
      computePresenceProfile(baseConfig()),
    );
  });

  test('pattern table stays inside the textbook ranges', () => {
    const expected: Record<PresencePattern, [number, number, number, number]> = {
      // checkMin, checkMax, windowMin, windowMax
      'phone-attached': [3, 7, 30, 89],
      'burst-checker': [15, 34, 2, 5],
      'rare-checker': [60, 119, 5, 14],
      'evening-only': [45, 74, 60, 149],
      'phone-attached-night': [10, 24, 20, 59],
    };
    for (const pattern of Object.keys(expected) as PresencePattern[]) {
      const config = configWithPattern(pattern);
      const profile = computePresenceProfile(config);
      const [checkMin, checkMax, windowMin, windowMax] = expected[pattern];
      expect(profile.checkEveryMin).toBeGreaterThanOrEqual(checkMin);
      expect(profile.checkEveryMin).toBeLessThanOrEqual(checkMax);
      expect(profile.onlineWindowMin).toBeGreaterThanOrEqual(windowMin);
      expect(profile.onlineWindowMin).toBeLessThanOrEqual(windowMax);
      expect(profile.offlineReplyChance).toBeGreaterThan(0);
      expect(profile.offlineReplyChance).toBeLessThanOrEqual(1);
    }
    expect(PATTERN_DEFAULTS['phone-attached'].offlineReplyChance).toBe(0.85);
    expect(PATTERN_DEFAULTS['burst-checker'].offlineReplyChance).toBe(0.5);
  });

  test('priority notification overrides rare/evening and bursty styles', () => {
    const bursty = baseConfig({
      communication: { messageStyle: 'bursty', notifications: 'priority' },
    });
    expect(computePresenceProfile(bursty).pattern).toBe('phone-attached');

    const evening = configWithPattern('evening-only');
    const priority = computePresenceProfile({
      ...evening,
      communication: { notifications: 'priority' },
    });
    expect(priority.pattern).toBe('phone-attached');
  });

  test('muted notification downgrades phone patterns', () => {
    const attached = configWithPattern('phone-attached');
    expect(
      computePresenceProfile({
        ...attached,
        communication: { notifications: 'muted' },
      }).pattern,
    ).toBe('burst-checker');

    const night = configWithPattern('phone-attached-night');
    expect(
      computePresenceProfile({
        ...night,
        communication: { notifications: 'muted' },
      }).pattern,
    ).toBe('evening-only');
  });

  test('priority makes checks faster and warm stages add offline reply', () => {
    const seeded = configWithPattern('burst-checker');
    const normal = computePresenceProfile(seeded);
    const priority = computePresenceProfile({
      ...seeded,
      communication: { notifications: 'priority' },
    });
    expect(priority.checkEveryMin).toBeLessThanOrEqual(normal.checkEveryMin);
    expect(priority.offlineReplyChance).toBeGreaterThanOrEqual(0.85);
    expect(priority.nightWakeChance).toBeGreaterThan(0.05);

    const warm = computePresenceProfile({ ...seeded, stage: 'dating-stable' });
    expect(warm.offlineReplyChance).toBeGreaterThan(normal.offlineReplyChance);
  });
});

describe('windows', () => {
  test('hour range handles midnight and degenerate windows', () => {
    expect(isHourInRange(23, 23, 8)).toBe(true);
    expect(isHourInRange(0, 23, 8)).toBe(true);
    expect(isHourInRange(7, 23, 8)).toBe(true);
    expect(isHourInRange(8, 23, 8)).toBe(false);
    expect(isHourInRange(22, 23, 8)).toBe(false);
    expect(isHourInRange(9, 9, 9)).toBe(false);
  });

  test('isEvening is a real midnight-aware window, not almost-all-day', () => {
    expect(isEvening(19, 23)).toBe(true);
    expect(isEvening(22, 23)).toBe(true);
    expect(isEvening(23, 23)).toBe(false);
    expect(isEvening(12, 23)).toBe(false);
    expect(isEvening(3, 23)).toBe(false);

    // Night owl: evening starts at 18 and runs past midnight until bedtime.
    expect(isEvening(23, 2)).toBe(true);
    expect(isEvening(1, 2)).toBe(true);
    expect(isEvening(3, 2)).toBe(false);

    // Degenerate bedtime at 18 has no evening window.
    expect(isEvening(19, 18)).toBe(false);
  });

  test('night owl window is 22:00–08:00', () => {
    expect(isNightWindow(22)).toBe(true);
    expect(isNightWindow(2)).toBe(true);
    expect(isNightWindow(7)).toBe(true);
    expect(isNightWindow(8)).toBe(false);
    expect(isNightWindow(12)).toBe(false);
  });

  test('busy slot crosses midnight with previous-day permission', () => {
    const slot = {
      label: 'вечеринка',
      days: ['fri' as const],
      from: '22:00',
      to: '02:00',
    };
    expect(activeBusySlot([slot], 'fri', 23 * 60)).not.toBeNull();
    // Saturday 01:00 belongs to Friday's slot.
    expect(activeBusySlot([slot], 'sat', 60)?.remainingMin).toBe(60);
    expect(activeBusySlot([slot], 'sat', 120)).toBeNull();
    expect(activeBusySlot([slot], 'mon', 60)).toBeNull();
  });
});

describe('presence state machine', () => {
  test('cold conflict wins over everything and waits until the cold ends', () => {
    const config = baseConfig();
    const profile = computePresenceProfile(config);
    const coldUntil = new Date(MSK_NOON + 2 * HOUR).toISOString();
    const state = computePresenceState(config, profile, {
      now: MSK_NOON,
      conflict: { level: 2, coldUntil, history: [] },
      rand: () => 0.5,
    });
    expect(state.online).toBe(false);
    expect(state.coldActive).toBe(true);
    expect(state.nextCheckSec).toBe(2 * 3600);
    expect(state.hint).toContain('молчания');
  });

  test('sleep keeps her offline until the morning plus jitter', () => {
    const config = baseConfig();
    const profile = computePresenceProfile(config);
    // 00:30 Moscow time.
    const state = computePresenceState(config, profile, {
      now: Date.UTC(2026, 10, 27, 21, 30, 0),
      rand: () => 0.99,
    });
    expect(state.asleep).toBe(true);
    expect(state.nightAwake).toBe(false);
    expect(state.online).toBe(false);
    expect(state.nextCheckSec).toBeGreaterThanOrEqual(7.5 * 3600);
    expect(state.nextCheckSec).toBeLessThan(8 * 3600);
    expect(state.hint).toContain('СПИШЬ');
  });

  test('forced wake overrides sleep and returns online immediately', () => {
    const config = baseConfig();
    const profile = computePresenceProfile(config);
    const state = computePresenceState(config, profile, {
      now: Date.UTC(2026, 10, 27, 21, 30, 0),
      forcedWake: true,
      rand: () => 0.99,
    });
    expect(state.asleep).toBe(true);
    expect(state.nightAwake).toBe(true);
    expect(state.online).toBe(true);
    expect(state.nextCheckSec).toBe(0);
    expect(state.hint).toContain('ПРИНУД');
  });

  test('active dialog means online', () => {
    const config = baseConfig();
    const profile = computePresenceProfile(config);
    const state = computePresenceState(config, profile, {
      now: MSK_NOON,
      lastUserMsgTs: MSK_NOON - 2 * 60_000,
      lastHerReplyTs: MSK_NOON - 60_000,
      recentExchangeCount: 4,
      rand: () => 0.99,
    });
    expect(state.online).toBe(true);
    expect(state.nextCheckSec).toBe(0);
    expect(state.hint).toContain('АКТИВНЫЙ ДИАЛОГ');
  });

  test('evening-only gate is offline at noon and online in the evening', () => {
    const config = configWithPattern('evening-only');
    const profile = computePresenceProfile(config);
    const noon = computePresenceState(config, profile, {
      now: MSK_NOON,
      rand: () => 0,
    });
    expect(noon.online).toBe(false);
    expect(noon.nextCheckSec).toBeGreaterThan(0);

    const evening = computePresenceState(config, profile, {
      now: Date.UTC(2026, 10, 27, 16, 0, 0), // 19:00 Moscow
      rand: () => 0,
    });
    expect(evening.online).toBe(true);
  });

  test('night-owl gate is offline during the day', () => {
    const config = configWithPattern('phone-attached-night');
    const profile = computePresenceProfile(config);
    const day = computePresenceState(config, profile, {
      now: MSK_NOON,
      rand: () => 0,
    });
    expect(day.online).toBe(false);

    const night = computePresenceState(config, profile, {
      now: Date.UTC(2026, 10, 27, 20, 0, 0), // 23:00 Moscow
      rand: () => 0,
    });
    expect(night.online).toBe(true);
  });

  test('boring busy slot uses micro-cycles; serious busy blocks the phone', () => {
    const boring = baseConfig({
      busySchedule: [
        { label: 'пары', from: '09:00', to: '14:00', checkAfterMin: [1, 3] },
      ],
    });
    const profile = computePresenceProfile(boring);
    // 10:31 Moscow: minuteOfCycle = 631 % 2 = 1 → offline half of the cycle.
    const state = computePresenceState(boring, profile, {
      now: Date.UTC(2026, 10, 27, 7, 31, 0),
      rand: () => 0,
    });
    expect(state.busy?.label).toBe('пары');
    expect(state.busy?.checkAfterMin).toBe(2);
    expect(state.online).toBe(false);
    expect(state.nextCheckSec).toBe(60);

    const serious = baseConfig({
      busySchedule: [
        { label: 'зал', from: '09:00', to: '14:00', checkAfterMin: [20, 40] },
      ],
    });
    const seriousState = computePresenceState(
      serious,
      computePresenceProfile(serious),
      { now: Date.UTC(2026, 10, 27, 7, 30, 0), rand: () => 0 },
    );
    expect(seriousState.busy?.label).toBe('зал');
    expect(seriousState.online).toBe(false);
    expect(seriousState.nextCheckSec).toBeGreaterThanOrEqual((209 + 20) * 60);
    expect(seriousState.hint).toContain('занята');
  });

  test('offline notification chance creates a short check delay', () => {
    const seeded = configWithPattern('burst-checker');
    const config = baseConfig({
      name: seeded.name,
      age: seeded.age,
      communication: { notifications: 'muted', messageStyle: 'balanced' },
    });
    const profile = computePresenceProfile(config);
    // rand 0.99: online roll fails, notification roll fails too.
    const unseen = computePresenceState(config, profile, {
      now: MSK_NOON,
      rand: () => 0.99,
    });
    expect(unseen.online).toBe(false);
    expect(unseen.notificationSeen).toBe(false);
    expect(unseen.nextCheckSec).toBeGreaterThanOrEqual(30);

    const seen = computePresenceState(config, profile, {
      now: MSK_NOON,
      rand: () => 0.2,
    });
    expect(seen.online).toBe(false);
    expect(seen.notificationSeen).toBe(true);
    expect(seen.nextCheckSec).toBeGreaterThanOrEqual(60);
    expect(seen.nextCheckSec).toBeLessThanOrEqual(300);
  });
});
