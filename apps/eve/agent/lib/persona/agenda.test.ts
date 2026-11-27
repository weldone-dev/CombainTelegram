import { describe, expect, test } from 'bun:test';
import {
  applyProactiveResponse,
  canGenerateAutonomous,
  countPendingSoon,
  dueAgendaItems,
  isDuringSleep,
  isDuringUnavailableBlock,
  isQuietTime,
  maxAutonomousItems,
  nextAllowedTime,
  normalizePingAt,
  planAgendaTick,
  reconcileAfterConflict,
  sanitizeAutonomousItems,
  selectDueItem,
} from './agenda';
import type {
  AgendaItem,
  ConflictState,
  DailyLife,
  PersonaConfig,
  PresenceState,
} from './types';

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0); // 12:00 Europe/Moscow
const MIN = 60_000;
const HOUR = 3_600_000;

function config(overrides: Partial<PersonaConfig> = {}): PersonaConfig {
  return {
    name: 'Аня',
    age: 22,
    timezone: 'Europe/Moscow',
    stage: 'dating-stable',
    sleepFrom: 23,
    sleepTo: 8,
    communication: { initiative: 'medium' },
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

function item(overrides: Partial<AgendaItem> = {}): AgendaItem {
  return {
    id: 'ag_1',
    about: 'спросить, как прошли соревнования',
    reason: 'хочет узнать как прошло',
    pingAt: NOW - HOUR,
    kind: 'user-event',
    state: 'pending',
    attempts: 0,
    history: [],
    importance: 2,
    createdAt: NOW - 5 * HOUR,
    ...overrides,
  };
}

function conflict(level: ConflictState['level'], coldHours = 0): ConflictState {
  return {
    level,
    ...(coldHours > 0
      ? { coldUntil: new Date(NOW + coldHours * HOUR).toISOString() }
      : {}),
    history: [],
  };
}

describe('autonomous limits', () => {
  test('daily limits follow stage and initiative', () => {
    expect(maxAutonomousItems('tg-given-cold', 'low')).toBe(0);
    expect(maxAutonomousItems('tg-given-cold', 'high')).toBe(1);
    expect(maxAutonomousItems('met-irl-got-tg', 'low')).toBe(0);
    expect(maxAutonomousItems('met-irl-got-tg', 'medium')).toBe(1);
    expect(maxAutonomousItems('met-irl-got-tg', 'high')).toBe(2);
    expect(maxAutonomousItems('convinced', 'medium')).toBe(2);
    expect(maxAutonomousItems('dating-early', 'medium')).toBe(3);
    expect(maxAutonomousItems('dating-stable', 'medium')).toBe(4);
    expect(maxAutonomousItems('dating-stable', 'low')).toBe(3);
    expect(maxAutonomousItems('dating-stable', 'high')).toBe(5);
    expect(maxAutonomousItems('dumped', 'high')).toBe(0);
  });

  test('generation gate checks life, conflict, day marker and pending limit', () => {
    const base = {
      stage: 'dating-stable' as const,
      conflictLevel: 0,
      hasDailyLife: true,
      initiative: 'medium' as const,
      pendingSoon: 0,
      alreadyGeneratedToday: false,
    };
    expect(canGenerateAutonomous(base).allowed).toBe(true);
    expect(canGenerateAutonomous({ ...base, hasDailyLife: false }).reason).toBe(
      'no-daily-life',
    );
    expect(canGenerateAutonomous({ ...base, conflictLevel: 2 }).reason).toBe('conflict');
    expect(canGenerateAutonomous({ ...base, alreadyGeneratedToday: true }).reason).toBe(
      'already-generated',
    );
    expect(canGenerateAutonomous({ ...base, pendingSoon: 4 }).reason).toBe('limit');
    expect(canGenerateAutonomous({ ...base, stage: 'dumped' }).reason).toBe('dumped');
  });
});

describe('proactive ping validation', () => {
  test('ping time must be in the future and inside the horizon', () => {
    expect(normalizePingAt(NOW + 2 * HOUR, NOW)).toBe(NOW + 2 * HOUR);
    expect(normalizePingAt(NOW + 4 * MIN, NOW)).toBeNull();
    expect(normalizePingAt(NOW + 5 * MIN, NOW)).toBeNull();
    expect(normalizePingAt(NOW + 19 * HOUR, NOW)).toBeNull();
    expect(normalizePingAt('not a date', NOW)).toBeNull();
  });

  test('quiet hours mean sleep or phone-unavailable blocks', () => {
    const night = Date.UTC(2026, 10, 27, 20, 0, 0); // 23:00 Moscow
    expect(isDuringSleep(config(), night)).toBe(true);
    expect(isDuringSleep(config(), Date.UTC(2026, 10, 27, 5, 0, 0))).toBe(false); // 08:00
    expect(isQuietTime(config(), undefined, night)).toBe(true);

    const life: DailyLife = {
      dateLocal: '2026-11-27',
      vibe: 'обычный',
      blocks: [
        {
          fromHour: 9,
          toHour: 14,
          activity: 'работа',
          social: 'with-coworkers',
          phoneAvailable: false,
        },
      ],
      events: [],
      wants: [],
    };
    expect(isDuringUnavailableBlock(life, config(), NOW)).toBe(true);
    expect(
      isDuringUnavailableBlock(life, config(), Date.UTC(2026, 10, 27, 12, 0, 0)),
    ).toBe(false);
  });

  test('nextAllowedTime skips the night', () => {
    // 23:30 Moscow → next allowed 08:00 next day.
    const from = Date.UTC(2026, 10, 27, 20, 30, 0);
    expect(nextAllowedTime(config(), undefined, from)).toBe(
      Date.UTC(2026, 10, 28, 5, 0, 0),
    );
  });

  test('sanitizer dedupes, spaces, rejects quiet/past and enforces the limit', () => {
    const result = sanitizeAutonomousItems(
      {
        items: [
          { about: 'рассказать про дурацкий созвон', pingAt: NOW + 2 * HOUR },
          { about: 'рассказать про дурацкий созвон', pingAt: NOW + 3 * HOUR },
          { about: 'спросить про планы', pingAt: NOW + 2 * HOUR + 30 * MIN },
          { about: 'ночная мысль', pingAt: NOW + 15 * HOUR },
          { about: 'слишком рано', pingAt: NOW + 2 * MIN },
          { about: '   ', pingAt: NOW + 4 * HOUR },
          {
            about: 'очень длинная тема '.repeat(20),
            pingAt: NOW + 4 * HOUR,
            importance: 9,
            reason: 'r'.repeat(300),
          },
          { about: 'ещё одна тема', pingAt: NOW + 5 * HOUR },
        ],
      },
      { now: NOW, config: config(), limit: 2 },
    );

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.about).toBe('рассказать про дурацкий созвон');
    expect(result.items[0]?.id).toBe(`auto_${NOW.toString(36)}_0`);
    expect(result.items[1]?.about).toHaveLength(120);
    expect(result.items[1]?.importance).toBe(3);
    expect(result.items[1]?.reason).toHaveLength(160);

    const reasons = result.rejected.map((entry) => entry.reason);
    expect(reasons).toContain('duplicate');
    expect(reasons).toContain('too-close');
    expect(reasons).toContain('quiet-hours');
    expect(reasons).toContain('bad-ping-at');
    expect(reasons).toContain('about-too-short');
    expect(reasons).toContain('limit');
  });

  test('countPendingSoon only counts the next 18 hours', () => {
    const items = [
      item({ id: 'a', pingAt: NOW + HOUR }),
      item({ id: 'b', pingAt: NOW + 10 * HOUR }),
      item({ id: 'c', pingAt: NOW + 20 * HOUR }),
      item({ id: 'd', pingAt: NOW - HOUR }),
    ];
    expect(countPendingSoon(items, NOW)).toBe(2);
  });
});

describe('due selection and tick', () => {
  test('due list is sorted and the tick takes exactly one', () => {
    const items = [
      item({ id: 'future', pingAt: NOW + HOUR }),
      item({ id: 'late', pingAt: NOW - 2 * HOUR }),
      item({ id: 'middle', pingAt: NOW - HOUR }),
    ];
    const due = dueAgendaItems(items, NOW);
    expect(due.map((entry) => entry.id)).toEqual(['late', 'middle']);
    expect(selectDueItem(items, NOW)?.id).toBe('late');
  });

  test('fires when awake, online and outside the dialog cooldown', () => {
    const plan = planAgendaTick([item()], {
      now: NOW,
      config: config(),
      stage: 'dating-stable',
      presence: presence(),
      lastMessageAt: NOW - 20 * MIN,
    });
    expect(plan.action).toBe('fire');
  });

  test('waits during the 10-minute dialog cooldown', () => {
    const plan = planAgendaTick([item()], {
      now: NOW,
      config: config(),
      stage: 'dating-stable',
      presence: presence(),
      lastMessageAt: NOW - 5 * MIN,
    });
    expect(plan.action).toBe('wait');
  });

  test('reschedules when offline and uses the next check delay', () => {
    const plan = planAgendaTick([item()], {
      now: NOW,
      config: config(),
      stage: 'dating-stable',
      presence: presence({ online: false, nextCheckSec: 600 }),
    });
    expect(plan.action).toBe('reschedule');
    if (plan.action === 'reschedule') {
      expect(plan.reason).toBe('offline');
      expect(plan.pingAt).toBeGreaterThanOrEqual(NOW + 600_000);
    }
  });

  test('quiet hours move the ping to the morning', () => {
    const night = Date.UTC(2026, 10, 26, 21, 0, 0); // 00:00 Moscow
    const plan = planAgendaTick([item({ pingAt: night - HOUR })], {
      now: night,
      config: config(),
      stage: 'dating-stable',
      presence: presence({ online: true, localHour: 0 }),
    });
    expect(plan.action).toBe('reschedule');
    if (plan.action === 'reschedule') {
      expect(plan.reason).toBe('quiet-hours');
      expect(plan.pingAt).toBe(Date.UTC(2026, 10, 27, 5, 0, 0)); // 08:00 Moscow
    }
  });

  test('conflict and dumped stages suppress proactive pings', () => {
    const conflictPlan = planAgendaTick([item()], {
      now: NOW,
      config: config(),
      stage: 'dating-stable',
      presence: presence(),
      conflict: conflict(2, 4),
    });
    expect(conflictPlan.action).toBe('reschedule');

    const dumped = planAgendaTick([item()], {
      now: NOW,
      config: config(),
      stage: 'dumped',
      presence: presence(),
    });
    expect(dumped.action).toBe('none');
  });
});

describe('reschedule and conflict reconciliation', () => {
  test('conflict level 2 cancels curiosity and moves important pings', () => {
    const items = [
      item({ id: 'low', importance: 1 }),
      item({ id: 'mid', importance: 2 }),
      item({ id: 'high', importance: 3 }),
    ];
    const result = reconcileAfterConflict(items, conflict(2), 1, NOW, () => 0);
    expect(result.cancelled).toBe(1);
    expect(result.rescheduled).toBe(1);
    expect(result.items[0]?.state).toBe('cancelled');
    expect(result.items[1]?.state).toBe('pending');
    expect(result.items[1]!.pingAt).toBe(NOW + 12 * HOUR);
    expect(result.items[2]?.state).toBe('pending');
  });

  test('level 3 cancels every pending item', () => {
    const items = [
      item({ id: 'low', importance: 1 }),
      item({ id: 'mid', importance: 2 }),
      item({ id: 'high', importance: 3 }),
    ];
    const result = reconcileAfterConflict(items, conflict(3), 2, NOW);
    expect(result.cancelled).toBe(3);
    expect(result.items.every((entry) => entry.state === 'cancelled')).toBe(true);
  });

  test('same or lower level changes nothing', () => {
    const items = [item()];
    const result = reconcileAfterConflict(items, conflict(1), 1, NOW);
    expect(result.items).toBe(items);
    expect(result.cancelled).toBe(0);
  });

  test('reschedule response must be in the future; past becomes cancelled', () => {
    const valid = applyProactiveResponse(
      item({ state: 'fired' }),
      { decision: 'reschedule', newPingAt: NOW + 2 * HOUR },
      NOW,
    );
    expect(valid.state).toBe('pending');
    expect(valid.pingAt).toBe(NOW + 2 * HOUR);

    const invalid = applyProactiveResponse(
      item({ state: 'fired' }),
      { decision: 'reschedule', newPingAt: NOW - HOUR },
      NOW,
    );
    expect(invalid.state).toBe('cancelled');

    const satisfied = applyProactiveResponse(
      item({ state: 'fired' }),
      { decision: 'satisfied' },
      NOW,
    );
    expect(satisfied.state).toBe('cancelled');
  });
});
