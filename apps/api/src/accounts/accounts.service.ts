import { Injectable, Logger, Optional } from '@nestjs/common';
import type { TelegramClient } from '@mtcute/node';
import { TdClientManagerService } from '../tdlib/td-client-manager.service.js';
import type {
  TelegramAccountModel,
  TelegramSessionModel,
} from '@repo/database';
import { getSessions, terminateSession } from 'opentele2/mtcute';
import { asFlowClient } from '../telegram/flow-client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientManagerService } from '../telegram/client-manager.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { UpdatesService } from '../realtime/updates.service.js';
import { TdUpdatesService } from '../tdlib/td-updates.service.js';
import { apiError, conflict, notFound } from '../common/api-error.js';
import { optionalString, requireString } from '../common/validation.js';
import { setLogProxyId } from '../logs/log-context.js';
import { emitLog } from '../logs/log-sink.js';
import { raiseTelegramError } from '../auth/telegram-error.js';
import { downloadFileBuffer } from '../messaging/telegram-download.js';
import type { AccountView } from './account-view.js';
import { serializeAccount } from './account-view.js';
import { newestMtcuteSession, resolveActiveSession } from './active-session.js';

export interface TelegramSessionView {
  hash: string;
  deviceModel: string;
  platform: string;
  systemVersion: string;
  apiId: number;
  appName: string;
  appVersion: string;
  dateCreated: number;
  dateActive: number;
  ip: string;
  country: string;
  region: string;
  current: boolean;
  officialApp: boolean;
  passwordPending: boolean;
}

export interface RemoveAccountResult {
  removed: boolean;
  revoked: boolean;
}

export interface DetachSessionResult {
  removed: boolean;
  revoked: boolean;
  accountRemoved: boolean;
}

/** An account + one of its sessions, with an opened Telegram client. */
export interface ResolvedAccountSession {
  account: TelegramAccountModel;
  session: TelegramSessionModel;
  client: TelegramClient;
}

type AccountWithSessions = TelegramAccountModel & {
  sessions: TelegramSessionModel[];
};

export interface AvatarImage {
  data: Buffer;
  mime: string;
}

const AVATAR_TTL_MS = 10 * 60 * 1000;
const AVATAR_CACHE_MAX_ENTRIES = 100;

@Injectable()
export class AccountsService {
  private readonly logger = new Logger(AccountsService.name);
  private readonly avatars = new Map<
    string,
    { data: Buffer | null; at: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: ClientManagerService,
    private readonly crypto: SessionCryptoService,
    private readonly tdClients: TdClientManagerService,
    @Optional() private readonly updates?: UpdatesService,
    @Optional() private readonly tdUpdates?: TdUpdatesService,
  ) {}

  async list(userId: string): Promise<AccountView[]> {
    const accounts = (await this.prisma.telegramAccount.findMany({
      where: { userId },
      include: { sessions: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'asc' },
    })) as AccountWithSessions[];

    return accounts.map((account) =>
      serializeAccount(
        account,
        account.sessions,
        this.decryptPhone(account),
      ),
    );
  }

  async activate(userId: string, accountId: string): Promise<AccountView> {
    const account = await this.requireAccount(userId, accountId);

    await this.prisma.$transaction([
      this.prisma.telegramAccount.updateMany({
        where: { userId, isActive: true },
        data: { isActive: false },
      }),
      this.prisma.telegramAccount.update({
        where: { id: account.id },
        data: { isActive: true, lastUsedAt: new Date() },
      }),
    ]);

    const updated = await this.requireAccount(userId, accountId);
    return serializeAccount(
      updated,
      updated.sessions,
      this.decryptPhone(updated),
    );
  }

  /**
   * Pins one of the account's sessions as its transport. The UI calls this
   * explicitly: attaching a session never changes `activeSessionId` on its own.
   * Realtime is rebound so the engine (mtcute vs TDLib) follows immediately.
   */
  async activateSession(
    userId: string,
    accountId: string,
    sessionId: string,
  ): Promise<AccountView> {
    const account = await this.requireAccount(userId, accountId);
    const session = account.sessions.find((row) => row.id === sessionId);
    if (!session) {
      throw notFound(
        'SESSION_NOT_FOUND',
        'This session does not belong to the account',
      );
    }
    if (session.revokedAt) {
      throw conflict(
        'SESSION_REVOKED',
        'This session was revoked and can no longer be activated',
      );
    }

    await this.prisma.telegramAccount.update({
      where: { id: account.id },
      data: { activeSessionId: session.id },
    });

    emitLog({
      level: 'info',
      source: 'accounts',
      action: 'accounts.session.activate',
      message: `Activated session ${session.id} of account ${account.id}`,
      status: 'ok',
      userId,
      accountId: account.id,
      sessionId: session.id,
      proxyId: session.proxyId,
      details: { engine: session.engine, deviceId: session.deviceId },
    });

    // The active engine may have changed; both bridges re-read the accounts.
    await this.refreshRealtime(userId);

    const updated = await this.requireAccount(userId, accountId);
    return serializeAccount(
      updated,
      updated.sessions,
      this.decryptPhone(updated),
    );
  }

