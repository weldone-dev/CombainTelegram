import {
  MAX_QUERY_LENGTH,
  redactMessageBody,
  sanitizeDetails,
  sanitizeQueryForLog,
  serializeJson,
} from './log-sanitize.js';
import { emitLog, setLogSink } from './log-sink.js';

describe('log metadata sanitizing', () => {
  it('redacts sensitive keys and keeps ordinary values', () => {
    const sanitized = sanitizeDetails({
      phone: '+79990000000',
      password: 'hunter2',
      code: '12345',
      secret: 'abc',
      apiHash: 'deadbeef',
      chatId: 42,
      nested: { text: 'hello', token: 't' },
    }) as Record<string, unknown>;

    expect(sanitized.phone).toBe('[redacted]');
    expect(sanitized.password).toBe('[redacted]');
    expect(sanitized.code).toBe('[redacted]');
    expect(sanitized.secret).toBe('[redacted]');
    expect(sanitized.apiHash).toBe('[redacted]');
    expect(sanitized.chatId).toBe(42);
    expect(sanitized.nested).toMatchObject({
      text: 'hello',
      token: '[redacted]',
    });
  });

  it('bounds long strings and deep structures', () => {
    const long = 'x'.repeat(5000);
    const sanitized = sanitizeDetails({
      long,
      deep: { a: { b: { c: { d: { e: 'too deep' } } } } },
    }) as { long: string; deep: unknown };

    expect(sanitized.long.length).toBeLessThan(5000);
    expect(JSON.stringify(sanitized)).toContain('[truncated]');
  });

  it('redacts message text and captions to their length', () => {
    const body = redactMessageBody({
      text: 'secret plans',
      caption: 'look at this',
      replyToId: 7,
    }) as Record<string, unknown>;
    expect(body.text).toBe('[redacted, 12 chars]');
    expect(body.caption).toBe('[redacted, 12 chars]');
    expect(body.replyToId).toBe(7);
  });

  it('truncates the search query to 64 chars', () => {
    const long = 'x'.repeat(200);
    const query = sanitizeQueryForLog({ q: long, limit: '50' }) as Record<
      string,
      unknown
    >;
    expect(String(query.q)).toHaveLength(MAX_QUERY_LENGTH + 1);
    expect(query.limit).toBe('50');
    expect(sanitizeQueryForLog({ q: 'short' })).toEqual({ q: 'short' });
  });

  it('serializes errors and bigint safely', () => {
    const json = serializeJson({
      error: new Error('boom'),
      big: 10n,
      date: new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(json).toContain('"message":"boom"');
    expect(json).toContain('"big":"10"');
    expect(json).toContain('2026-01-02T03:04:05.000Z');
  });
});

describe('log sink', () => {
  afterEach(() => setLogSink(null));

  it('forwards entries and survives a throwing sink', () => {
    const received: string[] = [];
    setLogSink((entry) => received.push(entry.action));

    emitLog({
      level: 'info',
      source: 'app',
      action: 'test.action',
      message: 'hello',
    });

    setLogSink(() => {
      throw new Error('sink is broken');
    });
    expect(() =>
      emitLog({
        level: 'info',
        source: 'app',
        action: 'test.second',
        message: 'hi',
      }),
    ).not.toThrow();

    expect(received).toEqual(['test.action']);
  });
});
