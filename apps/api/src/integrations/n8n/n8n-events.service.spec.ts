import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch as httpFetch } from 'undici';
import type { IntegrationEventModel } from '@repo/database';
import { setLogSink } from '../../logs/log-sink.js';
import { RealtimeService } from '../../realtime/realtime.service.js';
import { N8nEventsService } from './n8n-events.service.js';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn() };
});

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const WEBHOOK_URL = 'http://127.0.0.1:5678/webhook/combain-events';

function eventRow(
  overrides: Partial<IntegrationEventModel> = {},
): IntegrationEventModel {
  return {
    id: 'ev-1',
    userId: 'user-1',
    kind: 'message.new',
    accountId: 'acc-wf',
    chatId: BigInt(42),
    threadId: 0,
    payload: JSON.stringify({ text: 'hi' }),
    createdAt: new Date(NOW),
    deliveredAt: null,
    ...overrides,
  } as IntegrationEventModel;
}

function harness() {
  const rows: IntegrationEventModel[] = [];
  const prisma = {    integrationEvent: {
      findMany: vi.fn(
        async (query: {
          where: {
            userId: string;
            OR?: Array<{
              createdAt?: { gt?: Date } | Date;
              id?: { gt?: string };
            }>;
          };
          take?: number;
        }) => {
          let list = rows.filter((row) => row.userId === query.where.userId);
          if (query.where.OR) {
            const conditions = query.where.OR;
            list = list.filter((row) =>
              conditions.some((condition) => {
                const gt = condition.createdAt as { gt?: Date } | undefined;
                if (gt?.gt) return row.createdAt > gt.gt;
                if (condition.createdAt instanceof Date && condition.id?.gt) {
                  return (
                    row.createdAt.getTime() ===
                      condition.createdAt.getTime() &&
                    row.id > condition.id.gt
                  );
                }
                return false;
              }),
            );
          }
          list.sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() ||
              (a.id < b.id ? -1 : 1),
          );
          return list.slice(0, query.take ?? 50);
        },
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          rows.find(
            (row) => row.id === where.id && row.userId === where.userId,
          ) ?? null,
      ),
      create: vi.fn(
        async ({ data }: { data: Record<string, unknown> }) => {
          const row = eventRow({
            id: `ev-${rows.length + 1}`,
            userId: data.userId as string,
            kind: data.kind as string,
            accountId: (data.accountId as string | null) ?? null,
            chatId: (data.chatId as bigint | null) ?? null,
            threadId: (data.threadId as number) ?? 0,
            payload: data.payload as string,
            createdAt: new Date(NOW + rows.length * 1000),
          });
          rows.push(row);
          return row;
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: { in: string[] }; deliveredAt: null };
          data: { deliveredAt: Date };
        }) => {
          let count = 0;
          for (const row of rows) {
            if (where.id.in.includes(row.id) && row.deliveredAt === null) {
              row.deliveredAt = data.deliveredAt;
              count += 1;
            }
          }
          return { count };
        },
      ),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    telegramAccount: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'acc-wf'
          ? { workflowId: 'wf-1' }
          : { workflowId: null },
      ),
    },
  };

  const realtime = new RealtimeService();
  const account = {
    id: 'acc-wf',
    title: 'Роман Петров',
    firstName: 'Роман',
    lastName: 'Петров',
    username: 'roman',
    phone: '+15551234567',
    tgUserId: '9001',
    workflowId: 'wf-1',
    variables: { promo: 'spring' },
    soul: { name: 'Sales', mode: 'auto', temperature: 0.7 },
  };
  const chat = {
    id: 42,
    threadId: 0,
    title: 'Клиент',
    username: 'client',
    type: 'user',
    tags: ['vip'],
    access: { allowed: true, blocked: false, warnings: 0, reason: null },
  };
  const context = {
    account: vi.fn(async (accountId: string) =>
      accountId === 'acc-wf' ? account : null,
    ),
    chat: vi.fn(async () => chat),
    chatSettings: vi.fn(async () => ({})),
    invalidateChat: vi.fn(),
    invalidateAccount: vi.fn(),
  };
  const service = new N8nEventsService(
    prisma as never,
    realtime,
    context as never,
  );
  return { service, prisma, realtime, rows, context, account, chat };
}

