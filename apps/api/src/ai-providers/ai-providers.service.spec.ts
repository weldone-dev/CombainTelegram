import { ConfigService } from '@nestjs/config';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiProviderModel, AiSettingModel } from '@repo/database';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { AiProvidersService } from './ai-providers.service.js';
import { OPENCODE_GO_BASE_URL } from './ai-providers.presets.js';
import { resetOpencodeTokenCache } from './opencode-token.js';
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
    preset: null,
    baseUrl: 'https://ai.test/v1',
    apiKey: null,
    models: '[]',
    defaultModel: null,
    reasoningEffort: 'low',
    limits: '{}',
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
    agentRun: {
      count: vi.fn(async () => 0),
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

const tempDirs: string[] = [];

/**
 * Minimal stand-in for Orca's OpenCode database: one active `opencode`
 * credential whose OAuth access token is the Go key.
 */
function opencodeDatabase(token: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-providers-'));
  tempDirs.push(dir);
  const file = join(dir, 'opencode.db');
  const db = new DatabaseSync(file);
  try {
    db.exec(
      'create table credential (id text, integration_id text, active integer, time_updated integer, value text)',
    );
    db.prepare(
      'insert into credential (id, integration_id, active, time_updated, value) values (?, ?, ?, ?, ?)',
    ).run(
      'cred_1',
      'opencode',
      1,
      Date.now(),
      JSON.stringify({ type: 'oauth', access: token }),
    );
  } finally {
    db.close();
  }
  return file;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetOpencodeTokenCache();
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  }
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

  it('uses the OpenCode token for a preset provider with no stored key', async () => {
    vi.stubEnv('AI_API_KEY_SOURCE', 'opencode');
    vi.stubEnv('OPENCODE_DB', opencodeDatabase('go-token-from-opencode'));
    vi.stubEnv('AI_EXTRA_HEADERS', '{"x-opencode-session":"ses_test"}');
    const h = harness();
    const created = await h.service.create({ preset: 'opencode-go' });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"choices":[]}',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await h.service.test(created.id);

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(result.error).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('go-token-from-opencode');
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe(`${OPENCODE_GO_BASE_URL}/chat/completions`);
    expect(init.headers.authorization).toBe('Bearer go-token-from-opencode');
    expect(init.headers['x-opencode-session']).toBe('ses_test');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'deepseek-v4.1-flash',
      max_tokens: 1,
    });
  });

  it('falls through to the next key candidate after a 401', async () => {
    const h = harness();
    const created = await h.service.create({
      name: 'Provider',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'sk-stale',
      models: ['m1'],
    });
    vi.stubEnv('AI_API_KEY', 'sk-env');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"Invalid API key"}}',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{"choices":[]}',
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await h.service.test(created.id);

    expect(result).toMatchObject({ ok: true, status: 200 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const auth = fetchMock.mock.calls.map(
      (call) => (call[1] as { headers: Record<string, string> }).headers,
    );
    expect(auth[0]?.authorization).toBe('Bearer sk-stale');
    expect(auth[1]?.authorization).toBe('Bearer sk-env');
    expect(JSON.stringify(result)).not.toContain('sk-stale');
  });

  it('returns the last provider error when every candidate is rejected', async () => {
    const h = harness();
    const created = await h.service.create({
      name: 'Provider',
      baseUrl: 'https://provider.test/v1',
      apiKey: 'sk-stale',
      models: ['m1'],
    });
    vi.stubEnv('AI_API_KEY', 'sk-env');
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      text: async () => '{"error":{"message":"Invalid credential"}}',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await h.service.test(created.id);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      ok: false,
      status: 401,
      error: 'Invalid credential',
    });
    expect(JSON.stringify(result)).not.toContain('sk-stale');
    expect(JSON.stringify(result)).not.toContain('sk-env');
  });
});

