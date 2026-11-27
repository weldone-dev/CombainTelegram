import { describe, expect, it } from 'vitest';
import {
  normalizeLlmAgendaItems,
  parseAgendaActions,
  parseAgendaItems,
} from './eve-agenda-llm.js';

const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);

function at(hoursFromNow: number): string {
  return new Date(NOW + hoursFromNow * 3_600_000).toISOString();
}

describe('normalizeLlmAgendaItems', () => {
  const base = {
    now: NOW,
    timezone: 'UTC',
    sleepFrom: 23,
    sleepTo: 8,
    limit: 3,
  };

  it('keeps a valid future item and dedupes', () => {
    const result = normalizeLlmAgendaItems(
      [
        { about: 'спросить про соревнования', pingAt: at(6), importance: 2 },
        { about: 'спросить про соревнования', pingAt: at(8) },
      ],
      base,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.importance).toBe(2);
    expect(result.rejected).toBe(1);
  });

  it('rejects past, quiet and duplicate items', () => {
    const result = normalizeLlmAgendaItems(
      [
        { about: 'в прошлом', pingAt: at(-2) },
        { about: 'ночью', pingAt: at(13) },
      ],
      {
        ...base,
        blocks: [{ fromHour: 18, toHour: 20, phoneAvailable: false }],
      },
    );
    expect(result.items).toHaveLength(0);
  });

  it('enforces the 45-minute spacing', () => {
    const result = normalizeLlmAgendaItems(
      [
        { about: 'первое сообщение', pingAt: at(6) },
        { about: 'второе сообщение', pingAt: at(6.5) },
      ],
      base,
    );
    expect(result.items).toHaveLength(1);
  });
});

describe('agenda payload parsing', () => {
  it('reads arrays and wrapped objects', () => {
    expect(parseAgendaItems({ items: [{ about: 'a' }] })).toHaveLength(1);
    expect(parseAgendaItems([{ about: 'a' }])).toHaveLength(1);
    expect(parseAgendaActions({ actions: [{ action: 'create' }] })).toHaveLength(
      1,
    );
    expect(parseAgendaActions(null)).toEqual([]);
  });
});
