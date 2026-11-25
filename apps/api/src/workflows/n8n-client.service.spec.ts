import { ConfigService } from '@nestjs/config';
import { fetch as httpFetch } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiSettingModel } from '@repo/database';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import {
  N8nClientService,
  n8nApiBase,
  n8nExecutionsUrl,
  n8nWorkflowsUrl,
} from './n8n-client.service.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

const NOW = new Date('2026-11-25T12:00:00.000Z');
const SECRET_PREFIX = 'enc:v1:';

function settingRow(overrides: Partial<AiSettingModel> = {}): AiSettingModel {
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
    capabilities: '{}',
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
    n8nBaseUrl: 'https://n8n.example.com',
    n8nApiKey: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function cryptoService(): SessionCryptoService {
  return new SessionCryptoService(
    new TelegramConfigService(
      new ConfigService({
        TELEGRAM_SESSION_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      }),
    ),
  );
}

function sealKey(crypto: SessionCryptoService, key: string): string {
  const envelope = crypto.serialize(crypto.encrypt(key, 'ai:n8n-key'));
  return `${SECRET_PREFIX}${Buffer.from(envelope).toString('base64')}`;
}

function serviceWith(row: AiSettingModel | null): N8nClientService {
  const prisma = {
    aiSetting: { findUnique: vi.fn(async () => row) },
  };
  return new N8nClientService(prisma as never, cryptoService());
}

function respond(status: number, body: unknown): void {
  vi.mocked(httpFetch).mockImplementation((async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () =>
      typeof body === 'string' ? body : JSON.stringify(body),
  })) as never);
}

function lastUrl(): string {
  const input = vi.mocked(httpFetch).mock.calls.at(-1)?.[0] as
    | string
    | URL
    | { url?: string }
    | undefined;
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input?.url ?? '';
}

function lastInit(): {
  headers?: Record<string, string>;
  dispatcher?: unknown;
} {
  return (vi.mocked(httpFetch).mock.calls.at(-1)?.[1] ?? {}) as {
    headers?: Record<string, string>;
    dispatcher?: unknown;
  };
}

