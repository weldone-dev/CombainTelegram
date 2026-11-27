import { describe, expect, it } from 'vitest';
import {
  busyNow,
  decideOnline,
  parseBusySchedule,
  patternFor,
} from './eve-presence.js';

describe('eve presence pattern', () => {
  it('never claims online while asleep or busy', () => {
    const asleep = decideOnline({
      personaId: 'p1',
      hour: 12,
      minute: 0,
      weekday: 'mon',
      asleep: true,
    });
    expect(asleep.online).toBe(false);
    expect(asleep.reason).toBe('sleep');

    const busy = decideOnline({
      personaId: 'p1',
      hour: 12,
      minute: 0,
      weekday: 'mon',
      asleep: false,
      busy: { label: 'пары', from: '09:00', to: '15:00' },
    });
    expect(busy.online).toBe(false);
  });

  it('is stable inside one bucket and varies across buckets', () => {
    const input = {
      personaId: 'persona-a',
      hour: 20,
      minute: 0,
      weekday: 'fri',
      asleep: false,
    };
    const first = decideOnline({ ...input, now: 1_000_000 });
    const same = decideOnline({ ...input, now: 1_000_000 + 60_000 });
    expect(first.online).toBe(same.online);
  });

  it('parses the busy schedule JSON', () => {
    expect(
      parseBusySchedule(
        JSON.stringify([
          { label: 'пары', days: ['mon'], from: '09:00', to: '15:00' },
          { label: 'сломано' },
        ]),
      ),
    ).toEqual([
      { label: 'пары', days: ['mon'], from: '09:00', to: '15:00' },
    ]);
  });

  it('finds a slot for the weekday and handles midnight crossing', () => {
    const slots = parseBusySchedule(
      JSON.stringify([
        { label: 'смена', days: ['fri'], from: '22:00', to: '02:00' },
      ]),
    );
    expect(busyNow(slots, 'fri', 23 * 60)?.label).toBe('смена');
    expect(busyNow(slots, 'sat', 60)?.label).toBe('смена');
    expect(busyNow(slots, 'mon', 23 * 60)).toBeNull();
  });

  it('maps a persona id to a stable pattern', () => {
    expect(patternFor('persona-a')).toBe(patternFor('persona-a'));
  });
});
