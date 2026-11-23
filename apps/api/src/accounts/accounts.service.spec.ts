import { describe, expect, it, vi } from 'vitest';
import type { TelegramSessionModel } from '@repo/database';
import { AccountsService } from './accounts.service.js';
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
  activeSessionId: string | null;
  phoneEncrypted: Uint8Array | null;
  phoneNonce: Uint8Array | null;
  phoneTag: Uint8Array | null;
  cloudPasswordEncrypted: Uint8Array | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

const NOW = new Date('2026-11-20T10:00:00.000Z');

function session(
  id: string,
  accountId: string,
  engine: string,
  createdAt: Date,
  revoked = false,
): TelegramSessionModel {
  return {
    id,
    accountId,
    deviceId: id,
    label: null,
    platform: engine === 'tdlib' ? 'android' : 'desktop',
    profile: engine === 'tdlib' ? 'TelegramAndroid' : 'TelegramDesktop',
    engine,
    dcId: 0,
    apiId: 1,
    proxyId: null,
    keyVersion: 1,
    cipher: null,
    nonce: null,
    tag: null,
    dekWrapped: null,
    dekNonce: null,
    dekTag: null,
    tdlibPath: engine === 'tdlib' ? `/sessions/${id}` : null,
    tdlibKeyEncrypted: null,
    tdlibKeyNonce: null,
    tdlibKeyTag: null,
    revokedAt: revoked ? new Date(1) : null,
    lastUsedAt: null,
    createdAt,
  } as TelegramSessionModel;
}

function accountRow(
  id: string,
  overrides: Partial<FakeAccountRow> = {},
): FakeAccountRow {
  return {
    id,
    userId: 'user-1',
    tgUserId: 42n,
    firstName: 'Ann',
    lastName: null,
    username: 'ann',
    deviceProfile: '{}',
    isActive: true,
    activeSessionId: null,
    phoneEncrypted: null,
    phoneNonce: null,
    phoneTag: null,
    cloudPasswordEncrypted: null,
    lastUsedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

function createHarness(
  accounts: FakeAccountRow[],
  sessions: TelegramSessionModel[],
) {
  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(
        async ({ where }: { where: { id?: string; userId?: string } }) => {
          const row = accounts.find(
            (candidate) =>
              (where.id === undefined || candidate.id === where.id) &&
              (where.userId === undefined || candidate.userId === where.userId),
          );
          if (!row) return null;
          return {
            ...row,
            sessions: sessions
              .filter((row2) => row2.accountId === row.id)
              .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
          };
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<FakeAccountRow>;
        }) => {
          const row = accounts.find((candidate) => candidate.id === where.id);
          if (!row) throw new Error('account not found');
          Object.assign(row, data);
          return { ...row };
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = accounts.findIndex((row) => row.id === where.id);
        if (index >= 0) accounts.splice(index, 1);
        return { id: where.id };
      }),
    },
    telegramSession: {
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = sessions.findIndex((row) => row.id === where.id);
        if (index >= 0) sessions.splice(index, 1);
        return { id: where.id };
      }),
    },
  };

  const clients = {
    clientForSession: vi.fn(async () => ({ tag: 'mtcute' })),
    closeSession: vi.fn(async () => undefined),
  };
  const crypto = { deserialize: vi.fn(), decrypt: vi.fn() };
  const tdClients = {
    clientForSession: vi.fn(async () => ({
      api: { logOut: vi.fn(async () => ({})) },
    })),
    close: vi.fn(async () => undefined),
  };
  const updates = { reconnectForUser: vi.fn(async () => undefined) };
  const tdUpdates = { reconnectForUser: vi.fn(async () => undefined) };

  const service = new AccountsService(
    prisma as unknown as PrismaService,
    clients as never,
    crypto as never,
    tdClients as never,
    updates as never,
    tdUpdates as never,
  );

  return {
    service,
    prisma,
    clients,
    tdClients,
    updates,
    tdUpdates,
    accounts,
    sessions,
  };
}

function httpCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'getResponse' in error) {
    const body = (error as { getResponse(): unknown }).getResponse();
    if (body && typeof body === 'object' && 'code' in body) {
      return String((body as { code: unknown }).code);
    }
  }
  return undefined;
}

describe('AccountsService.activateSession', () => {
  it('pins the session, returns the view and rebinds realtime', async () => {
    const sessions = [
      session('s-mtcute', 'acc-1', 'mtcute', new Date(1)),
      session('s-tdlib', 'acc-1', 'tdlib', new Date(2)),
    ];
    const harness = createHarness([accountRow('acc-1')], sessions);

    const view = await harness.service.activateSession(
      'user-1',
      'acc-1',
      's-mtcute',
    );

    expect(view.activeSessionId).toBe('s-mtcute');
    expect(harness.accounts[0].activeSessionId).toBe('s-mtcute');
    expect(harness.updates.reconnectForUser).toHaveBeenCalledWith('user-1');
    expect(harness.tdUpdates.reconnectForUser).toHaveBeenCalledWith('user-1');
  });

  it('refuses a revoked session', async () => {
    const harness = createHarness(
      [accountRow('acc-1')],
      [session('s-dead', 'acc-1', 'mtcute', new Date(1), true)],
    );

    await expect(
      harness.service.activateSession('user-1', 'acc-1', 's-dead'),
    ).rejects.toSatisfy(
      (error: unknown) => httpCode(error) === 'SESSION_REVOKED',
    );
    expect(harness.accounts[0].activeSessionId).toBeNull();
  });

  it('refuses a session of another account (ownership)', async () => {
    const harness = createHarness(
      [accountRow('acc-1')],
      [session('s-other', 'acc-2', 'mtcute', new Date(1))],
    );

    await expect(
      harness.service.activateSession('user-1', 'acc-1', 's-other'),
    ).rejects.toSatisfy(
      (error: unknown) => httpCode(error) === 'SESSION_NOT_FOUND',
    );
  });
});

