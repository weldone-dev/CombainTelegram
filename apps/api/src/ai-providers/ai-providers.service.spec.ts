import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProviderModel, AiSettingModel } from '@repo/database';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { AiProvidersService } from './ai-providers.service.js';
import { DEFAULT_CAPABILITIES } from '../ai/ai.types.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const SECRET_PREFIX = 'enc:v1:';

function providerRow(
  overrides: Partial<AiProviderModel> = {},
): AiProviderModel {
  return {
    id: 'p1',
    name: 'Provider',
    kind: 'openai-compatible',
    baseUrl: 'https://ai.test/v1',
    apiKey: null,
    models: '[]',
    defaultModel: null,
    reasoningEffort: 'low',
    isDefault: false,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function settingRow(
  overrides: Partial<AiSettingModel> = {},
): AiSettingModel {
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

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where?: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function sorted(rows: AiProviderModel[]): AiProviderModel[] {
  return [...rows].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

function harness(
  options: {
    providers?: Partial<AiProviderModel>[];
    setting?: Partial<AiSettingModel> | null;
  } = {},
) {
  let providers: AiProviderModel[] = (options.providers ?? []).map((input, index) =>
    providerRow({
      id: input.id ?? `p${index + 1}`,
      name: input.name ?? `Provider ${index + 1}`,
      createdAt: input.createdAt ?? new Date(NOW.getTime() + index * 1000),
      ...input,
    }),
  );
  let setting: AiSettingModel | null =
    options.setting === null ? null : settingRow(options.setting);

  const prisma: Record<string, any> = {
    aiProvider: {
      count: vi.fn(async () => providers.length),
      findMany: vi.fn(async () => sorted(providers)),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        return providers.find((row) => row.id === where.id) ?? null;
      }),
      findFirst: vi.fn(
        async ({
          where,
          orderBy,
        }: {
          where?: Where;
          orderBy?: { createdAt?: 'asc' | 'desc' };
        } = {}) => {
          const rows = sorted(providers.filter((row) => matches(row, where)));
          if (orderBy?.createdAt === 'desc') rows.reverse();
          return rows[0] ?? null;
        },
      ),
      create: vi.fn(async ({ data }: { data: Partial<AiProviderModel> }) => {
        const row = providerRow(data);
        providers.push(row);
        return row;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<AiProviderModel>;
        }) => {
          const row = providers.find((item) => item.id === where.id);
          if (!row) throw new Error('provider not found');
          Object.assign(row, data, { updatedAt: NOW });
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where?: Where; data: Partial<AiProviderModel> }) => {
          const rows = providers.filter((row) => matches(row, where));
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = providers.findIndex((row) => row.id === where.id);
        if (index < 0) throw new Error('provider not found');
        const [row] = providers.splice(index, 1);
        return row;
      }),
    },
    aiSetting: {
      findUnique: vi.fn(async () => setting),
      update: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    ),
  };

  const crypto = new SessionCryptoService(
    new TelegramConfigService(
      new ConfigService({
        TELEGRAM_SESSION_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      }),
    ),
  );
  const service = new AiProvidersService(prisma as never, crypto);

  return {
    service,
    prisma,
    crypto,
    providers: () => providers,
    setting: (next: AiSettingModel | null) => {
      setting = next;
    },
  };
}

