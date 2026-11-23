import { describe, expect, it, vi } from 'vitest';
import type { TelegramSessionModel } from '@repo/database';
import { TdUpdatesService } from './td-updates.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

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
    platform: 'android',
    profile: 'TelegramAndroid',
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
    tdlibPath: `/sessions/${id}`,
    tdlibKeyEncrypted: null,
    tdlibKeyNonce: null,
    tdlibKeyTag: null,
    revokedAt: revoked ? new Date(1) : null,
    lastUsedAt: null,
    createdAt,
  } as TelegramSessionModel;
}

function fakeTdClient() {
  return {
    updates: { subscribe: vi.fn(() => () => undefined) },
    api: {
      loadChats: vi.fn(async () => ({})),
      getChats: vi.fn(async () => ({ chat_ids: [] })),
    },
  };
}

function createHarness(
  accounts: Array<{
    id: string;
    activeSessionId: string | null;
    sessions: TelegramSessionModel[];
  }>,
) {
  const prisma = {
    telegramAccount: { findMany: vi.fn(async () => accounts) },
  };
  const tdClients = { clientForSession: vi.fn(async () => fakeTdClient()) };
  const realtime = { emitToUser: vi.fn() };
  const service = new TdUpdatesService(
    prisma as unknown as PrismaService,
    tdClients as never,
    realtime as never,
  );
  return { service, tdClients };
}

describe('TdUpdatesService — active engine', () => {
  it('binds only the pinned TDLib session of a TDLib-active account', async () => {
    const { service, tdClients } = createHarness([
      {
        id: 'acc-1',
        activeSessionId: 's-tdlib',
        sessions: [
          session('s-mtcute', 'acc-1', 'mtcute', new Date(9)),
          session('s-tdlib', 'acc-1', 'tdlib', new Date(1)),
          session('s-tdlib-2', 'acc-1', 'tdlib', new Date(10)),
        ],
      },
    ]);

    await service.startForUser('user-1');

    expect(tdClients.clientForSession).toHaveBeenCalledTimes(1);
    expect(tdClients.clientForSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-tdlib' }),
    );

    await service.stopForUser('user-1');
  });

  it('binds no TDLib session when the account pinned mtcute', async () => {
    const { service, tdClients } = createHarness([
      {
        id: 'acc-1',
        activeSessionId: 's-mtcute',
        sessions: [
          session('s-mtcute', 'acc-1', 'mtcute', new Date(1)),
          session('s-tdlib', 'acc-1', 'tdlib', new Date(9)),
        ],
      },
    ]);

    await service.startForUser('user-1');

    expect(tdClients.clientForSession).not.toHaveBeenCalled();

    await service.stopForUser('user-1');
  });

  it('falls back to the newest live TDLib session when nothing is pinned', async () => {
    const { service, tdClients } = createHarness([
      {
        id: 'acc-1',
        activeSessionId: null,
        sessions: [
          session('s-mtcute', 'acc-1', 'mtcute', new Date(9)),
          session('s-tdlib-old', 'acc-1', 'tdlib', new Date(1)),
          session('s-tdlib-new', 'acc-1', 'tdlib', new Date(2)),
        ],
      },
    ]);

    await service.startForUser('user-1');

    expect(tdClients.clientForSession).toHaveBeenCalledTimes(1);
    expect(tdClients.clientForSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-tdlib-new' }),
    );

    await service.stopForUser('user-1');
  });
});
