import { Injectable, Logger } from '@nestjs/common';
import { proxyTransportFromUrl } from '@mtcute/node';
import type { TelegramTransport } from '@mtcute/node';
import type { ProxyModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from './session-crypto.service.js';
import { apiError } from '../common/api-error.js';

export const PROXY_KINDS = [
  'socks5',
  'socks4',
  'http',
  'https',
  'mtproto',
] as const;

export type ProxyKind = (typeof PROXY_KINDS)[number];

/**
 * Turns a stored `Proxy` row into an mtcute transport.
 *
 * A session that has a proxy assigned never falls back to a direct connection:
 * a missing, disabled or undecryptable proxy is an error, because silently
 * leaking the real IP would defeat the point of assigning one.
 */
@Injectable()
export class ProxyTransportService {
  private readonly logger = new Logger(ProxyTransportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SessionCryptoService,
  ) {}

  /** Transport for an optional `Proxy.id`; `null`/`undefined` means direct. */
  async transportForProxyId(
    proxyId: string | null | undefined,
  ): Promise<TelegramTransport | undefined> {
    if (!proxyId) return undefined;

    const proxy = await this.prisma.proxy.findUnique({
      where: { id: proxyId },
    });
    if (!proxy) {
      throw apiError(
        'PROXY_NOT_FOUND',
        'The proxy assigned to this session no longer exists',
        409,
      );
    }
    return this.transportForRow(proxy);
  }

  /** Transport for a session row (uses `session.proxyId`). */
  async transportForSession(session: {
    proxyId?: string | null;
  }): Promise<TelegramTransport | undefined> {
    return this.transportForProxyId(session.proxyId);
  }

  /** Builds a transport from a row, decrypting the secret when present. */
  transportForRow(proxy: ProxyModel): TelegramTransport {
    if (!proxy.enabled) {
      throw apiError(
        'PROXY_DISABLED',
        'The proxy assigned to this session is disabled',
        409,
      );
    }
    return proxyTransportFromUrl(this.urlFor(proxy));
  }

  /**
   * Plain connection details (with the decrypted secret) for transports that
   * are not mtcute, such as TDLib's `addProxy`.
   */
  credentialsFor(proxy: ProxyModel): {
    kind: ProxyKind;
    host: string;
    port: number;
    username: string | null;
    secret: string | null;
  } {
    if (!proxy.enabled) {
      throw apiError(
        'PROXY_DISABLED',
        'The proxy assigned to this session is disabled',
        409,
      );
    }
    return {
      kind: normalizeKind(proxy.kind),
      host: proxy.host,
      port: proxy.port,
      username: proxy.username ?? null,
      secret: this.decryptSecret(proxy),
    };
  }

  /** Rebuilds the proxy URL, including the decrypted secret when present. */
  urlFor(proxy: ProxyModel): string {
    const kind = normalizeKind(proxy.kind);
    const secret = this.decryptSecret(proxy);

    if (kind === 'mtproto') {
      if (!secret) {
        throw apiError(
          'PROXY_SECRET_REQUIRED',
          'An MTProto proxy requires a secret',
          409,
        );
      }
      const params = new URLSearchParams({
        server: proxy.host,
        port: String(proxy.port),
        secret,
      });
      return `https://t.me/proxy?${params.toString()}`;
    }

    const credentials = proxy.username
      ? `${encodeURIComponent(proxy.username)}${
          secret ? `:${encodeURIComponent(secret)}` : ''
        }@`
      : '';
    return `${kind}://${credentials}${formatHost(proxy.host)}:${proxy.port}`;
  }

  private decryptSecret(proxy: ProxyModel): string | null {
    if (!proxy.secretEncrypted) return null;
    try {
      const envelope = this.crypto.deserialize(proxy.secretEncrypted);
      return this.crypto
        .decrypt(envelope, `proxy:${proxy.id}`)
        .toString('utf8');
    } catch {
      this.logger.warn(`Could not decrypt secret for proxy ${proxy.id}`);
      throw apiError(
        'PROXY_SECRET_INVALID',
        'The stored proxy secret could not be decrypted',
        500,
      );
    }
  }
}

export function normalizeKind(value: string): ProxyKind {
  return (PROXY_KINDS as readonly string[]).includes(value)
    ? (value as ProxyKind)
    : 'socks5';
}

function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
