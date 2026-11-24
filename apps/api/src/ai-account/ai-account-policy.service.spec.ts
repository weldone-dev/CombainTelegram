import { describe, expect, it, vi } from 'vitest';
import type { AiAccountSettingModel } from '@repo/database';
import type { AiConfigService } from '../ai/ai-config.service.js';
import type { AiPolicyService } from '../ai/ai-policy.service.js';
import type { AiCapabilities, AiPolicyView, ToolContext } from '../ai/ai.types.js';
import { DEFAULT_CAPABILITIES } from '../ai/ai.types.js';
import { AiAccountPolicyService } from './ai-account-policy.service.js';
import { AiAccountSettingsService } from './ai-account-settings.service.js';

const USER_ID = 'local';
const ACCOUNT_ID = 'account-1';
const OTHER_ACCOUNT = 'account-2';

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    chatId: 42,
    source: 'mcp',
    ...overrides,
  };
}

interface HarnessOptions {
  global?: Partial<AiCapabilities>;
  stored?: Record<string, unknown>;
  allowAccountIds?: string[];
  allowChatIds?: number[];
  blockChatIds?: number[];
  dryRun?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const rows = new Map<string, AiAccountSettingModel>();
  if (options.stored) {
    rows.set(ACCOUNT_ID, {
      id: 'setting-1',
      accountId: ACCOUNT_ID,
      permissions: JSON.stringify(options.stored),
      createdAt: new Date('2026-11-24T10:00:00.000Z'),
      updatedAt: new Date('2026-11-24T10:00:00.000Z'),
    });
  }
  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === ACCOUNT_ID && where.userId === USER_ID
            ? { id: ACCOUNT_ID }
            : null,
      ),
    },
    aiAccountSetting: {
      findUnique: vi.fn(
        async ({ where }: { where: { accountId: string } }) =>
          rows.get(where.accountId) ?? null,
      ),
    },
  };

  const policy: AiPolicyView = {
    capabilities: { ...DEFAULT_CAPABILITIES, ...options.global },
    allowAccountIds: options.allowAccountIds ?? [],
    allowChatIds: options.allowChatIds ?? [],
    blockChatIds: options.blockChatIds ?? [],
    dryRun: options.dryRun ?? false,
    ownerTgUserIds: [],
  };
  const config = {
    policy: vi.fn(async () => policy),
  } as unknown as AiConfigService;
  // Stand-in for the global policy: allows everything, dryRun marker.
  const globalPolicy = {
    evaluate: vi.fn(async () => ({ allowed: true, dryRun: true })),
  } as unknown as AiPolicyService;

  const settings = new AiAccountSettingsService(prisma as never, config);
  const service = new AiAccountPolicyService(
    settings,
    config,
    globalPolicy,
  );
  return { service, settings, config, globalPolicy, prisma };
}

describe('AiAccountPolicyService', () => {
  it('delegates to the global policy when nothing is overridden', async () => {
    const { service, globalPolicy } = harness();

    const decision = await service.evaluate('send', ctx());

    expect(decision).toEqual({ allowed: true, dryRun: true });
    expect(globalPolicy.evaluate).toHaveBeenCalledWith('send', ctx());
  });

  it('denies a capability the account turned off', async () => {
    const { service, globalPolicy } = harness({
      global: { delete: true },
      stored: { delete: false },
    });

    const decision = await service.evaluate('delete', ctx());

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('CAPABILITY_DISABLED');
    expect(decision.reason).toContain(ACCOUNT_ID);
    expect(globalPolicy.evaluate).not.toHaveBeenCalled();
  });

  it('grants a globally disabled capability when the account enables it', async () => {
    const { service, globalPolicy } = harness({
      global: { delete: false },
      stored: { delete: true },
      dryRun: true,
    });

    const decision = await service.evaluate('delete', ctx());

    expect(decision.allowed).toBe(true);
    // Write still respects the global dry-run switch.
    expect(decision.dryRun).toBe(true);
    expect(globalPolicy.evaluate).not.toHaveBeenCalled();
  });

  it('still applies the account allowlist to a granted capability', async () => {
    const { service } = harness({
      global: { send: false },
      stored: { send: true },
      allowAccountIds: [OTHER_ACCOUNT],
    });

    const decision = await service.evaluate('send', ctx());

    expect(decision.code).toBe('ACCOUNT_DENIED');
  });

  it('still applies chat blocks to a granted capability', async () => {
    const { service } = harness({
      global: { send: false },
      stored: { send: true },
      blockChatIds: [42],
    });

    const decision = await service.evaluate('send', ctx());

    expect(decision.code).toBe('CHAT_DENIED');
  });

  it('does not apply chat allowlists to read-only capabilities', async () => {
    const { service } = harness({
      global: { admin: false },
      stored: { admin: true },
      allowChatIds: [7],
    });

    const decision = await service.evaluate('admin', ctx());

    expect(decision).toEqual({ allowed: true, dryRun: false });
  });

  it('reports effective capabilities of an account', async () => {
    const { service } = harness({
      global: { delete: false },
      stored: { delete: true, mcp: false },
    });

    const capabilities = await service.capabilities(ACCOUNT_ID);
    expect(capabilities.delete).toBe(true);
    expect(capabilities.mcp).toBe(false);
    expect(capabilities.read).toBe(DEFAULT_CAPABILITIES.read);

    const inherited = await service.capabilities(null);
    expect(inherited.delete).toBe(false);
  });

  it('assert throws a typed PolicyError for a denied capability', async () => {
    const { service } = harness({
      global: { send: true },
      stored: { send: false },
    });

    await expect(service.assert('send', ctx())).rejects.toMatchObject({
      code: 'CAPABILITY_DISABLED',
    });
  });
});
