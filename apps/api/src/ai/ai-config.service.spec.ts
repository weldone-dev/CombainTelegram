import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiSettingModel } from '@repo/database';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { AiConfigService, parseCapabilities } from './ai-config.service.js';
import { DEFAULT_CAPABILITIES } from './ai.types.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');

function row(overrides: Partial<AiSettingModel> = {}): AiSettingModel {
  return {
    id: 'default',
    provider: 'openai-compatible',
    baseUrl: '',
    model: '',
    fastModel: '',
    apiKeyEncrypted: null,
    apiKeyNonce: null,
    apiKeyTag: null,
    apiKeyDekWrapped: null,
    apiKeyDekNonce: null,
    apiKeyDekTag: null,
    temperature: 0.7,
    maxSteps: 6,
    dryRun: true,
    capabilities: JSON.stringify(DEFAULT_CAPABILITIES),
    allowAccountIds: '[]',
    allowChatIds: '[]',
    blockChatIds: '[]',
    ownerTgUserIds: '[]',
    mcpTokenEncrypted: null,
    mcpTokenNonce: null,
    mcpTokenTag: null,
    mcpTokenDekWrapped: null,
    mcpTokenDekNonce: null,
    mcpTokenDekTag: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface UpdateCall {
  where: { id: string };
  data: Record<string, unknown>;
}

function harness(options: { existing?: AiSettingModel | null } = {}) {
  let stored: AiSettingModel | null = options.existing ?? null;

  const prisma = {
    aiSetting: {
      findUnique: vi.fn(async () => stored),
      create: vi.fn(async ({ data }: { data: Partial<AiSettingModel> }) => {
        stored = row(data);
        return stored;
      }),
      update: vi.fn(async ({ data }: UpdateCall) => {
        stored = { ...(stored ?? row()), ...data } as AiSettingModel;
        return stored;
      }),
    },
    telegramAccount: {
      findMany: vi.fn(async () => [
        { tgUserId: BigInt('1001') },
        { tgUserId: BigInt('1002') },
      ]),
    },
  };

  const telegramConfig = new TelegramConfigService(
    new ConfigService({
      TELEGRAM_SESSION_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    }),
  );
  const crypto = new SessionCryptoService(telegramConfig);
  const service = new AiConfigService(prisma as never, crypto);

  return { service, prisma, crypto, current: () => stored };
}

function lastSettingsUpdate(
  prisma: ReturnType<typeof harness>['prisma'],
): UpdateCall {
  const calls = prisma.aiSetting.update.mock.calls as Array<[UpdateCall]>;
  // `update()` ends with `view()`, which may also persist a generated MCP
  // token; skip those writes and return the settings write.
  const call = [...calls]
    .reverse()
    .find(([entry]) =>
      Object.keys(entry.data).some((key) => !key.startsWith('mcpToken')),
    );
  if (!call) throw new Error('no settings update was recorded');
  return call[0];
}

function decryptRow(
  crypto: SessionCryptoService,
  stored: AiSettingModel,
  prefix: 'apiKey' | 'mcpToken',
  aad: string,
): string {
  return crypto
    .decrypt(
      {
        cipher: new Uint8Array(stored[`${prefix}Encrypted`] as Uint8Array),
        nonce: new Uint8Array(stored[`${prefix}Nonce`] as Uint8Array),
        tag: new Uint8Array(stored[`${prefix}Tag`] as Uint8Array),
        dekWrapped: new Uint8Array(stored[`${prefix}DekWrapped`] as Uint8Array),
        dekNonce: new Uint8Array(stored[`${prefix}DekNonce`] as Uint8Array),
        dekTag: new Uint8Array(stored[`${prefix}DekTag`] as Uint8Array),
        keyVersion: 1,
      },
      aad,
    )
    .toString('utf8');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AiConfigService settings', () => {
  it('creates the singleton row with the default capabilities', async () => {
    const h = harness();

    const created = await h.service.row();

    expect(created.id).toBe('default');
    expect(h.prisma.aiSetting.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(created.capabilities)).toEqual(DEFAULT_CAPABILITIES);
  });

  it('prefers database values over environment variables', async () => {
    vi.stubEnv('AI_BASE_URL', 'https://env.test/v1');
    vi.stubEnv('AI_MODEL', 'env-model');
    vi.stubEnv('AI_FAST_MODEL', 'env-fast');
    vi.stubEnv('AI_API_KEY', 'env-key-0000');
    const h = harness();

    const fromEnv = await h.service.resolved();
    expect(fromEnv).toMatchObject({
      baseUrl: 'https://env.test/v1',
      model: 'env-model',
      fastModel: 'env-fast',
      apiKey: 'env-key-0000',
      source: 'env',
    });

    await h.service.update({
      baseUrl: 'https://db.test/v1',
      model: 'db-model',
    });
    const mixed = await h.service.resolved();
    expect(mixed).toMatchObject({
      baseUrl: 'https://db.test/v1',
      model: 'db-model',
      fastModel: 'env-fast',
      apiKey: 'env-key-0000',
      source: 'database',
    });

    await h.service.update({ fastModel: 'db-fast' });
    expect((await h.service.resolved()).fastModel).toBe('db-fast');
  });

  it('uses the encrypted database key over the environment key', async () => {
    vi.stubEnv('AI_API_KEY', 'env-key-0000');
    const h = harness();

    await h.service.update({ apiKey: 'sk-db-secret-1234' });

    const resolved = await h.service.resolved();
    expect(resolved.apiKey).toBe('sk-db-secret-1234');

    const view = await h.service.view();
    expect(view.hasApiKey).toBe(true);
    expect(view.apiKeySource).toBe('db');
    expect(view.apiKeyHint).toBe('…1234');
    expect(JSON.stringify(view)).not.toContain('sk-db-secret-1234');
  });

  it('stores the API key encrypted and clears it on an empty value', async () => {
    const h = harness();

    await h.service.update({ apiKey: 'sk-live-secret' });

    const data = lastSettingsUpdate(h.prisma).data;
    expect(data.apiKeyEncrypted).toBeInstanceOf(Uint8Array);
    expect(JSON.stringify(data)).not.toContain('sk-live-secret');

    const stored = h.current();
    expect(stored).not.toBeNull();
    expect(
      decryptRow(h.crypto, stored as AiSettingModel, 'apiKey', 'ai:api-key'),
    ).toBe('sk-live-secret');
    expect((await h.service.view()).hasApiKey).toBe(true);

    await h.service.update({ apiKey: '' });
    expect(lastSettingsUpdate(h.prisma).data.apiKeyEncrypted).toBeNull();
    expect(h.current()?.apiKeyNonce).toBeNull();

    const view = await h.service.view();
    expect(view.hasApiKey).toBe(false);
    expect(view.apiKeyHint).toBeNull();
    expect(view.apiKeySource).toBe('none');
  });

  it('requires a base URL, a model and a key', async () => {
    const h = harness();

    await expect(h.service.requireProvider()).rejects.toThrow(
      /LLM is not configured/,
    );

    await h.service.update({ baseUrl: 'https://db.test/v1', model: 'm' });
    await expect(h.service.requireProvider()).rejects.toThrow(
      /API key is missing/,
    );

    await h.service.update({ apiKey: 'sk-test' });
    const provider = await h.service.requireProvider();
    expect(provider.apiKey).toBe('sk-test');
    expect(provider.baseUrl).toBe('https://db.test/v1');
  });

  it('clamps temperature and maxSteps to their ranges', async () => {
    const h = harness();

    await h.service.update({ temperature: 9, maxSteps: 99 });
    expect(lastSettingsUpdate(h.prisma).data).toMatchObject({
      temperature: 2,
      maxSteps: 12,
    });

    await h.service.update({ temperature: -3, maxSteps: 0 });
    expect(lastSettingsUpdate(h.prisma).data).toMatchObject({
      temperature: 0,
      maxSteps: 1,
    });

    await h.service.update({ temperature: 'nope', maxSteps: 'nope' });
    expect(lastSettingsUpdate(h.prisma).data).toMatchObject({
      temperature: 0,
      maxSteps: 1,
    });
  });
});

describe('AiConfigService MCP token', () => {
  it('generates a 64-char hex token once and keeps it stable', async () => {
    const h = harness();

    const first = await h.service.mcpToken();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await h.service.mcpToken()).toBe(first);
    expect(h.prisma.aiSetting.update).toHaveBeenCalledTimes(1);

    const stored = h.current() as AiSettingModel;
    expect(
      decryptRow(h.crypto, stored, 'mcpToken', 'ai:mcp-token'),
    ).toBe(first);
  });

  it('rotates the token and serves the rotated value afterwards', async () => {
    const h = harness();

    const first = await h.service.mcpToken();
    const rotated = await h.service.rotateMcpToken();

    expect(rotated).toMatch(/^[0-9a-f]{64}$/);
    expect(rotated).not.toBe(first);
    expect(await h.service.mcpToken()).toBe(rotated);
    expect((await h.service.view()).mcp.token).toBe(rotated);
  });

  it('falls back to MCP_TOKEN from the environment before generating', async () => {
    vi.stubEnv('MCP_TOKEN', 'env-mcp-token');
    const h = harness();

    expect(await h.service.mcpToken()).toBe('env-mcp-token');
    expect(h.prisma.aiSetting.update).not.toHaveBeenCalled();

    // An explicitly stored token always wins over the environment.
    const rotated = await h.service.rotateMcpToken();
    expect(await h.service.mcpToken()).toBe(rotated);
  });
});