describe('AccountsService.detachSession', () => {
  it('clears activeSessionId when the deleted session was active', async () => {
    const harness = createHarness(
      [accountRow('acc-1', { activeSessionId: 's-tdlib' })],
      [
        session('s-mtcute', 'acc-1', 'mtcute', new Date(1)),
        session('s-tdlib', 'acc-1', 'tdlib', new Date(2)),
      ],
    );

    const result = await harness.service.detachSession(
      'user-1',
      'acc-1',
      's-tdlib',
      false,
    );

    expect(result).toEqual({
      removed: true,
      revoked: false,
      accountRemoved: false,
    });
    expect(harness.accounts[0].activeSessionId).toBeNull();
    expect(harness.tdClients.close).toHaveBeenCalledWith('s-tdlib');
    expect(harness.tdClients.close).not.toHaveBeenCalledWith('s-mtcute');
    expect(harness.prisma.telegramAccount.delete).not.toHaveBeenCalled();
    expect(harness.updates.reconnectForUser).toHaveBeenCalledWith('user-1');
    expect(harness.tdUpdates.reconnectForUser).toHaveBeenCalledWith('user-1');
  });

  it('keeps activeSessionId when another session is deleted', async () => {
    const harness = createHarness(
      [accountRow('acc-1', { activeSessionId: 's-mtcute' })],
      [
        session('s-mtcute', 'acc-1', 'mtcute', new Date(1)),
        session('s-tdlib', 'acc-1', 'tdlib', new Date(2)),
      ],
    );

    await harness.service.detachSession('user-1', 'acc-1', 's-tdlib', false);

    expect(harness.accounts[0].activeSessionId).toBe('s-mtcute');
  });

  it('logs out only the revoked TDLib session', async () => {
    const harness = createHarness(
      [accountRow('acc-1', { activeSessionId: 's-tdlib' })],
      [
        session('s-mtcute', 'acc-1', 'mtcute', new Date(1)),
        session('s-tdlib', 'acc-1', 'tdlib', new Date(2)),
        session('s-tdlib-2', 'acc-1', 'tdlib', new Date(3)),
      ],
    );

    await harness.service.detachSession('user-1', 'acc-1', 's-tdlib', true);

    expect(harness.tdClients.clientForSession).toHaveBeenCalledTimes(1);
    expect(harness.tdClients.clientForSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-tdlib' }),
    );
    expect(harness.tdClients.close).toHaveBeenCalledWith('s-tdlib');
    expect(harness.tdClients.close).not.toHaveBeenCalledWith('s-tdlib-2');
    expect(harness.accounts[0].activeSessionId).toBeNull();
  });
});

describe('AccountsService.resolveSession', () => {
  it('uses the pinned mtcute session when it is active', async () => {
    const pinned = session('s-old', 'acc-1', 'mtcute', new Date(1));
    const newer = session('s-new', 'acc-1', 'mtcute', new Date(9));
    const harness = createHarness(
      [accountRow('acc-1', { activeSessionId: 's-old' })],
      [pinned, newer],
    );

    const resolved = await harness.service.resolveSession('user-1', 'acc-1');

    expect(resolved.session.id).toBe('s-old');
  });

  it('falls back to the newest mtcute session when TDLib is active', async () => {
    const harness = createHarness(
      [accountRow('acc-1', { activeSessionId: 's-tdlib' })],
      [
        session('s-mtcute-old', 'acc-1', 'mtcute', new Date(1)),
        session('s-mtcute-new', 'acc-1', 'mtcute', new Date(9)),
        session('s-tdlib', 'acc-1', 'tdlib', new Date(10)),
      ],
    );

    const resolved = await harness.service.resolveSession('user-1', 'acc-1');

    expect(resolved.session.id).toBe('s-mtcute-new');
    expect(harness.clients.clientForSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-mtcute-new' }),
    );
  });

  it('throws NO_SESSIONS for a TDLib-only account', async () => {
    const harness = createHarness(
      [accountRow('acc-1')],
      [session('s-tdlib', 'acc-1', 'tdlib', new Date(1))],
    );

    await expect(
      harness.service.resolveSession('user-1', 'acc-1'),
    ).rejects.toSatisfy((error: unknown) => httpCode(error) === 'NO_SESSIONS');
  });
});
