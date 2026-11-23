import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { UpdatesService } from './updates.service.js';

type SessionRow = {
  id: string;
  engine: string;
  revokedAt: Date | null;
  proxyId: string | null;
};

function session(id: string, engine: string, revoked = false): SessionRow {
  return {
    id,
    engine,
    revokedAt: revoked ? new Date(0) : null,
    proxyId: null,
  };
}

function fakeClient() {
  const emitter = () => {
    const listeners: Array<(value: unknown) => void> = [];
    return {
      add: (listener: (value: unknown) => void) => listeners.push(listener),
      remove: (listener: (value: unknown) => void) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      },
    };
  };
  return {
    onNewMessage: emitter(),
    onEditMessage: emitter(),
    onDeleteMessage: emitter(),
    onHistoryRead: emitter(),
    onUserTyping: emitter(),
    startUpdatesLoop: vi.fn(async () => undefined),
    stopUpdatesLoop: vi.fn(async () => undefined),
  };
}

function createService(accounts: Array<{ id: string; sessions: SessionRow[] }>) {
  const prisma = {
    telegramAccount: {
      findMany: vi.fn(async () => accounts),
    },
  };
  const clients = {
    clientForSession: vi.fn(async () => fakeClient()),
  };
  const realtime = { emitToUser: vi.fn() };
  const service = new UpdatesService(
    prisma as never,
    clients as never,
    realtime as never,
  );
  return { service, clients, prisma };
}

describe('UpdatesService — TDLib session wins', () => {
  it('skips every mtcute session of an account that has a live TDLib session', async () => {
    const debug = vi.spyOn(Logger.prototype, 'debug');
    const { service, clients } = createService([
      { id: 'acc-1', sessions: [session('s-mtcute', 'mtcute'), session('s-td', 'tdlib')] },
    ]);

    await service.startForUser('user-1');

    expect(clients.clientForSession).not.toHaveBeenCalled();
    expect(service.isStarted('user-1')).toBe(true);
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('Skipping mtcute updates for account acc-1'),
    );

    await service.stopForUser('user-1');
    debug.mockRestore();
  });

  it('subscribes mtcute sessions when the TDLib session is revoked', async () => {
    const { service, clients } = createService([
      {
        id: 'acc-2',
        sessions: [
          session('s-mtcute', 'mtcute'),
          session('s-td', 'tdlib', true),
        ],
      },
    ]);

    await service.startForUser('user-1');

    expect(clients.clientForSession).toHaveBeenCalledTimes(1);
    expect(clients.clientForSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-mtcute' }),
    );

    await service.stopForUser('user-1');
  });

  it('subscribes mtcute-only accounts as before', async () => {
    const { service, clients } = createService([
      { id: 'acc-3', sessions: [session('s-mtcute', 'mtcute')] },
    ]);

    await service.startForUser('user-1');

    expect(clients.clientForSession).toHaveBeenCalledTimes(1);

    await service.stopForUser('user-1');
  });
});
