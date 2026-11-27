import { afterEach, describe, expect, it } from 'bun:test';
import hook from '../../hooks/context-snapshot';
import {
  recordModelCallStarted,
  recordModelCallSettled,
  resetContextCapture,
} from './capture';

function ctx(kind: string) {
  return {
    session: {
      id: 'session-1',
      auth: {
        current: {
          attributes: {
            personaId: 'persona-1',
            accountId: 'account-1',
            chatId: '1830539716',
            threadId: '0',
            kind,
          },
        },
        initiator: null,
      },
    },
  };
}

function call() {
  return {
    model: { modelId: 'deepseek-v4.1-flash', provider: 'combain' },
    scope: { sessionId: 'session-1', turnId: 'turn_3', runId: 'run_1' },
    input: {
      instructions: '# Персона\nтебя зовут Аня.',
      messages: [
        { role: 'user', kind: 'memory.load', content: 'stage=convinced' },
        {
          role: 'user',
          kind: 'user',
          content: '[internal: intent=reply]\nон(9): привет',
        },
      ],
    },
  };
}

const events = hook.events as unknown as Record<
  string,
  (event: unknown, context: unknown) => Promise<void>
>;

afterEach(() => {
  resetContextCapture();
  delete process.env.EVE_NEST_URL;
  delete process.env.EVE_TOKEN;
});

describe('context snapshot hook', () => {
  it('posts the captured turn with the address and the turn kind', async () => {
    process.env.EVE_NEST_URL = 'http://nest.test';
    process.env.EVE_TOKEN = 'secret';
    recordModelCallStarted(call());
    recordModelCallSettled({
      outcome: 'completed',
      usage: { inputTokens: 1000, outputTokens: 25 },
      scope: { sessionId: 'session-1', turnId: 'turn_3' },
    });
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await events['turn.settled']!({ data: { turnId: 'turn_3' } }, ctx('reaction'));

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      personaId: 'persona-1',
      accountId: 'account-1',
      chatId: '1830539716',
      kind: 'reaction',
      turnId: 'session-1:turn_3',
      tokens: { input: 1000, output: 25, total: 1000 },
    });
    expect(
      (bodies[0]!.messages as Array<{ kind?: string }>).map((row) => row.kind),
    ).toEqual(['memory', 'internal']);
  });

  it('does nothing when there is no capture or no address', async () => {
    let called = 0;
    globalThis.fetch = (async () => {
      called += 1;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await events['turn.settled']!({ data: { turnId: 'turn_missing' } }, ctx('inbound'));
    expect(called).toBe(0);
  });
});
