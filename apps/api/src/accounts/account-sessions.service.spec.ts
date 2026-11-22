import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProfileService } from '../telegram/client-profile.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { AccountSessionsService } from './account-sessions.service.js';
import type { AttachSessionInput } from './account-sessions.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

interface FakeAccountRow {
  id: string;
  userId: string;
  tgUserId: bigint;
  firstName: string;
  lastName: string | null;
  username: string | null;
  deviceProfile: string;
  isActive: boolean;
  phoneEncrypted?: Uint8Array | null;
  phoneNonce?: Uint8Array | null;
  phoneTag?: Uint8Array | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeSessionRow {
  id: string;
  accountId: string;
  deviceId: string;
  label: string | null;
  platform: string;
  profile: string;
  dcId: number;
  apiId: number;
  keyVersion: number;
  cipher: Uint8Array;
  nonce: Uint8Array;
  tag: Uint8Array;
  dekWrapped: Uint8Array;
  dekNonce: Uint8Array;
  dekTag: Uint8Array;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

function createFakePrisma(): {
  prisma: PrismaService;
  accounts: FakeAccountRow[];
  sessions: FakeSessionRow[];
} {
  const accounts: FakeAccountRow[] = [];
  const sessions: FakeSessionRow[] = [];
  let accountSeq = 0;
  let sessionSeq = 0;

  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
    Object.entries(where).every(([key, value]) => row[key] === value);

  const fake = {
    telegramAccount: {
      findUnique: async ({
        where,
      }: {
        where: { userId_tgUserId: { userId: string; tgUserId: bigint } };
      }) => {
        const key = where.userId_tgUserId;
        const account = accounts.find(
          (row) => row.userId === key.userId && row.tgUserId === key.tgUserId,
        );
        if (!account) return null;
        return {
          ...account,
          sessions: sessions.filter((row) => row.accountId === account.id),
        };
      },
      count: async ({ where }: { where: Record<string, unknown> }) =>
        accounts.filter((row) =>
          matches(row as unknown as Record<string, unknown>, where),
        ).length,
      create: async ({ data }: { data: Partial<FakeAccountRow> }) => {
        const now = new Date();
        const row: FakeAccountRow = {
          id: `acc_${++accountSeq}`,
          userId: data.userId as string,
          tgUserId: data.tgUserId as bigint,
          firstName: data.firstName ?? '',
          lastName: data.lastName ?? null,
          username: data.username ?? null,
          deviceProfile: data.deviceProfile ?? '{}',
          isActive: data.isActive ?? false,
          lastUsedAt: data.lastUsedAt ?? null,
          createdAt: now,
          updatedAt: now,
        };
        accounts.push(row);
        return { ...row };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Partial<FakeAccountRow>;
      }) => {
        const row = accounts.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('account not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row };
      },
    },
    telegramSession: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { accountId_deviceId: { accountId: string; deviceId: string } };
        create: Partial<FakeSessionRow>;
        update: Partial<FakeSessionRow>;
      }) => {
        const key = where.accountId_deviceId;
        const existing = sessions.find(
          (row) =>
            row.accountId === key.accountId && row.deviceId === key.deviceId,
        );
        if (existing) {
          Object.assign(existing, update);
          return { ...existing };
        }

        const row: FakeSessionRow = {
          id: `ses_${++sessionSeq}`,
          accountId: key.accountId,
          deviceId: key.deviceId,
          label: create.label ?? null,
          platform: create.platform ?? 'desktop',
          profile: create.profile ?? 'desktop',
          dcId: create.dcId ?? 2,
          apiId: create.apiId ?? 2040,
          keyVersion: create.keyVersion ?? 1,
          cipher: create.cipher as Uint8Array,
          nonce: create.nonce as Uint8Array,
          tag: create.tag as Uint8Array,
          dekWrapped: create.dekWrapped as Uint8Array,
          dekNonce: create.dekNonce as Uint8Array,
          dekTag: create.dekTag as Uint8Array,
          revokedAt: null,
          lastUsedAt: create.lastUsedAt ?? null,
          createdAt: new Date(),
        };
        sessions.push(row);
        return { ...row };
      },
    },
  };

  return {
    prisma: fake as unknown as PrismaService,
    accounts,
    sessions,
  };
}

const MASTER_KEY = Buffer.alloc(32, 3).toString('base64');

function makeService(env: Record<string, unknown> = {}): {
  service: AccountSessionsService;
  crypto: SessionCryptoService;
  profiles: ClientProfileService;
  fake: ReturnType<typeof createFakePrisma>;
} {
  const config = new TelegramConfigService(
    new ConfigService({ TELEGRAM_SESSION_MASTER_KEY: MASTER_KEY, ...env }),
  );
  const crypto = new SessionCryptoService(config);
  const fake = createFakePrisma();
  const service = new AccountSessionsService(fake.prisma, crypto, config);
  return {
    service,
    crypto,
    profiles: new ClientProfileService(config),
    fake,
  };
}

