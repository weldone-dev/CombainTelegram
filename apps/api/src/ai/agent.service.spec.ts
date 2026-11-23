import { describe, expect, it, vi } from 'vitest';
import type { LlmReply, LlmToolCall, ToolSchema } from './ai.types.js';
import { AgentService } from './agent.service.js';

const SCHEMA: ToolSchema = {
  type: 'function',
  function: {
    name: 'accounts_list',
    description: 'List accounts',
    parameters: { type: 'object', properties: {} },
  },
};

const TOOL_CALL: LlmToolCall = {
  id: 'call-1',
  type: 'function',
  function: { name: 'accounts_list', arguments: '{"limit":5}' },
};

function reply(overrides: Partial<LlmReply> = {}): LlmReply {
  return {
    content: '',
    toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0 },
    model: 'main-model',
    ...overrides,
  };
}

function harness(
  options: { toolResult?: unknown; toolError?: boolean; skillTools?: string[] } = {},
) {
  const prisma = {
    agentRun: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'run-1',
        ...data,
      })),
      update: vi.fn(async () => ({})),
    },
  };
  const config = {
    requireProvider: vi.fn(async () => ({
      provider: 'openai-compatible',
      baseUrl: 'https://llm.test/v1',
      model: 'main-model',
      fastModel: 'fast-model',
      apiKey: 'sk-test',
      temperature: 0.4,
      maxSteps: 6,
      dryRun: true,
      source: 'database' as const,
    })),
  };
  const llm = { chat: vi.fn() };
  const souls = {
    model: vi.fn(async () => null),
    get: vi.fn(async () => null),
    promptFor: vi.fn(async () => ''),
  };
  const memory = {
    context: vi.fn(async () => ({ summary: '', facts: [], turns: [] })),
    formatContext: vi.fn(() => ''),
  };
  const skills = {
    instructions: vi.fn(async () => [] as Array<{ slug: string; text: string }>),
    toolsFor: vi.fn(async () => options.skillTools ?? []),
  };
  const tools = {
    schemas: vi.fn(
      async (_ctx: unknown, filter?: string[] | null) =>
        filter === null ||
        filter === undefined ||
        filter.includes('accounts_list')
          ? [SCHEMA]
          : [],
    ),
    execute: vi.fn(async () =>
      options.toolError
        ? { ok: false, error: 'policy refused', code: 'POLICY_DENIED' }
        : {
            ok: true,
            result: options.toolResult ?? { accounts: [{ id: 'acc-1' }] },
          },
    ),
  };

  const service = new AgentService(
    prisma as never,
    config as never,
    llm as never,
    souls as never,
    memory as never,
    skills as never,
    tools as never,
  );

  return { service, prisma, config, llm, souls, memory, skills, tools };
}

const input = {
  userId: 'user-1',
  source: 'ui',
  prompt: 'List my accounts',
};

function updatedData(
  prisma: ReturnType<typeof harness>['prisma'],
): Record<string, unknown> {
  const last = prisma.agentRun.update.mock.calls.at(-1);
  if (!last) throw new Error('no agent run update was recorded');
  return (last[0] as { data: Record<string, unknown> }).data;
}