/** Lets the serialised outbox chain run its writes. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Minimal undici Response stand-in for the webhook POST. */
function response(status: number): {
  status: number;
  text: () => Promise<string>;
} {
  return { status, text: async () => '' };
}

function pushInit(index = -1): {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: unknown;
  dispatcher?: unknown;
} {
  const calls = vi.mocked(httpFetch).mock.calls;
  const call = index < 0 ? calls.at(-1) : calls[index];
  return (call?.[1] ?? {}) as {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: unknown;
    dispatcher?: unknown;
  };
}

function emitMessage(h: ReturnType<typeof harness>, id = 777): void {
  h.realtime.emitToUser('user-1', 'message.new', {
    accountId: 'acc-wf',
    chatId: 42,
    message: { id, chatId: 42, text: 'Привет' },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(httpFetch).mockReset();
  // A stray N8N_* from the shell must not change these expectations.
  vi.stubEnv('N8N_WEBHOOK_URL', '');
  vi.stubEnv('N8N_WEBHOOK_TOKEN', '');
  vi.stubEnv('N8N_WEBHOOK_ENABLED', '');
  vi.stubEnv('N8N_ACTION_TOKEN', '');
});

describe('N8nEventsService read side', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('pages oldest-first with a cursor and marks rows delivered', async () => {
    const h = harness();
    h.rows.push(
      eventRow({ id: 'ev-1', createdAt: new Date(NOW) }),
      eventRow({ id: 'ev-2', createdAt: new Date(NOW + 1000) }),
      eventRow({ id: 'ev-3', createdAt: new Date(NOW + 2000) }),
    );

    const first = await h.service.list('user-1', { limit: 2 });
    expect(first.events.map((event) => event.id)).toEqual(['ev-1', 'ev-2']);
    expect(first.nextCursor).toBe('ev-2');
    expect(h.rows[0]?.deliveredAt).toBeInstanceOf(Date);

    const second = await h.service.list('user-1', {
      cursor: first.nextCursor ?? undefined,
      limit: 2,
    });
    expect(second.events.map((event) => event.id)).toEqual(['ev-3']);
    expect(second.nextCursor).toBe('ev-3');
    expect(h.rows[2]?.deliveredAt).toBeInstanceOf(Date);
  });

  it('enriches rows read back through GET /events', async () => {
    const h = harness();
    h.rows.push(
      eventRow({
        id: 'ev-1',
        payload: JSON.stringify({
          messageId: 777,
          chatId: 42,
          threadId: 0,
          text: 'Привет',
          outgoing: true,
          senderId: 42,
          senderName: 'Роман',
          replyToId: 5,
          date: '2026-11-25T11:59:00.000Z',
          mediaType: 'voice',
          media: {
            kind: 'voice',
            mimeType: 'audio/ogg',
            fileName: null,
            size: 1200,
            emoji: null,
            downloadable: true,
          },
          transcript: 'hello',
          isVoice: true,
        }),
      }),
    );

    const page = await h.service.list('user-1', {});
    const [event] = page.events;
    expect(event?.account).toMatchObject({
      id: 'acc-wf',
      variables: { promo: 'spring' },
      soul: { name: 'Sales', mode: 'auto', temperature: 0.7 },
    });
    expect(event?.chat).toMatchObject({
      id: 42,
      tags: ['vip'],
      access: { allowed: true, blocked: false, warnings: 0, reason: null },
    });
    expect(event?.message).toEqual({
      id: 777,
      date: '2026-11-25T11:59:00.000Z',
      outgoing: true,
      senderId: 42,
      senderName: 'Роман',
      text: 'Привет',
      transcript: 'hello',
      mediaType: 'voice',
      media: {
        kind: 'voice',
        mimeType: 'audio/ogg',
        fileName: null,
        size: 1200,
        emoji: null,
      },
      isVoice: true,
      replyToId: 5,
    });
    // The old flat payload is untouched.
    expect(event?.payload).toMatchObject({ messageId: 777, text: 'Привет' });
    expect(h.context.account).toHaveBeenCalledWith('acc-wf');
    expect(h.context.chat).toHaveBeenCalledWith('user-1', 'acc-wf', 42, 0);
  });

  it('returns an empty page when nothing is new', async () => {
    const h = harness();
    h.rows.push(eventRow({ id: 'ev-1' }));
    const page = await h.service.list('user-1', { cursor: 'ev-1' });
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBe('ev-1');
  });

  it('long-polls until an event appears', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.service.list('user-1', { waitMs: 1500 });

    await vi.advanceTimersByTimeAsync(300);
    expect(h.prisma.integrationEvent.findMany).toHaveBeenCalled();
    h.rows.push(eventRow({ id: 'ev-9', createdAt: new Date(NOW) }));
    await vi.advanceTimersByTimeAsync(300);

    const page = await pending;
    expect(page.events.map((event) => event.id)).toEqual(['ev-9']);
  });

  it('gives up after the wait budget', async () => {
    vi.useFakeTimers();
    const h = harness();
    const pending = h.service.list('user-1', { waitMs: 300 });
    await vi.advanceTimersByTimeAsync(400);
    const page = await pending;
    expect(page.events).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});

describe('N8nEventsService outbox', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('skips accounts without a workflow', async () => {
    const h = harness();
    h.service.onModuleInit();
    h.realtime.emitToUser('user-1', 'message.new', {
      accountId: 'acc-plain',
      chatId: 43,
      message: { id: 1, text: 'ignored', chatId: 43 },
    });
    await flush();
    expect(h.prisma.integrationEvent.create).not.toHaveBeenCalled();
    h.service.onModuleDestroy();
  });

  it('records message.new for a workflow account with a payload minus media', async () => {
    const h = harness();
    h.service.onModuleInit();
    h.realtime.emitToUser('user-1', 'message.new', {
      accountId: 'acc-wf',
      chatId: 42,
      message: {
        id: 777,
        chatId: 42,
        text: 'Привет',
        date: '2026-11-25T12:00:00.000Z',
        outgoing: false,
        edited: false,
        senderId: 42,
        senderName: 'Роман',
        replyToId: null,
        mediaType: 'photo',
        media: {
          kind: 'photo',
          mimeType: 'image/jpeg',
          fileName: null,
          size: 1024,
          downloadable: true,
        },
        reactions: [],
        poll: null,
        isVoice: false,
        thread: null,
      },
    });
    await flush();
    expect(h.prisma.integrationEvent.create).toHaveBeenCalledTimes(1);
    const data = h.prisma.integrationEvent.create.mock.calls[0]?.[0] as {
      data: {
        kind: string;
        accountId: string;
        chatId: bigint;
        payload: string;
      };
    };
    expect(data.data.kind).toBe('message.new');
    expect(data.data.accountId).toBe('acc-wf');
    expect(data.data.chatId).toBe(BigInt(42));
    const payload = JSON.parse(data.data.payload) as Record<string, unknown>;
    expect(payload).toMatchObject({
      messageId: 777,
      chatId: 42,
      text: 'Привет',
      mediaType: 'photo',
      outgoing: false,
      senderName: 'Роман',
      transcript: null,
    });
    expect(payload).not.toHaveProperty('data');
    h.service.onModuleDestroy();
  });

  it('records message.edited and message.deleted without media bytes', async () => {
    const h = harness();
    h.service.onModuleInit();
    h.realtime.emitToUser('user-1', 'message.edited', {
      accountId: 'acc-wf',
      chatId: 42,
      message: { id: 800, chatId: 42, text: 'fixed', edited: true },
    });
    h.realtime.emitToUser('user-1', 'message.deleted', {
      accountId: 'acc-wf',
      chatId: 42,
      messageIds: [800, 801],
    });
    await flush();
    const calls = h.prisma.integrationEvent.create.mock.calls.map(
      (call) => call[0] as { data: { kind: string; payload: string } },
    );
    expect(calls.map((call) => call.data.kind)).toEqual([
      'message.edited',
      'message.deleted',
    ]);
    expect(JSON.parse(calls[0]?.data.payload ?? '{}')).toMatchObject({
      messageId: 800,
      text: 'fixed',
      edited: true,
    });
    expect(JSON.parse(calls[1]?.data.payload ?? '{}')).toEqual({
      chatId: 42,
      messageIds: [800, 801],
    });
    h.service.onModuleDestroy();
  });

  it('maps access changes to access.changed and block.changed', async () => {
    const h = harness();
    h.service.onModuleInit();
    h.realtime.emitToUser('user-1', 'access.changed', {
      accountId: 'acc-wf',
      chatId: 42,
      threadId: 0,
      action: 'access',
      actor: 'user',
      warnings: 0,
    });
    h.realtime.emitToUser('user-1', 'access.changed', {
      accountId: 'acc-wf',
      chatId: 42,
      threadId: 0,
      action: 'block',
      reason: 'spam',
      actor: 'user',
      warnings: 1,
    });
    await flush();
    const kinds = h.prisma.integrationEvent.create.mock.calls.map(
      (call) => (call[0] as { data: { kind: string } }).data.kind,
    );
    expect(kinds).toEqual(['access.changed', 'block.changed']);
    h.service.onModuleDestroy();
  });

  it('emits for every account when N8N_EVENTS_ALL is on', async () => {
    vi.stubEnv('N8N_EVENTS_ALL', '1');
    const h = harness();
    h.service.onModuleInit();
    h.realtime.emitToUser('user-1', 'message.read', {
      accountId: 'acc-plain',
      chatId: 43,
      maxId: 10,
      outbox: false,
      unread: 0,
    });
    await flush();
    expect(h.prisma.integrationEvent.create).toHaveBeenCalledTimes(1);
    h.service.onModuleDestroy();
  });

  it('prunes delivered rows past the retention window', async () => {
    const h = harness();
    await h.service.pruneDelivered(NOW);
    expect(h.prisma.integrationEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        deliveredAt: {
          not: null,
          lt: new Date(NOW - 7 * 24 * 60 * 60 * 1000),
        },
      },
    });
  });
});

