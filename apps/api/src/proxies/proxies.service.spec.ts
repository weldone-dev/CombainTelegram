import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProxyModel } from '@repo/database';
import type { LogInput } from '../logs/log-sink.js';
import { setLogSink } from '../logs/log-sink.js';
import { PROXY_CHECK_TTL_MS, ProxiesService } from './proxies.service.js';

const SECRET = 'super-secret-proxy-pass';
const NOW = new Date('2026-11-23T10:00:00.000Z');

function proxyRow(overrides: Partial<ProxyModel> = {}): ProxyModel {
  return {
    id: 'proxy-1',
    userId: 'user-1',
    name: 'Frankfurt',
    kind: 'socks5',
    host: '127.0.0.1',
    port: 1080,
    username: 'user',
    secretEncrypted: new Uint8Array([1, 2, 3]),
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ProxyModel;
}

function createHarness(rows: ProxyModel[] = [proxyRow()]) {
  const prisma = {
    proxy: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          rows.find(
            (row) => row.id === where.id && row.userId === where.userId,
          ) ?? null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<ProxyModel>;
        }) => {
          const row = rows.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error('proxy not found');
          Object.assign(row, data);
          return row;
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = rows.findIndex((row) => row.id === where.id);
        if (index >= 0) rows.splice(index, 1);
        return { id: where.id };
      }),
    },
  };
  const crypto = {
    deserialize: vi.fn(() => ({ tag: 'envelope' })),
    decrypt: vi.fn(() => Buffer.from(SECRET, 'utf8')),
  };
  const transports = {
    credentialsFor: vi.fn((proxy: ProxyModel) => ({
      kind: proxy.kind,
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      secret: SECRET,
    })),
  };
  const probe = {
    probe: vi.fn(async () => ({ exitIp: '203.0.113.9' })),
  };

  const service = new ProxiesService(
    prisma as never,
    crypto as never,
    transports as never,
    probe as never,
  );

  const logs: LogInput[] = [];
  setLogSink((entry) => logs.push(entry));

  return { service, prisma, probe, transports, logs, rows };
}

function httpBody(error: unknown): { code: string; message: string } {
  return (
    error as { getResponse(): { code: string; message: string } }
  ).getResponse();
}

function httpStatus(error: unknown): number {
  return (error as { getStatus(): number }).getStatus();
}

afterEach(() => {
  setLogSink(null);
  vi.useRealTimers();
});

