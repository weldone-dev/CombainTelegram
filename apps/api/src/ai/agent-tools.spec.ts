import { describe, expect, it, vi } from 'vitest';
import { AgentToolsService } from './agent-tools.service.js';
import { PolicyError } from './ai-policy.service.js';
import { DEFAULT_CAPABILITIES, type AiCapabilities } from './ai.types.js';

function harness(
  overrides: {
    caps?: Partial<AiCapabilities>;
    dryRun?: boolean;
    /** Per-account capability overrides, mirroring `AiAccountPolicyService`. */
    accountCaps?: Record<string, Partial<AiCapabilities>>;
  } = {},
) {
  const caps = { ...DEFAULT_CAPABILITIES, ...overrides.caps };
  const capsFor = (accountId: string | null): AiCapabilities =>
    accountId && overrides.accountCaps?.[accountId]
      ? { ...caps, ...overrides.accountCaps[accountId] }
      : caps;
  const messaging = {
    sendMessage: vi.fn(async () => ({ id: 1 })),
    getChat: vi.fn(async () => ({ id: 42, type: 'user', title: 'Peer' })),
  };
  const policy = {
    capabilities: vi.fn(async (accountId: string | null = null) =>
      capsFor(accountId),
    ),
    // Same rule as the real resolver: the effective capability of the calling
    // account decides, an account override wins over the global one.
    assert: vi.fn(
      async (
        capability: keyof AiCapabilities,
        ctx?: { accountId?: string | null },
      ) => {
        if (!capsFor(ctx?.accountId ?? null)[capability]) {
          throw new PolicyError(
            `Capability "${capability}" is disabled for the AI/MCP. Enable it in AI permissions.`,
            'CAPABILITY_DISABLED',
          );
        }
        return overrides.dryRun ?? true;
      },
    ),
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
  const automations = {
    list: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: 'automation-1' })),
    update: vi.fn(),
    remove: vi.fn(),
    requestRun: vi.fn(),
    pauseForChat: vi.fn(async () => []),
    resume: vi.fn(async () => []),
  };
  const access = {
    view: vi.fn(async () => ({
      allowed: false,
      blocked: false,
      reason: null,
      warnings: 0,
      soulId: null,
      note: null,
      threadId: 0,
    })),
    setAccess: vi.fn(async () => ({ allowed: true })),
    block: vi.fn(async () => ({ blocked: true })),
    unblock: vi.fn(async () => ({ removed: true, warnings: 0, blocked: false })),
    bumpWarning: vi.fn(async () => ({ warnings: 1, blocked: false })),
    removeAccess: vi.fn(),
    list: vi.fn(),
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
    automations as never,
    { list: vi.fn(async () => []) } as never,
    { count: vi.fn(async () => 0) } as never,
    access as never,
  );
  return { service, messaging, policy, automations, access };
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
      caps: { send: false, edit: false, react: false, automations: false },
    });
    const schemas = await service.schemas(ctx, null);
    const names = schemas.map((schema) => schema.function.name);
    expect(names).toContain('accounts_list');
    expect(names).not.toContain('messages_send');
    expect(names).not.toContain('automation_pause_chat');
    expect(names).not.toContain('chat_block');
  });

  it('returns a structured error for an unknown tool', async () => {
    const { service } = harness();
    const result = await service.execute('nope', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.code).toBe('UNKNOWN_TOOL');
  });

  it('binds an automation to the chat as the soul', async () => {
    const { service, automations } = harness();
    const result = await service.execute(
      'automation_create',
      {
        accountId: 'account-1',
        chatId: 42,
        threadId: 7,
        timezone: 'Europe/Moscow',
        name: 'Follow up',
        trigger: { kind: 'every', minutes: 60 },
        action: { type: 'agent', prompt: 'Check in' },
      },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(automations.create).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'account-1',
        chatId: 42,
        threadId: 7,
        timezone: 'Europe/Moscow',
        createdBy: 'soul',
      }),
    );
  });

  it('returns the service error when chatId has no account', async () => {
    const { service, automations } = harness();
    automations.create.mockRejectedValue(
      new Error('chatId requires accountId'),
    );
    const result = await service.execute(
      'automation_create',
      {
        chatId: 42,
        name: 'Follow up',
        trigger: { kind: 'every', minutes: 60 },
        action: { type: 'agent', prompt: 'Check in' },
      },
      { ...ctx, accountId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('TOOL_ERROR');
    expect(result.error).toBe('chatId requires accountId');
  });

  it('pauses and resumes the automations of one chat', async () => {
    const { service, automations } = harness();
    automations.pauseForChat.mockResolvedValue([
      { id: 'automation-1', name: 'Ping', enabled: true, selfPaused: true, selfPauseReason: 'rude' },
    ] as never);
    const paused = await service.execute(
      'automation_pause_chat',
      { accountId: 'account-1', chatId: 42, threadId: 5, reason: 'rude' },
      ctx,
    );
    expect(paused.ok).toBe(true);
    expect(paused.result).toMatchObject({ chatId: 42, threadId: 5, count: 1 });
    expect(automations.pauseForChat).toHaveBeenCalledWith({
      accountId: 'account-1',
      chatId: 42,
      threadId: 5,
      reason: 'rude',
    });

    const resumed = await service.execute(
      'automation_resume_chat',
      { accountId: 'account-1', chatId: 42 },
      ctx,
    );
    expect(resumed.ok).toBe(true);
    expect(automations.resume).toHaveBeenCalledWith({
      accountId: 'account-1',
      chatId: 42,
      threadId: 0,
    });
  });

  it('requires a reason to pause a chat', async () => {
    const { service, automations } = harness();
    const result = await service.execute(
      'automation_pause_chat',
      { accountId: 'account-1', chatId: 42 },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reason/);
    expect(automations.pauseForChat).not.toHaveBeenCalled();
  });

  it('reads the access view of one chat/topic', async () => {
    const { service, access } = harness();
    const result = await service.execute(
      'ai_access_get',
      { accountId: 'account-1', chatId: 42, threadId: 7 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(access.view).toHaveBeenCalledWith('user-1', 'account-1', 42, 7);
  });

  it('sets the access row of a chat', async () => {
    const { service, access } = harness();
    const result = await service.execute(
      'ai_access_set',
      { accountId: 'account-1', chatId: 42, enabled: true, note: 'vip' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(access.setAccess).toHaveBeenCalledWith({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: 42,
      threadId: 0,
      enabled: true,
      soulId: undefined,
      note: 'vip',
    });
  });

  it('reports the automatic block when the warning threshold is reached', async () => {
    const { service, access } = harness({ caps: { admin: true } });
    access.bumpWarning.mockResolvedValue({ warnings: 3, blocked: true });
    const result = await service.execute(
      'chat_warn',
      { accountId: 'account-1', chatId: 42, reason: 'insults' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ warnings: 3, blocked: true });
    expect(access.bumpWarning).toHaveBeenCalledWith({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: 42,
      threadId: 0,
      reason: 'insults',
      blockedBy: 'soul',
    });
  });

  it('refuses chat_block without a reason', async () => {
    const { service, access } = harness({ caps: { admin: true } });
    for (const reason of [undefined, '', 'ab']) {
      const result = await service.execute(
        'chat_block',
        { accountId: 'account-1', chatId: 42, reason },
        ctx,
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe('TOOL_ERROR');
      expect(result.error).toMatch(/reason/);
    }
    expect(access.block).not.toHaveBeenCalled();
  });

  it('blocks the chat as the soul and can unblock it', async () => {
    const { service, access } = harness({ caps: { admin: true } });
    const blocked = await service.execute(
      'chat_block',
      { accountId: 'account-1', chatId: 42, threadId: 5, reason: 'threats' },
      ctx,
    );
    expect(blocked.ok).toBe(true);
    expect(access.block).toHaveBeenCalledWith({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: 42,
      threadId: 5,
      reason: 'threats',
      blockedBy: 'soul',
    });

    const unblocked = await service.execute(
      'chat_unblock',
      { accountId: 'account-1', chatId: 42 },
      ctx,
    );
    expect(unblocked.ok).toBe(true);
    expect(access.unblock).toHaveBeenCalledWith('user-1', 'account-1', 42, 0);
  });

  it('denies destructive tools when the policy forbids the capability', async () => {
    const denied = harness();
    const blocked = await denied.service.execute(
      'chat_block',
      { accountId: 'account-1', chatId: 42, reason: 'threats' },
      ctx,
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('CAPABILITY_DISABLED');
    expect(denied.access.block).not.toHaveBeenCalled();

    const muted = await denied.service.execute(
      'ai_access_set',
      { accountId: 'account-1', chatId: 42, enabled: false },
      ctx,
    );
    expect(muted.ok).toBe(false);
    expect(muted.code).toBe('CAPABILITY_DISABLED');
    expect(denied.access.setAccess).not.toHaveBeenCalled();

    const paused = await harness({
      caps: { automations: false },
    }).service.execute(
      'automation_pause_chat',
      { accountId: 'account-1', chatId: 42, reason: 'rude' },
      ctx,
    );
    expect(paused.ok).toBe(false);
    expect(paused.code).toBe('CAPABILITY_DISABLED');
  });

  it('still allows the soul to mute a chat once admin is enabled', async () => {
    const { service, access } = harness({ caps: { admin: true } });
    const result = await service.execute(
      'ai_access_set',
      { accountId: 'account-1', chatId: 42, enabled: false },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(access.setAccess).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 42, enabled: false }),
    );
  });

  it('denies a tool when the account override disables a globally allowed capability', async () => {
    const denied = harness({ accountCaps: { 'account-1': { send: false } } });
    const result = await denied.service.execute(
      'messages_send',
      { accountId: 'account-1', chatId: 42, text: 'hello' },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('CAPABILITY_DISABLED');
    expect(denied.messaging.sendMessage).not.toHaveBeenCalled();

    // The same call is allowed for an account without an override.
    const allowed = harness();
    const ok = await allowed.service.execute(
      'messages_send',
      { accountId: 'account-1', chatId: 42, text: 'hello' },
      ctx,
    );
    expect(ok.ok).toBe(true);
  });

  it('grants a tool when the account override enables a globally disabled capability', async () => {
    const granted = harness({
      caps: { delete: false },
      accountCaps: { 'account-1': { delete: true } },
    });
    const result = await granted.service.execute(
      'messages_delete',
      { accountId: 'account-1', chatId: 42, messageId: 7 },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);

    // Without the account the global policy still denies it.
    const global = harness({ caps: { delete: false } });
    const denied = await global.service.execute(
      'messages_delete',
      { chatId: 42, messageId: 7 },
      { ...ctx, accountId: null },
    );
    expect(denied.ok).toBe(false);
    expect(denied.code).toBe('CAPABILITY_DISABLED');
  });

  it('filters tool schemas by the effective capabilities of the account', async () => {
    const { service, policy } = harness({
      accountCaps: { 'account-1': { send: false, automations: false } },
    });
    const names = (await service.schemas(ctx, null)).map(
      (schema) => schema.function.name,
    );
    expect(names).not.toContain('messages_send');
    expect(names).not.toContain('automation_pause_chat');
    expect(names).toContain('accounts_list');
    expect(policy.capabilities).toHaveBeenCalledWith('account-1');
  });

  it('keeps the global behaviour when no account is in context', async () => {
    const { service, policy } = harness({ caps: { send: false } });
    const result = await service.execute(
      'messages_send',
      { chatId: 42, text: 'hello' },
      { ...ctx, accountId: null },
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe('CAPABILITY_DISABLED');
    expect(policy.assert).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({ accountId: null }),
    );

    const schemas = await service.schemas({ ...ctx, accountId: null }, null);
    expect(schemas.map((schema) => schema.function.name)).not.toContain(
      'messages_send',
    );
    expect(policy.capabilities).toHaveBeenCalledWith(null);
  });
});
