import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Client } from 'tdlib-native';
import type { setTdlibParameters$Input } from 'tdlib-native/types';
import type { TelegramSessionModel } from '@repo/database';
import { profile } from 'opentele2';
import type { ApiProfile } from 'opentele2';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { ProxyTransportService } from '../telegram/proxy-transport.service.js';
import { emitLog } from '../logs/log-sink.js';

const READY_TIMEOUT_MS = 30_000;

/** Files and database folders of one TDLib session. */
export interface TdlibDirectories {
  root: string;
  databaseDirectory: string;
  filesDirectory: string;
}

export interface TdlibOpenedClient {
  client: Client;
  directories: TdlibDirectories;
}

function directoriesFor(root: string): TdlibDirectories {
  return {
    root,
    databaseDirectory: join(root, 'db'),
    filesDirectory: join(root, 'files'),
  };
}

/**
 * Owns one native TDLib client per TDLib session.
 *
 * TDLib keeps its own encrypted auth key + cache in a per-session folder, so a
 * client can be reopened after a restart without any Telegram login. Every
 * folder has its own `database_encryption_key`, sealed with the session master
 * key (`SessionCryptoService`).
 */
@Injectable()
export class TdClientManagerService implements OnModuleDestroy {
  private readonly logger = new Logger(TdClientManagerService.name);
  private adapter?: Promise<unknown>;
  private readonly clients = new Map<string, Client>();
  private readonly opening = new Map<string, Promise<Client>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramConfigService,
    private readonly crypto: SessionCryptoService,
    private readonly proxies: ProxyTransportService,
  ) {}

  /** The native TDLib addon is loaded once per process, lazily. */
  private async addon(): Promise<unknown> {
    this.adapter ??= (async () => {
      const { TDLibAddon } = await import('tdlib-native/addon');
      const { Client } = await import('tdlib-native');
      const adapter = await TDLibAddon.create();
      Client.disableLogs(adapter as never);
      return adapter;
    })();
    return this.adapter;
  }

  /** `TelegramAndroid` (or the operator's custom profile) for new clients. */
  tdlibProfile(): ApiProfile {
    if (this.config.mode === 'custom' && this.config.customApiId) {
      return {
        apiId: this.config.customApiId,
        apiHash: this.config.customApiHash ?? '',
        deviceModel: this.config.customDevice.deviceModel,
        systemVersion: this.config.customDevice.systemVersion,
        appVersion: this.config.customDevice.appVersion,
        langCode: this.config.customDevice.langCode,
        systemLanguageCode: this.config.customDevice.systemLangCode,
        systemLangCode: this.config.customDevice.systemLangCode,
        langPack: this.config.customDevice.langPack,
      } as unknown as ApiProfile;
    }
    return profile('TelegramAndroid');
  }

  /**
   * `setTdlibParameters` for a folder. `database_encryption_key` must be the
   * same value on every restart, otherwise TDLib refuses to open the database.
   */
  parameters(
    directories: TdlibDirectories,
    databaseKey: string,
    options: { useCache?: boolean } = {},
  ): setTdlibParameters$Input {
    const useCache = options.useCache ?? true;
    const api = this.tdlibProfile();
    return {
      _: 'setTdlibParameters',
      api_id: api.apiId,
      api_hash: api.apiHash,
      database_directory: directories.databaseDirectory,
      files_directory: directories.filesDirectory,
      database_encryption_key: databaseKey,
      use_message_database: useCache,
      use_chat_info_database: useCache,
      use_file_database: useCache,
      use_secret_chats: false,
      system_language_code: api.systemLangCode ?? 'en-US',
      device_model: api.deviceModel,
      system_version: api.systemVersion,
      application_version: api.appVersion,
    };
  }

  directories(root: string): TdlibDirectories {
    return directoriesFor(root);
  }

  sessionDirectories(sessionId: string): TdlibDirectories {
    return directoriesFor(join(this.config.tdlibDataDir, 'sessions', sessionId));
  }

  temporaryDirectories(attemptId: string): TdlibDirectories {
    return directoriesFor(join(this.config.tdlibDataDir, 'attempts', attemptId));
  }

  generateDatabaseKey(): string {
    return randomBytes(32).toString('base64');
  }

  async ensureDirectories(dirs: TdlibDirectories): Promise<void> {
    await mkdir(dirs.databaseDirectory, { recursive: true });
    await mkdir(dirs.filesDirectory, { recursive: true });
  }

  /** Creates a client for `dirs` but does not start it. */
  async create(dirs: TdlibDirectories): Promise<Client> {
    const adapter = await this.addon();
    const { Client: ClientCtor } = await import('tdlib-native');
    return new ClientCtor(adapter as never);
  }

  /**
   * Opens (or reopens) the stored TDLib client of a session: starts TDLib,
   * supplies the parameters from the session row and waits for `Ready`.
   */
  clientForSession(session: TelegramSessionModel): Promise<Client> {
    const cached = this.clients.get(session.id);
    if (cached) return Promise.resolve(cached);

    const inflight = this.opening.get(session.id);
    if (inflight) return inflight;

    const promise = this.openStored(session).finally(() => {
      this.opening.delete(session.id);
    });
    this.opening.set(session.id, promise);
    return promise;
  }

  private async openStored(session: TelegramSessionModel): Promise<Client> {
    if (session.engine !== 'tdlib' || !session.tdlibPath) {
      throw new Error('This session is not backed by TDLib');
    }
    const dirs = directoriesFor(session.tdlibPath);
    await this.ensureDirectories(dirs);

    const databaseKey = this.decryptDatabaseKey(session);
    const parameters = this.parameters(dirs, databaseKey);
    const client = await this.create(dirs);

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('TDLib did not become ready in time'));
      }, READY_TIMEOUT_MS);
      client.updates.subscribe((update) => {
        if (update._ !== 'updateAuthorizationState') return;
        const state = update.authorization_state;
        switch (state._) {
          case 'authorizationStateWaitTdlibParameters':
            void client.api.setTdlibParameters(parameters).catch(reject);
            break;
          case 'authorizationStateReady':
            clearTimeout(timer);
            resolve();
            break;
          case 'authorizationStateClosed':
            clearTimeout(timer);
            reject(new Error('TDLib closed the client'));
            break;
          default:
            break;
        }
      });
    });

    try {
      await client.start();
      await ready;
      await this.applyProxy(client, session);
    } catch (error) {
      await client.destroy().catch(() => undefined);
      emitLog({
        level: 'error',
        source: 'telegram',
        action: 'tdlib.open',
        message: `Could not open the TDLib session ${session.id}: ${(error as Error).message}`,
        status: 'failed',
        accountId: session.accountId,
        sessionId: session.id,
        errorCode: 'TDLIB_OPEN_FAILED',
      });
      throw error;
    }

    this.clients.set(session.id, client);
    return client;
  }

  /** Applies the session proxy through TDLib's own proxy support. */
  private async applyProxy(
    client: Client,
    session: TelegramSessionModel,
  ): Promise<void> {
    if (!session.proxyId) return;
    const proxy = await this.prisma.proxy.findUnique({
      where: { id: session.proxyId },
    });
    if (!proxy) return;

    const credentials = this.proxies.credentialsFor(proxy);
    const type =
      credentials.kind === 'http' || credentials.kind === 'https'
        ? ({
            _: 'proxyTypeHttp',
            username: credentials.username ?? '',
            password: credentials.secret ?? '',
            http_only: credentials.kind === 'http',
          } as const)
        : ({
            _: 'proxyTypeSocks5',
            username: credentials.username ?? '',
            password: credentials.secret ?? '',
          } as const);

    try {
      await client.api.addProxy({
        proxy: {
          _: 'proxy',
          server: credentials.host,
          port: credentials.port,
          type,
        },
        enable: true,
        comment: proxy.name,
      });
    } catch (error) {
      this.logger.warn(
        `Could not apply proxy ${proxy.id} to TDLib session ${session.id}: ${(error as Error).message}`,
      );
    }
  }

  private decryptDatabaseKey(session: TelegramSessionModel): string {
    if (!session.tdlibKeyEncrypted) {
      throw new Error('The TDLib session has no database key');
    }
    const envelope = this.crypto.deserialize(session.tdlibKeyEncrypted);
    return this.crypto
      .decrypt(envelope, `tdlib:${session.accountId}`)
      .toString('utf8');
  }

  /** Encrypts a database key for storage in a session row. */
  packDatabaseKey(accountId: string, key: string): {
    tdlibKeyEncrypted: Uint8Array<ArrayBuffer>;
    tdlibKeyNonce: Uint8Array<ArrayBuffer>;
    tdlibKeyTag: Uint8Array<ArrayBuffer>;
  } {
    const envelope = this.crypto.encrypt(key, `tdlib:${accountId}`);
    return {
      tdlibKeyEncrypted: this.crypto.serialize(envelope),
      tdlibKeyNonce: envelope.nonce,
      tdlibKeyTag: envelope.tag,
    };
  }

  /** Stops one client (used by logout/removal); ignores unknown sessions. */
  async close(sessionId: string): Promise<void> {
    const client = this.clients.get(sessionId);
    this.clients.delete(sessionId);
    if (!client) return;
    await client.destroy().catch((error: unknown) => {
      this.logger.warn(
        `TDLib destroy failed for session ${sessionId}: ${(error as Error).message}`,
      );
    });
  }

  /**
   * Moves a finished login attempt folder to its permanent location. TDLib
   * must be closed first: it keeps the database open while the client lives.
   */
  async adoptDirectory(from: TdlibDirectories, sessionId: string): Promise<string> {
    const target = this.sessionDirectories(sessionId).root;
    await mkdir(dirname(target), { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(from.root, target);
    return target;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled(
      [...this.clients.keys()].map((sessionId) => this.close(sessionId)),
    );
  }
}