describe('ProxiesService.check', () => {
  it('maps a successful probe to the exit node answer', async () => {
    const harness = createHarness();

    const result = await harness.service.check('user-1', 'proxy-1');

    expect(result.ok).toBe(true);
    expect(result.exitIp).toBe('203.0.113.9');
    expect(result.unsupported).toBeUndefined();
    expect(result.country).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(new Date(result.checkedAt).toISOString()).toBe(result.checkedAt);
    expect(harness.probe.probe).toHaveBeenCalledWith({
      kind: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'user',
      secret: SECRET,
    });
  });

  it('passes a country through only when the echo returned one', async () => {
    const harness = createHarness();
    harness.probe.probe.mockResolvedValue({
      exitIp: '203.0.113.9',
      country: 'DE',
    });

    const result = await harness.service.check('user-1', 'proxy-1');

    expect(result.country).toBe('DE');
  });

  it('reports mtproto as unsupported instead of failing', async () => {
    const harness = createHarness([proxyRow({ kind: 'mtproto' })]);

    const result = await harness.service.check('user-1', 'proxy-1');

    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(harness.probe.probe).not.toHaveBeenCalled();
    expect(harness.transports.credentialsFor).not.toHaveBeenCalled();
  });

  it('maps an unreachable proxy to a 502 without leaking the secret', async () => {
    const harness = createHarness();
    harness.probe.probe.mockRejectedValue(
      new Error(`connect failed for socks5://user:${SECRET}@127.0.0.1:1080`),
    );

    const error = await harness.service
      .check('user-1', 'proxy-1')
      .catch((caught: unknown) => caught);

    expect(httpStatus(error)).toBe(502);
    expect(httpBody(error)).toEqual({
      code: 'PROXY_CHECK_FAILED',
      message: 'The proxy did not pass the exit-node check',
    });
    expect(JSON.stringify(httpBody(error))).not.toContain(SECRET);
  });

  it('rejects an owned-but-disabled proxy with 409', async () => {
    const harness = createHarness([proxyRow({ enabled: false })]);

    const error = await harness.service
      .check('user-1', 'proxy-1')
      .catch((caught: unknown) => caught);

    expect(httpStatus(error)).toBe(409);
    expect(httpBody(error).code).toBe('PROXY_DISABLED');
    expect(harness.probe.probe).not.toHaveBeenCalled();
  });

  it('checks ownership before probing', async () => {
    const harness = createHarness();

    const error = await harness.service
      .check('user-2', 'proxy-1')
      .catch((caught: unknown) => caught);

    expect(httpStatus(error)).toBe(404);
    expect(httpBody(error).code).toBe('PROXY_NOT_FOUND');
    expect(harness.probe.probe).not.toHaveBeenCalled();
  });

  it('serves the cached result inside five minutes', async () => {
    const harness = createHarness();

    const first = await harness.service.check('user-1', 'proxy-1');
    const second = await harness.service.check('user-1', 'proxy-1');

    expect(harness.probe.probe).toHaveBeenCalledTimes(1);
    expect(second.checkedAt).toBe(first.checkedAt);
  });

  it('probes again after the five-minute cache expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();

    await harness.service.check('user-1', 'proxy-1');
    vi.advanceTimersByTime(PROXY_CHECK_TTL_MS + 1);
    await harness.service.check('user-1', 'proxy-1');

    expect(harness.probe.probe).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache when the proxy is updated', async () => {
    const harness = createHarness();

    await harness.service.check('user-1', 'proxy-1');
    await harness.service.update('user-1', 'proxy-1', { name: 'Renamed' });
    await harness.service.check('user-1', 'proxy-1');

    expect(harness.probe.probe).toHaveBeenCalledTimes(2);
  });

  it('invalidates the cache when the proxy is deleted', async () => {
    const harness = createHarness();
    const row = harness.rows[0];

    await harness.service.check('user-1', 'proxy-1');
    await harness.service.remove('user-1', 'proxy-1');
    // Recreate the same id to observe the invalidation, not the 404.
    harness.rows.push(row);
    await harness.service.check('user-1', 'proxy-1');

    expect(harness.probe.probe).toHaveBeenCalledTimes(2);
  });

  it('runs one in-flight probe per proxy id', async () => {
    const harness = createHarness();
    let release: (value: { exitIp: string }) => void = () => undefined;
    const gate = new Promise<{ exitIp: string }>((resolve) => {
      release = resolve;
    });
    harness.probe.probe.mockReturnValue(gate);

    const first = harness.service.check('user-1', 'proxy-1');
    const second = harness.service.check('user-1', 'proxy-1');
    release({ exitIp: '203.0.113.9' });

    expect(await first).toBe(await second);
    expect(harness.probe.probe).toHaveBeenCalledTimes(1);
  });

  it('never puts the secret in the result or the log entry', async () => {
    const harness = createHarness();

    const result = await harness.service.check('user-1', 'proxy-1');
    await harness.service.update('user-1', 'proxy-1', { name: 'Renamed' });
    harness.probe.probe.mockRejectedValue(
      new Error(`bad auth socks5://user:${SECRET}@127.0.0.1:1080`),
    );
    await harness.service.check('user-1', 'proxy-1').catch(() => undefined);

    const payload = JSON.stringify({ result, logs: harness.logs });
    expect(payload).not.toContain(SECRET);
    expect(harness.logs).toHaveLength(2);

    const [okLog, failedLog] = harness.logs;
    expect(okLog).toMatchObject({
      source: 'proxy',
      action: 'proxy.check',
      status: 'ok',
      proxyId: 'proxy-1',
      proxyLabel: 'Frankfurt',
      userId: 'user-1',
    });
    expect(okLog.proxySnapshot).toMatchObject({
      id: 'proxy-1',
      host: '127.0.0.1',
      port: 1080,
      username: 'user',
      enabled: true,
    });
    expect(okLog.proxySnapshot).not.toHaveProperty('secret');
    expect(failedLog.status).toBe('failed');
    expect(failedLog.errorCode).toBe('PROXY_CHECK_FAILED');
  });
});
