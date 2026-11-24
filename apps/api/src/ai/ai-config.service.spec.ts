import { ConfigService } from '@nestjs/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch as httpFetch } from 'undici';
import type { AiSettingModel } from '@repo/database';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { AiConfigService, parseCapabilities } from './ai-config.service.js';
import { AiController } from './ai.controller.js';
import { DEFAULT_CAPABILITIES } from './ai.types.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

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
    reasoningEffort: 'low',
    sttEngine: 'auto',
    sttBaseUrl: '',
    sttModel: null,
    sttApiKey: null,
    sttLanguage: 'auto',
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

/** The controller only delegates settings work to `AiConfigService`. */
function controller(service: AiConfigService): AiController {
  return new AiController(
    service,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
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

const fetchMock = vi.mocked(httpFetch);

function healthResponse(ok = true, status = 200) {
  return {
    ok,
    status,
    body: { cancel: vi.fn(async () => undefined) },
  } as never;
}

/** Removes STT variables that a developer machine may export. */
function clearSttEnv() {
  vi.stubEnv('STT_BASE_URL', '');
  vi.stubEnv('STT_REMOTE', '');
  vi.stubEnv('STT_ENGINE', '');
}

function decryptSttKey(
  crypto: SessionCryptoService,
  stored: string,
): string {
  const envelope = new Uint8Array(
    Buffer.from(stored.slice('enc:v1:'.length), 'base64'),
  );
  return crypto
    .decrypt(crypto.deserialize(envelope), 'ai:stt-key')
    .toString('utf8');
}

interface HttpErrorLike {
  getStatus(): number;
  response: unknown;
}

/** `update()` must reject; returns the HttpException for status/code checks. */
async function updateError(
  service: AiConfigService,
  input: Record<string, unknown>,
): Promise<HttpErrorLike> {
  try {
    await service.update(input);
  } catch (error) {
    return error as HttpErrorLike;
  }
  throw new Error('expected the settings update to fail');
}

describe('AiConfigService speech-to-text settings', () => {
  beforeEach(() => {
    clearSttEnv();
  });

  it('returns the stt fields from GET /ai/settings without the key', async () => {
    const h = harness({
      existing: row({
        sttEngine: 'remote',
        sttBaseUrl: 'https://stt.test/v1',
        sttModel: 'parakeet-tdt-0.6b-v3',
        sttLanguage: 'ru',
        sttApiKey: 'stt-secret-value',
      }),
    });

    const view = await controller(h.service).settings();

    expect(view).toMatchObject({
      sttEngine: 'remote',
      sttBaseUrl: 'https://stt.test/v1',
      sttModel: 'parakeet-tdt-0.6b-v3',
      sttLanguage: 'ru',
      hasSttKey: true,
    });
    expect(JSON.stringify(view)).not.toContain('stt-secret-value');
    // Existing fields stay untouched.
    expect(view).toHaveProperty('baseUrl');
    expect(view).toHaveProperty('mcp.token');
  });

  it('defaults stt fields for a row written before the feature', async () => {
    const legacy = row();
    delete (legacy as Partial<AiSettingModel>).sttEngine;
    delete (legacy as Partial<AiSettingModel>).sttBaseUrl;
    delete (legacy as Partial<AiSettingModel>).sttModel;
    delete (legacy as Partial<AiSettingModel>).sttApiKey;
    delete (legacy as Partial<AiSettingModel>).sttLanguage;
    const h = harness({ existing: legacy });

    const view = await h.service.view();

    expect(view).toMatchObject({
      // Legacy `auto` maps to remote because the built-in LXC is configured.
      sttEngine: 'remote',
      sttBaseUrl: '',
      sttModel: 'parakeet-tdt-0.6b-v3',
      sttLanguage: 'auto',
      hasSttKey: false,
    });
  });

  it('persists engine, URL, model and language through PUT and PATCH', async () => {
    const h = harness();
    const ctrl = controller(h.service);

    const put = await ctrl.updateSettings({
      sttEngine: 'remote',
      sttBaseUrl: 'https://stt.example.com/v1',
      sttModel: 'parakeet-tdt-0.6b-v3',
      sttLanguage: 'ru',
    });
    expect(put).toMatchObject({
      sttEngine: 'remote',
      sttBaseUrl: 'https://stt.example.com/v1',
      sttModel: 'parakeet-tdt-0.6b-v3',
      sttLanguage: 'ru',
      hasSttKey: false,
    });
    expect(lastSettingsUpdate(h.prisma).data).toMatchObject({
      sttEngine: 'remote',
      sttBaseUrl: 'https://stt.example.com/v1',
      sttModel: 'parakeet-tdt-0.6b-v3',
      sttLanguage: 'ru',
    });

    const patched = await ctrl.patchSettings({
      sttEngine: 'local',
      sttLanguage: 'en',
    });
    expect(patched).toMatchObject({
      sttEngine: 'local',
      sttLanguage: 'en',
      // Untouched fields survive a partial update.
      sttBaseUrl: 'https://stt.example.com/v1',
      sttModel: 'parakeet-tdt-0.6b-v3',
    });

    const cleared = await ctrl.patchSettings({
      sttBaseUrl: '',
      sttModel: null,
      sttLanguage: '',
    });
    expect(cleared).toMatchObject({
      sttBaseUrl: '',
      // An empty model means the Parakeet default.
      sttModel: 'parakeet-tdt-0.6b-v3',
      sttLanguage: 'auto',
    });
  });

  it('encrypts the stt key with the ai:stt-key AAD and clears it', async () => {
    const h = harness();
    const ctrl = controller(h.service);

    const view = await ctrl.updateSettings({ sttApiKey: 'stt-live-secret' });
    expect(view.hasSttKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('stt-live-secret');

    const stored = h.current() as AiSettingModel;
    expect(stored.sttApiKey).toMatch(/^enc:v1:/);
    expect(stored.sttApiKey).not.toContain('stt-live-secret');
    expect(decryptSttKey(h.crypto, stored.sttApiKey as string)).toBe(
      'stt-live-secret',
    );

    const cleared = await ctrl.patchSettings({ sttApiKey: null });
    expect(cleared.hasSttKey).toBe(false);
    expect(h.current()?.sttApiKey).toBeNull();

    // An empty string clears as well.
    await ctrl.updateSettings({ sttApiKey: 'another-secret' });
    expect((await ctrl.updateSettings({ sttApiKey: '' })).hasSttKey).toBe(
      false,
    );
    expect(h.current()?.sttApiKey).toBeNull();
  });

  it('treats a legacy plaintext stt key as configured', async () => {
    const h = harness({ existing: row({ sttApiKey: 'plain-legacy-key' }) });

    const view = await h.service.view();

    expect(view.hasSttKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('plain-legacy-key');
  });

  it('rejects an unknown engine and a non-http URL', async () => {
    const h = harness();

    const badEngine = await updateError(h.service, { sttEngine: 'bogus' });
    expect(badEngine.getStatus()).toBe(400);
    expect(badEngine.response).toMatchObject({ code: 'INVALID_STT_ENGINE' });

    // Whisper is an internal fallback, never a selectable engine.
    const whisper = await updateError(h.service, { sttEngine: 'whisper' });
    expect(whisper.getStatus()).toBe(400);
    expect(whisper.response).toMatchObject({ code: 'INVALID_STT_ENGINE' });
    expect(JSON.stringify(whisper.response)).toContain('internal fallback');

    for (const value of [
      'ftp://stt.local/v1',
      'not a url',
      'javascript:alert(1)',
    ]) {
      const badUrl = await updateError(h.service, { sttBaseUrl: value });
      expect(badUrl.getStatus()).toBe(400);
      expect(badUrl.response).toMatchObject({ code: 'INVALID_STT_URL' });
    }

    expect(h.prisma.aiSetting.update).not.toHaveBeenCalled();
    // Nothing was persisted by the failed writes.
    expect((await h.service.view()).sttEngine).toBe('remote');

    // Unknown engines are still tolerated when reading a stored row.
    const stored = harness({ existing: row({ sttEngine: 'openai' }) });
    expect((await stored.service.view()).sttEngine).toBe('remote');

    // A trailing-slash URL is accepted and kept as sent.
    const ok = await h.service.update({
      sttEngine: 'Remote',
      sttBaseUrl: 'http://192.168.31.108:5092/v1/',
    });
    expect(ok).toMatchObject({
      sttEngine: 'remote',
      sttBaseUrl: 'http://192.168.31.108:5092/v1/',
    });
  });

  it('maps legacy engine names and keeps only remote, local and disabled', async () => {
    const h = harness();

    // `auto` maps to remote while a remote endpoint is configured.
    expect((await h.service.update({ sttEngine: 'auto' })).sttEngine).toBe(
      'remote',
    );
    // `parakeet` collapses into `local`.
    expect((await h.service.update({ sttEngine: 'parakeet' })).sttEngine).toBe(
      'local',
    );
    expect((await h.service.update({ sttEngine: 'local' })).sttEngine).toBe(
      'local',
    );
    expect((await h.service.update({ sttEngine: 'disabled' })).sttEngine).toBe(
      'disabled',
    );

    // Legacy stored names are mapped on read as well.
    const parakeet = harness({ existing: row({ sttEngine: 'parakeet' }) });
    expect((await parakeet.service.view()).sttEngine).toBe('local');
    const whisper = harness({ existing: row({ sttEngine: 'whisper' }) });
    expect((await whisper.service.view()).sttEngine).toBe('remote');

    // Without a remote endpoint (STT_REMOTE=off) `auto` falls back to local.
    vi.stubEnv('STT_REMOTE', 'off');
    expect((await h.service.update({ sttEngine: 'auto' })).sttEngine).toBe(
      'local',
    );
    const storedAuto = harness({ existing: row({ sttEngine: 'auto' }) });
    expect((await storedAuto.service.view()).sttEngine).toBe('local');
  });

  it('validates the model against Parakeet', async () => {
    const h = harness();
    const ctrl = controller(h.service);

    // Empty clears to the default.
    expect(
      (await ctrl.patchSettings({ sttModel: '' })).sttModel,
    ).toBe('parakeet-tdt-0.6b-v3');
    expect(
      (await ctrl.patchSettings({ sttModel: 'parakeet-tdt-0.6b-v3' })).sttModel,
    ).toBe('parakeet-tdt-0.6b-v3');

    for (const value of ['whisper-large-v3', 'gpt-4o-transcribe', 'tiny']) {
      const bad = await updateError(h.service, { sttModel: value });
      expect(bad.getStatus()).toBe(400);
      expect(bad.response).toMatchObject({ code: 'INVALID_STT_MODEL' });
    }

    // A legacy foreign model id is never shown: the view reports the default.
    const legacy = harness({
      existing: row({ sttModel: 'whisper-large-v3' }),
    });
    expect((await legacy.service.view()).sttModel).toBe(
      'parakeet-tdt-0.6b-v3',
    );
  });

  it('does not touch stt fields when the payload omits them', async () => {
    const h = harness({
      existing: row({
        sttEngine: 'remote',
        sttBaseUrl: 'https://stt.test/v1',
        sttLanguage: 'ru',
        sttApiKey: 'plain-key',
      }),
    });

    const view = await h.service.update({ model: 'gpt-test' });

    expect(view).toMatchObject({
      model: 'gpt-test',
      sttEngine: 'remote',
      sttBaseUrl: 'https://stt.test/v1',
      sttLanguage: 'ru',
      hasSttKey: true,
    });
    expect(h.current()?.sttApiKey).toBe('plain-key');
  });
});

describe('AiConfigService STT probe', () => {
  beforeEach(() => {
    clearSttEnv();
    fetchMock.mockReset();
  });

  it('probes the default LAN /health with a proxy-free dispatcher', async () => {
    const h = harness();
    fetchMock.mockResolvedValueOnce(healthResponse());

    const result = await h.service.sttTest();

    expect(result).toMatchObject({ ok: true, status: 200, engine: 'remote' });
    expect(typeof result.latencyMs).toBe('number');
    expect(result).not.toHaveProperty('detail');

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method?: string; dispatcher?: unknown; signal?: unknown },
    ];
    expect(String(url)).toBe('http://192.168.31.108:5092/health');
    expect(init.method).toBe('GET');
    // The corporate proxy answers 503 for the LAN, so bypass it.
    expect(init.dispatcher).toBeDefined();
    expect(init.signal).toBeDefined();
  });

  it('probes the stored base URL origin and reports HTTP failures', async () => {
    const h = harness({
      existing: row({
        sttEngine: 'remote',
        sttBaseUrl: 'https://stt.example.com/v1',
      }),
    });
    fetchMock.mockResolvedValueOnce(healthResponse(false, 503));

    const result = await h.service.sttTest();

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      engine: 'remote',
      detail: 'HTTP 503',
    });
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { dispatcher?: unknown },
    ];
    expect(String(url)).toBe('https://stt.example.com/health');
    expect(init.dispatcher).toBeUndefined();
  });

  it('reports a network failure without leaking the key', async () => {
    const h = harness();
    await h.service.update({ sttApiKey: 'stt-secret-key' });
    fetchMock.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const result = await h.service.sttTest();

    expect(result).toMatchObject({
      ok: false,
      status: null,
      engine: 'remote',
      detail: 'connect ECONNREFUSED',
    });
    expect(JSON.stringify(result)).not.toContain('stt-secret-key');
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers?: Record<string, string>; body?: unknown },
    ];
    expect(init.headers).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('checks the local Parakeet files without decoding', async () => {
    const directory = join(tmpdir(), `stt-probe-${process.pid}-ok`);
    mkdirSync(directory, { recursive: true });
    for (const name of [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
    ]) {
      writeFileSync(join(directory, name), 'x');
    }
    vi.stubEnv('PARAKEET_MODEL_DIR', directory);

    const local = harness({ existing: row({ sttEngine: 'local' }) });
    await expect(local.service.sttTest()).resolves.toEqual({
      ok: true,
      status: null,
      latencyMs: 0,
      engine: 'local',
      detail: 'parakeet-tdt-0.6b-v3',
    });

    // The legacy name is the same local engine.
    const parakeet = harness({ existing: row({ sttEngine: 'parakeet' }) });
    await expect(parakeet.service.sttTest()).resolves.toMatchObject({
      ok: true,
      engine: 'local',
      detail: 'parakeet-tdt-0.6b-v3',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports missing local model files instead of decoding', async () => {
    vi.stubEnv('PARAKEET_MODEL_DIR', join(tmpdir(), `stt-probe-${process.pid}-missing`));
    const h = harness({ existing: row({ sttEngine: 'local' }) });

    const result = await h.service.sttTest();

    expect(result).toMatchObject({ ok: false, status: null, engine: 'local' });
    expect(result.detail).toContain('missing parakeet model files');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a disabled engine as off', async () => {
    const disabled = harness({ existing: row({ sttEngine: 'disabled' }) });

    await expect(disabled.service.sttTest()).resolves.toEqual({
      ok: false,
      status: null,
      latencyMs: 0,
      engine: 'local',
      detail: 'disabled',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a legacy "auto" row to local when STT_REMOTE=off', async () => {
    const directory = join(tmpdir(), `stt-probe-${process.pid}-auto`);
    mkdirSync(directory, { recursive: true });
    for (const name of [
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'joiner.int8.onnx',
      'tokens.txt',
    ]) {
      writeFileSync(join(directory, name), 'x');
    }
    vi.stubEnv('PARAKEET_MODEL_DIR', directory);
    vi.stubEnv('STT_REMOTE', 'off');

    const h = harness({ existing: row({ sttEngine: 'auto' }) });
    await expect(h.service.sttTest()).resolves.toMatchObject({
      ok: true,
      engine: 'local',
      detail: 'parakeet-tdt-0.6b-v3',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honours STT_BASE_URL and STT_ENGINE from the environment', async () => {
    const h = harness({ existing: row({ sttBaseUrl: 'https://db.test/v1' }) });
    vi.stubEnv('STT_BASE_URL', 'http://10.0.0.5:5092');
    fetchMock.mockResolvedValueOnce(healthResponse());

    await h.service.sttTest();
    const [firstUrl] = fetchMock.mock.calls[0] as [string, unknown];
    expect(firstUrl).toBe('http://10.0.0.5:5092/health');

    // `whisper` is env-only: reported as the internal local fallback.
    vi.stubEnv('STT_ENGINE', 'whisper');
    await expect(h.service.sttTest()).resolves.toMatchObject({
      ok: true,
      engine: 'local',
      detail: 'whisper (internal fallback)',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Legacy `parakeet` maps to a local probe, never a network call.
    vi.stubEnv('STT_ENGINE', 'parakeet');
    vi.stubEnv('PARAKEET_MODEL_DIR', join(tmpdir(), `stt-probe-${process.pid}-env`));
    await expect(h.service.sttTest()).resolves.toMatchObject({
      ok: false,
      engine: 'local',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The env still wins over a stored remote choice.
    vi.stubEnv('STT_ENGINE', 'disabled');
    await expect(h.service.sttTest()).resolves.toMatchObject({
      ok: false,
      engine: 'local',
      detail: 'disabled',
    });
  });

  it('exposes the probe through POST /ai/stt/test', async () => {
    const h = harness();
    fetchMock.mockResolvedValueOnce(healthResponse());

    const result = await controller(h.service).sttTest();

    expect(result).toMatchObject({ ok: true, status: 200, engine: 'remote' });
    expect(result).not.toHaveProperty('hasSttKey');
  });
});

