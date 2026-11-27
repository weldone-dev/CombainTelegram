import { afterEach, describe, expect, it } from 'bun:test';
import {
  buildSnapshotPayload,
  captureCount,
  messageEntriesOf,
  normalizeKind,
  postSnapshot,
  recordModelCallSettled,
  recordModelCallStarted,
  resetContextCapture,
  splitIncoming,
  systemBlocksOf,
  takeTurnCapture,
  estimateTokens,
} from './capture';

const ADDRESS = {
  personaId: 'persona-1',
  accountId: 'account-1',
  chatId: '1830539716',
  threadId: 0,
};

/** A realistic first model call of an inbound turn. */
function inboundCall() {
  return {
    model: { modelId: 'deepseek-v4.1-flash', provider: 'combain' },
    runtimeContext: { 'eve.turn': 'turn_6' },
    scope: { sessionId: 'session-1', turnId: 'turn_6', runId: 'run_9' },
    input: {
      instructions: [
        '# Кто ты\nТы живая девушка.',
        '# Персона\nтебя зовут Аня.\n\n# Отношения\nстадия: convinced',
      ].join('\n\n'),
      messages: [
        {
          role: 'user',
          kind: 'user',
          content: 'привет',
        },
        {
          role: 'assistant',
          content: 'привет)',
        },
        {
          role: 'user',
          kind: 'memory.load',
          content:
            'stage=convinced; interest=12; trust=8; attraction=6; annoyance=0; cringe=0',
        },
        {
          role: 'user',
          kind: 'memory.load',
          content: '- он любит горные лыжи\n- работает в айти',
        },
        {
          role: 'user',
          kind: 'user',
          content: [
            '[internal: intent=reply; bubbles=2; typing=true]',
            '[internal: он прислал фото]',
            'он(101): смотри какое фото',
            'он(102): правда красиво?',
          ].join('\n'),
        },
      ],
    },
  };
}

afterEach(() => {
  resetContextCapture();
  delete process.env.EVE_NEST_URL;
  delete process.env.EVE_TOKEN;
});

describe('estimateTokens', () => {
  it('uses a Cyrillic-aware coefficient instead of chars/4', () => {
    expect(estimateTokens('а'.repeat(220))).toBe(100);
    expect(estimateTokens('a'.repeat(400))).toBe(100);
    expect(estimateTokens('')).toBe(0);
  });
});

describe('systemBlocksOf', () => {
  it('partitions the exact system text by markdown headings', () => {
    const blocks = systemBlocksOf(
      '# Кто ты\nТы девушка.\n\n# Стиль\nКоротко.\n\n## Документы\nБез markdown.',
    );
    expect(blocks).toEqual([
      { name: 'Кто ты', text: '# Кто ты\nТы девушка.' },
      { name: 'Стиль', text: '# Стиль\nКоротко.' },
      { name: 'Документы', text: '## Документы\nБез markdown.' },
    ]);
  });

  it('keeps a heading-less prompt as one block', () => {
    expect(systemBlocksOf('просто системный текст')).toEqual([
      { name: 'system', text: 'просто системный текст' },
    ]);
    expect(systemBlocksOf(undefined)).toEqual([]);
  });

  it('accepts the AI SDK system message object Eve passes', () => {
    expect(
      systemBlocksOf({
        role: 'system',
        content: 'Instructions (instructions)\n# Кто ты\nТы девушка.',
      }),
    ).toEqual([
      { name: 'system', text: 'Instructions (instructions)' },
      { name: 'Кто ты', text: '# Кто ты\nТы девушка.' },
    ]);
  });

  it('normalizes the AI SDK chat provider suffix', () => {
    recordModelCallStarted({
      ...inboundCall(),
      model: { modelId: 'deepseek-v4.1-flash', provider: 'combain.chat' },
    });
    expect(takeTurnCapture('session-1', 'turn_6')!.model).toBe(
      'combain/deepseek-v4.1-flash',
    );
  });
});