describe('N8nEventsService webhook push', () => {
  it('POSTs one event for a workflow account with account/chat/message blocks', async () => {
    vi.stubEnv('N8N_WEBHOOK_URL', WEBHOOK_URL);
    vi.stubEnv('N8N_WEBHOOK_TOKEN', 'hook-secret');
    vi.mocked(httpFetch).mockResolvedValue(response(200) as never);
    const h = harness();
    h.service.onModuleInit();
    emitMessage(h);
    await flush();
    await flush();

    expect(httpFetch).toHaveBeenCalledTimes(1);
    const [url] = vi.mocked(httpFetch).mock.calls[0] ?? [];
    expect(url).toBe(WEBHOOK_URL);

    const init = pushInit();
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'x-combain-token': 'hook-secret',
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // 127.0.0.1 must bypass the workstation proxy, like the n8n API client.
    expect(init.dispatcher).toBeTruthy();

    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      'account',
      'accountId',
      'chat',
      'chatId',
      'createdAt',
      'id',
      'kind',
      'message',
      'payload',
      'threadId',
    ]);
    expect(body).toMatchObject({
      id: 'ev-1',
      kind: 'message.new',
      accountId: 'acc-wf',
      chatId: 42,
      threadId: 0,
    });
    expect(body.payload).toMatchObject({ messageId: 777, text: 'Привет' });
    // Backward compatibility: the flat payload keeps the old keys.
    expect(body.payload).toHaveProperty('mediaType');
    expect(body.payload).toHaveProperty('senderName');
    expect(body.account).toEqual({
      id: 'acc-wf',
      title: 'Роман Петров',
      firstName: 'Роман',
      lastName: 'Петров',
      username: 'roman',
      phone: '+15551234567',
      tgUserId: '9001',
      workflowId: 'wf-1',
      variables: { promo: 'spring' },
      soul: { name: 'Sales', mode: 'auto', temperature: 0.7 },
    });
    expect(body.chat).toEqual({
      id: 42,
      threadId: 0,
      title: 'Клиент',
      username: 'client',
      type: 'user',
      tags: ['vip'],
      access: { allowed: true, blocked: false, warnings: 0, reason: null },
    });
    expect(body.message).toEqual({
      id: 777,
      date: null,
      outgoing: false,
      senderId: null,
      senderName: '',
      text: 'Привет',
      transcript: null,
      mediaType: null,
      media: null,
      isVoice: false,
      replyToId: null,
    });
    expect(h.rows[0]?.deliveredAt).toBeInstanceOf(Date);
    h.service.onModuleDestroy();
  });

  it('enriches the pushed event with media metadata but never bytes', async () => {
    vi.stubEnv('N8N_WEBHOOK_URL', WEBHOOK_URL);
    vi.mocked(httpFetch).mockResolvedValue(response(200) as never);
    const h = harness();
    h.service.onModuleInit();
    h.realtime.emitToUser('user-1', 'message.new', {
      accountId: 'acc-wf',
      chatId: 42,
      message: {
        id: 900,
        chatId: 42,
        text: '',
        mediaType: 'sticker',
        isVoice: false,
        media: {
          kind: 'sticker',
          mimeType: 'image/webp',
          fileName: 'sticker.webp',
          size: 2048,
          emoji: '🔥',
          downloadable: true,
          // A stray field must never leak into the event.
          data: Buffer.from('bytes'),
        },
      },
    });
    await flush();
    await flush();

    const body = JSON.parse(pushInit().body ?? '{}') as {
      message: Record<string, unknown>;
      payload: Record<string, unknown>;
    };
    expect(body.message).toMatchObject({
      id: 900,
      mediaType: 'sticker',
      media: {
        kind: 'sticker',
        mimeType: 'image/webp',
        fileName: 'sticker.webp',
        size: 2048,
        emoji: '🔥',
      },
    });
    expect(JSON.stringify(body)).not.toContain('"data"');
    expect(JSON.stringify(body)).not.toContain('bytes');
    expect(body.payload.media).not.toHaveProperty('data');
    h.service.onModuleDestroy();
  });

  it('falls back to N8N_ACTION_TOKEN when no webhook token is set', async () => {
    vi.stubEnv('N8N_WEBHOOK_URL', WEBHOOK_URL);
    vi.stubEnv('N8N_ACTION_TOKEN', 'action-secret');
    vi.mocked(httpFetch).mockResolvedValue(response(204) as never);
    const h = harness();
    h.service.onModuleInit();
    emitMessage(h);
    await flush();
    await flush();
    expect(pushInit().headers?.['x-combain-token']).toBe('action-secret');
    expect(h.rows[0]?.deliveredAt).toBeInstanceOf(Date);
    h.service.onModuleDestroy();
  });

  it('does not push for accounts without a workflow', async () => {
    vi.stubEnv('N8N_WEBHOOK_URL', WEBHOOK_URL);
    const h = harness();
    h.service.onModuleInit();
    h.realtime.emitToUser('user-1', 'message.new', {
      accountId: 'acc-plain',
      chatId: 43,
      message: { id: 1, text: 'ignored', chatId: 43 },
    });
    await flush();
    expect(h.prisma.integrationEvent.create).not.toHaveBeenCalled();
    expect(httpFetch).not.toHaveBeenCalled();
    h.service.onModuleDestroy();
  });

  it('pushes access and block changes too', async () => {
    vi.stubEnv('N8N_WEBHOOK_URL', WEBHOOK_URL);
    vi.mocked(httpFetch).mockResolvedValue(response(200) as never);
    const h = harness();
    h.service.onModuleInit();
    h.realtime.emitToUser('user-1', 'access.changed', {
      accountId: 'acc-wf',
      chatId: 42,
      threadId: 0,
      action: 'block',
      reason: 'spam',
      actor: 'user',
      warnings: 1,
    });
    await flush();
    await flush();
    expect(httpFetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(pushInit().body ?? '{}') as {
      kind: string;
      payload: Record<string, unknown>;
      account: unknown;
      chat: unknown;
      message?: unknown;
    };
    expect(body.kind).toBe('block.changed');
    expect(body.payload).toMatchObject({ action: 'block', reason: 'spam' });
    // Enrichment is there, but only message events carry a message block.
    expect(body.account).toMatchObject({ id: 'acc-wf' });
    expect(body.chat).toMatchObject({ id: 42, tags: ['vip'] });
    expect(body).not.toHaveProperty('message');
    // The access row just changed: the cached chat context must be dropped.
    expect(h.context.invalidateChat).toHaveBeenCalledWith('acc-wf', 42);
    h.service.onModuleDestroy();
  });

  it('keeps a null account and missing soul while still pushing', async () => {
    vi.stubEnv('N8N_WEBHOOK_URL', WEBHOOK_URL);
    vi.mocked(httpFetch).mockResolvedValue(response(200) as never);
    const h = harness();
    h.context.account.mockResolvedValue({
      ...h.account,
      variables: {},
      soul: null,
    } as never);
    h.context.chat.mockResolvedValue({
      ...h.chat,
      tags: [],
      access: { allowed: false, blocked: false, warnings: 0, reason: null },
    } as never);
    h.service.onModuleInit();
    emitMessage(h);
    await flush();
    await flush();

    const body = JSON.parse(pushInit().body ?? '{}') as {
      account: { soul: unknown; variables: unknown };
      chat: { tags: unknown; access: unknown };
    };
    expect(body.account.soul).toBeNull();
    expect(body.account.variables).toEqual({});
    expect(body.chat.tags).toEqual([]);
    expect(body.chat.access).toEqual({
      allowed: false,
      blocked: false,
      warnings: 0,
      reason: null,
    });
    h.service.onModuleDestroy();
  });

  it('retries a 500 and marks the row delivered when the retry succeeds', async () => {
    vi.useFakeTimers();
    vi.stubEnv('N8N_WEBHOOK_URL', WEBHOOK_URL);
    vi.mocked(httpFetch)
      .mockResolvedValueOnce(response(500) as never)
      .mockResolvedValueOnce(response(200) as never);
    const h = harness();
    h.service.onModuleInit();
    emitMessage(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(httpFetch).toHaveBeenCalledTimes(1);
    expect(h.rows[0]?.deliveredAt).toBeNull();

    await vi.advanceTimersByTimeAsync(250);
    expect(httpFetch).toHaveBeenCalledTimes(2);
    expect(h.rows[0]?.deliveredAt).toBeInstanceOf(Date);
    h.service.onModuleDestroy();
  });

  it('leaves the row undelivered after three failed attempts and warns', async () => {
    vi.useFakeTimers();
    vi.stubEnv('N8N_WEBHOOK_URL', WEBHOOK_URL);
    vi.mocked(httpFetch).mockResolvedValue(response(500) as never);
    const entries: Array<Record<string, unknown>> = [];
    setLogSink((entry) => entries.push(entry as unknown as Record<string, unknown>));

    const h = harness();
    h.service.onModuleInit();
    emitMessage(h);
    await vi.advanceTimersByTimeAsync(1_500);

    expect(httpFetch).toHaveBeenCalledTimes(3);
    expect(h.rows[0]?.deliveredAt).toBeNull();
    const failure = entries.find(
      (entry) => entry.action === 'n8n.event.push' && entry.status === 'failed',
    );
    expect(failure).toMatchObject({
      level: 'warn',
      errorCode: undefined,
      details: { kind: 'message.new', status: 500, attempts: 3 },
    });
    expect(JSON.stringify(failure)).not.toContain('Привет');
    setLogSink(null);
    h.service.onModuleDestroy();
  });

  it('does not push when N8N_WEBHOOK_ENABLED turns the URL off', async () => {
    vi.stubEnv('N8N_WEBHOOK_URL', WEBHOOK_URL);
    vi.stubEnv('N8N_WEBHOOK_ENABLED', '0');
    const h = harness();
    h.service.onModuleInit();
    emitMessage(h);
    await flush();
    expect(h.prisma.integrationEvent.create).toHaveBeenCalledTimes(1);
    expect(httpFetch).not.toHaveBeenCalled();
    h.service.onModuleDestroy();
  });
});
