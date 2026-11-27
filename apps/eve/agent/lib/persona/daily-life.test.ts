import { describe, expect, test } from 'bun:test';
import {
  blockAtHour,
  collectRecentEvents,
  currentBlock,
  dailyLifePromptFragment,
  decodeDailyLifeCache,
  encodeDailyLifeCache,
  isPhoneAvailable,
  isQuietBlock,
  isUsableDailyLife,
  parseHourValue,
  validateDailyLife,
} from './daily-life';
import type { DailyLife } from './types';

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0); // 12:00 Moscow

function day(): DailyLife {
  return {
    dateLocal: '2026-11-27',
    weather: 'мокрый снег',
    vibe: 'сонный день',
    blocks: [
      {
        fromHour: 8,
        toHour: 10,
        activity: 'просыпается',
        social: 'alone',
        phoneAvailable: true,
      },
      {
        fromHour: 10,
        toHour: 14,
        activity: 'на работе',
        social: 'with-coworkers',
        phoneAvailable: false,
      },
      {
        fromHour: 14,
        toHour: 15,
        activity: 'обед',
        social: 'alone',
        phoneAvailable: true,
      },
      {
        fromHour: 15,
        toHour: 18,
        activity: 'работа',
        social: 'with-coworkers',
        phoneAvailable: false,
      },
      {
        fromHour: 18,
        toHour: 21,
        activity: 'дом',
        social: 'with-family',
        phoneAvailable: true,
      },
      {
        fromHour: 21,
        toHour: 23,
        activity: 'сериал',
        social: 'alone',
        phoneAvailable: true,
      },
    ],
    events: ['преподша наорала', 'нашла смешной мем'],
    wants: ['выспаться', 'шаурму'],
  };
}

describe('daily-life validation', () => {
  test('normalizes a valid day', () => {
    const result = validateDailyLife(day(), { dateLocal: '2026-11-27' });
    expect(result.issues).toEqual([]);
    expect(result.value.blocks).toHaveLength(6);
    expect(isUsableDailyLife(result.value)).toBe(true);
  });

  test('caps blocks at 9 and reports too many', () => {
    const raw = {
      ...day(),
      blocks: Array.from({ length: 12 }, (_, index) => ({
        fromHour: index % 24,
        toHour: (index + 1) % 24,
        activity: `дело ${index}`,
        social: 'alone',
        phoneAvailable: true,
      })),
    };
    const result = validateDailyLife(raw, { dateLocal: '2026-11-27' });
    expect(result.value.blocks).toHaveLength(9);
    expect(result.issues).toContain('too-many-blocks');
  });

  test('drops invalid blocks and reports too few', () => {
    const result = validateDailyLife(
      {
        vibe: 'день',
        blocks: [
          { fromHour: 9, toHour: 9, activity: 'не бывает' },
          { fromHour: '10:00', toHour: '12:00', activity: 'ок' },
          'мусор',
        ],
      },
      { dateLocal: '2026-11-27' },
    );
    expect(result.value.blocks).toHaveLength(1);
    expect(result.issues).toContain('too-few-blocks');
  });

  test('parses hour formats and rejects minute granularity', () => {
    expect(parseHourValue('08:00')).toBe(8);
    expect(parseHourValue('8:00')).toBe(8);
    expect(parseHourValue('24:00')).toBe(0);
    expect(parseHourValue(22)).toBe(22);
    expect(parseHourValue('8:30')).toBeNull();
    expect(parseHourValue(25)).toBeNull();
    expect(parseHourValue('nope')).toBeNull();
  });
});

describe('blocks and cache', () => {
  test('finds blocks including a midnight-crossing one', () => {
    const life = day();
    expect(blockAtHour(life, 12)?.activity).toBe('на работе');
    expect(blockAtHour(life, 20)?.activity).toBe('дом');
    expect(blockAtHour(life, 3)).toBeUndefined(); // real gap, not "last block"
    expect(currentBlock(life, { timezone: 'Europe/Moscow' }, NOW)?.activity).toBe(
      'на работе',
    );

    const night: DailyLife = {
      ...life,
      blocks: [
        {
          fromHour: 22,
          toHour: 6,
          activity: 'вечеринка',
          social: 'with-friends',
          phoneAvailable: true,
        },
      ],
    };
    expect(blockAtHour(night, 23)?.activity).toBe('вечеринка');
    expect(blockAtHour(night, 2)?.activity).toBe('вечеринка');
    expect(blockAtHour(night, 12)).toBeUndefined();
  });

  test('phone availability and quiet blocks come from the current block', () => {
    const life = day();
    expect(isPhoneAvailable(life, 12)).toBe(false);
    expect(isQuietBlock(life, 12)).toBe(true);
    expect(isQuietBlock(life, 20)).toBe(false);
    expect(isPhoneAvailable(life, 3)).toBe(true); // unknown time is not a block
  });

  test('markdown cache round-trips through the daily comment', () => {
    const life = day();
    const markdown = encodeDailyLifeCache(life);
    expect(markdown).toContain('<!--daily:');
    expect(markdown).toContain('## Расписание');
    expect(decodeDailyLifeCache(markdown, '2026-11-27')).toEqual(life);
    expect(decodeDailyLifeCache('no marker', '2026-11-27')).toBeNull();
    expect(decodeDailyLifeCache('<!--daily:{broken}-->', '2026-11-27')).toBeNull();
  });

  test('prompt fragment tells her what she is doing without dumping a schedule', () => {
    const fragment = dailyLifePromptFragment(day(), { timezone: 'Europe/Moscow' }, NOW);
    expect(fragment).toContain('Твой день');
    expect(fragment).toContain('на работе');
    expect(fragment).toContain('телефон сейчас недоступен');
    expect(fragment).toContain('преподша наорала');
  });

  test('collects recent events without duplicates', () => {
    expect(collectRecentEvents([day(), day()])).toEqual([
      'преподша наорала',
      'нашла смешной мем',
    ]);
  });
});