describe('AgentService.run', () => {
  it('feeds tool results back and persists the run', async () => {
    const h = harness();
    h.llm.chat
      .mockResolvedValueOnce(
        reply({
          toolCalls: [TOOL_CALL],
          usage: { promptTokens: 10, completionTokens: 2 },
        }),
      )
      .mockResolvedValueOnce(
        reply({
          content: '  You have one account.  ',
          usage: { promptTokens: 5, completionTokens: 3 },
        }),
      );

    const result = await h.service.run(input);

    expect(result).toMatchObject({
      runId: 'run-1',
      text: 'You have one account.',
      model: 'main-model',
      steps: 2,
      usage: { promptTokens: 15, completionTokens: 5 },
    });
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0]).toMatchObject({
      step: 0,
      tool: 'accounts_list',
      args: { limit: 5 },
      result: { accounts: [{ id: 'acc-1' }] },
      durationMs: 0,
    });

    expect(h.tools.execute).toHaveBeenCalledWith(
      'accounts_list',
      { limit: 5 },
      {
        userId: 'user-1',
        accountId: null,
        chatId: null,
        source: 'ui',
      },
    );
    expect(h.tools.schemas).toHaveBeenCalledWith(
      { userId: 'user-1', accountId: null, chatId: null, source: 'ui' },
      null,
    );
    expect(h.llm.chat).toHaveBeenCalledTimes(2);
    expect(h.llm.chat.mock.calls[0]?.[0]).toMatchObject({
      baseUrl: 'https://llm.test/v1',
      apiKey: 'sk-test',
      model: 'main-model',
      temperature: 0.4,
    });

    const secondMessages = h.llm.chat.mock.calls[1]?.[0].messages as Array<{
      role: string;
      content: string | null;
      tool_calls?: LlmToolCall[];
      tool_call_id?: string;
    }>;
    expect(secondMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          tool_calls: [TOOL_CALL],
        }),
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'call-1',
        }),
      ]),
    );
    expect(JSON.stringify(secondMessages)).toContain('acc-1');

    expect(h.prisma.agentRun.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId: null,
        chatId: null,
        source: 'ui',
        prompt: 'List my accounts',
        model: 'main-model',
        status: 'running',
      }),
    });
    const data = updatedData(h.prisma);
    expect(data).toMatchObject({
      status: 'ok',
      output: 'You have one account.',
      steps: 2,
      inputTokens: 15,
      outputTokens: 5,
    });
    expect(JSON.parse(data.trace as string)).toEqual([
      expect.objectContaining({ tool: 'accounts_list', step: 0 }),
    ]);
    expect(data.finishedAt).toBeInstanceOf(Date);
  });

  it('treats an explicit empty tool list as no tools at all', async () => {
    const h = harness({ skillTools: ['memory_add'] });
    h.llm.chat.mockResolvedValue(reply({ content: 'Plain answer' }));

    const result = await h.service.run({ ...input, tools: [] });

    expect(result.text).toBe('Plain answer');
    expect(h.tools.schemas).toHaveBeenCalledWith(expect.anything(), []);
    expect(h.llm.chat.mock.calls[0]?.[0].tools).toEqual([]);
  });

  it('falls back to the skill tool list when the caller does not restrict it', async () => {
    const h = harness({ skillTools: ['memory_add'] });
    h.llm.chat.mockResolvedValue(reply({ content: 'Plain answer' }));

    await h.service.run(input);

    expect(h.tools.schemas).toHaveBeenCalledWith(expect.anything(), [
      'memory_add',
    ]);
  });

  it('records a failed tool as a trace entry but keeps going', async () => {    const h = harness({ toolError: true });
    h.llm.chat
      .mockResolvedValueOnce(
        reply({
          toolCalls: [TOOL_CALL],
          usage: { promptTokens: 1, completionTokens: 1 },
        }),
      )
      .mockResolvedValueOnce(reply({ content: 'Tool failed.' }));

    const result = await h.service.run(input);

    expect(result.text).toBe('Tool failed.');
    expect(result.trace[0]).toMatchObject({
      tool: 'accounts_list',
      error: 'policy refused',
    });
    const messages = h.llm.chat.mock.calls[1]?.[0].messages as Array<{
      role: string;
      content: string | null;
    }>;
    const toolMessage = messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('POLICY_DENIED');
  });

  it('asks for a plain summary after maxSteps of tool calls', async () => {
    const h = harness();
    h.llm.chat
      .mockResolvedValueOnce(
        reply({
          toolCalls: [TOOL_CALL],
          usage: { promptTokens: 1, completionTokens: 1 },
        }),
      )
      .mockResolvedValueOnce(
        reply({
          toolCalls: [TOOL_CALL],
          usage: { promptTokens: 1, completionTokens: 1 },
        }),
      )
      .mockResolvedValueOnce(
        reply({
          content: 'Summary text',
          usage: { promptTokens: 2, completionTokens: 2 },
        }),
      );

    const result = await h.service.run({ ...input, maxSteps: 2 });

    expect(result.text).toBe('Summary text');
    expect(result.steps).toBe(2);
    expect(result.trace).toHaveLength(2);
    expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 4 });
    expect(h.llm.chat).toHaveBeenCalledTimes(3);

    const finalRequest = h.llm.chat.mock.calls[2]?.[0] as {
      tools?: unknown;
      messages: Array<{ role: string; content: string | null }>;
    };
    expect(finalRequest.tools).toBeUndefined();
    expect(finalRequest.messages[finalRequest.messages.length - 1]).toMatchObject(
      { role: 'user', content: expect.stringContaining('подведи итог') },
    );
    expect(updatedData(h.prisma)).toMatchObject({
      status: 'ok',
      output: 'Summary text',
      steps: 2,
    });
  });

  it('marks the run as error and rethrows when the LLM fails', async () => {
    const h = harness();
    h.llm.chat.mockRejectedValue(new Error('LLM exploded'));

    await expect(h.service.run(input)).rejects.toThrow('LLM exploded');

    expect(h.prisma.agentRun.create).toHaveBeenCalledTimes(1);
    expect(updatedData(h.prisma)).toMatchObject({
      status: 'error',
      error: 'LLM exploded',
      steps: 0,
      trace: '[]',
      inputTokens: 0,
      outputTokens: 0,
    });
  });

  it('says the final text and executes single tools for MCP', async () => {
    const h = harness();
    h.llm.chat.mockResolvedValue(reply({ content: 'Hi' }));

    expect(await h.service.say(input)).toBe('Hi');

    await expect(
      h.service.callTool('accounts_list', { limit: 1 }, {
        userId: 'user-1',
        accountId: null,
        chatId: null,
        source: 'mcp',
      }),
    ).resolves.toEqual({ accounts: [{ id: 'acc-1' }] });

    h.tools.execute.mockResolvedValue({
      ok: false,
      error: 'policy refused',
      code: 'POLICY_DENIED',
    });
    await expect(
      h.service.callTool('accounts_list', {}, {
        userId: 'user-1',
        accountId: null,
        chatId: null,
        source: 'mcp',
      }),
    ).rejects.toThrow('POLICY_DENIED: policy refused');
  });

  it('parses tool arguments defensively', () => {
    const h = harness();

    expect(h.service.parseCall(TOOL_CALL)).toEqual({ limit: 5 });
    expect(
      h.service.parseCall({
        ...TOOL_CALL,
        function: { name: 'x', arguments: '' },
      }),
    ).toEqual({});
    expect(
      h.service.parseCall({
        ...TOOL_CALL,
        function: { name: 'x', arguments: 'not json' },
      }),
    ).toEqual({ __raw: 'not json' });
  });
});