  /**
   * Local detach is the default. `revokeSession=true` calls `auth.logOut` on
   * every session first, which truly terminates them on Telegram.
   */
  async remove(
    userId: string,
    accountId: string,
    revoke: boolean,
  ): Promise<RemoveAccountResult> {
    const account = await this.requireAccount(userId, accountId);

    if (revoke) {
      for (const session of account.sessions) {
        if (session.engine === 'tdlib') {
          await this.revokeTdlibSession(session).catch((error: unknown) => {
            this.logger.warn(
              `TDLib logOut failed for session ${session.id}: ${(error as Error).message}`,
            );
          });
          continue;
        }
        const client = await this.clients
          .clientForSession(session)
          .catch((error: unknown) => {
            this.logger.warn(
              `Cannot open session ${session.id} for revoke: ${(error as Error).message}`,
            );
            return null;
          });
        if (!client) continue;
        await client.logOut().catch((error: unknown) => {
          this.logger.warn(
            `auth.logOut failed for session ${session.id}: ${(error as Error).message}`,
          );
        });
        await this.clients.closeSession(session.id);
      }
    } else {
      await Promise.all(
        account.sessions.map((session) =>
          session.engine === 'tdlib'
            ? this.tdClients.close(session.id)
            : this.clients.closeSession(session.id),
        ),
      );
    }

    await this.prisma.telegramAccount.delete({ where: { id: account.id } });
    return { removed: true, revoked: revoke };
  }

  async listTelegramSessions(
    userId: string,
    accountId: string,
  ): Promise<TelegramSessionView[]> {
    const account = await this.requireAccount(userId, accountId);
    const session = newestMtcuteSession(account);
    if (!session) {
      throw conflict(
        'NO_SESSIONS',
        'This account has no stored session to query Telegram with',
      );
    }

    const client = await this.clients.clientForSession(session);
    let authorizations;
    try {
      authorizations = await getSessions(asFlowClient(client));
    } catch (error) {
      throw apiError(
        'SESSIONS_UNAVAILABLE',
        `Telegram did not return the authorization list: ${(error as Error).message}`,
        502,
      );
    }
    return authorizations.authorizations.map((authorization) => ({
      hash: authorization.hash.toString(),
      deviceModel: authorization.deviceModel,
      platform: authorization.platform,
      systemVersion: authorization.systemVersion,
      apiId: authorization.apiId,
      appName: authorization.appName,
      appVersion: authorization.appVersion,
      dateCreated: authorization.dateCreated,
      dateActive: authorization.dateActive,
      ip: authorization.ip,
      country: authorization.country,
      region: authorization.region,
      current: authorization.current === true,
      officialApp: authorization.officialApp === true,
      passwordPending: authorization.passwordPending === true,
    }));
  }