function input(
  profiles: ClientProfileService,
  overrides: Partial<AttachSessionInput> = {},
): AttachSessionInput {
  const profile = profiles.resolve('desktop');
  return {
    userId: 'user_1',
    deviceId: 'desktop-device-01',
    profile,
    session: 'session-string-desktop',
    apiId: profile.api.apiId,
    apiHash: profile.api.apiHash,
    init: profile.init,
    dcId: 2,
    tgUser: {
      id: 777n,
      firstName: 'Ann',
      lastName: 'Lee',
      username: 'ann',
    },
    phone: '+15551234567',
    ...overrides,
  };
}

function httpBody(error: unknown): { code: string; message: string } {
  expect(error).toBeInstanceOf(HttpException);
  return (error as HttpException).getResponse() as {
    code: string;
    message: string;
  };
}

describe('AccountSessionsService multi-session attach', () => {
  it('adds a second device as a new session under the same account', async () => {
    const { service, profiles, fake } = makeService();
    const desktopProfile = profiles.resolve('desktop');
    const phoneProfile = profiles.resolve('mobile');

    const first = await service.attachSession(
      input(profiles, { profile: desktopProfile }),
    );
    expect(first.isNewAccount).toBe(true);
    expect(first.isNewSession).toBe(true);
    expect(first.account.isActive).toBe(true);
    expect(first.account.sessions).toHaveLength(1);
    expect(first.account.tgUserId).toBe('777');
    expect(first.account.phoneMasked).toContain('4567');

    const second = await service.attachSession(
      input(profiles, {
        deviceId: 'phone-device-01',
        profile: phoneProfile,
        session: 'session-string-phone',
        apiId: phoneProfile.api.apiId,
        apiHash: phoneProfile.api.apiHash,
        init: phoneProfile.init,
        phone: null,
      }),
    );

    expect(second.isNewAccount).toBe(false);
    expect(second.isNewSession).toBe(true);
    expect(second.account.id).toBe(first.account.id);
    expect(second.account.sessions).toHaveLength(2);
    expect(second.account.sessions.map((row) => row.deviceId).sort()).toEqual([
      'desktop-device-01',
      'phone-device-01',
    ]);
    expect(second.account.isActive).toBe(true);

    expect(fake.accounts).toHaveLength(1);
    expect(fake.sessions).toHaveLength(2);
  });

  it('replaces the key when the same deviceId logs in again', async () => {
    const { service, crypto, profiles, fake } = makeService();

    const first = await service.attachSession(input(profiles));
    const originalCipher = Buffer.from(fake.sessions[0].cipher).toString('hex');

    const replaced = await service.attachSession(
      input(profiles, { session: 'session-string-replaced' }),
    );

    expect(replaced.account.id).toBe(first.account.id);
    expect(replaced.isNewSession).toBe(false);
    expect(fake.sessions).toHaveLength(1);
    expect(Buffer.from(fake.sessions[0].cipher).toString('hex')).not.toBe(
      originalCipher,
    );

    const row = fake.sessions[0];
    const payload = JSON.parse(
      crypto
        .decrypt(
          {
            cipher: row.cipher,
            nonce: row.nonce,
            tag: row.tag,
            dekWrapped: row.dekWrapped,
            dekNonce: row.dekNonce,
            dekTag: row.dekTag,
            keyVersion: row.keyVersion,
          },
          `session:${row.accountId}`,
        )
        .toString('utf8'),
    ) as { session: string };
    expect(payload.session).toBe('session-string-replaced');
  });

  it('refuses a new account over MAX_ACCOUNTS_PER_USER', async () => {
    const { service, profiles } = makeService({ MAX_ACCOUNTS_PER_USER: '1' });

    await service.attachSession(input(profiles));

    try {
      await service.attachSession(
        input(profiles, {
          deviceId: 'second-device-01',
          tgUser: { id: 888n, firstName: 'Bob' },
        }),
      );
      throw new Error('expected ACCOUNT_LIMIT');
    } catch (error) {
      expect(httpBody(error).code).toBe('ACCOUNT_LIMIT');
    }
  });

  it('refuses a new session over MAX_SESSIONS_PER_ACCOUNT', async () => {
    const { service, profiles } = makeService({
      MAX_SESSIONS_PER_ACCOUNT: '1',
    });

    await service.attachSession(input(profiles));

    try {
      await service.attachSession(
        input(profiles, { deviceId: 'second-device-01' }),
      );
      throw new Error('expected SESSION_LIMIT');
    } catch (error) {
      expect(httpBody(error).code).toBe('SESSION_LIMIT');
    }
  });
});
