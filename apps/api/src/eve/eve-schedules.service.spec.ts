import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  delayedPreview,
  eveInfoUrl,
  parseChatId,
  parseLimit,
  parseStates,
  splitSchedules,
} from './eve-schedules.service.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('splitSchedules', () => {
  it('reads static schedules from the Eve info payload', () => {
    const result = splitSchedules({
      schedules: [
        {
          name: 'presence',
          cron: '* * * * *',
          logicalPath: 'schedules/presence.ts',
          hasRun: true,
        },
        {
          name: 'proactive',
          cron: '*/5 * * * *',
          logicalPath: 'schedules/proactive.ts',
          hasRun: false,
          timezone: 'Europe/Moscow',
        },
      ],
    });

    expect(result.static).toEqual([
      {
        name: 'presence',
        cron: '* * * * *',
        path: 'schedules/presence.ts',
        hasRun: true,
        timezone: null,
      },
      {
        name: 'proactive',
        cron: '*/5 * * * *',
        path: 'schedules/proactive.ts',
        hasRun: false,
        timezone: 'Europe/Moscow',
      },
    ]);
    expect(result.dynamic).toEqual([]);
  });

  it('moves flagged schedules and collections into dynamic', () => {
    const result = splitSchedules({
      schedules: [
        { name: 'static', cron: '* * * * *', logicalPath: 'schedules/a.ts' },
        {
          name: 'runtime',
          cron: '0 * * * *',
          logicalPath: 'schedules/b.ts',
          owner: { kind: 'dynamic' },
        },
      ],
      scheduleCollections: [
        {
          name: 'reminders',
          logicalPath: 'schedules/reminders.ts',
          application: 'agent',
        },
      ],
    });

    expect(result.static.map((row) => row.name)).toEqual(['static']);
    expect(result.dynamic.map((row) => row.name)).toEqual([
      'runtime',
      'reminders',
    ]);
  });

  it('ignores malformed entries instead of failing the list', () => {
    const result = splitSchedules({ schedules: [null, {}, { cron: '*' }] });
    expect(result.static).toEqual([]);
    expect(result.dynamic).toEqual([]);
  });
});

describe('delayedPreview', () => {
  it('prefers incoming text and truncates to 200 characters', () => {
    const long = 'x'.repeat(500);
    expect(
      delayedPreview({
        kind: 'turn',
        payload: JSON.stringify({ incoming: long }),
      }),
    ).toHaveLength(200);
  });

  it('falls back to burst, text, emoji and finally the kind', () => {
    expect(
      delayedPreview({
        kind: 'turn',
        payload: JSON.stringify({
          burst: [{ text: 'first' }, { text: 'second' }],
        }),
      }),
    ).toBe('second');
    expect(
      delayedPreview({
        kind: 'edit',
        payload: JSON.stringify({ text: 'fixed' }),
      }),
    ).toBe('fixed');
    expect(
      delayedPreview({
        kind: 'react',
        payload: JSON.stringify({ emoji: '🔥' }),
      }),
    ).toBe('🔥');
    expect(delayedPreview({ kind: 'read', payload: 'not json' })).toBe('read');
  });
});

describe('query parsing', () => {
  it('defaults to pending and ignores unknown states', () => {
    expect(parseStates(undefined)).toEqual(['pending']);
    expect(parseStates('')).toEqual(['pending']);
    expect(parseStates('bogus')).toEqual(['pending']);
    expect(parseStates('failed,pending,failed')).toEqual(['failed', 'pending']);
  });

  it('caps the limit', () => {
    expect(parseLimit(undefined)).toBe(100);
    expect(parseLimit('0')).toBe(1);
    expect(parseLimit('9999')).toBe(200);
    expect(parseLimit('nope')).toBe(100);
  });

  it('parses chat ids without losing precision', () => {
    expect(parseChatId('1830539716')).toBe(1830539716n);
    expect(parseChatId('-1001234567890')).toBe(-1001234567890n);
    expect(parseChatId('12x')).toBeNull();
    expect(parseChatId('')).toBeNull();
  });
});

describe('eveInfoUrl', () => {
  it('derives /eve/v1/info from the webhook host', () => {
    vi.stubEnv('EVE_TOKEN', 'token');
    vi.stubEnv(
      'EVE_WEBHOOK_URL',
      'http://127.0.0.1:4020/eve/v1/nest/events',
    );
    expect(eveInfoUrl()).toBe('http://127.0.0.1:4020/eve/v1/info');
  });

  it('returns null when Eve is not configured', () => {
    vi.stubEnv('EVE_TOKEN', '');
    vi.stubEnv('EVE_ENABLED', '');
    delete process.env.EVE_WEBHOOK_URL;
    expect(eveInfoUrl()).toBeNull();
  });
});
