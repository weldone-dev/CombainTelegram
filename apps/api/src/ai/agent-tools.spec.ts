import { describe, expect, it, vi } from 'vitest';
import { AgentToolsService } from './agent-tools.service.js';
import { DEFAULT_CAPABILITIES } from './ai.types.js';

function harness(overrides: { caps?: Partial<typeof DEFAULT_CAPABILITIES>; dryRun?: boolean } = {}) {
  const caps = { ...DEFAULT_CAPABILITIES, ...overrides.caps };
  const messaging = {
    sendMessage: vi.fn(async () => ({ id: 1 })),
    getChat: vi.fn(async () => ({ id: 42, type: 'user', title: 'Peer' })),
  };
  const policy = {
    capabilities: vi.fn(async () => caps),
    assert: vi.fn(async () => overrides.dryRun ?? true),
    evaluate: vi.fn(async () => ({
      allowed: true,
      dryRun: overrides.dryRun ?? true,
    })),
  };
  const config = {
    policy: vi.fn(async () => ({
      capabilities: caps,
      allowAccountIds: [],
      allowChatIds: [],
      blockChatIds: [],
      dryRun: overrides.dryRun ?? true,
      ownerTgUserIds: [],
    })),
    view: vi.fn(async () => ({
      provider: 'openai-compatible',
      baseUrl: 'https://example.test/v1',
      model: 'test',
      fastModel: 'test',
      hasApiKey: true,
      apiKeyHint: '…1234',
      temperature: 0.7,
      maxSteps: 6,
      dryRun: overrides.dryRun ?? true,
      capabilities: caps,
      allowAccountIds: [],
      allowChatIds: [],
      blockChatIds: [],
      ownerTgUserIds: [],
      source: 'database',
      envConfigured: false,
      mcp: { endpoint: '/mcp', token: 'token' },
      updatedAt: null,
    })),
    updatePolicy: vi.fn(async () => ({})),
  };
  const service = new AgentToolsService(
    { list: vi.fn(async () => []) } as never,
    messaging as never,
    { query: vi.fn(async () => ({ entries: [], nextBefore: null })) } as never,
    { list: vi.fn(async () => []), get: vi.fn(), update: vi.fn(), model: vi.fn() } as never,
    { view: vi.fn(), addFact: vi.fn(), summarize: vi.fn() } as never,
    { list: vi.fn(async () => []) } as never,
    config as never,
    policy as never,
    { list: vi.fn(async () => []), create: vi.fn(), update: vi.fn(), remove: vi.fn(), requestRun: vi.fn() } as never,
    { list: vi.fn(async () => []) } as never,
    { count: vi.fn(async () => 0) } as never,
  );
  return { service, messaging, policy };
}

const ctx = {
  userId: 'user-1',
  accountId: 'account-1',
  chatId: null,
  source: 'mcp',
};

describe('AgentToolsService', () => {
  it('does not touch Telegram when dryRun simulated the write', async () => {
    const { service, messaging } = harness({ dryRun: true });
    const result = await service.execute(
      'messages_send',
      { accountId: 'account-1', chatId: 42, text: 'hello' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses to act on another account from a scoped surface', async () => {
    const { service } = harness();
    const result = await service.execute(
      'messages_send',
      { accountId: 'account-2', chatId: 42, text: 'hello' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('ACCOUNT_SCOPE');
  });

  it('filters tools by capability for MCP', async () => {
    const { service } = harness({
      caps: { send: false, edit: false, react: false },
    });
    const schemas = await service.schemas(ctx, null);
    const names = schemas.map((schema) => schema.function.name);
    expect(names).toContain('accounts_list');
    expect(names).not.toContain('messages_send');
  });

  it('returns a structured error for an unknown tool', async () => {
    const { service } = harness();
    const result = await service.execute('nope', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNKNOWN_TOOL');
  });
});