  /**
   * Detaches one of *our* sessions. With `revoke=true` the matching Telegram
   * authorization is terminated on the server too (`account.resetAuthorization`
   * on the session's own authorization, which is flagged `current`).
   */
  async detachSession(
    userId: string,
    accountId: string,
    sessionId: string,
    revoke: boolean,
  ): Promise<DetachSessionResult> {
    const account = await this.requireAccount(userId, accountId);
    const session = account.sessions.find((row) => row.id === sessionId);
    if (!session) {
      throw notFound(
        'SESSION_NOT_FOUND',
        'This session does not belong to the account',
      );
    }

    if (revoke) {
      if (session.engine === 'tdlib') {
        await this.revokeTdlibSession(session);
        await this.clearActiveSession(account, sessionId);
        await this.prisma.telegramSession.delete({ where: { id: sessionId } });
        const left = account.sessions.length - 1;
        if (left <= 0) {
          await this.prisma.telegramAccount.delete({ where: { id: account.id } });
        }
        await this.refreshRealtime(userId);
        return { removed: true, revoked: true, accountRemoved: left <= 0 };
      }
      try {
        const client = await this.clients.clientForSession(session);
        const authorizations = await getSessions(asFlowClient(client));
        const current = authorizations.authorizations.find(
          (authorization) => authorization.current === true,
        );
        if (current) {
          await terminateSession(asFlowClient(client), current.hash);
        }
      } catch (error) {
        throw apiError(
          'SESSION_REVOKE_FAILED',
          `Telegram refused to terminate the session: ${(error as Error).message}`,
          502,
        );
      }
    }

    if (session.engine === 'tdlib') {
      await this.tdClients.close(sessionId);
    } else {
      await this.clients.closeSession(sessionId);
    }
    await this.clearActiveSession(account, sessionId);
    await this.prisma.telegramSession.delete({ where: { id: sessionId } });

    const remaining = account.sessions.length - 1;
    if (remaining <= 0) {
      await this.prisma.telegramAccount.delete({ where: { id: account.id } });
    }

    await this.refreshRealtime(userId);
    return { removed: true, revoked: revoke, accountRemoved: remaining <= 0 };
  }

  /**
   * Assigns a proxy (or clears it) and/or renames one of our sessions. The live
   * client is closed so the next request reconnects through the new transport.
   */
  async updateSession(
    userId: string,
    accountId: string,
    sessionId: string,
    body: { proxyId?: unknown; label?: unknown },
  ): Promise<AccountView> {
    const account = await this.requireAccount(userId, accountId);
    const session = account.sessions.find((row) => row.id === sessionId);
    if (!session) {
      throw notFound(
        'SESSION_NOT_FOUND',
        'This session does not belong to the account',
      );
    }

    const data: { proxyId?: string | null; label?: string | null } = {};
    if (body.proxyId !== undefined) {
      const proxyId =
        body.proxyId === null || body.proxyId === ''
          ? null
          : requireString(body.proxyId, 'proxyId', { max: 64 });
      if (proxyId) {
        const proxy = await this.prisma.proxy.findFirst({
          where: { id: proxyId, userId },
          select: { id: true },
        });
        if (!proxy) throw notFound('PROXY_NOT_FOUND', 'Proxy not found');
      }
      data.proxyId = proxyId;
    }
    if (body.label !== undefined) {
      data.label = optionalString(body.label, 'label', { max: 64 }) ?? null;
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.telegramSession.update({
        where: { id: session.id },
        data,
      });
      if (session.engine === 'tdlib') {
        await this.tdClients.close(session.id);
      } else {
        await this.clients.closeSession(session.id);
      }
      await this.updates?.reconnectForUser(userId);
      await this.tdUpdates?.reconnectForUser(userId);
    }

    const updated = await this.requireAccount(userId, accountId);
    return serializeAccount(
      updated,
      updated.sessions,
      this.decryptPhone(updated),
    );
  }

  /**
   * Resolves the account (owned by `userId`) and the session to talk to
   * Telegram with, then opens that session's client.
   *
   * `sessionId` is optional: without it the account's active session is used
   * (`resolveActiveSession`: pinned id, then live TDLib, then the newest live
   * mtcute session). This method always returns an mtcute client, so when the
   * active session belongs to TDLib it falls back to the newest mtcute session
   * and TDLib-only accounts raise `NO_SESSIONS`. Both the session and the
   * account are ownership-checked here.
   */
  async resolveSession(
    userId: string,
    accountId: string,
    sessionId?: string,
  ): Promise<ResolvedAccountSession> {
    const account = await this.requireAccount(userId, accountId);

    let session: TelegramSessionModel | undefined;
    if (sessionId) {
      session = account.sessions.find((row) => row.id === sessionId);
      if (!session) {
        throw notFound(
          'SESSION_NOT_FOUND',
          'This session does not belong to the account',
        );
      }
      if (session.revokedAt) {
        throw conflict(
          'SESSION_REVOKED',
          'This session was revoked and can no longer be used',
        );
      }
    } else {
      // Only mtcute sessions can open an mtcute client; TDLib rows are used
      // by TdClientManagerService and must never be picked here. When the
      // active session is TDLib, keep the rest of the API working through the
      // newest mtcute session.
      const active = resolveActiveSession(account);
      session =
        active && active.engine !== 'tdlib'
          ? active
          : newestMtcuteSession(account);
      if (!session) {
        throw conflict(
          'NO_SESSIONS',
          'This account has no stored session to talk to Telegram with',
        );
      }
    }

    setLogProxyId(session.proxyId);
    const client = await this.clients.clientForSession(session);
    return { account, session, client };
  }

