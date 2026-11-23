import { describe, expect, it, vi } from 'vitest';
import { AiPolicyService } from './ai-policy.service.js';
import { DEFAULT_CAPABILITIES } from './ai.types.js';
import type { AiConfigService } from './ai-config.service.js';
import type { AiCapabilities, AiPolicyView } from './ai.types.js';

function configWith(
  overrides: Partial<AiPolicyView> = {},
): AiConfigService {
  const policy: AiPolicyView = {
    capabilities: { ...DEFAULT_CAPABILITIES },
    allowAccountIds: [],
    allowChatIds: [],
    blockChatIds: [],
    dryRun: true,
    ownerTgUserIds: [],
    ...overrides,
  };
  return {
    policy: vi.fn(async () => policy),
    updatePolicy: vi.fn(async () => policy),
  } as unknown as AiConfigService;
}

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    userId: 'user-1',
    accountId: 'account-1',
    chatId: 42,
    source: 'mcp',
    ...overrides,
  };
}

describe('AiPolicyService', () => {
  it('simulates writes while dryRun is on', async () => {
    const service = new AiPolicyService({} as never, configWith());
    const decision = await service.evaluate('send', ctx() as never);
    expect(decision).toEqual({ allowed: true, dryRun: true });
  });

  it('allows real writes after dryRun is disabled', async () => {
    const service = new AiPolicyService(
      {} as never,
      configWith({ dryRun: false }),
    );
    const decision = await service.evaluate('send', ctx() as never);
    expect(decision.allowed).toBe(true);
    expect(decision.dryRun).toBe(false);
  });

  it('never simulates soul autopilot replies', async () => {
    const service = new AiPolicyService({} as never, configWith());
    const decision = await service.evaluate(
      'send',
      ctx({ source: 'dm' }) as never,
    );
    expect(decision.allowed).toBe(true);
    expect(decision.dryRun).toBe(false);
  });

  it('denies disabled capabilities', async () => {
    const service = new AiPolicyService({} as never, configWith());
    const decision = await service.evaluate('delete', ctx() as never);
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('CAPABILITY_DISABLED');
  });

  it('enforces account and chat allowlists', async () => {
    const capabilities: AiCapabilities = {
      ...DEFAULT_CAPABILITIES,
      send: true,
    };
    const accountDenied = new AiPolicyService(
      {} as never,
      configWith({ allowAccountIds: ['other'] }),
    );
    expect(
      (await accountDenied.evaluate('send', ctx() as never)).code,
    ).toBe('ACCOUNT_DENIED');

    const chatAllowed = new AiPolicyService(
      {} as never,
      configWith({ allowChatIds: [42] }),
    );
    expect(
      (await chatAllowed.evaluate('send', { ...ctx(), capabilities } as never))
        .allowed,
    ).toBe(true);

    const chatDenied = new AiPolicyService(
      {} as never,
      configWith({ allowChatIds: [7] }),
    );
    expect(
      (await chatDenied.evaluate('send', { ...ctx(), capabilities } as never))
        .code,
    ).toBe('CHAT_DENIED');

    const blocked = new AiPolicyService(
      {} as never,
      configWith({ blockChatIds: [42] }),
    );
    expect(
      (await blocked.evaluate('send', { ...ctx(), capabilities } as never)).code,
    ).toBe('CHAT_DENIED');
  });
});