describe('AiConfigService policy', () => {
  it('parses capabilities and lists and ignores unknown JSON', async () => {
    const h = harness({
      existing: row({
        capabilities: '{"delete":true,"admin":"yes","bogus":true}',
        allowAccountIds: '["acc-1",5," "]',
        allowChatIds: '["42","x",7]',
        blockChatIds: '{"not":"a list"}',
        ownerTgUserIds: '[123,"-100"]',
      }),
    });

    const policy = await h.service.policy();

    expect(policy.capabilities.read).toBe(true);
    expect(policy.capabilities.delete).toBe(true);
    expect(policy.capabilities.admin).toBe(false);
    expect(policy.capabilities).not.toHaveProperty('bogus');
    expect(policy.allowAccountIds).toEqual(['acc-1', '5']);
    expect(policy.allowChatIds).toEqual([42, 7]);
    expect(policy.blockChatIds).toEqual([]);
    expect(policy.ownerTgUserIds).toEqual(['123', '-100']);
  });

  it('clamps unknown capability payloads to the defaults', () => {
    expect(parseCapabilities('{"read":false}')).toEqual({
      ...DEFAULT_CAPABILITIES,
      read: false,
    });
    expect(parseCapabilities('not json')).toEqual(DEFAULT_CAPABILITIES);
    expect(parseCapabilities(null)).toEqual(DEFAULT_CAPABILITIES);
    expect(parseCapabilities({ send: false, nope: true })).toEqual({
      ...DEFAULT_CAPABILITIES,
      send: false,
    });
  });

  it('stores policy updates as normalized JSON', async () => {
    const h = harness();

    const policy = await h.service.updatePolicy({
      capabilities: { read: false, delete: 'true', nonsense: true },
      allowChatIds: ['42'],
      dryRun: false,
    });

    expect(policy.capabilities.read).toBe(false);
    expect(policy.capabilities.delete).toBe(false);
    expect(policy.capabilities).not.toHaveProperty('nonsense');
    expect(policy.allowChatIds).toEqual([42]);
    expect(policy.dryRun).toBe(false);

    const stored = JSON.parse(
      (h.current() as AiSettingModel).capabilities,
    ) as Record<string, unknown>;
    expect(stored.read).toBe(false);
    expect(stored).not.toHaveProperty('nonsense');
  });

  it('derives the bot owner ids from the attached accounts when unset', async () => {
    const h = harness();
    expect(await h.service.ownerTgUserIds()).toEqual(['1001', '1002']);

    await h.service.updatePolicy({ ownerTgUserIds: [77] });
    expect(await h.service.ownerTgUserIds()).toEqual(['77']);
    expect(h.prisma.telegramAccount.findMany).toHaveBeenCalledTimes(1);
  });
});
