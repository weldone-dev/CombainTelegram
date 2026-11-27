import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_EVE_WEBHOOK_URL,
  eveWebhookUrl,
  pushEveEvent,
} from './eve-push.js';

const URL = 'http://127.0.0.1:4020/eve/v1/nest/events';
const EVENT = { id: 'evt-1', allowed: true, chatId: '1830539716' };

function fetchOf(...results: Array<() => Promise<unknown>>) {
  const mock = vi.fn();
  for (const result of results) mock.mockImplementationOnce(result);
  return mock;
}

beforeEach(() => {
  delete process.env.EVE_WEBHOOK_URL;
  delete process.env.EVE_ENABLED;
  delete process.env.EVE_TOKEN;
});

afterEach(() => {
  delete process.env.EVE_WEBHOOK_URL;
  delete process.env.EVE_ENABLED;
  delete process.env.EVE_TOKEN;
});

describe('eveWebhookUrl', () => {
  it('prefers an explicit EVE_WEBHOOK_URL', () => {
    process.env.EVE_WEBHOOK_URL = ' http://127.0.0.1:9999/events ';

    expect(eveWebhookUrl()).toBe('http://127.0.0.1:9999/events');
  });

  it('disables push when EVE_WEBHOOK_URL is explicitly empty', () => {
    process.env.EVE_WEBHOOK_URL = '   ';
    process.env.EVE_TOKEN = 'secret';

    expect(eveWebhookUrl()).toBeNull();
  });

  it('defaults to the local Eve endpoint when Eve is configured', () => {
    process.env.EVE_TOKEN = 'secret';
    expect(eveWebhookUrl()).toBe(DEFAULT_EVE_WEBHOOK_URL);

    delete process.env.EVE_TOKEN;
    process.env.EVE_ENABLED = 'true';
    expect(eveWebhookUrl()).toBe(DEFAULT_EVE_WEBHOOK_URL);
  });

  it('is disabled when nothing is configured', () => {
    expect(eveWebhookUrl()).toBeNull();
  });
});

describe('pushEveEvent', () => {
  it('posts once on success with the shared token', async () => {
    const mock = fetchOf(async () => ({ ok: true, status: 200 }));

    const result = await pushEveEvent(URL, EVENT, {
      token: 'secret',
      fetchImpl: mock as unknown as typeof fetch,
      delaysMs: [0, 0, 0],
    });

    expect(result).toEqual({ ok: true, attempts: 1, status: 200 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-eve-token': 'secret',
        },
        body: JSON.stringify(EVENT),
      }),
    );
  });

  it('retries three times with backoff and reports the last error', async () => {
    const mock = vi.fn(async () => {
      throw new Error('connection refused');
    });

    const result = await pushEveEvent(URL, EVENT, {
      fetchImpl: mock as unknown as typeof fetch,
      delaysMs: [0, 0, 0],
    });

    expect(result).toMatchObject({
      ok: false,
      attempts: 3,
      error: 'connection refused',
    });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('retries a non-2xx answer and reports the status', async () => {
    const mock = vi.fn(async () => ({ ok: false, status: 503 }));

    const result = await pushEveEvent(URL, EVENT, {
      fetchImpl: mock as unknown as typeof fetch,
      delaysMs: [0, 0, 0],
    });

    expect(result).toMatchObject({
      ok: false,
      attempts: 3,
      status: 503,
      error: 'HTTP 503',
    });
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it('stops retrying once an attempt succeeds', async () => {
    const mock = fetchOf(
      async () => {
        throw new Error('connection refused');
      },
      async () => ({ ok: true, status: 204 }),
    );

    const result = await pushEveEvent(URL, EVENT, {
      fetchImpl: mock as unknown as typeof fetch,
      delaysMs: [0, 0, 0],
    });

    expect(result).toEqual({ ok: true, attempts: 2, status: 204 });
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