describe('AiProvidersService.presets', () => {
  it('offers OpenCode Go and custom without asking for a key', () => {
    const h = harness();

    const presets = h.service.presets();

    expect(presets.map((preset) => preset.id)).toEqual(['opencode-go', 'custom']);
    expect(presets[0]).toMatchObject({
      id: 'opencode-go',
      name: 'OpenCode Go',
      kind: 'openai-compatible',
      baseUrl: OPENCODE_GO_BASE_URL,
      keySource: 'opencode',
      defaultModel: 'deepseek-v4.1-flash',
    });
    expect(presets[1]).toMatchObject({
      id: 'custom',
      keySource: 'stored',
      baseUrl: '',
    });
  });

  it('creates an OpenCode Go provider from the preset and stores no key', async () => {
    const h = harness();

    const view = await h.service.create({
      preset: 'opencode-go',
      // The dashboard may post the field anyway: a preset with
      // `keySource: opencode` must never persist it.
      apiKey: 'sk-should-be-ignored',
    });

    expect(view).toMatchObject({
      name: 'OpenCode Go',
      preset: 'opencode-go',
      keySource: 'opencode',
      baseUrl: OPENCODE_GO_BASE_URL,
      models: ['deepseek-v4.1-flash'],
      defaultModel: 'deepseek-v4.1-flash',
      isDefault: true,
      hasKey: false,
    });
    expect(h.providers()[0]?.apiKey).toBeNull();
    expect(h.providers()[0]?.preset).toBe('opencode-go');
    expect(JSON.stringify(view)).not.toContain('sk-should-be-ignored');
  });

  it('lets every preset default be overridden', async () => {
    const h = harness();

    const view = await h.service.create({
      preset: 'opencode-go',
      name: 'Go (proxy)',
      baseUrl: 'https://proxy.test/v1/',
      defaultModel: 'glm-5.3',
      models: ['glm-5.3'],
    });

    expect(view).toMatchObject({
      name: 'Go (proxy)',
      baseUrl: 'https://proxy.test/v1',
      defaultModel: 'glm-5.3',
      models: ['glm-5.3'],
      preset: 'opencode-go',
      keySource: 'opencode',
    });
  });

  it('keeps custom providers unchanged and rejects unknown presets', async () => {
    const h = harness();

    const view = await h.service.create({
      name: 'Local',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: 'sk-custom',
    });
    expect(view).toMatchObject({
      preset: null,
      keySource: 'stored',
      hasKey: true,
      defaultModel: null,
      models: [],
    });
    expect(h.providers()[0]?.preset).toBeNull();

    const explicitCustom = await h.service.create({
      preset: 'custom',
      name: 'Own',
      baseUrl: 'https://own.test/v1',
    });
    expect(explicitCustom).toMatchObject({ preset: null, keySource: 'stored' });

    await expect(
      h.service.create({ preset: 'nope', name: 'x', baseUrl: 'https://x.test' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.providers()).toHaveLength(2);
  });

  it('exposes the stored limits and key source in the list view', async () => {
    const h = harness({
      providers: [
        {
          id: 'p1',
          preset: 'opencode-go',
          limits: '{"maxPerHour":4,"maxPerDay":0}',
        },
      ],
    });

    const [view] = await h.service.list();

    expect(view).toMatchObject({
      preset: 'opencode-go',
      keySource: 'opencode',
      limits: { maxPerHour: 4, maxPerDay: 0 },
    });
  });
});

function modelsResponse(payload: unknown) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}

describe('AiProvidersService.models', () => {
  it('fetches <baseUrl>/models and keeps ids, labels and types', async () => {
    const h = harness();
    const created = await h.service.create({ preset: 'opencode-go' });
    vi.stubEnv('AI_API_KEY', 'sk-env');
    const fetchMock = vi.fn(async () =>
      modelsResponse({
        object: 'list',
        data: [
          {
            id: 'deepseek-v4.1-flash',
            name: 'DeepSeek V4.1 Flash 1017',
            type: 'chat',
          },
          { id: 'glm-5.3', name: 'GLM-5.3' },
          'plain-id',
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await h.service.models(created.id);

    expect(result).toMatchObject({ source: 'provider' });
    expect(result.error).toBeUndefined();
    expect(result.models).toEqual([
      {
        id: 'deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash 1017',
        type: 'chat',
      },
      { id: 'glm-5.3', label: 'GLM-5.3' },
      { id: 'plain-id' },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe(`${OPENCODE_GO_BASE_URL}/models`);
    expect(init.headers.authorization).toBe('Bearer sk-env');
  });

  it('caches a successful list for five minutes', async () => {
    const h = harness();
    const created = await h.service.create({
      name: 'P',
      baseUrl: 'https://p.test/v1',
    });
    const fetchMock = vi.fn(async () =>
      modelsResponse({ data: [{ id: 'm1', name: 'Model 1' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await h.service.models(created.id);
    const second = await h.service.models(created.id);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.cached).toBeUndefined();
    expect(second).toMatchObject({ source: 'provider', cached: true });
    expect(second.models).toEqual(first.models);

    // Expire the entry: the next call goes back to the provider.
    const cache = (
      h.service as unknown as {
        modelCache: Map<string, { baseUrl: string; at: number }>;
      }
    ).modelCache;
    const entry = cache.get(created.id);
    expect(entry).toBeDefined();
    if (entry) entry.at = Date.now() - 6 * 60_000;

    const third = await h.service.models(created.id);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(third.cached).toBeUndefined();
  });

  it('returns the stored list with the provider error instead of throwing', async () => {
    const h = harness({
      providers: [{ id: 'p1', models: '["stored-a","stored-b"]' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => '{"error":{"message":"upstream is down"}}',
      })),
    );

    const result = await h.service.models('p1');

    expect(result).toMatchObject({
      source: 'stored',
      error: 'upstream is down',
      models: [{ id: 'stored-a' }, { id: 'stored-b' }],
    });
  });

  it('falls back to the stored list on a transport error', async () => {
    const h = harness({
      providers: [{ id: 'p1', models: '["stored-a"]' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      }),
    );

    const result = await h.service.models('p1');

    expect(result.source).toBe('stored');
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.models).toEqual([{ id: 'stored-a' }]);
  });

  it('retries with AI_API_KEY when the stored key is rejected', async () => {
    const h = harness();
    const created = await h.service.create({
      name: 'P',
      baseUrl: 'https://p.test/v1',
      apiKey: 'sk-stale',
    });
    vi.stubEnv('AI_API_KEY', 'sk-env');
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"Invalid credential"}}',
      })
      .mockResolvedValueOnce(modelsResponse({ data: [{ id: 'm1' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await h.service.models(created.id);

    expect(result.source).toBe('provider');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const headers = fetchMock.mock.calls.map(
      (call) => (call[1] as { headers: Record<string, string> }).headers,
    );
    expect(headers[0]?.authorization).toBe('Bearer sk-stale');
    expect(headers[1]?.authorization).toBe('Bearer sk-env');
  });
});

describe('AiProvidersService.limits', () => {
  it('reports stored limits plus local counters for a custom provider', async () => {
    const h = harness({
      providers: [{ id: 'p1', limits: '{"maxPerHour":5,"maxPerDay":0}' }],
    });
    h.prisma.agentRun.count
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(11);

    const result = await h.service.limits('p1');

    expect(result).toMatchObject({
      source: 'manual',
      limits: { maxPerHour: 5, maxPerDay: 0 },
      observed: { lastHour: 3, lastDay: 11 },
    });
    expect(result.error).toBeUndefined();
    expect(typeof result.checkedAt).toBe('string');
    expect(h.prisma.agentRun.count).toHaveBeenCalledTimes(2);
  });

  it('reads the documented OpenCode Go usage meters', async () => {
    const h = harness({
      providers: [
        { id: 'p1', preset: 'opencode-go', baseUrl: OPENCODE_GO_BASE_URL },
      ],
    });
    const fetchMock = vi.fn(async () =>
      modelsResponse({
        usage: {
          rolling: {
            status: 'ok',
            percent: 8,
            resetsAt: '2026-11-24T17:52:21.000Z',
          },
          weekly: {
            status: 'rate-limited',
            percent: 100,
            resetsAt: '2026-11-30T00:00:00.000Z',
          },
          monthly: {
            status: 'ok',
            percent: 48,
            resetsAt: '2026-11-29T10:54:44.000Z',
          },
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await h.service.limits('p1');

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://opencode.ai/inference/go/v1/usage',
    );
    expect(result).toMatchObject({
      source: 'provider',
      limits: {},
      usage: {
        rolling: { status: 'ok', percent: 8, resetsAt: '2026-11-24T17:52:21.000Z' },
        weekly: { status: 'rate-limited', percent: 100 },
        monthly: { status: 'ok', percent: 48 },
      },
    });
  });

  it('falls back to manual limits with an error when usage cannot be read', async () => {
    const h = harness({
      providers: [
        { id: 'p1', preset: 'opencode-go', baseUrl: OPENCODE_GO_BASE_URL },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:1');
      }),
    );

    const result = await h.service.limits('p1');

    expect(result.source).toBe('manual');
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.usage).toBeUndefined();
  });

  it('treats a provider error answer as manual limits', async () => {
    const h = harness({
      providers: [
        { id: 'p1', preset: 'opencode-go', baseUrl: OPENCODE_GO_BASE_URL },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 403,
        text: async () =>
          '{"type":"error","error":{"type":"EntitlementError","message":"OpenCode Go subscription required."}}',
      })),
    );

    const result = await h.service.limits('p1');

    expect(result).toMatchObject({
      source: 'manual',
      error: 'OpenCode Go subscription required.',
    });
  });
});

describe('AiProvidersService.updateLimits', () => {
  it('persists numbers, keeps 0 as unlimited and clears with null', async () => {
    const h = harness({ providers: [{ id: 'p1' }] });

    expect(await h.service.updateLimits('p1', { maxPerHour: 10 })).toEqual({
      limits: { maxPerHour: 10 },
    });
    expect(JSON.parse(h.providers()[0]?.limits as string)).toEqual({
      maxPerHour: 10,
    });

    const afterDay = await h.service.updateLimits('p1', { maxPerDay: 0 });
    expect(afterDay.limits).toEqual({ maxPerHour: 10, maxPerDay: 0 });

    const cleared = await h.service.updateLimits('p1', { maxPerHour: null });
    expect(cleared.limits).toEqual({ maxPerDay: 0 });
    expect(JSON.parse(h.providers()[0]?.limits as string)).toEqual({
      maxPerDay: 0,
    });
  });

  it('rejects negative, fractional and non-numeric limits', async () => {
    const h = harness({ providers: [{ id: 'p1' }] });

    await expect(
      h.service.updateLimits('p1', { maxPerHour: -1 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.service.updateLimits('p1', { maxPerDay: 1.5 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.service.updateLimits('p1', { maxPerHour: 'not-a-number' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.providers()[0]?.limits).toBe('{}');
  });

  it('returns 404 for an unknown provider', async () => {
    const h = harness();

    await expect(
      h.service.updateLimits('missing', { maxPerHour: 1 }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('AiProvidersService.saveModels', () => {
  it('persists the chosen list and never keeps a stale default', async () => {
    const h = harness({
      providers: [{ id: 'p1', models: '["gone"]', defaultModel: 'gone' }],
    });

    const view = await h.service.saveModels('p1', { models: ['a', 'b'] });
    expect(view.models).toEqual(['a', 'b']);
    expect(view.defaultModel).toBe('a');
    expect(JSON.parse(h.providers()[0]?.models as string)).toEqual(['a', 'b']);

    const explicit = await h.service.saveModels('p1', {
      models: ['a', 'c'],
      defaultModel: 'c',
    });
    expect(explicit.defaultModel).toBe('c');
    expect(JSON.parse(h.providers()[0]?.models as string)).toEqual(['a', 'c']);
  });

  it('accepts a comma-separated string like the other write paths', async () => {
    const h = harness({ providers: [{ id: 'p1' }] });

    const view = await h.service.saveModels('p1', {
      models: 'glm-5.3, kimi-k3',
    });

    expect(view.models).toEqual(['glm-5.3', 'kimi-k3']);
    expect(view.defaultModel).toBe('glm-5.3');
  });
});
