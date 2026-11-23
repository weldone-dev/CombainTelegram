import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPABILITIES } from '../ai/ai.types.js';
import type { SkillView, SoulView } from '../ai/ai.types.js';
import type { AccountView } from '../accounts/account-view.js';
import { McpController } from './mcp.controller.js';

interface FakeResponse {
  statusCode?: number;
  body?: unknown;
  ended: boolean;
  status(code: number): FakeResponse;
  json(body: unknown): FakeResponse;
  end(): FakeResponse;
}

function fakeResponse(): FakeResponse {
  return {
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function skillRow(overrides: Partial<SkillView> = {}): SkillView {
  return {
    id: 'skill-1',
    slug: 'soul-creator',
    name: 'Soul creator',
    description: '',
    instructions: 'Create souls.',
    tools: [],
    origin: 'system',
    enabled: true,
    createdAt: '2026-11-24T10:00:00.000Z',
    updatedAt: '2026-11-24T10:00:00.000Z',
    ...overrides,
  };
}

function accountRow(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: 'acc-1',
    tgUserId: '1001',
    firstName: 'Roman',
    lastName: null,
    username: 'roman',
    phone: '+1 555 0100',
    phoneMasked: '+1 *** 0100',
    isActive: true,
    activeSessionId: null,
    createdAt: '2026-11-24T10:00:00.000Z',
    lastUsedAt: null,
    deviceProfile: null,
    sessions: [],
    ...overrides,
  };
}

function harness(
  options: {
    token?: string;
    toolResult?: unknown;
    toolExecute?: unknown;
  } = {},
) {
  const policy = {
    capabilities: { ...DEFAULT_CAPABILITIES },
    allowAccountIds: [],
    allowChatIds: [],
    blockChatIds: [],
    dryRun: true,
    ownerTgUserIds: [],
  };
  const config = {
    mcpToken: vi.fn(async () => options.token ?? 'secret-token'),
    policy: vi.fn(async () => policy),
  };
  const tools = {
    schemas: vi.fn(async () => [
      {
        type: 'function',
        function: {
          name: 'accounts_list',
          description: 'List accounts',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]),
    execute: vi.fn(
      async () =>
        options.toolExecute ?? {
          ok: true,
          result: options.toolResult ?? { accounts: ['acc-1'] },
        },
    ),
  };
  const skills = {
    list: vi.fn(async () => [
      skillRow(),
      skillRow({ id: 'skill-2', slug: 'other', name: 'Other' }),
    ]),
    get: vi.fn(async (name: string) =>
      name === 'soul-creator' ? skillRow() : null,
    ),
  };
  const souls = { list: vi.fn(async () => [{ id: 'soul-1' } as SoulView]) };
  const accounts = { list: vi.fn(async () => [accountRow()]) };
  const users = { get: vi.fn(async () => ({ id: 'user-1' })) };

  const controller = new McpController(
    config as never,
    tools as never,
    skills as never,
    souls as never,
    accounts as never,
    users as never,
  );

  return { controller, config, tools, skills, souls, accounts, users, policy };
}

async function call(
  h: ReturnType<typeof harness>,
  body: unknown,
  authorization: string | null = 'Bearer secret-token',
): Promise<FakeResponse> {
  const response = fakeResponse();
  if (authorization === null) {
    await h.controller.rpc({ body } as never, response as never);
  } else {
    await h.controller.rpc({ body } as never, response as never, authorization);
  }
  return response;
}

function errorOf(response: FakeResponse): { code: number; message: string } {
  return (response.body as { error: { code: number; message: string } }).error;
}

describe('McpController auth', () => {
  it('rejects a missing or malformed bearer token', async () => {
    const h = harness();
    const body = { jsonrpc: '2.0', id: 1, method: 'ping' };

    for (const header of [null, '', 'Bearer ', 'Basic secret-token']) {
      const response = await call(h, body, header);
      expect(response.statusCode).toBe(401);
      expect(errorOf(response)).toMatchObject({ code: -32001 });
    }
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('rejects a token of the same length but different bytes', async () => {
    const h = harness();
    const response = await call(
      h,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      'Bearer secret-toker',
    );

    expect(response.statusCode).toBe(401);
  });

  it('accepts the configured token case-insensitively for the scheme', async () => {
    const h = harness();
    const response = await call(
      h,
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      'bearer secret-token',
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });
});

describe('McpController methods', () => {
  it('answers initialize with the negotiated protocol and dry-run note', async () => {
    const h = harness();

    const response = await call(h, {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });

    expect(response.statusCode).toBe(200);
    const result = (response.body as { result: Record<string, unknown> }).result;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual({
      name: 'combain-telegram',
      title: 'CombainTelegram',
      version: '1.0.0',
    });
    expect(result.capabilities).toMatchObject({
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    });
    expect(String(result.instructions)).toContain('dryRun');
    expect(String(result.instructions)).toContain('read');
  });

  it('falls back to the server protocol version when the client omits it', async () => {
    const h = harness();

    const response = await call(h, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
    });

    expect(
      (response.body as { result: { protocolVersion: string } }).result
        .protocolVersion,
    ).toBe('2025-06-18');
  });

  it('lists tools from the shared registry', async () => {
    const h = harness();

    const response = await call(h, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });

    expect(response.body).toEqual({
      jsonrpc: '2.0',
      id: 3,
      result: {
        tools: [
          {
            name: 'accounts_list',
            description: 'List accounts',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
    expect(h.tools.schemas).toHaveBeenCalledWith(
      { userId: 'user-1', accountId: null, chatId: null, source: 'mcp' },
      null,
    );
  });

  it('executes a tool and serialises the result as text', async () => {
    const h = harness({ toolResult: { messages: [{ id: 1 }] } });

    const response = await call(h, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'messages_search', arguments: { query: 'hi' } },
    });

    expect(h.tools.execute).toHaveBeenCalledWith(
      'messages_search',
      { query: 'hi' },
      { userId: 'user-1', accountId: null, chatId: null, source: 'mcp' },
    );
    const result = (response.body as { result: Record<string, unknown> }).result;
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ messages: [{ id: 1 }] }, null, 2),
      },
    ]);
  });

  it('reports tool failures with isError instead of a JSON-RPC error', async () => {
    const h = harness({
      toolExecute: { ok: false, error: 'policy refused', code: 'POLICY_DENIED' },
    });

    const response = await call(h, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'messages_send', arguments: {} },
    });

    expect(response.statusCode).toBe(200);
    const result = (response.body as { result: Record<string, unknown> }).result;
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('POLICY_DENIED');
    expect(text).toContain('policy refused');
  });

  it('requires params.name for tools/call', async () => {
    const h = harness();

    const response = await call(h, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {},
    });

    expect(errorOf(response)).toMatchObject({ code: -32602 });
    expect(h.tools.execute).not.toHaveBeenCalled();
  });

  it('lists skills as prompts and reads one', async () => {
    const h = harness();

    const list = await call(h, {
      jsonrpc: '2.0',
      id: 7,
      method: 'prompts/list',
    });
    expect((list.body as { result: { prompts: unknown[] } }).result.prompts).toEqual(
      [
        {
          name: 'soul-creator',
          description: 'Soul creator',
          arguments: [],
        },
        { name: 'other', description: 'Other', arguments: [] },
      ],
    );

    const get = await call(h, {
      jsonrpc: '2.0',
      id: 8,
      method: 'prompts/get',
      params: { name: 'soul-creator' },
    });
    expect((get.body as { result: { messages: unknown[] } }).result.messages).toEqual(
      [
        {
          role: 'user',
          content: { type: 'text', text: 'Create souls.' },
        },
      ],
    );

    const missing = await call(h, {
      jsonrpc: '2.0',
      id: 9,
      method: 'prompts/get',
      params: { name: 'nope' },
    });
    expect(errorOf(missing)).toMatchObject({ code: -32602 });
  });

  it('reads the accounts and souls resources', async () => {
    const h = harness();

    const accounts = await call(h, {
      jsonrpc: '2.0',
      id: 10,
      method: 'resources/read',
      params: { uri: 'telegram://accounts' },
    });
    const accountContent = (
      accounts.body as {
        result: { contents: Array<{ uri: string; text: string }> };
      }
    ).result.contents[0];
    expect(accountContent?.uri).toBe('telegram://accounts');
    expect(JSON.parse(accountContent?.text ?? '')).toEqual([
      {
        id: 'acc-1',
        name: 'Roman',
        username: 'roman',
        phoneMasked: '+1 *** 0100',
      },
    ]);

    const souls = await call(h, {
      jsonrpc: '2.0',
      id: 11,
      method: 'resources/read',
      params: { uri: 'telegram://souls' },
    });
    const soulContent = (
      souls.body as {
        result: { contents: Array<{ text: string }> };
      }
    ).result.contents[0];
    expect(JSON.parse(soulContent?.text ?? '')).toEqual([{ id: 'soul-1' }]);

    const unknown = await call(h, {
      jsonrpc: '2.0',
      id: 12,
      method: 'resources/read',
      params: { uri: 'telegram://nope' },
    });
    expect(errorOf(unknown)).toMatchObject({ code: -32602 });
  });

  it('returns -32601 for an unknown method', async () => {
    const h = harness();

    const response = await call(h, {
      jsonrpc: '2.0',
      id: 13,
      method: 'does/not/exist',
    });

    expect(errorOf(response)).toEqual({
      code: -32601,
      message: 'Method not found: does/not/exist',
    });
  });

  it('answers a notification with 202 and no body', async () => {
    const h = harness();

    const response = await call(h, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });

    expect(response.statusCode).toBe(202);
    expect(response.ended).toBe(true);
    expect(response.body).toBeUndefined();
  });

  it('answers a batch with one reply per request, skipping notifications', async () => {
    const h = harness();

    const response = await call(h, [
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 'b', method: 'nope' },
    ]);

    expect(response.statusCode).toBe(200);
    const replies = response.body as Array<{
      id: unknown;
      result?: unknown;
      error?: { code: number };
    }>;
    expect(replies).toHaveLength(2);
    expect(replies[0]).toEqual({ jsonrpc: '2.0', id: 'a', result: {} });
    expect(replies[1]).toMatchObject({ id: 'b', error: { code: -32601 } });
  });
});

describe('McpController transport', () => {
  it('documents GET and no-op DELETE', () => {
    const h = harness();

    expect(h.controller.get()).toMatchObject({ error: expect.any(String) });
    expect(h.controller.delete()).toBeUndefined();
  });
});