function decryptStoredKey(
  crypto: SessionCryptoService,
  stored: string,
  id: string,
): string {
  expect(stored.startsWith(SECRET_PREFIX)).toBe(true);
  const envelope = new Uint8Array(
    Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64'),
  );
  return crypto
    .decrypt(crypto.deserialize(envelope), `ai-provider:${id}`)
    .toString('utf8');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('AiProvidersService', () => {
  it('creates a provider, encrypts the key and makes the first one default', async () => {
    const h = harness();

    const view = await h.service.create({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1/',
      apiKey: 'sk-live-secret',
      models: ['gpt-4o', 'gpt-4o-mini'],
      defaultModel: 'gpt-4o',
    });

    expect(view).toMatchObject({
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o', 'gpt-4o-mini'],
      defaultModel: 'gpt-4o',
      reasoningEffort: 'low',
      isDefault: true,
      enabled: true,
      hasKey: true,
    });
    expect(JSON.stringify(view)).not.toContain('sk-live-secret');

    const stored = h.providers()[0];
    expect(stored?.apiKey).toContain(SECRET_PREFIX);
    expect(stored?.apiKey).not.toContain('sk-live-secret');
    expect(
      decryptStoredKey(h.crypto, stored?.apiKey as string, view.id),
    ).toBe('sk-live-secret');
  });

  it('clears the default flag on every other row when creating a default', async () => {
    const h = harness({
      providers: [
        { id: 'a', name: 'A', isDefault: true },
        { id: 'b', name: 'B' },
      ],
    });

    const view = await h.service.create({
      name: 'C',
      baseUrl: 'https://c.test/v1',
      isDefault: true,
    });

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(
      h.providers().filter((row) => row.isDefault).map((row) => row.id),
    ).toEqual([view.id]);
  });

  it('updates fields and clears the key with null', async () => {
    const h = harness();
    const created = await h.service.create({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-old',
    });

    const cleared = await h.service.update(created.id, {
      name: 'Renamed',
      apiKey: null,
      models: ['gpt-4o'],
    });
    expect(cleared.name).toBe('Renamed');
    expect(cleared.models).toEqual(['gpt-4o']);
    expect(cleared.hasKey).toBe(false);
    expect(h.providers()[0]?.apiKey).toBeNull();

    const replaced = await h.service.update(created.id, { apiKey: 'sk-new' });
    expect(replaced.hasKey).toBe(true);
    expect(
      decryptStoredKey(h.crypto, h.providers()[0]?.apiKey as string, created.id),
    ).toBe('sk-new');
  });

  it('never returns the key in list views', async () => {
    const h = harness();
    await h.service.create({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-hidden',
    });

    const views = await h.service.list();
    expect(views).toHaveLength(1);
    expect(JSON.stringify(views)).not.toContain('sk-hidden');
  });

  it('promotes the oldest enabled provider when the default is deleted', async () => {
    const h = harness({
      providers: [
        {
          id: 'a',
          name: 'A',
          isDefault: true,
          createdAt: new Date('2026-11-20T10:00:00.000Z'),
        },
        {
          id: 'b',
          name: 'B',
          createdAt: new Date('2026-11-21T10:00:00.000Z'),
        },
        {
          id: 'c',
          name: 'C',
          createdAt: new Date('2026-11-22T10:00:00.000Z'),
        },
        {
          id: 'd',
          name: 'D',
          enabled: false,
          createdAt: new Date('2026-11-19T10:00:00.000Z'),
        },
      ],
    });

    const result = await h.service.remove('a');

    expect(result).toEqual({ removed: true, promotedId: 'b' });
    expect(h.providers().find((row) => row.id === 'b')?.isDefault).toBe(true);
    expect(h.providers().find((row) => row.id === 'c')?.isDefault).toBe(false);
  });

  it('returns 404 for an unknown provider', async () => {
    const h = harness();
    await expect(h.service.update('missing', { name: 'x' })).rejects.toMatchObject(
      { status: 404 },
    );
  });
});

describe('AiProvidersService.resolver', () => {
  it('prefers the default enabled provider', async () => {
    vi.stubEnv('AI_BASE_URL', 'https://env.test/v1');
    vi.stubEnv('AI_MODEL', 'env-model');
    vi.stubEnv('AI_API_KEY', 'env-key');
    const h = harness({
      setting: { baseUrl: 'https://settings.test/v1', model: 'settings-model' },
    });
    await h.service.create({
      name: 'Provider',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'provider-key',
      models: ['provider-model'],
      reasoningEffort: 'high',
    });

    const resolved = await h.service.resolve();

    expect(resolved).toEqual({
      baseUrl: 'https://provider.test/v1',
      model: 'provider-model',
      apiKey: 'provider-key',
      reasoningEffort: 'high',
      extraHeaders: {},
      source: 'provider',
    });
  });

  it('falls back to AiSetting when no provider is enabled', async () => {
    vi.stubEnv('AI_BASE_URL', 'https://env.test/v1');
    vi.stubEnv('AI_MODEL', 'env-model');
    const h = harness({
      providers: [
        { id: 'a', baseUrl: 'https://provider.test/v1', isDefault: true, enabled: false },
      ],
      setting: { baseUrl: 'https://settings.test/v1', model: 'settings-model' },
    });

    const resolved = await h.service.resolve();

    expect(resolved).toMatchObject({
      baseUrl: 'https://settings.test/v1',
      model: 'settings-model',
      source: 'settings',
    });
  });

  it('falls back to env when neither providers nor settings are configured', async () => {
    vi.stubEnv('AI_BASE_URL', 'https://env.test/v1');
    vi.stubEnv('AI_MODEL', 'env-model');
    vi.stubEnv('AI_API_KEY', 'env-key');
    vi.stubEnv('AI_EXTRA_HEADERS', '{"x-title":"tg"}');
    const h = harness({ setting: null });

    const resolved = await h.service.resolve();

    expect(resolved).toEqual({
      baseUrl: 'https://env.test/v1',
      model: 'env-model',
      apiKey: 'env-key',
      reasoningEffort: 'low',
      extraHeaders: { 'x-title': 'tg' },
      source: 'env',
    });
  });

  it('reuses the settings key when the provider stores none', async () => {
    const h = harness();
    const serialized = h.crypto.serialize(
      h.crypto.encrypt('sk-settings', 'ai:api-key'),
    );
    // Rebuild the legacy AiSetting row with the real envelope columns.
    const envelope = JSON.parse(Buffer.from(serialized).toString('utf8')) as {
      cipher: string;
      nonce: string;
      tag: string;
      dekWrapped: string;
      dekNonce: string;
      dekTag: string;
    };
    h.setting(
      settingRow({
        apiKeyEncrypted: new Uint8Array(Buffer.from(envelope.cipher, 'base64')),
        apiKeyNonce: new Uint8Array(Buffer.from(envelope.nonce, 'base64')),
        apiKeyTag: new Uint8Array(Buffer.from(envelope.tag, 'base64')),
        apiKeyDekWrapped: new Uint8Array(
          Buffer.from(envelope.dekWrapped, 'base64'),
        ),
        apiKeyDekNonce: new Uint8Array(Buffer.from(envelope.dekNonce, 'base64')),
        apiKeyDekTag: new Uint8Array(Buffer.from(envelope.dekTag, 'base64')),
      }),
    );
    await h.service.create({
      name: 'Provider',
      baseUrl: 'https://provider.test/v1',
      models: ['provider-model'],
    });

    const resolved = await h.service.resolve();

    expect(resolved.source).toBe('provider');
    expect(resolved.apiKey).toBe('sk-settings');
  });
});

describe('AiProvidersService.importSettings', () => {
  it('migrates the legacy settings once and is idempotent', async () => {
    const h = harness();
    const envelope = JSON.parse(
      Buffer.from(
        h.crypto.serialize(h.crypto.encrypt('sk-setting', 'ai:api-key')),
      ).toString('utf8'),
    ) as Record<string, string>;
    h.setting(
      settingRow({
        provider: 'openai-compatible',
        baseUrl: 'https://legacy.test/v1',
        model: 'legacy-model',
        apiKeyEncrypted: new Uint8Array(
          Buffer.from(envelope.cipher as string, 'base64'),
        ),
        apiKeyNonce: new Uint8Array(
          Buffer.from(envelope.nonce as string, 'base64'),
        ),
        apiKeyTag: new Uint8Array(
          Buffer.from(envelope.tag as string, 'base64'),
        ),
        apiKeyDekWrapped: new Uint8Array(
          Buffer.from(envelope.dekWrapped as string, 'base64'),
        ),
        apiKeyDekNonce: new Uint8Array(
          Buffer.from(envelope.dekNonce as string, 'base64'),
        ),
        apiKeyDekTag: new Uint8Array(
          Buffer.from(envelope.dekTag as string, 'base64'),
        ),
      }),
    );

    expect(await h.service.importSettings()).toEqual({ created: true });
    expect(h.providers()).toHaveLength(1);
    expect(h.providers()[0]).toMatchObject({
      name: 'legacy.test',
      baseUrl: 'https://legacy.test/v1',
      defaultModel: 'legacy-model',
      models: '["legacy-model"]',
      isDefault: true,
      enabled: true,
    });
    expect(
      decryptStoredKey(
        h.crypto,
        h.providers()[0]?.apiKey as string,
        h.providers()[0]?.id as string,
      ),
    ).toBe('sk-setting');

    expect(await h.service.importSettings()).toEqual({ created: false });
    expect(h.providers()).toHaveLength(1);
  });

  it('does nothing when the legacy settings are empty', async () => {
    const h = harness();
    expect(await h.service.importSettings()).toEqual({ created: false });
    expect(h.providers()).toHaveLength(0);
  });

  it('imports automatically on module init', async () => {
    const h = harness({
      setting: { baseUrl: 'https://legacy.test/v1', model: 'legacy-model' },
    });

    await h.service.onModuleInit();

    expect(h.providers()).toHaveLength(1);
    expect(h.providers()[0]?.isDefault).toBe(true);
  });
});

describe('AiProvidersService.test', () => {
  it('reports a transport failure without leaking the key', async () => {
    const h = harness();
    const created = await h.service.create({
      name: 'Provider',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'sk-super-secret',
      models: ['m1'],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      }),
    );

    const result = await h.service.test(created.id);

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toContain('ECONNREFUSED');
    expect(JSON.stringify(result)).not.toContain('sk-super-secret');
  });

  it('reports an HTTP error body and a success', async () => {
    const h = harness();
    const created = await h.service.create({
      name: 'Provider',
      baseUrl: 'https://provider.test/v1',
      models: ['m1'],
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"Invalid API key"}}',
      })),
    );
    expect(await h.service.test(created.id)).toMatchObject({
      ok: false,
      status: 401,
      error: 'Invalid API key',
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () => '{"choices":[]}',
      })),
    );
    const ok = await h.service.test(created.id);
    expect(ok.ok).toBe(true);
    expect(ok.status).toBe(200);
    expect(ok.error).toBeUndefined();
  });
});
