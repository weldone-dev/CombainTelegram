import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeEvent } from '../realtime/realtime.service.js';
import { EveEventsService } from './eve-events.service.js';
import type { EveEventView } from './eve-events.service.js';

const ACCOUNT = 'account-1';
const PERSONA = 'persona-1';
const CHAT = 1830539716;
const NOW = new Date('2026-11-27T10:00:00.000Z');

beforeEach(() => {
  delete process.env.EVE_WEBHOOK_URL;
  delete process.env.EVE_ENABLED;
  delete process.env.EVE_TOKEN;
});

afterEach(() => {
  delete process.env.EVE_WEBHOOK_URL;
  delete process.env.EVE_ENABLED;
  delete process.env.EVE_TOKEN;
  vi.unstubAllGlobals();
});

interface EventRow {
  id: string;
  kind: string;
  personaId: string | null;
  accountId: string | null;
  chatId: bigint | null;
  threadId: number;
  payload: string;
  createdAt: Date;
  deliveredAt: Date | null;
}

function harness(
  options: {
    allowedChat?: boolean;
    /** Shared across two harnesses to model a process restart. */
    dedupeStore?: Set<string>;
  } = {},
) {
  const subject = new Subject<RealtimeEvent>();
  const allowedChat = options.allowedChat ?? false;
  const dedupeStore = options.dedupeStore ?? new Set<string>();
  let sequence = 0;
  const prisma = {
    eveEventDedupe: {
      create: vi.fn(async ({ data }: { data: { key: string } }) => {
        if (dedupeStore.has(data.key)) {
          throw Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
          });
        }
        dedupeStore.add(data.key);
        return { key: data.key, createdAt: NOW };
      }),
      delete: vi.fn(async ({ where }: { where: { key: string } }) => {
        dedupeStore.delete(where.key);
        return { key: where.key, createdAt: NOW };
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findUnique: vi.fn(
        async ({ where }: { where: { key: string } }) =>
          dedupeStore.has(where.key)
            ? { key: where.key, createdAt: NOW }
            : null,
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { key: string };
          data: { createdAt: Date };
        }) => ({ key: where.key, createdAt: data.createdAt }),
      ),
    },
    evePersonaAccount: {
      findFirst: vi.fn(
        async ({ where }: { where: { accountId: string; enabled: boolean } }) =>
          where.accountId === ACCOUNT && where.enabled
            ? { personaId: PERSONA }
            : null,
      ),
    },
    eveChatBinding: {
      findUnique: vi.fn(
        async ({ where }: { where: { personaId_accountId_chatId_threadId: { chatId: bigint } } }) =>
          where.personaId_accountId_chatId_threadId.chatId === BigInt(CHAT) &&
          allowedChat
            ? { allowed: true }
            : null,
      ),
    },
    eveEvent: {
      create: vi.fn(
        async ({ data }: { data: Omit<EventRow, 'id' | 'createdAt' | 'deliveredAt'> }) => {
          const row: EventRow = {
            id: `evt-${++sequence}`,
            createdAt: NOW,
            deliveredAt: null,
            ...data,
          };
          return row;
        },
      ),
      findMany: vi.fn(async (): Promise<EventRow[]> => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: { deliveredAt: Date };
        }) => ({ id: where.id, deliveredAt: data.deliveredAt }),
      ),
    },
  };
  const gateway = { broadcast: vi.fn() };
  const realtime = { events$: subject.asObservable() };
  const delayed = {
    supersedePendingTurns: vi.fn(async () => [] as Array<{ id: number; text: string }>),
  };

  const service = new EveEventsService(
    prisma as never,
    realtime as never,
    gateway as never,
    delayed as never,
  );

  return { service, prisma, gateway, subject, delayed };
}

function payloadOf(
  prisma: ReturnType<typeof harness>['prisma'],
): Record<string, unknown> {
  const call = prisma.eveEvent.create.mock.calls[0] as
    | [{ data: { payload: string } }]
    | undefined;
  expect(call).toBeDefined();
  return JSON.parse(call![0].data.payload) as Record<string, unknown>;
}

