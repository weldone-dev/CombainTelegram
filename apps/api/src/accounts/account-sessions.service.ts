import { Injectable, Optional } from '@nestjs/common';
import type {
  TelegramAccountModel,
  TelegramSessionModel,
} from '@repo/database';
import type { InitConnectionOptions } from 'opentele2/mtcute';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import type { ResolvedProfile } from '../telegram/client-profile.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { apiError, notFound } from '../common/api-error.js';
import { emitLog } from '../logs/log-sink.js';
import { UpdatesService } from '../realtime/updates.service.js';
import type { AccountView } from './account-view.js';
import { serializeAccount } from './account-view.js';

/** The Telegram side of a freshly authorized user. */
export interface TelegramUserInfo {
  id: number | bigint;
  firstName: string;
  lastName?: string | null;
  username?: string | null;
}

export interface AttachSessionInput {
  userId: string;
  deviceId: string;
  label?: string | null;
  profile: ResolvedProfile;
  /** mtcute v3 string session of the new auth key. */
  session: string;
  apiId: number;
  apiHash: string;
  init: InitConnectionOptions;
  dcId: number;
  tgUser: TelegramUserInfo;
  phone?: string | null;
  /** Optional proxy from the user's list, used by the login client too. */
  proxyId?: string | null;
}

export interface AttachedSession {
  account: AccountView;
  sessionId: string;
  isNewAccount: boolean;
  isNewSession: boolean;
}

type AccountWithSessions = TelegramAccountModel & {
  sessions: TelegramSessionModel[];
};

/**
 * The single place where an authorized Telegram user becomes an account slot +
 * encrypted session.
 *
 * Rules: upsert by `(userId, tgUserId)` (never duplicate an account), add or
 * replace by `(accountId, deviceId)`, enforce `MAX_ACCOUNTS_PER_USER` and
 * `MAX_SESSIONS_PER_ACCOUNT`, and encrypt everything with the account id as AAD.
 */
