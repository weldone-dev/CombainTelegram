import { describe, expect, it, vi } from 'vitest';
import type {
  TelegramAccountModel,
  TelegramSessionModel,
} from '@repo/database';
import { TdMessagingService } from './td-messaging.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const NOW = new Date('2026-11-20T10:00:00.000Z');

function session(
  id: string,
  engine: string,
  createdAt: Date,
  revoked = false,
): TelegramSessionModel {
  return {
    id,
    accountId: 'acc-1',
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
    tdlibPath: engine === 'tdlib' ? `/sessions/${id}` : null,
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
    api: {},
  };
}

function createHarness(
  activeSessionId: string | null,
  sessions: TelegramSessionModel[],
  engine: 'auto' | 'mtcute' | 'tdlib' = 'auto',
) {
  const account = {
    id: 'acc-1',
    userId: 'user-1',
    tgUserId: 42n,
    firstName: 'Ann',
    lastName: null,
    username: 'ann',
    deviceProfile: '{}',
    isActive: true,
    activeSessionId,
    cloudPasswordEncrypted: null,
    lastUsedAt: null,
    createdAt: NOW,
  } as TelegramAccountModel;

  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(async () => ({ ...account, sessions })),
    },
  };
  const tdClients = {
    clientForSession: vi.fn(async () => fakeTdClient()),
  };
  const config = { engine };
  const files = {};
  const service = new TdMessagingService(
    prisma as unknown as PrismaService,
    config as never,
    tdClients as never,
    files as never,
  );
  return { service, tdClients };
}

describe('TdMessagingService.forAccount — active engine', () => {
  it('routes to TDLib when the active session is a live TDLib row', async () => {
    const { service, tdClients } = createHarness('s-tdlib', [
      session('s-mtcute', 'mtcute', new Date(9)),
      session('s-tdlib', 'tdlib', new Date(1)),
    ]);

    const messenger = await service.forAccount('user-1', 'acc-1');

    expect(messenger).not.toBeNull();
    expect(tdClients.clientForSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-tdlib' }),
    );
  });

  it('stays on mtcute when the account pinned an mtcute session', async () => {
    const { service, tdClients } = createHarness('s-mtcute', [
      session('s-mtcute', 'mtcute', new Date(1)),
      session('s-tdlib', 'tdlib', new Date(9)),
    ]);

    expect(await service.forAccount('user-1', 'acc-1')).toBeNull();
    expect(tdClients.clientForSession).not.toHaveBeenCalled();
  });

  it('cannot be forced onto TDLib by a sessionId when mtcute is active', async () => {
    const { service } = createHarness('s-mtcute', [
      session('s-mtcute', 'mtcute', new Date(1)),
      session('s-tdlib', 'tdlib', new Date(9)),
    ]);

    expect(await service.forAccount('user-1', 'acc-1', 's-tdlib')).toBeNull();
  });

  it('honours an explicit TDLib sessionId among several TDLib sessions', async () => {
    const { service, tdClients } = createHarness('s-tdlib', [
      session('s-tdlib', 'tdlib', new Date(1)),
      session('s-tdlib-2', 'tdlib', new Date(9)),
    ]);

    await service.forAccount('user-1', 'acc-1', 's-tdlib-2');

    expect(tdClients.clientForSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-tdlib-2' }),
    );
  });

  it('falls back to the live TDLib row when it is not pinned', async () => {
    const { service, tdClients } = createHarness(null, [
      session('s-mtcute', 'mtcute', new Date(9)),
      session('s-tdlib', 'tdlib', new Date(1)),
    ]);

    expect(await service.forAccount('user-1', 'acc-1')).not.toBeNull();
    expect(tdClients.clientForSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-tdlib' }),
    );
  });

  it('ignores TDLib rows when the engine is forced to mtcute', async () => {
    const { service, tdClients } = createHarness(
      's-tdlib',
      [session('s-tdlib', 'tdlib', new Date(1))],
      'mtcute',
    );

    expect(await service.forAccount('user-1', 'acc-1')).toBeNull();
    expect(tdClients.clientForSession).not.toHaveBeenCalled();
  });
});