describe('splitIncoming', () => {
  it('separates internal frames from the incoming series', () => {
    expect(
      splitIncoming(
        '[internal: intent=short]\n[internal: это ответ на сообщение «ок».]\nон(5): ну?',
      ),
    ).toEqual([
      {
        kind: 'internal',
        text: '[internal: intent=short]\n[internal: это ответ на сообщение «ок».]',
      },
      { kind: 'incoming', text: 'он(5): ну?' },
    ]);
  });
});

describe('messageEntriesOf', () => {
  it('labels memory, history, internal frames and incoming text', () => {
    const entries = messageEntriesOf(
      inboundCall().input.messages as unknown[],
      'inbound',
    );
    expect(entries).toEqual([
      { role: 'user', kind: 'history', text: 'привет' },
      { role: 'assistant', kind: 'history', text: 'привет)' },
      {
        role: 'user',
        kind: 'memory',
        text: 'stage=convinced; interest=12; trust=8; attraction=6; annoyance=0; cringe=0',
      },
      {
        role: 'user',
        kind: 'memory',
        text: '- он любит горные лыжи\n- работает в айти',
      },
      {
        role: 'user',
        kind: 'internal',
        text: '[internal: intent=reply; bubbles=2; typing=true]\n[internal: он прислал фото]',
      },
      {
        role: 'user',
        kind: 'incoming',
        text: 'он(101): смотри какое фото\nон(102): правда красиво?',
      },
    ]);
  });

  it('never shows model reasoning in assistant history', () => {
    const entries = messageEntriesOf(
      [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'The user says it is a dry-run test' },
            { type: 'text', text: 'да никак, сижу с кофе' },
          ],
        },
        {
          role: 'user',
          kind: 'user',
          content: 'ну что там?',
        },
      ],
      'inbound',
    );
    expect(entries).toEqual([
      { role: 'assistant', kind: 'history', text: 'да никак, сижу с кофе' },
      { role: 'user', kind: 'incoming', text: 'ну что там?' },
    ]);
  });

  it('marks the whole proactive prompt as internal', () => {
    const entries = messageEntriesOf(
      [
        {
          role: 'user',
          content: '[internal: proactive]\nПовод: спорт.\nНапиши первой.',
        },
      ],
      normalizeKind('proactive'),
    );
    // The frame prefix is stripped from history; the remaining event text is
    // still marked internal for this kind of turn.
    expect(entries).toEqual([
      {
        role: 'user',
        kind: 'internal',
        text: 'Повод: спорт.\nНапиши первой.',
      },
    ]);
  });
});

describe('capture store', () => {
  it('keeps the first non-compaction call of a turn and its usage', () => {
    recordModelCallStarted(inboundCall());
    recordModelCallStarted({
      ...inboundCall(),
      input: { instructions: 'второй вызов с tool-result', messages: [] },
    });
    recordModelCallSettled({
      outcome: 'completed',
      finishReason: 'stop',
      usage: { inputTokens: 2400, outputTokens: 40 },
      scope: { sessionId: 'session-1', turnId: 'turn_6', runId: 'run_9' },
    });

    const capture = takeTurnCapture('session-1', 'turn_6');
    expect(capture).not.toBeNull();
    expect(capture!.model).toBe('combain/deepseek-v4.1-flash');
    expect(capture!.finishReason).toBe('stop');
    expect(capture!.usage).toEqual({ input: 2400, output: 40 });
    expect(captureCount()).toBe(0);
    expect(takeTurnCapture('session-1', 'turn_6')).toBeNull();
  });

  it('ignores compaction calls and calls without a turn', () => {
    recordModelCallStarted({
      ...inboundCall(),
      runtimeContext: { 'eve.compaction.request': 'summary' },
    });
    recordModelCallStarted({
      model: { modelId: 'x' },
      scope: { sessionId: 'session-1' },
      input: { messages: [] },
    });
    expect(captureCount()).toBe(0);
  });
});