describe('EveEventsService recording', () => {
  it('records a message for an enabled persona binding', async () => {
    const { service, prisma, gateway } = harness({ allowedChat: true });

    await service.record('message.new', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      message: { id: 77, text: 'hello', outgoing: false },
    });

    expect(prisma.eveEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'message.new',
        personaId: PERSONA,
        accountId: ACCOUNT,
        chatId: BigInt(CHAT),
        threadId: 0,
      }),
    });
    expect(payloadOf(prisma)).toMatchObject({
      allowed: true,
      dedupeKey: `message.new:${ACCOUNT}:${CHAT}:0:77`,
    });
    expect(gateway.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: true, chatId: String(CHAT) }),
    );
  });

  it('marks an event from a chat outside the allowlist as not allowed', async () => {
    const { service, prisma } = harness({ allowedChat: false });

    await service.record('message.new', {
      accountId: ACCOUNT,
      chatId: CHAT,
      message: { id: 78, text: 'hi', outgoing: false },
    });

    expect(payloadOf(prisma)).toMatchObject({ allowed: false });
  });

  it('survives a deleted chat (chatId: null) and drops it from the allowlist', async () => {
    const { service, prisma, gateway } = harness({ allowedChat: true });

    await expect(
      service.record('message.deleted', {
        accountId: ACCOUNT,
        chatId: null,
        threadId: 0,
        messageIds: [1, 2],
      }),
    ).resolves.toBeUndefined();

    const data = prisma.eveEvent.create.mock.calls[0]?.[0].data as {
      chatId: bigint | null;
    };
    expect(data.chatId).toBeNull();
    expect(payloadOf(prisma)).toMatchObject({
      allowed: false,
      dedupeKey: null,
    });
    expect(gateway.broadcast).toHaveBeenCalled();
  });

  it('treats an unparseable chatId as deleted instead of throwing', async () => {
    const { service, prisma } = harness();

    await expect(
      service.record('message.new', {
        accountId: ACCOUNT,
        chatId: 'not-a-chat',
        message: { id: 5, outgoing: false },
      }),
    ).resolves.toBeUndefined();

    const data = prisma.eveEvent.create.mock.calls[0]?.[0].data as {
      chatId: bigint | null;
    };
    expect(data.chatId).toBeNull();
  });

  it('ignores events without a bound account', async () => {
    const { service, prisma, gateway } = harness();

    await service.record('message.new', {
      accountId: 'unknown-account',
      chatId: CHAT,
    });

    expect(prisma.eveEvent.create).not.toHaveBeenCalled();
    expect(gateway.broadcast).not.toHaveBeenCalled();
  });

  it('records a reaction with its own dedupe key', async () => {
    const { service, prisma, gateway } = harness({ allowedChat: true });

    await service.record('message.reaction', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      messageId: 77,
      emoji: '❤',
      fromId: 555,
      outgoing: false,
      targetIsMine: true,
      date: 1_700_000_000,
    });

    expect(prisma.eveEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        kind: 'message.reaction',
        personaId: PERSONA,
        accountId: ACCOUNT,
        chatId: BigInt(CHAT),
      }),
    });
    expect(payloadOf(prisma)).toMatchObject({
      allowed: true,
      messageId: 77,
      emoji: '❤',
      fromId: 555,
      outgoing: false,
      targetIsMine: true,
      dedupeKey: `message.reaction:${ACCOUNT}:${CHAT}:0:77:❤:555:1700000000`,
    });
    expect(gateway.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'message.reaction', allowed: true }),
    );
  });

  it('does not duplicate a replayed reaction row', async () => {
    const { service, prisma } = harness({ allowedChat: true });
    const payload = {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      messageId: 77,
      emoji: '🔥',
      fromId: 555,
      outgoing: false,
      targetIsMine: true,
      date: 1_700_000_000,
    };

    await service.record('message.reaction', payload);
    await service.record('message.reaction', { ...payload });

    expect(prisma.eveEvent.create).toHaveBeenCalledTimes(1);
  });

  it('drops a reaction the persona sent', async () => {
    const { service, prisma } = harness({ allowedChat: true });

    await service.record('message.reaction', {
      accountId: ACCOUNT,
      chatId: CHAT,
      messageId: 77,
      emoji: '👍',
      fromId: 555,
      outgoing: true,
      date: 1_700_000_000,
    });

    expect(prisma.eveEvent.create).not.toHaveBeenCalled();
  });

  it('drops a reaction in a group or channel', async () => {
    const { service, prisma } = harness({ allowedChat: true });

    await service.record('message.reaction', {
      accountId: ACCOUNT,
      chatId: -100123,
      messageId: 77,
      emoji: '👍',
      fromId: 555,
      outgoing: false,
      date: 1_700_000_000,
    });

    expect(prisma.eveEvent.create).not.toHaveBeenCalled();
  });

  it('keeps the delete payload (ids + outgoing) intact', async () => {
    const { service, prisma } = harness({ allowedChat: true });

    await service.record('message.deleted', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      messageIds: [1, 2],
      outgoing: false,
    });

    expect(payloadOf(prisma)).toMatchObject({
      allowed: true,
      messageIds: [1, 2],
      outgoing: false,
      dedupeKey: expect.stringMatching(
        new RegExp(`^message\\.deleted:${ACCOUNT}:${CHAT}:0:window:\\d+$`),
      ),
    });
  });

  it('keeps the dedupe claim across a restart (durable table)', async () => {
    const dedupeStore = new Set<string>();
    const payload = {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      messageId: 77,
      emoji: '🔥',
      fromId: 555,
      outgoing: false,
      targetIsMine: true,
      date: 1_700_000_000,
    };

    const first = harness({ allowedChat: true, dedupeStore });
    await first.service.record('message.reaction', payload);
    expect(first.prisma.eveEvent.create).toHaveBeenCalledTimes(1);

    // A fresh service = a restarted Nest process: the in-memory `recentKeys`
    // map is empty, only the DB row remains.
    const second = harness({ allowedChat: true, dedupeStore });
    await second.service.record('message.reaction', { ...payload });
    expect(second.prisma.eveEvent.create).not.toHaveBeenCalled();
  });

  it('records a replayed deletion once, even after a restart', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-27T07:00:00.000Z'));
      const dedupeStore = new Set<string>();
      const payload = {
        accountId: ACCOUNT,
        chatId: CHAT,
        threadId: 0,
        messageIds: [801, 802],
        messages: [
          {
            id: 801,
            outgoing: false,
            text: 'секрет',
            date: new Date(Date.now() - 60_000).toISOString(),
          },
          {
            id: 802,
            outgoing: false,
            text: 'ещё',
            date: new Date(Date.now() - 60_000).toISOString(),
          },
        ],
        outgoing: false,
      };

      const first = harness({ allowedChat: true, dedupeStore });
      await first.service.record('message.deleted', payload);
      expect(first.prisma.eveEvent.create).toHaveBeenCalledTimes(1);

      const second = harness({ allowedChat: true, dedupeStore });
      await second.service.record('message.deleted', { ...payload });
      expect(second.prisma.eveEvent.create).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a bulk history cleanup instead of commenting on every id', async () => {
    const { service, prisma } = harness({ allowedChat: true });
    const now = Date.now();
    const messages = Array.from({ length: 39 }, (_value, index) => ({
      id: 800 + index,
      outgoing: false,
      text: `old ${index}`,
      date: new Date(now - 60_000).toISOString(),
    }));

    await service.record('message.deleted', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      messageIds: messages.map((entry) => entry.id),
      messages,
      outgoing: false,
    });

    expect(prisma.eveEvent.create).not.toHaveBeenCalled();
  });

  it('ignores a deletion of a message older than ten minutes', async () => {
    const { service, prisma } = harness({ allowedChat: true });
    const now = Date.now();

    await service.record('message.deleted', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      messageIds: [901],
      messages: [
        {
          id: 901,
          outgoing: false,
          text: 'старое',
          date: new Date(now - 20 * 60_000).toISOString(),
        },
      ],
      outgoing: false,
    });

    expect(prisma.eveEvent.create).not.toHaveBeenCalled();
  });

  it('ignores a deletion whose author is unknown', async () => {
    const { service, prisma } = harness({ allowedChat: true });

    await service.record('message.deleted', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      messageIds: [902],
      messages: [{ id: 902, text: 'кто-то удалил' }],
    });

    expect(prisma.eveEvent.create).not.toHaveBeenCalled();
  });

  it('collapses three growing delete lists inside one window into one event', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-27T07:00:00.000Z'));
      const { service, prisma } = harness({ allowedChat: true });
      const date = new Date(Date.now() - 30_000).toISOString();

      for (const ids of [[801, 802], [801, 802, 803], [801, 802, 803, 804]]) {
        await service.record('message.deleted', {
          accountId: ACCOUNT,
          chatId: CHAT,
          threadId: 0,
          messageIds: ids,
          messages: ids.map((id) => ({ id, outgoing: false, date })),
          outgoing: false,
        });
      }

      expect(prisma.eveEvent.create).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('supersedes a pending turn and attaches its text to the new event', async () => {
    const { service, prisma, delayed, gateway } = harness({ allowedChat: true });
    delayed.supersedePendingTurns.mockResolvedValueOnce([
      { id: 11, text: 'первое сообщение' },
    ]);

    await service.record('message.new', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      message: { id: 12, text: 'второе сообщение', outgoing: false },
    });

    expect(delayed.supersedePendingTurns).toHaveBeenCalledWith({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: BigInt(CHAT),
      threadId: 0,
    });
    expect(prisma.eveEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: {
        payload: expect.stringContaining('"supersededBurst"'),
      },
    });
    // The push/broadcast view carries the dropped text so Eve can answer it.
    const view = gateway.broadcast.mock.calls[0]?.[0] as {
      payload: Record<string, unknown>;
    };
    expect(view.payload).toMatchObject({
      supersededBurst: [{ id: 11, text: 'первое сообщение' }],
      message: { id: 12, text: 'второе сообщение', outgoing: false },
    });
  });

  it('does not call supersede for an outgoing or not-allowed message', async () => {
    const { service, delayed } = harness({ allowedChat: false });

    await service.record('message.new', {
      accountId: ACCOUNT,
      chatId: CHAT,
      message: { id: 12, text: 'hi' },
    });
    await service.record('message.new', {
      accountId: ACCOUNT,
      chatId: CHAT,
      message: { id: 13, text: 'sent', outgoing: true },
    });

    expect(delayed.supersedePendingTurns).not.toHaveBeenCalled();
  });

  it('subscribes to the realtime bus and records known kinds only', async () => {
    const { service, prisma, subject } = harness({ allowedChat: true });
    service.onModuleInit();

    subject.next({
      userId: 'local',
      event: 'ai.thinking',
      payload: { accountId: ACCOUNT, chatId: CHAT },
    });
    subject.next({
      userId: 'local',
      event: 'message.new',
      payload: { accountId: ACCOUNT, chatId: CHAT, message: { id: 9, outgoing: false } },
    });

    await vi.waitFor(() => {
      expect(prisma.eveEvent.create).toHaveBeenCalledTimes(1);
    });

    service.onModuleDestroy();
  });
});