  /**
   * Profile photo of the account's own Telegram user (small size, JPEG).
   * Cached in memory for a few minutes; `null` means the account has no photo.
   */
  async avatar(
    userId: string,
    accountId: string,
  ): Promise<AvatarImage | null> {
    // Resolve (and ownership-check) the session before the cache lookup so a
    // cached avatar can never answer for an account the user does not own.
    const { client } = await this.resolveSession(userId, accountId);

    const cacheKey = `${userId}:${accountId}`;
    const cached = this.avatars.get(cacheKey);
    if (cached && Date.now() - cached.at < AVATAR_TTL_MS) {
      return cached.data ? { data: cached.data, mime: 'image/jpeg' } : null;
    }

    let location: Parameters<typeof client.downloadAsBuffer>[0] | null = null;
    try {
      const me = await client.getMe();
      if (me.photo) {
        location = me.photo
          .small as Parameters<typeof client.downloadAsBuffer>[0];
      } else {
        const photos = await client.getProfilePhotos('me', { limit: 1 });
        const first = photos[0];
        if (first) {
          location = first as Parameters<typeof client.downloadAsBuffer>[0];
        }
      }
    } catch (error) {
      raiseTelegramError(error);
    }
    if (!location) {
      this.cacheAvatar(cacheKey, null);
      return null;
    }

    try {
      const data = await downloadFileBuffer(
        client,
        location as unknown as Parameters<typeof downloadFileBuffer>[1],
      );
      this.cacheAvatar(cacheKey, data);
      return { data, mime: 'image/jpeg' };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /** Bounded avatar cache: expired entries and the oldest extras are dropped. */
  private cacheAvatar(
    key: string,
    data: Buffer | null,
    now = Date.now(),
  ): void {
    this.avatars.delete(key);
    this.avatars.set(key, { data, at: now });
    for (const [cachedKey, entry] of this.avatars) {
      if (now - entry.at >= AVATAR_TTL_MS) this.avatars.delete(cachedKey);
    }
    while (this.avatars.size > AVATAR_CACHE_MAX_ENTRIES) {
      const oldest = this.avatars.keys().next().value;
      if (oldest === undefined) break;
      this.avatars.delete(oldest);
    }
  }

  /** Deleting the pinned session unpins it; the fallback order takes over. */
  private async clearActiveSession(
    account: AccountWithSessions,
    sessionId: string,
  ): Promise<void> {
    if (account.activeSessionId !== sessionId) return;
    await this.prisma.telegramAccount.update({
      where: { id: account.id },
      data: { activeSessionId: null },
    });
  }

  /** Rebinds both realtime bridges after the active engine may have changed. */
  private async refreshRealtime(userId: string): Promise<void> {
    await this.updates?.reconnectForUser(userId);
    await this.tdUpdates?.reconnectForUser(userId);
  }

  private async requireAccount(
    userId: string,
    accountId: string,
  ): Promise<AccountWithSessions> {
    const account = (await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      include: { sessions: { orderBy: { createdAt: 'asc' } } },
    })) as AccountWithSessions | null;

    if (!account) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
    return account;
  }

  /**
   * Terminates one TDLib session on Telegram. This touches only that TDLib
   * auth key: the account's mtcute/desktop session is never logged out here.
   */
  private async revokeTdlibSession(
    session: TelegramSessionModel,
  ): Promise<void> {
    try {
      const client = await this.tdClients.clientForSession(session);
      await client.api.logOut({}).catch((error: unknown) => {
        this.logger.warn(
          `TDLib logOut failed for session ${session.id}: ${(error as Error).message}`,
        );
      });
    } finally {
      await this.tdClients.close(session.id);
    }
  }

  private decryptPhone(account: TelegramAccountModel): string | null {
    if (
      !account.phoneEncrypted ||
      !account.phoneNonce ||
      !account.phoneTag
    ) {
      return null;
    }

    try {
      const envelope = this.crypto.deserialize(account.phoneEncrypted);
      return this.crypto
        .decrypt(envelope, `phone:${account.id}`)
        .toString('utf8');
    } catch {
      return null;
    }
  }
}
