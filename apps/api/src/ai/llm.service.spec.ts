import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmReply, LlmStreamHandlers, ToolSchema } from './ai.types.js';
import { LlmService } from './llm.service.js';
import type { LlmRequest } from './llm.service.js';

const SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'accounts_list',
    description: 'List accounts',
    parameters: { type: 'object', properties: {} },
  },
};

const REQUEST: LlmRequest = {
  baseUrl: 'https://llm.test/v1',
  apiKey: 'sk-test',
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [SCHEMA],
  temperature: 1,
  maxTokens: 900,
  reasoningEffort: 'low',
};

function reply(overrides: Partial<LlmReply> = {}): LlmReply {
  return {
    content: '',
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0 },
    model: 'test-model',
    ...overrides,
  };
}

/** SSE line with the given payload object. */
function sse(payload: unknown, eol = '\n'): string {
  return `data: ${JSON.stringify(payload)}${eol}${eol}`;
}

function responseFrom(
  chunks: string[],
  init: { status?: number; contentType?: string } = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': init.contentType ?? 'text/event-stream' },
  });
}

/** A stream that emits `chunks` and then never closes. */
function stallingResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function collect(handlers: {
  reasoning: string[];
  content: string[];
}): LlmStreamHandlers {
  return {
    onReasoningDelta: (text) => handlers.reasoning.push(text),
    onContentDelta: (text) => handlers.content.push(text),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LlmService.chatStream', () => {
  it('assembles content, reasoning, tool calls and usage from SSE', async () => {
    const fetchMock = vi.fn(async () =>
      responseFrom([
        ': keep-alive\r\n\r\n',
        sse({ model: 'streamed-model', choices: [{ delta: { role: 'assistant' } }] }, '\r\n'),
        sse({ choices: [{ delta: { reasoning_content: 'Думаю' } }] }, '\r\n'),
        sse({ choices: [{ delta: { reasoning_content: ' ещё' } }] }, '\r\n'),
        sse({ choices: [{ delta: { content: 'При' } }] }, '\r\n'),
        sse({ choices: [{ delta: { content: 'вет' } }] }, '\r\n'),
        // Multi-line `data:` fields are joined with a newline per the SSE spec.
        'data: {"choices":[{"delta":\r\ndata: {"content":"!"}}]}\r\n\r\n',
        sse(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call-1',
                      type: 'function',
                      function: { name: 'accounts_', arguments: '{"lim' },
                    },
                  ],
                },
              },
            ],
          },
          '\r\n',
        ),
        sse(
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      function: { name: 'list', arguments: 'it":5}' },
                    },
                  ],
                },
              },
            ],
          },
          '\r\n',
        ),
        sse(
          {
            choices: [],
            usage: { prompt_tokens: 11, completion_tokens: 7 },
          },
          '\r\n',
        ),
        'data: [DONE]\r\n\r\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const deltas = { reasoning: [] as string[], content: [] as string[] };
    const service = new LlmService();
    const result = await service.chatStream(REQUEST, collect(deltas));

    expect(result).toEqual({
      content: 'Привет!',
      reasoning: 'Думаю ещё',
      toolCalls: [
        {
          id: 'call-1',
          type: 'function',
          function: { name: 'accounts_list', arguments: '{"limit":5}' },
        },
      ],
      usage: { promptTokens: 11, completionTokens: 7 },
      model: 'streamed-model',
    });
    expect(deltas.reasoning).toEqual(['Думаю', ' ещё']);
    expect(deltas.content).toEqual(['При', 'вет', '!']);
    // Tool names and arguments never reach the text callbacks.
    const streamedText = [...deltas.reasoning, ...deltas.content].join(' ');
    expect(streamedText).not.toContain('accounts_list');
    expect(streamedText).not.toContain('limit');

    const init = fetchMock.mock.calls[0]?.[1] as { body: string };
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'test-model',
      temperature: 1,
      max_tokens: 900,
      reasoning_effort: 'low',
      tools: [SCHEMA],
      tool_choice: 'auto',
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('reassembles a chunk split mid-JSON', async () => {
    const fetchMock = vi.fn(async () =>
      responseFrom([
        'data: {"choices":[{"del',
        'ta":{"content":"Hel',
        'lo"}}]}\n\ndata: [DONE]\n\n',
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const service = new LlmService();
    const result = await service.chatStream(REQUEST);

    expect(result.content).toBe('Hello');
    expect(result.reasoning).toBeUndefined();
    expect(result.toolCalls).toEqual([]);
  });

  it('stops at [DONE] and ignores whatever follows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        responseFrom([
          sse({ choices: [{ delta: { content: 'A' } }] }),
          'data: [DONE]\n\n',
          sse({ choices: [{ delta: { content: 'B' } }] }),
        ]),
      ),
    );

    const deltas = { reasoning: [] as string[], content: [] as string[] };
    const service = new LlmService();
    const result = await service.chatStream(REQUEST, collect(deltas));

    expect(result.content).toBe('A');
    expect(deltas.content).toEqual(['A']);
  });

  it('accepts a plain JSON completion when the server ignores streaming', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              model: 'json-model',
              choices: [{ message: { content: 'plain answer' } }],
              usage: { prompt_tokens: 3, completion_tokens: 4 },
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const deltas = { reasoning: [] as string[], content: [] as string[] };
    const service = new LlmService();
    const result = await service.chatStream(REQUEST, collect(deltas));

    expect(result).toMatchObject({
      content: 'plain answer',
      model: 'json-model',
      usage: { promptTokens: 3, completionTokens: 4 },
    });
    expect(deltas.content).toEqual(['plain answer']);
  });

  it('surfaces a non-SSE error body without retrying a 4xx', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: 'streaming is not enabled' } }),
          {
            status: 400,
            headers: { 'content-type': 'application/json' },
          },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const service = new LlmService();
    await expect(service.chatStream(REQUEST)).rejects.toThrow(
      /LLM 400:.*streaming is not enabled/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to chat() when the stream fails before any delta', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('socket hang up');
      }),
    );
    const service = new LlmService();
    const expected = reply({ content: 'fallback answer' });
    const chatSpy = vi.spyOn(service, 'chat').mockResolvedValue(expected);

    const deltas = { reasoning: [] as string[], content: [] as string[] };
    const result = await service.chatStream(REQUEST, collect(deltas));

    expect(result).toBe(expected);
    expect(chatSpy).toHaveBeenCalledWith(REQUEST);
    expect(deltas).toEqual({ reasoning: [], content: [] });
  });

  it('fails with a timeout when the stream stalls mid-answer', async () => {
    const fetchMock = vi.fn(async () =>
      stallingResponse([
        sse({ choices: [{ delta: { reasoning_content: 'starting' } }] }),
      ]),
    );
    vi.stubGlobal('fetch', fetchMock);

    const deltas = { reasoning: [] as string[], content: [] as string[] };
    const service = new LlmService();

    await expect(
      service.chatStream({ ...REQUEST, timeoutMs: 30 }, collect(deltas)),
    ).rejects.toThrow(/timed out after 30 ms/);
    expect(deltas.reasoning).toContain('starting');
    // The retry policy still applies to timeouts.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
