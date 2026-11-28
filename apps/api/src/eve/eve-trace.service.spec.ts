import { afterEach, describe, expect, it, vi } from 'vitest';
import { decisionOf, EveTraceService } from './eve-trace.service.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('decisionOf', () => {
  it('keeps the decision fields the dashboard renders', () => {
    expect(
      decisionOf({
        ok: true,
        decision: {
          at: '2026-11-28T01:00:00.000Z',
          intent: 'reply',
          shouldReply: true,
          delaySec: 42.9,
          source: 'active-dialog',
          reaction: '🔥',
        },
      }),
    ).toEqual({
      at: '2026-11-28T01:00:00.000Z',
      intent: 'reply',
      shouldReply: true,
      delaySec: 42,
      source: 'active-dialog',
      reaction: '🔥',
    });
  });

  it('returns null for a chat that has no decision yet', () => {
    expect(decisionOf({ ok: true, decision: null })).toBeNull();
    expect(decisionOf({ ok: false, error: 'bad-address' })).toBeNull();
  });

  it('keeps the ignore reason of a refused turn', () => {
    expect(
      decisionOf({
        decision: {
          intent: 'ignore',
          shouldReply: false,
          ignoreReason: 'busy: работа',
          delaySec: 0,
        },
      }),
    ).toEqual({
      at: '',
      intent: 'ignore',
      shouldReply: false,
      delaySec: 0,
      ignoreReason: 'busy: работа',
    });
  });
});

describe('why', () => {
  it('reads the decision from the running Eve process', async () => {
    vi.stubEnv('EVE_WEBHOOK_URL', 'http://eve.test/eve/v1/nest/events');
    vi.stubEnv('EVE_WHY_URL', 'http://eve.test/eve/v1/nest/why');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            decision: {
              at: '2026-11-28T01:00:00.000Z',
              intent: 'short',
              shouldReply: true,
              delaySec: 4,
              source: 'active-dialog',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const service = new EveTraceService();
    const view = await service.why({
      personaId: 'persona-1',
      accountId: 'account-1',
      chatId: '1000',
    });

    expect(view.ok).toBe(true);
    expect(view.decision).toMatchObject({
      intent: 'short',
      shouldReply: true,
      delaySec: 4,
      source: 'active-dialog',
    });
    const [url] = fetchMock.mock.calls[0] as unknown as [URL];
    expect(String(url)).toBe(
      'http://eve.test/eve/v1/nest/why?personaId=persona-1&accountId=account-1&chatId=1000',
    );
  });

  it('answers a soft error when Eve is down', async () => {
    vi.stubEnv('EVE_WEBHOOK_URL', 'http://eve.test/eve/v1/nest/events');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      }),
    );

    const view = await new EveTraceService().why({
      personaId: 'persona-1',
      accountId: 'account-1',
      chatId: '1000',
    });

    expect(view.ok).toBe(false);
    expect(view.decision).toBeNull();
    expect(view.error).toContain('connection refused');
  });

  it('answers a soft error when Eve is not configured', async () => {
    vi.stubEnv('EVE_WEBHOOK_URL', '');
    const view = await new EveTraceService().why({
      personaId: 'persona-1',
      accountId: 'account-1',
      chatId: '1000',
    });
    expect(view.ok).toBe(false);
    expect(view.error).toContain('не настроен');
  });

  it('validates the address before calling Eve', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      new EveTraceService().why({ personaId: 'persona-1' }),
    ).rejects.toThrow(/accountId is required/);
    await expect(
      new EveTraceService().why({
        personaId: 'persona-1',
        accountId: 'account-1',
      }),
    ).rejects.toThrow(/chatId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
