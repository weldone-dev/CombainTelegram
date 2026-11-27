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
      emit: (value: unknown) => {
        for (const listener of [...listeners]) listener(value);
      },
    };
  };
  return {
    onNewMessage: emitter(),
    onEditMessage: emitter(),
    onDeleteMessage: emitter(),
    onRawUpdate: emitter(),
    getMessages: vi.fn(async () => [] as unknown[]),
    onHistoryRead: emitter(),
    onUserTyping: emitter(),
    startUpdatesLoop: vi.fn(async () => undefined),
    stopUpdatesLoop: vi.fn(async () => undefined),
  };
}

function createService(
  accounts: Array<{
    id: string;
    activeSessionId?: string | null;
    sessions: SessionRow[];
  }>,
) {
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
  return { service, clients, prisma, realtime };
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

  it('subscribes only the pinned mtcute session when that is the active one', async () => {
    const { service, clients } = createService([
      {
        id: 'acc-4',
        activeSessionId: 's-pinned',
        sessions: [session('s-pinned', 'mtcute'), session('s-td', 'tdlib')],
      },
    ]);

    await service.startForUser('user-1');

    expect(clients.clientForSession).toHaveBeenCalledTimes(1);
    expect(clients.clientForSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 's-pinned' }),
    );

    await service.stopForUser('user-1');
  });

  it('skips mtcute when the account pinned its TDLib session', async () => {
    const { service, clients } = createService([
      {
        id: 'acc-5',
        activeSessionId: 's-td',
        sessions: [session('s-mtcute', 'mtcute'), session('s-td', 'tdlib')],
      },
    ]);

    await service.startForUser('user-1');

    expect(clients.clientForSession).not.toHaveBeenCalled();

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

describe('UpdatesService — reactions on own messages (mtcute)', () => {
  function reactionUpdate(
    chatId: number,
    msgId: number,
    emoji = '❤',
  ): unknown {
    return {
      update: {
        _: 'updateMessageReactions',
        peer: { _: 'peerUser', userId: chatId },
        msgId,
        reactions: {
          recentReactions: [
            {
              _: 'messagePeerReaction',
              peerId: { _: 'peerUser', userId: 7 },
              reaction: { _: 'reactionEmoji', emoticon: emoji },
              date: 1_700_000_000,
              my: false,
            },
          ],
        },
      },
    };
  }

  it('an outgoing send is indexed and a reaction on it is targetIsMine', async () => {
    const { service, clients, realtime } = createService([
      { id: 'acc-r', sessions: [session('s-r', 'mtcute')] },
    ]);
    await service.startForUser('user-1');
    const client = (await clients.clientForSession.mock.results[0]!.value) as {
      onRawUpdate: { emit: (value: unknown) => void };
    };

    // This is what MessagingService does after every Nest/Eve send.
    service.noteOutgoing('acc-r', 42, 501, 'привет');

    client.onRawUpdate.emit(reactionUpdate(42, 501));

    await vi.waitFor(() => {
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'user-1',
        'message.reaction',
        expect.objectContaining({ targetIsMine: true, messageId: 501 }),
      );
    });

    await service.stopForUser('user-1');
  });

  it('a reaction on his message resolves to targetIsMine false', async () => {
    const { service, clients, realtime } = createService([
      { id: 'acc-r', sessions: [session('s-r', 'mtcute')] },
    ]);
    // Different account id keeps the two tests independent at the emit level.
    await service.startForUser('user-1');
    const client = (await clients.clientForSession.mock.results[0]!.value) as {
      onRawUpdate: { emit: (value: unknown) => void };
      getMessages: { mockResolvedValue: (value: unknown[]) => void };
    };
    client.getMessages.mockResolvedValue([
      { id: 502, isOutgoing: false, text: 'его сообщение', date: new Date(0) },
    ]);

    client.onRawUpdate.emit(reactionUpdate(42, 502, '🔥'));

    await vi.waitFor(() => {
      expect(realtime.emitToUser).toHaveBeenCalledWith(
        'user-1',
        'message.reaction',
        expect.objectContaining({ targetIsMine: false, messageId: 502 }),
      );
    });

    await service.stopForUser('user-1');
  });
});