describe('buildSnapshotPayload', () => {
  it('builds the dashboard contract from the real model input', () => {
    recordModelCallStarted(inboundCall());
    recordModelCallSettled({
      outcome: 'completed',
      finishReason: 'stop',
      usage: { inputTokens: 2400, outputTokens: 40 },
      scope: { sessionId: 'session-1', turnId: 'turn_6' },
    });
    const capture = takeTurnCapture('session-1', 'turn_6')!;
    const payload = buildSnapshotPayload(
      capture,
      ADDRESS,
      normalizeKind('inbound'),
    );

    expect(payload).toMatchObject({
      personaId: 'persona-1',
      accountId: 'account-1',
      chatId: '1830539716',
      threadId: 0,
      kind: 'inbound',
      model: 'combain/deepseek-v4.1-flash',
      turnId: 'session-1:turn_6',
    });
    expect(payload.system.map((block) => block.name)).toEqual([
      'Кто ты',
      'Персона',
      'Отношения',
    ]);
    expect(payload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', kind: 'memory' }),
        expect.objectContaining({ role: 'user', kind: 'internal' }),
        expect.objectContaining({ role: 'user', kind: 'incoming' }),
      ]),
    );
    expect(payload.tokens).toEqual({
      system: expect.any(Number),
      messages: expect.any(Number),
      total: 2400,
      input: 2400,
      output: 40,
    });
    expect(payload.tokens.system).toBeGreaterThan(0);
    expect(payload.tokens.messages).toBeGreaterThan(0);
    expect(payload.meta).toMatchObject({
      sessionId: 'session-1',
      eveTurnId: 'turn_6',
      modelProvider: 'combain',
      finishReason: 'stop',
      estimated: true,
      estimator: 'chars',
    });
  });

  it('keeps the real input while estimating Russian system/messages close to it', () => {
    recordModelCallStarted({
      ...inboundCall(),
      input: {
        instructions: `# Персона\n${'ты живая девушка, '.repeat(800)}`,
        messages: [{ role: 'user', kind: 'user', content: 'б'.repeat(800) }],
      },
    });
    recordModelCallSettled({
      outcome: 'completed',
      finishReason: 'stop',
      usage: { inputTokens: 6300, outputTokens: 40 },
      scope: { sessionId: 'session-1', turnId: 'turn_6' },
    });
    const capture = takeTurnCapture('session-1', 'turn_6')!;
    const payload = buildSnapshotPayload(capture, ADDRESS, 'inbound');

    const estimated = payload.tokens.system! + payload.tokens.messages!;
    expect(payload.tokens.total).toBe(6300);
    expect(payload.tokens.input).toBe(6300);
    expect(Math.abs(estimated - 6300) / 6300).toBeLessThan(0.1);
    expect(payload.meta).toMatchObject({
      estimated: true,
      estimator: 'chars',
    });
  });

  it('marks tokens as estimated when the provider reported no usage', () => {
    recordModelCallStarted(inboundCall());
    const capture = takeTurnCapture('session-1', 'turn_6')!;
    const payload = buildSnapshotPayload(capture, ADDRESS, 'inbound');

    expect(payload.meta.estimated).toBe(true);
    expect(payload.tokens.input).toBeGreaterThan(0);
    expect(payload.tokens.total).toBeGreaterThan(0);
    expect(payload.meta.estimated === true).toBe(true);
  });
});

describe('postSnapshot', () => {
  it('posts to Nest with the Eve token', async () => {
    process.env.EVE_NEST_URL = 'http://nest.test';
    process.env.EVE_TOKEN = 'secret';
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const ok = await postSnapshot(
      {
        personaId: 'p',
        accountId: 'a',
        chatId: '1',
        threadId: 0,
        kind: 'inbound',
        model: 'combain/deepseek-v4.1-flash',
        turnId: 's:t',
        tokens: {},
        system: [],
        messages: [],
        meta: {},
      },
      fakeFetch,
    );

    expect(ok).toBe(true);
    expect(calls[0]!.url).toBe('http://nest.test/internal/eve/context/snapshot');
    expect(
      (calls[0]!.init.headers as Record<string, string>)['x-eve-token'],
    ).toBe('secret');
  });

  it('never throws when Nest is down', async () => {
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const ok = await postSnapshot(
      {
        personaId: 'p',
        accountId: 'a',
        chatId: '1',
        threadId: 0,
        kind: 'inbound',
        model: 'm',
        turnId: 's:t',
        tokens: {},
        system: [],
        messages: [],
        meta: {},
      },
      failing,
    );
    expect(ok).toBe(false);
  });
});