@Injectable()
export class AccountSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SessionCryptoService,
    private readonly config: TelegramConfigService,
    /**
     * Optional so unit tests can construct the service without the realtime
     * module. When present, a freshly attached session is subscribed at once
     * for users that already have a live `/events` socket.
     */
    @Optional() private readonly updates?: UpdatesService,
  ) {}

  async attachSession(input: AttachSessionInput): Promise<AttachedSession> {
    const now = new Date();
    const tgUserId = BigInt(input.tgUser.id);
    if (input.proxyId) {
      const proxy = await this.prisma.proxy.findFirst({
        where: { id: input.proxyId, userId: input.userId },
        select: { id: true },
      });
      if (!proxy) {
        throw notFound('PROXY_NOT_FOUND', 'Proxy not found');
      }
    }
    const deviceProfile = JSON.stringify({
      key: input.profile.key,
      platform: input.profile.platform,
      apiId: input.profile.api.apiId,
      deviceModel: input.profile.api.deviceModel,
      systemVersion: input.profile.api.systemVersion,
      appVersion: input.profile.api.appVersion,
      langCode: input.profile.api.langCode,
      systemLangCode: input.profile.api.systemLangCode,
      langPack: input.profile.api.langPack,
    });

    const existing = (await this.prisma.telegramAccount.findUnique({
      where: { userId_tgUserId: { userId: input.userId, tgUserId } },
      include: { sessions: true },
    })) as AccountWithSessions | null;

    let account: TelegramAccountModel;
    let isNewAccount = false;
    let sessions: TelegramSessionModel[];

    if (existing) {
      account = await this.prisma.telegramAccount.update({
        where: { id: existing.id },
        data: {
          firstName: input.tgUser.firstName,
          lastName: input.tgUser.lastName ?? null,
          username: input.tgUser.username ?? null,
          deviceProfile,
          lastUsedAt: now,
        },
      });
      sessions = existing.sessions;
    } else {
      const accountCount = await this.prisma.telegramAccount.count({
        where: { userId: input.userId },
      });
      if (accountCount >= this.config.maxAccountsPerUser) {
        throw apiError(
          'ACCOUNT_LIMIT',
          `This user already has the maximum of ${this.config.maxAccountsPerUser} Telegram accounts`,
          409,
        );
      }

      const activeCount = await this.prisma.telegramAccount.count({
        where: { userId: input.userId, isActive: true },
      });

      account = await this.prisma.telegramAccount.create({
        data: {
          userId: input.userId,
          tgUserId,
          firstName: input.tgUser.firstName,
          lastName: input.tgUser.lastName ?? null,
          username: input.tgUser.username ?? null,
          deviceProfile,
          // The first session makes the account active; later accounts do not
          // steal focus from an account that already has it.
          isActive: activeCount === 0,
          lastUsedAt: now,
        },
      });
      isNewAccount = true;
      sessions = [];
    }

    const existingSession = sessions.find(
      (session) => session.deviceId === input.deviceId,
    );
    if (!existingSession && sessions.length >= this.config.maxSessionsPerAccount) {
      throw apiError(
        'SESSION_LIMIT',
        `This account already has the maximum of ${this.config.maxSessionsPerAccount} sessions`,
        409,
      );
    }

    const envelope = this.crypto.encrypt(
      JSON.stringify({
        session: input.session,
        apiId: input.apiId,
        apiHash: input.apiHash,
        init: input.init,
      }),
      `session:${account.id}`,
    );

    const sessionData = {
      label: input.label ?? null,
      platform: input.profile.platform,
      profile: input.profile.key,
      dcId: input.dcId,
      apiId: input.apiId,
      proxyId: input.proxyId ?? existingSession?.proxyId ?? null,
      keyVersion: envelope.keyVersion,
      cipher: envelope.cipher,
      nonce: envelope.nonce,
      tag: envelope.tag,
      dekWrapped: envelope.dekWrapped,
      dekNonce: envelope.dekNonce,
      dekTag: envelope.dekTag,
      revokedAt: null,
      lastUsedAt: now,
    };

    const session = await this.prisma.telegramSession.upsert({
      where: {
        accountId_deviceId: {
          accountId: account.id,
          deviceId: input.deviceId,
        },
      },
      create: {
        accountId: account.id,
        deviceId: input.deviceId,
        ...sessionData,
      },
      update: sessionData,
    });

    if (input.phone) {
      const phoneEnvelope = this.crypto.encrypt(
        input.phone,
        `phone:${account.id}`,
      );
      await this.prisma.telegramAccount.update({
        where: { id: account.id },
        data: {
          // The whole envelope lives in one blob; the schema has no phone DEK
          // columns. Nonce/tag are duplicated for introspection only.
          phoneEncrypted: this.crypto.serialize(phoneEnvelope),
          phoneNonce: phoneEnvelope.nonce,
          phoneTag: phoneEnvelope.tag,
        },
      });
    }

    const allSessions = existingSession
      ? sessions.map((row) => (row.id === session.id ? session : row))
      : [...sessions, session];

    // A user that is already listening on /events should receive updates from
    // this account immediately, without having to reconnect the socket.
    void this.updates?.refreshForUser(input.userId);

    emitLog({
      level: 'info',
      source: 'auth',
      action: 'auth.session.attach',
      message: `${isNewAccount ? 'Attached new account' : 'Attached session'} ${session.id}`,
      status: 'ok',
      userId: input.userId,
      accountId: account.id,
      sessionId: session.id,
      proxyId: session.proxyId,
      details: {
        isNewAccount,
        isNewSession: !existingSession,
        proxyId: session.proxyId,
        platform: session.platform,
        profile: session.profile,
        deviceId: input.deviceId,
      },
    });

    return {
      account: serializeAccount(account, allSessions, input.phone ?? null),
      sessionId: session.id,
      isNewAccount,
      isNewSession: !existingSession,
    };
  }
}
