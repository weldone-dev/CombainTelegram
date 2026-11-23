import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { ProxyModel } from '@repo/database';
import type { TelegramTransport } from '@mtcute/node';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import {
  PROXY_KINDS,
  ProxyTransportService,
  normalizeKind,
} from '../telegram/proxy-transport.service.js';
import type { ProxyKind } from '../telegram/proxy-transport.service.js';
import { apiError, conflict, notFound } from '../common/api-error.js';
import {
  optionalString,
  requireString,
} from '../common/validation.js';
import { emitLog } from '../logs/log-sink.js';
import type {
  ProxyCheckResult,
  ProxyTestResult,
  ProxyView,
} from './proxy-view.js';
import { serializeProxy } from './proxy-view.js';
import { ProxyProbeService } from './proxy-probe.service.js';

const CONNECT_TIMEOUT_MS = 8_000;
/** How long the last exit-node result is served before probing again. */
export const PROXY_CHECK_TTL_MS = 5 * 60 * 1000;

export interface ProxyCreateDto {
  name?: unknown;
  kind?: unknown;
  host?: unknown;
  port?: unknown;
  username?: unknown;
  secret?: unknown;
  enabled?: unknown;
}

export type ProxyUpdateDto = ProxyCreateDto;

interface NormalizedProxyInput {
  name?: string;
  kind?: ProxyKind;
  host?: string;
  port?: number;
  username?: string | null;
  secret?: string | null;
  enabled?: boolean;
}

/**
 * A user's personal proxy list. Credentials are never returned: the API only
 * exposes whether a secret is stored, and every write re-encrypts it.
 */