describe('EveEventsService listing', () => {
  it('uses a stable createdAt+id cursor and a deterministic order', async () => {
    const { service, prisma } = harness();
    prisma.eveEvent.findMany.mockResolvedValueOnce([
      {
        id: 'evt-2',
        kind: 'message.new',
        personaId: PERSONA,
        accountId: ACCOUNT,
        chatId: BigInt(CHAT),
        threadId: 0,
        payload: JSON.stringify({ allowed: true, dedupeKey: 'k' }),
        createdAt: NOW,
        deliveredAt: null,
      },
    ]);

    const result = await service.list(`${NOW.toISOString()}|evt-1`, '1');

    expect(prisma.eveEvent.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { createdAt: { gt: NOW } },
          { createdAt: NOW, id: { gt: 'evt-1' } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 1,
    });
    expect(result).toEqual({
      events: [
        expect.objectContaining({
          id: 'evt-2',
          allowed: true,
          dedupeKey: 'k',
          chatId: String(CHAT),
        }),
      ],
      nextCursor: `${NOW.toISOString()}|evt-2`,
      hasMore: true,
    });
    expect(prisma.eveEvent.updateMany).toHaveBeenCalled();
  });

  it('keeps accepting the legacy iso-only cursor', async () => {
    const { service, prisma } = harness();

    await service.list(NOW.toISOString(), undefined);

    expect(prisma.eveEvent.findMany).toHaveBeenCalledWith({
      where: { createdAt: { gt: NOW } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    });
  });

  it('rejects a malformed cursor with EVE_CURSOR_INVALID', async () => {
    const { service } = harness();

    await expect(service.list('not-a-date', '10')).rejects.toMatchObject({
      response: { code: 'EVE_CURSOR_INVALID' },
    });
  });

  it('does not fail the listing when delivery bookkeeping fails', async () => {
    const { service, prisma } = harness();
    prisma.eveEvent.findMany.mockResolvedValueOnce([
      {
        id: 'evt-3',
        kind: 'message.read',
        personaId: PERSONA,
        accountId: ACCOUNT,
        chatId: null,
        threadId: 0,
        payload: '{}',
        createdAt: NOW,
        deliveredAt: null,
      },
    ]);
    prisma.eveEvent.updateMany.mockRejectedValueOnce(new Error('db is busy'));

    await expect(service.list(undefined, '10')).resolves.toMatchObject({
      events: [expect.objectContaining({ id: 'evt-3', allowed: false })],
      nextCursor: `${NOW.toISOString()}|evt-3`,
    });
  });
});

function eventView(overrides: Partial<EveEventView> = {}): EveEventView {
  return {
    id: 'evt-1',
    kind: 'message.new',
    personaId: PERSONA,
    accountId: ACCOUNT,
    chatId: String(CHAT),
    threadId: 0,
    allowed: true,
    dedupeKey: `message.new:${ACCOUNT}:${CHAT}:0:1`,
    payload: { message: { id: 1, text: 'hi' } },
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('EveEventsService push', () => {
  it('posts an allowed event with the shared token and marks it delivered', async () => {
    process.env.EVE_WEBHOOK_URL = 'http://127.0.0.1:4020/eve/v1/nest/events';
    process.env.EVE_TOKEN = 'secret';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, prisma } = harness();

    await expect(
      service.pushEvent(eventView(), { attempts: 1, delaysMs: [] }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    expect(call[0]).toBe(process.env.EVE_WEBHOOK_URL);
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['x-eve-token']).toBe('secret');
    expect(JSON.parse(call[1].body)).toMatchObject({
      id: 'evt-1',
      allowed: true,
      chatId: String(CHAT),
      message: { id: 1, text: 'hi' },
      dedupeKey: `message.new:${ACCOUNT}:${CHAT}:0:1`,
    });
    expect(prisma.eveEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: { deliveredAt: expect.any(Date) },
    });
  });

  it('does not wake Eve for an allowed:false event', async () => {
    process.env.EVE_WEBHOOK_URL = 'http://127.0.0.1:4020/eve/v1/nest/events';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, prisma } = harness();

    await expect(
      service.pushEvent(eventView({ allowed: false })),
    ).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.eveEvent.update).not.toHaveBeenCalled();
  });

  it('leaves deliveredAt untouched when every attempt fails', async () => {
    process.env.EVE_WEBHOOK_URL = 'http://127.0.0.1:4020/eve/v1/nest/events';
    const fetchMock = vi.fn(async () => {
      throw new Error('connection refused');
    });
    vi.stubGlobal('fetch', fetchMock);
    const { service, prisma } = harness();

    await expect(
      service.pushEvent(eventView(), { attempts: 1, delaysMs: [] }),
    ).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(prisma.eveEvent.update).not.toHaveBeenCalled();
  });

  it('skips push entirely when EVE_WEBHOOK_URL is empty', async () => {
    process.env.EVE_WEBHOOK_URL = '';
    process.env.EVE_TOKEN = 'secret';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = harness();

    await expect(service.pushEvent(eventView())).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pushes a recorded allowed event asynchronously', async () => {
    process.env.EVE_WEBHOOK_URL = 'http://127.0.0.1:4020/eve/v1/nest/events';
    process.env.EVE_TOKEN = 'secret';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service, prisma } = harness({ allowedChat: true });

    await service.record('message.new', {
      accountId: ACCOUNT,
      chatId: CHAT,
      message: { id: 77, text: 'hello', outgoing: false },
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect(prisma.eveEvent.update).toHaveBeenCalledWith({
      where: { id: 'evt-1' },
      data: { deliveredAt: expect.any(Date) },
    });
  });

  it('pushes a recorded reaction, including its payload fields', async () => {
    process.env.EVE_WEBHOOK_URL = 'http://127.0.0.1:4020/eve/v1/nest/events';
    process.env.EVE_TOKEN = 'secret';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = harness({ allowedChat: true });

    await service.record('message.reaction', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      messageId: 77,
      emoji: '❤',
      fromId: 555,
      outgoing: false,
      targetIsMine: true,
      date: 1_700_000_000,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(call[1].body)).toMatchObject({
      kind: 'message.reaction',
      allowed: true,
      messageId: 77,
      emoji: '❤',
      fromId: 555,
      targetIsMine: true,
    });
  });

  it('pushes a recorded delete without dropping its messageIds', async () => {
    process.env.EVE_WEBHOOK_URL = 'http://127.0.0.1:4020/eve/v1/nest/events';
    process.env.EVE_TOKEN = 'secret';
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { service } = harness({ allowedChat: true });

    await service.record('message.deleted', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      messageIds: [4, 5],
      outgoing: false,
    });

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(JSON.parse(call[1].body)).toMatchObject({
      kind: 'message.deleted',
      messageIds: [4, 5],
      outgoing: false,
    });
  });

  it('never turns an outgoing message into a new Eve turn', async () => {
    const { service, prisma } = harness({ allowedChat: true });

    await service.record('message.new', {
      accountId: ACCOUNT,
      chatId: CHAT,
      message: { id: 78, text: 'sent by the persona', outgoing: true },
    });

    expect(prisma.eveEvent.create).not.toHaveBeenCalled();
  });
});