beforeEach(() => {
  vi.mocked(httpFetch).mockReset();
  // A stray N8N_* from the shell must not change these expectations.
  vi.stubEnv('N8N_BASE_URL', '');
  vi.stubEnv('N8N_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('n8n URL helpers', () => {
  it('joins the API path once, with or without a trailing slash', () => {
    expect(n8nApiBase('http://127.0.0.1:5678')).toBe(
      'http://127.0.0.1:5678/api/v1',
    );
    expect(n8nApiBase('http://127.0.0.1:5678/')).toBe(
      'http://127.0.0.1:5678/api/v1',
    );
    expect(n8nApiBase('https://n8n.example.com/api/v1/')).toBe(
      'https://n8n.example.com/api/v1',
    );
    expect(n8nWorkflowsUrl('https://n8n.example.com/')).toBe(
      'https://n8n.example.com/api/v1/workflows?limit=100',
    );
    expect(n8nExecutionsUrl('https://n8n.example.com', 'w/1', 5)).toBe(
      'https://n8n.example.com/api/v1/executions?workflowId=w%2F1&limit=5',
    );
    // The execution limit is clamped to a sane range.
    expect(n8nExecutionsUrl('https://n8n.example.com', 'w1', 5000)).toContain(
      'limit=100',
    );
    expect(n8nExecutionsUrl('https://n8n.example.com', 'w1', 0)).toContain(
      'limit=1',
    );
  });
});

describe('N8nClientService.listWorkflows', () => {
  it('maps the n8n list, sends the key and keeps public hosts proxied', async () => {
    const crypto = cryptoService();
    const service = serviceWith(
      settingRow({ n8nApiKey: sealKey(crypto, 'super-secret-key') }),
    );
    respond(200, {
      data: [
        {
          id: 'wf-1',
          name: 'Support bot',
          active: true,
          updatedAt: '2026-11-25T09:00:00.000Z',
        },
        { id: 'wf-2', name: '', active: false },
        { name: 'no id' },
      ],
    });

    const result = await service.listWorkflows();

    expect(result).toEqual({
      ok: true,
      workflows: [
        {
          id: 'wf-1',
          name: 'Support bot',
          active: true,
          updatedAt: '2026-11-25T09:00:00.000Z',
        },
        { id: 'wf-2', name: 'wf-2', active: false, updatedAt: null },
      ],
    });
    expect(lastUrl()).toBe(
      'https://n8n.example.com/api/v1/workflows?limit=100',
    );
    const init = lastInit();
    expect(init.headers).toEqual({
      accept: 'application/json',
      'X-N8N-API-KEY': 'super-secret-key',
    });
    // Public host: the default egress path (HTTP_PROXY) stays in effect.
    expect(init.dispatcher).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('super-secret-key');
  });

  it('bypasses the proxy for loopback and accepts an /api/v1 base', async () => {
    vi.stubEnv('N8N_BASE_URL', 'http://127.0.0.1:5678/api/v1');
    const service = serviceWith(settingRow());
    respond(200, { data: [] });

    const result = await service.listWorkflows();

    expect(result).toEqual({ ok: true, workflows: [] });
    expect(lastUrl()).toBe('http://127.0.0.1:5678/api/v1/workflows?limit=100');
    expect(lastInit().dispatcher).toBeDefined();
    expect(lastInit().headers).toEqual({ accept: 'application/json' });
  });

  it('returns ok:false instead of throwing when n8n is unreachable', async () => {
    const service = serviceWith(settingRow());
    vi.mocked(httpFetch).mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:5678'),
    );

    const result = await service.listWorkflows();

    expect(result.ok).toBe(false);
    expect(result.workflows).toEqual([]);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('reports an HTTP error and never echoes the API key', async () => {
    const crypto = cryptoService();
    const service = serviceWith(
      settingRow({ n8nApiKey: sealKey(crypto, 'super-secret-key') }),
    );
    respond(401, {
      message: 'unauthorized: super-secret-key is not valid',
    });

    const result = await service.listWorkflows();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 401');
    expect(result.error).toContain('***');
    expect(JSON.stringify(result)).not.toContain('super-secret-key');
  });

  it('fails cleanly on a non-JSON answer', async () => {
    const service = serviceWith(settingRow());
    respond(200, '<html>login</html>');

    const result = await service.listWorkflows();

    expect(result).toEqual({
      ok: false,
      workflows: [],
      error: 'n8n returned an unexpected payload',
    });
  });
});

describe('N8nClientService.test', () => {
  it('reports status and latency for a healthy instance', async () => {
    const service = serviceWith(settingRow());
    respond(200, { data: [] });

    const result = await service.test();

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
    expect(lastUrl()).toBe('https://n8n.example.com/api/v1/workflows?limit=1');
  });

  it('reports an HTTP failure without throwing', async () => {
    const service = serviceWith(settingRow());
    respond(503, { message: 'n8n is starting' });

    const result = await service.test();

    expect(result).toMatchObject({
      ok: false,
      status: 503,
      error: 'n8n is starting',
    });
  });

  it('reports a transport failure', async () => {
    const service = serviceWith(settingRow());
    vi.mocked(httpFetch).mockRejectedValue(new Error('fetch failed'));

    const result = await service.test();

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe('fetch failed');
  });

  it('surfaces the connection error code hidden behind "fetch failed"', async () => {
    const service = serviceWith(settingRow());
    vi.mocked(httpFetch).mockRejectedValue(
      new Error('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
    );

    const result = await service.test();

    expect(result.error).toBe('fetch failed (ECONNREFUSED)');
  });

  it('prefers N8N_BASE_URL and N8N_API_KEY over the stored row', async () => {
    vi.stubEnv('N8N_BASE_URL', 'https://env.example.com/');
    vi.stubEnv('N8N_API_KEY', 'env-key');
    const service = serviceWith(
      settingRow({ n8nBaseUrl: 'https://row.example.com' }),
    );
    respond(200, { data: [] });

    await service.test();

    expect(lastUrl()).toBe('https://env.example.com/api/v1/workflows?limit=1');
    expect(lastInit().headers).toEqual({
      accept: 'application/json',
      'X-N8N-API-KEY': 'env-key',
    });
  });
});

describe('N8nClientService.executions', () => {
  it('maps recent executions', async () => {
    const service = serviceWith(settingRow());
    respond(200, {
      data: [
        {
          id: 101,
          status: 'success',
          mode: 'webhook',
          startedAt: '2026-11-25T09:00:00.000Z',
          stoppedAt: '2026-11-25T09:00:02.000Z',
        },
        { id: '102', finished: false, mode: 'trigger' },
        { id: 103, finished: true },
        { mode: 'manual' },
      ],
    });

    const result = await service.executions('wf-1', 5);

    expect(result).toEqual({
      ok: true,
      executions: [
        {
          id: '101',
          status: 'success',
          startedAt: '2026-11-25T09:00:00.000Z',
          stoppedAt: '2026-11-25T09:00:02.000Z',
          mode: 'webhook',
        },
        {
          id: '102',
          status: 'running',
          startedAt: null,
          stoppedAt: null,
          mode: 'trigger',
        },
        {
          id: '103',
          status: 'success',
          startedAt: null,
          stoppedAt: null,
          mode: null,
        },
      ],
    });
    expect(lastUrl()).toBe(
      'https://n8n.example.com/api/v1/executions?workflowId=wf-1&limit=5',
    );
  });

  it('defaults to ten executions and reports failures', async () => {
    const service = serviceWith(settingRow());
    respond(404, { message: 'workflow not found' });

    const result = await service.executions('missing');

    expect(result).toEqual({
      ok: false,
      executions: [],
      error: 'HTTP 404: workflow not found',
    });
    expect(lastUrl()).toContain('limit=10');
  });
});