@Injectable()
export class ProxiesService {
  private readonly logger = new Logger(ProxiesService.name);
  private readonly checks = new Map<
    string,
    { result: ProxyCheckResult; at: number }
  >();
  private readonly inflight = new Map<string, Promise<ProxyCheckResult>>();
  /** Bumped on update/delete so a slow probe cannot cache stale settings. */
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SessionCryptoService,
    private readonly transports: ProxyTransportService,
    private readonly probe: ProxyProbeService,
  ) {}

  async list(userId: string): Promise<ProxyView[]> {
    const rows = (await this.prisma.proxy.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    })) as ProxyModel[];
    return rows.map(serializeProxy);
  }

  async create(userId: string, body: ProxyCreateDto): Promise<ProxyView> {
    const input = this.normalize(body, true);
    const id = randomUUID();

    const secretEncrypted =
      input.secret !== undefined && input.secret !== null
        ? this.crypto.serialize(
            this.crypto.encrypt(input.secret, `proxy:${id}`),
          )
        : null;

    try {
      const proxy = (await this.prisma.proxy.create({
        data: {
          id,
          userId,
          name: input.name as string,
          kind: input.kind as string,
          host: input.host as string,
          port: input.port as number,
          username: input.username ?? null,
          secretEncrypted,
          enabled: input.enabled ?? true,
        },
      })) as ProxyModel;
      return serializeProxy(proxy);
    } catch (error) {
      this.rethrowUnique(error, input.name as string, userId);
      throw error;
    }
  }

  async update(
    userId: string,
    id: string,
    body: ProxyUpdateDto,
  ): Promise<ProxyView> {
    const existing = await this.requireOwned(userId, id);
    const input = this.normalize(body, false);

    const data: {
      name?: string;
      kind?: string;
      host?: string;
      port?: number;
      username?: string | null;
      enabled?: boolean;
      secretEncrypted?: Uint8Array<ArrayBuffer> | null;
    } = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.kind !== undefined) data.kind = input.kind;
    if (input.host !== undefined) data.host = input.host;
    if (input.port !== undefined) data.port = input.port;
    if (input.username !== undefined) data.username = input.username;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (body.secret !== undefined) {
      if (input.secret) {
        data.secretEncrypted = this.crypto.serialize(
          this.crypto.encrypt(input.secret, `proxy:${existing.id}`),
        );
      } else {
        data.secretEncrypted = null;
      }
    }

    const nextKind = data.kind ?? existing.kind;
    const hasSecret =
      data.secretEncrypted !== undefined
        ? data.secretEncrypted !== null
        : existing.secretEncrypted !== null;
    if (nextKind === 'mtproto' && !hasSecret) {
      throw apiError(
        'PROXY_SECRET_REQUIRED',
        'An MTProto proxy needs a secret',
      );
    }

    if (Object.keys(data).length === 0) return serializeProxy(existing);

    try {
      const proxy = (await this.prisma.proxy.update({
        where: { id: existing.id },
        data,
      })) as ProxyModel;
      this.invalidateCheck(existing.id);
      return serializeProxy(proxy);
    } catch (error) {
      this.rethrowUnique(error, data.name ?? existing.name, userId);
      throw error;
    }
  }

  async remove(userId: string, id: string): Promise<{ removed: boolean }> {
    const existing = await this.requireOwned(userId, id);
    await this.prisma.proxy.delete({ where: { id: existing.id } });
    this.invalidateCheck(existing.id);
    return { removed: true };
  }

  /**
   * Reachability probe: opens a TCP connection to the proxy endpoint. It does
   * not authenticate, so a wrong password still reports `ok`.
   */
  async test(userId: string, id: string): Promise<ProxyTestResult> {
    const proxy = await this.requireOwned(userId, id);
    const started = Date.now();

    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: proxy.host, port: proxy.port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          apiError(
            'PROXY_UNREACHABLE',
            `Proxy ${proxy.host}:${proxy.port} did not answer within ${
              CONNECT_TIMEOUT_MS / 1000
            } s`,
            502,
          ),
        );
      }, CONNECT_TIMEOUT_MS);

      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(
          apiError(
            'PROXY_UNREACHABLE',
            `Cannot reach proxy ${proxy.host}:${proxy.port}: ${error.message}`,
            502,
          ),
        );
      });
    });

    return { ok: true, latencyMs: Date.now() - started };
  }

  /**
   * Real exit-node check: one HTTP request through the proxy to an IP echo.
   * `ok` means the request succeeded and `exitIp` is what the echo saw, not the
   * proxy host. Results are cached for 5 minutes and one probe per proxy id
   * runs at a time.
   */
  async check(userId: string, id: string): Promise<ProxyCheckResult> {
    const proxy = await this.requireOwned(userId, id);
    if (!proxy.enabled) {
      throw conflict('PROXY_DISABLED', 'This proxy is disabled');
    }

    const cached = this.checks.get(proxy.id);
    if (cached && Date.now() - cached.at < PROXY_CHECK_TTL_MS) {
      return cached.result;
    }

    const running = this.inflight.get(proxy.id);
    if (running) return running;

    const revision = this.revisions.get(proxy.id) ?? 0;
    const pending = this.runCheck(proxy, revision).finally(() => {
      if (this.inflight.get(proxy.id) === pending) {
        this.inflight.delete(proxy.id);
      }
    });
    this.inflight.set(proxy.id, pending);
    return pending;
  }

  /**
   * Transport for an auth attempt. `proxyId` is optional: without it the login
   * goes direct, exactly like before proxies existed.
   */
  async transportFor(
    userId: string,
    proxyId: unknown,
  ): Promise<TelegramTransport | undefined> {
    const id = optionalString(proxyId, 'proxyId', { max: 64 });
    if (!id) return undefined;
    await this.requireOwned(userId, id);
    return this.transports.transportForProxyId(id);
  }

  async requireOwned(userId: string, id: string): Promise<ProxyModel> {
    const proxy = (await this.prisma.proxy.findFirst({
      where: { id, userId },
    })) as ProxyModel | null;
    if (!proxy) throw notFound('PROXY_NOT_FOUND', 'Proxy not found');
    return proxy;
  }

  private async runCheck(
    proxy: ProxyModel,
    revision: number,
  ): Promise<ProxyCheckResult> {
    const started = Date.now();
    const checkedAt = new Date().toISOString();
    const kind = normalizeKind(proxy.kind);

    // MTProto is a Telegram-only transport: it cannot tunnel arbitrary HTTP,
    // so there is no exit node to report.
    if (kind === 'mtproto') {
      const result: ProxyCheckResult = {
        ok: false,
        unsupported: true,
        latencyMs: Date.now() - started,
        checkedAt,
      };
      this.cacheResult(proxy, result, revision);
      this.logCheck(proxy, result, 'ok');
      return result;
    }

    try {
      const credentials = this.transports.credentialsFor(proxy);
      const outcome = await this.probe.probe({
        kind,
        host: credentials.host,
        port: credentials.port,
        username: credentials.username,
        secret: credentials.secret,
      });
      const result: ProxyCheckResult = {
        ok: true,
        latencyMs: Date.now() - started,
        checkedAt,
        ...(outcome.exitIp ? { exitIp: outcome.exitIp } : {}),
        ...(outcome.country ? { country: outcome.country } : {}),
      };
      this.cacheResult(proxy, result, revision);
      this.logCheck(proxy, result, 'ok');
      return result;
    } catch {
      const result: ProxyCheckResult = {
        ok: false,
        latencyMs: Date.now() - started,
        checkedAt,
        error: 'PROXY_CHECK_FAILED',
      };
      this.logCheck(proxy, result, 'failed');
      // The underlying message may contain the proxy URL (credentials), so the
      // public error stays generic.
      throw apiError(
        'PROXY_CHECK_FAILED',
        'The proxy did not pass the exit-node check',
        502,
      );
    }
  }

  private cacheResult(
    proxy: ProxyModel,
    result: ProxyCheckResult,
    revision: number,
  ): void {
    if ((this.revisions.get(proxy.id) ?? 0) !== revision) return;
    this.checks.set(proxy.id, { result, at: Date.now() });
  }

  /** Logs a probe without the secret: credentials never reach the log store. */
  private logCheck(
    proxy: ProxyModel,
    result: ProxyCheckResult,
    status: 'ok' | 'failed',
  ): void {
    const snapshot = {
      id: proxy.id,
      name: proxy.name,
      kind: normalizeKind(proxy.kind),
      host: proxy.host,
      port: proxy.port,
      username: proxy.username,
      enabled: proxy.enabled,
    };
    const message = result.unsupported
      ? `Proxy ${proxy.name}: exit-node check is unsupported for mtproto`
      : result.ok
        ? `Proxy ${proxy.name}: exit node ${result.exitIp ?? 'unknown'}`
        : `Proxy ${proxy.name}: exit-node check failed`;

    emitLog({
      level: status === 'ok' ? 'info' : 'warn',
      source: 'proxy',
      action: 'proxy.check',
      message,
      status,
      userId: proxy.userId,
      proxyId: proxy.id,
      proxyLabel: proxy.name,
      proxySnapshot: snapshot,
      durationMs: result.latencyMs,
      ...(result.ok || result.unsupported
        ? {}
        : { errorCode: 'PROXY_CHECK_FAILED' }),
      details: {
        kind: snapshot.kind,
        host: snapshot.host,
        port: snapshot.port,
        username: snapshot.username,
        enabled: snapshot.enabled,
        exitIp: result.exitIp ?? null,
        country: result.country ?? null,
        unsupported: result.unsupported === true,
      },
    });
  }

  private invalidateCheck(id: string): void {
    this.checks.delete(id);
    this.inflight.delete(id);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }

  private normalize(
    body: ProxyCreateDto,
    required: boolean,
  ): NormalizedProxyInput {
    const input: NormalizedProxyInput = {};

    if (required || body.name !== undefined) {
      input.name = requireString(body.name, 'name', { max: 64 });
    }

    if (required || body.kind !== undefined) {
      const kind = requireString(body.kind ?? 'socks5', 'kind', { max: 16 });
      if (!(PROXY_KINDS as readonly string[]).includes(kind)) {
        throw apiError(
          'PROXY_KIND_INVALID',
          `kind must be one of: ${PROXY_KINDS.join(', ')}`,
        );
      }
      input.kind = kind as ProxyKind;
    }

    if (required || body.host !== undefined) {
      input.host = requireString(body.host, 'host', { max: 255 });
    }

    if (required || body.port !== undefined) {
      const port = Number(body.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw apiError('PROXY_PORT_INVALID', 'port must be 1..65535');
      }
      input.port = port;
    }

    if (body.username !== undefined) {
      input.username =
        optionalString(body.username, 'username', { max: 255 }) ?? null;
    }

    if (body.secret !== undefined) {
      if (body.secret === null || body.secret === '') {
        input.secret = null;
      } else {
        input.secret = requireString(body.secret, 'secret', { max: 512 });
      }
    }

    if (body.enabled !== undefined) {
      input.enabled = body.enabled === true || body.enabled === 'true';
    }

    const kind = input.kind;
    if (kind === 'mtproto' && required && !input.secret) {
      throw apiError(
        'PROXY_SECRET_REQUIRED',
        'An MTProto proxy needs a secret',
      );
    }

    return input;
  }

  private rethrowUnique(error: unknown, name: string, userId: string): void {
    if (
      error !== null &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'P2002'
    ) {
      this.logger.debug(`Duplicate proxy name for user ${userId}`);
      throw conflict(
        'PROXY_NAME_TAKEN',
        `A proxy named "${name}" already exists`,
      );
    }
  }
}
