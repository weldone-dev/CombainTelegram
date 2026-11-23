import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { MemoryStorage, TelegramClient, tl } from '@mtcute/node';
import type { TelegramTransport } from '@mtcute/node';
import type { TelegramSessionModel } from '@repo/database';
import type { InitConnectionOptions } from 'opentele2/mtcute';
import { SessionCryptoService } from './session-crypto.service.js';
import { ClientProfileService } from './client-profile.service.js';
import type { ResolvedProfile } from './client-profile.service.js';
import { ProxyTransportService } from './proxy-transport.service.js';
import { apiError } from '../common/api-error.js';
import { mapTelegramError } from '../auth/telegram-error.js';
import { emitLog } from '../logs/log-sink.js';
import {
  markTelegramErrorLogged,
  setLogTelegramMethod,
} from '../logs/log-context.js';

/** Everything needed to rebuild a client, encrypted inside a session record. */
export interface SessionPayload {
  session: string;
  apiId: number;
  apiHash: string;
  init: InitConnectionOptions;
}

/**
 * Owns every live mtcute client, one per `TelegramSession` row.
 *
 * Nothing connects at boot and no client is created eagerly: a client is built
 * the first time its session is used (or handed over by an auth flow that just
 * finished), so PC and phone sessions are independent clients.
 */
@Injectable()
export class ClientManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(ClientManagerService.name);
  private readonly clients = new Map<string, TelegramClient>();

  constructor(
    private readonly crypto: SessionCryptoService,
    private readonly profiles: ClientProfileService,
    private readonly proxies: ProxyTransportService,
  ) {}

  /**
   * A fresh, unauthenticated client for a pending login. Accepts a profile key
   * (`desktop`, `mobile`, ...) or an already resolved profile, plus an optional
   * proxy transport so the login itself does not go direct.
   */
  createAnonymous(
    profile: string | ResolvedProfile,
    transport?: TelegramTransport,
    proxyId?: string | null,
  ): TelegramClient {
    const resolved =
      typeof profile === 'string' ? this.profiles.resolve(profile) : profile;
    const client = new TelegramClient({
      apiId: resolved.api.apiId,
      apiHash: resolved.api.apiHash,
      storage: new MemoryStorage(),
      initConnectionOptions: resolved.init,
      ...(transport ? { transport } : {}),
    });
    this.instrument(client, { proxyId: proxyId ?? null, kind: 'login' });
    return client;
  }

  /** Returns the cached client for a session, rebuilding it from the DB row. */
  async clientForSession(
    session: TelegramSessionModel,
  ): Promise<TelegramClient> {
    const cached = this.clients.get(session.id);
    if (cached) return cached;

    const payload = this.decryptSession(session);

    let transport: TelegramTransport | undefined;
    try {
      transport = await this.proxies.transportForSession(session);
    } catch (error) {
      emitLog({
        level: 'error',
        source: 'proxy',
        action: 'proxy.transport',
        message: `Could not build proxy transport for session ${session.id}: ${(error as Error).message}`,
        status: 'failed',
        accountId: session.accountId,
        sessionId: session.id,
        errorCode: (error as { code?: string }).code,
        proxyId: session.proxyId,
        details: { proxyId: session.proxyId },
      });
      throw error;
    }

    const client = new TelegramClient({
      apiId: payload.apiId,
      apiHash: payload.apiHash,
      storage: new MemoryStorage(),
      initConnectionOptions: payload.init,
      ...(transport ? { transport } : {}),
    });

    try {
      await client.importSession(payload.session);
    } catch (error) {
      await client.destroy().catch(() => undefined);
      emitLog({
        level: 'error',
        source: 'telegram',
        action: 'telegram.client.import',
        message: `Could not import the stored session ${session.id}: ${(error as Error).message}`,
        status: 'failed',
        accountId: session.accountId,
        sessionId: session.id,
        errorCode: 'SESSION_IMPORT_FAILED',
        proxyId: session.proxyId,
        telegramResponse: { message: (error as Error).message },
      });
      throw apiError(
        'SESSION_IMPORT_FAILED',
        `Could not open the stored session: ${(error as Error).message}`,
        502,
      );
    }

    this.clients.set(session.id, client);
    this.instrument(client, {
      accountId: session.accountId,
      sessionId: session.id,
      proxyId: session.proxyId,
      kind: 'session',
    });
    emitLog({
      level: 'info',
      source: 'telegram',
      action: 'telegram.client.open',
      message: `Opened client for session ${session.id}`,
      status: 'ok',
      accountId: session.accountId,
      sessionId: session.id,
      proxyId: session.proxyId,
      details: {
        proxyId: session.proxyId,
        viaProxy: Boolean(transport),
        platform: session.platform,
        profile: session.profile,
      },
    });
    return client;
  }

  /**
   * Takes ownership of a client that just completed a login, so the newly
   * created session is live without re-importing the key.
   */
  async adopt(sessionId: string, client: TelegramClient): Promise<void> {
    const previous = this.clients.get(sessionId);
    this.clients.set(sessionId, client);
    if (previous && previous !== client) {
      await previous.destroy().catch(() => undefined);
    }
  }

  get(sessionId: string): TelegramClient | undefined {
    return this.clients.get(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    if (!client) return;
    this.clients.delete(sessionId);
    await client.destroy().catch((error: unknown) => {
      this.logger.warn(
        `Failed to close Telegram client for session ${sessionId}: ${(error as Error).message}`,
      );
      emitLog({
        level: 'warn',
        source: 'telegram',
        action: 'telegram.client.close',
        message: `Failed to close client for session ${sessionId}: ${(error as Error).message}`,
        status: 'failed',
        sessionId,
        details: { error: (error as Error).message },
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((client) => client.destroy()));
  }

  /**
   * Wraps `client.call` so every MTProto request lands in the log with its
   * method name, duration and the raw Telegram error text. Successes are info,
   * failures are errors; the HTTP interceptor still records the request that
   * caused them.
   */
  private instrument(
    client: TelegramClient,
    meta: {
      accountId?: string;
      sessionId?: string;
      proxyId?: string | null;
      kind: 'login' | 'session';
    },
  ): void {
    // High-level helper methods (`signInQr`, `sendText`, ...) call the low-level
    // `_client.call` directly, so the wrapper goes there rather than on the
    // public facade.
    const lowLevel = (
      client as unknown as {
        _client: {
          call: (method: { _?: string }, params?: unknown) => Promise<unknown>;
        };
      }
    )._client;
    const original = lowLevel.call.bind(lowLevel);
    lowLevel.call = async (method, params) => {
      const name =
        typeof method?._ === 'string' ? method._ : 'unknown';
      const startedAt = Date.now();
      setLogTelegramMethod(name);

      try {
        const result = await original(method, params);
        emitLog({
          level: 'info',
          source: 'telegram',
          action: 'telegram.call',
          message: `${name} · ${Date.now() - startedAt} мс`,
          status: 'ok',
          accountId: meta.accountId,
          sessionId: meta.sessionId,
          proxyId: meta.proxyId,
          telegramMethod: name,
          durationMs: Date.now() - startedAt,
          details: { kind: meta.kind },
        });
        return result;
      } catch (error) {
        const mapped = mapTelegramError(error);
        const rpc = tl.RpcError.is(error)
          ? { code: error.code, text: error.text, stack: error.stack?.slice(0, 4000) }
          : {
              message:
                error instanceof Error ? error.message : String(error),
            };
        emitLog({
          level: 'error',
          source: 'telegram',
          action: 'telegram.call',
          message: `${name} failed: ${
            tl.RpcError.is(error)
              ? error.text
              : error instanceof Error
                ? error.message
                : String(error)
          }`,
          status: 'failed',
          accountId: meta.accountId,
          sessionId: meta.sessionId,
          proxyId: meta.proxyId,
          telegramMethod: name,
          errorCode: mapped.code,
          telegramError: tl.RpcError.is(error) ? error.text : undefined,
          telegramResponse: rpc,
          durationMs: Date.now() - startedAt,
          details: { kind: meta.kind, mapped: { ...mapped } },
        });
        // `raiseTelegramError` normally logs the same failure; avoid a duplicate.
        markTelegramErrorLogged();
        throw error;
      }
    };
  }

  private decryptSession(session: TelegramSessionModel): SessionPayload {
    if (
      !session.cipher ||
      !session.nonce ||
      !session.tag ||
      !session.dekWrapped ||
      !session.dekNonce ||
      !session.dekTag
    ) {
      throw apiError(
        'SESSION_DECRYPT_FAILED',
        'This session is not an mtcute session and has no stored payload',
        500,
      );
    }
    let raw: string;
    try {
      raw = this.crypto
        .decrypt(
          {
            cipher: session.cipher,
            nonce: session.nonce,
            tag: session.tag,
            dekWrapped: session.dekWrapped,
            dekNonce: session.dekNonce,
            dekTag: session.dekTag,
            keyVersion: session.keyVersion,
          },
          `session:${session.accountId}`,
        )
        .toString('utf8');
    } catch {
      throw apiError(
        'SESSION_DECRYPT_FAILED',
        'Stored session key could not be decrypted',
        500,
      );
    }

    try {
      const parsed = JSON.parse(raw) as Partial<SessionPayload>;
      if (
        typeof parsed.session !== 'string' ||
        typeof parsed.apiId !== 'number' ||
        typeof parsed.apiHash !== 'string' ||
        typeof parsed.init !== 'object' ||
        parsed.init === null
      ) {
        throw new Error('bad payload');
      }
      return {
        session: parsed.session,
        apiId: parsed.apiId,
        apiHash: parsed.apiHash,
        init: parsed.init,
      };
    } catch {
      throw apiError(
        'SESSION_PAYLOAD_INVALID',
        'Stored session payload is malformed',
        500,
      );
    }
  }
}
