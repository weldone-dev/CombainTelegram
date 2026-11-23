import { createServer } from 'node:http';
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelegramBotModel } from '@repo/database';
import { BotRunnerService } from './bot-runner.service.js';
import { TelegramBotApi } from './telegram-bot-api.js';
import type { BotApiUpdate } from './telegram-bot-api.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const TOKEN = '123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

function botRow(overrides: Partial<TelegramBotModel> = {}): TelegramBotModel {
  return {
    id: 'bot-1',
    accountId: null,
    username: 'soul_bot',
    title: 'Создатель душ',
    mode: 'soul-creator',
    enabled: true,
    tokenEncrypted: null,
    tokenNonce: null,
    tokenTag: null,
    tokenDekWrapped: null,
    tokenDekNonce: null,
    tokenDekTag: null,
    allowedUserIds: '[]',
    lastUpdateId: 0n,
    lastError: null,
    lastPolledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function messageUpdate(
  text: string,
  overrides: {
    chatId?: number;
    chatType?: string;
    senderId?: number;
    isBot?: boolean;
    updateId?: number;
  } = {},
): BotApiUpdate {
  const chatId = overrides.chatId ?? 7;
  return {
    update_id: overrides.updateId ?? 100,
    message: {
      message_id: 5,
      date: 1_700_000_000,
      chat: { id: chatId, type: overrides.chatType ?? 'private' },
      from: {
        id: overrides.senderId ?? chatId,
        is_bot: overrides.isBot ?? false,
        first_name: 'Owner',
      },
      text,
    },
  };
}

interface TurnRow {
  id: string;
  botId: string;
  chatId: bigint;
  role: string;
  content: string;
  createdAt: Date;
}

function createHarness() {
  const turns: TurnRow[] = [];
  let turnSequence = 0;

  const botTurn = {
    findMany: vi.fn(
      async (args: {
        where: { botId?: string; chatId?: bigint; id?: { in: string[] } };
        orderBy?: { createdAt: 'asc' | 'desc' };
        take?: number;
      }) => {
        let list = turns.filter((turn) => {
          if (args.where.botId && turn.botId !== args.where.botId) return false;
          if (args.where.chatId && turn.chatId !== args.where.chatId) {
            return false;
          }
          if (args.where.id && !args.where.id.in.includes(turn.id)) {
            return false;
          }
          return true;
        });
        const direction = args.orderBy?.createdAt ?? 'asc';
        list = list.slice().sort((a, b) => {
          const diff = a.createdAt.getTime() - b.createdAt.getTime();
          return direction === 'desc' ? -diff : diff;
        });
        return args.take ? list.slice(0, args.take) : list;
      },
    ),
    createMany: vi.fn(
      async (args: {
        data: Array<Omit<TurnRow, 'id' | 'createdAt'>>;
      }) => {
        for (const row of args.data) {
          turnSequence += 1;
          turns.push({
            ...row,
            id: `turn-${turnSequence}`,
            createdAt: new Date(NOW.getTime() + turnSequence),
          });
        }
        return { count: args.data.length };
      },
    ),
    count: vi.fn(
      async (args: { where: { botId: string; chatId: bigint } }) =>
        turns.filter(
          (turn) =>
            turn.botId === args.where.botId &&
            turn.chatId === args.where.chatId,
        ).length,
    ),
    deleteMany: vi.fn(
      async (args: {
        where: {
          botId?: string;
          chatId?: bigint;
          id?: { in: string[] };
        };
      }) => {
        let count = 0;
        for (let index = turns.length - 1; index >= 0; index -= 1) {
          const turn = turns[index];
          const matches =
            (args.where.botId === undefined ||
              turn.botId === args.where.botId) &&
            (args.where.chatId === undefined ||
              turn.chatId === args.where.chatId) &&
            (args.where.id === undefined ||
              args.where.id.in.includes(turn.id));
          if (matches) {
            turns.splice(index, 1);
            count += 1;
          }
        }
        return { count };
      },
    ),
  };

  const bots = {
    allowedTgUserIds: vi.fn(async () => [] as string[]),
    setPolling: vi.fn(async () => undefined),
    pollable: vi.fn(async () => []),
  };
  const users = { get: vi.fn(async () => ({ id: 'local' })) };
  const agent = {
    run: vi.fn(async () => ({ text: 'Ответ агента' })),
  };
  const skills = { forBot: vi.fn(async () => []) };

  const service = new BotRunnerService(
    { botTurn } as never,
    bots as never,
    users as never,
    agent as never,
    skills as never,
  );

  const api = {
    deleteWebhook: vi.fn(async () => true),
    getUpdates: vi.fn(async () => [] as BotApiUpdate[]),
    sendMessage: vi.fn(async () => ({ message_id: 1 })),
    sendChatAction: vi.fn(async () => true),
  };

  return { service, api, bots, users, agent, skills, turns, botTurn };
}

function chatOf(api: ReturnType<typeof createHarness>['api'], index = 0) {
  return api.sendMessage.mock.calls[index] as unknown as [number, string];
}

describe('BotRunnerService.handleUpdate', () => {
  it('answers /start and /help without calling the agent', async () => {
    const harness = createHarness();

    await harness.service.handleUpdate(
      botRow(),
      harness.api as unknown as TelegramBotApi,
      messageUpdate('/start'),
    );
    await harness.service.handleUpdate(
      botRow(),
      harness.api as unknown as TelegramBotApi,
      messageUpdate('/help'),
    );

    expect(harness.agent.run).not.toHaveBeenCalled();
    expect(harness.api.sendMessage).toHaveBeenCalledTimes(2);
    expect(chatOf(harness.api, 0)[0]).toBe(7);
    expect(chatOf(harness.api, 0)[1]).toContain('ИИ-ассистент');
    expect(chatOf(harness.api, 1)[1]).toContain('/reset');
    expect(harness.turns).toHaveLength(0);
  });

  it('returns the sender and chat ids for /id', async () => {
    const harness = createHarness();

    await harness.service.handleUpdate(
      botRow(),
      harness.api as unknown as TelegramBotApi,
      messageUpdate('/id', { chatId: -100, senderId: 42 }),
    );

    expect(harness.agent.run).not.toHaveBeenCalled();
    const [, text] = chatOf(harness.api);
    expect(text).toContain('user_id: 42');
    expect(text).toContain('chat_id: -100');
    expect(text).toContain('@soul_bot');
  });

  it('clears the dialogue buffer for /reset', async () => {
    const harness = createHarness();
    harness.turns.push({
      id: 'turn-old',
      botId: 'bot-1',
      chatId: 7n,
      role: 'user',
      content: 'old',
      createdAt: NOW,
    });

    await harness.service.handleUpdate(
      botRow(),
      harness.api as unknown as TelegramBotApi,
      messageUpdate('/reset'),
    );

    expect(harness.turns).toHaveLength(0);
    expect(chatOf(harness.api)[1]).toContain('Контекст диалога очищен');
    expect(harness.agent.run).not.toHaveBeenCalled();
  });

  it('denies an unauthorized sender without calling the agent', async () => {
    const harness = createHarness();
    harness.bots.allowedTgUserIds.mockResolvedValue(['42']);

    await harness.service.handleUpdate(
      botRow(),
      harness.api as unknown as TelegramBotApi,
      messageUpdate('привет', { senderId: 7 }),
    );

    expect(harness.agent.run).not.toHaveBeenCalled();
    expect(harness.api.sendMessage).toHaveBeenCalledTimes(1);
    expect(chatOf(harness.api)[1]).toContain('Ваш id: 7');
    expect(harness.turns).toHaveLength(0);
  });

  it('runs the shared bot as soul-creator and stores the turn', async () => {
    const harness = createHarness();

    await harness.service.handleUpdate(
      botRow(),
      harness.api as unknown as TelegramBotApi,
      messageUpdate('создай душу'),
    );

    expect(harness.agent.run).toHaveBeenCalledTimes(1);
    expect(harness.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'local',
        accountId: null,
        chatId: null,
        source: 'soul-creator',
        prompt: 'создай душу',
        history: [],
        skillSlugs: ['soul-creator'],
      }),
    );
    expect(harness.api.sendChatAction).toHaveBeenCalledWith(7);
    expect(chatOf(harness.api)).toEqual([7, 'Ответ агента']);
    expect(harness.botTurn.createMany).toHaveBeenCalledWith({
      data: [
        { botId: 'bot-1', chatId: 7n, role: 'user', content: 'создай душу' },
        {
          botId: 'bot-1',
          chatId: 7n,
          role: 'assistant',
          content: 'Ответ агента',
        },
      ],
    });
  });

  it('runs an account bot as source bot with its account id', async () => {
    const harness = createHarness();

    await harness.service.handleUpdate(
      botRow({
        id: 'bot-2',
        accountId: 'acc-1',
        mode: 'assistant',
        username: 'assistant_bot',
      }),
      harness.api as unknown as TelegramBotApi,
      messageUpdate('статус'),
    );

    expect(harness.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'acc-1',
        source: 'bot',
        skillSlugs: ['telegram-assistant'],
      }),
    );
    expect(chatOf(harness.api)).toEqual([7, 'Ответ агента']);
  });

  it('replays the stored history on the next message', async () => {
    const harness = createHarness();
    const api = harness.api as unknown as TelegramBotApi;
    const bot = botRow();

    await harness.service.handleUpdate(bot, api, messageUpdate('первое'));
    await harness.service.handleUpdate(bot, api, messageUpdate('второе'));

    expect(harness.agent.run).toHaveBeenLastCalledWith(
      expect.objectContaining({
        prompt: 'второе',
        history: [
          { role: 'user', content: 'первое' },
          { role: 'assistant', content: 'Ответ агента' },
        ],
      }),
    );
  });

  it('ignores group chats, other bots and messages without text', async () => {
    const harness = createHarness();
    const api = harness.api as unknown as TelegramBotApi;

    await harness.service.handleUpdate(
      botRow(),
      api,
      messageUpdate('группа', { chatType: 'group' }),
    );
    await harness.service.handleUpdate(
      botRow(),
      api,
      messageUpdate('бот', { isBot: true }),
    );
    await harness.service.handleUpdate(botRow(), api, {
      update_id: 101,
      message: {
        message_id: 6,
        date: 1_700_000_000,
        chat: { id: 7, type: 'private' },
        from: { id: 7 },
      },
    });

    expect(harness.agent.run).not.toHaveBeenCalled();
    expect(harness.api.sendMessage).not.toHaveBeenCalled();
  });

  it('reports agent failures back to the chat', async () => {
    const harness = createHarness();
    harness.agent.run.mockRejectedValue(new Error('LLM down'));

    await harness.service.handleUpdate(
      botRow(),
      harness.api as unknown as TelegramBotApi,
      messageUpdate('вопрос'),
    );

    expect(chatOf(harness.api)[1]).toContain('Не получилось: LLM down');
    expect(harness.turns).toHaveLength(0);
  });
});

describe('BotRunnerService loop', () => {
  let server: Server | undefined;
  const originalBase = process.env.TELEGRAM_BOT_API_BASE;

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    if (originalBase === undefined) {
      delete process.env.TELEGRAM_BOT_API_BASE;
    } else {
      process.env.TELEGRAM_BOT_API_BASE = originalBase;
    }
  });

  it('polls a fake Bot API, handles the update and stops on abort', async () => {
    let getUpdatesCalls = 0;
    const paths: string[] = [];
    server = createServer((request: IncomingMessage, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const method = (request.url ?? '').split('/').pop() ?? '';
        paths.push(method);
        const send = (body: unknown): void => {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify(body));
        };
        if (method === 'getUpdates') {
          getUpdatesCalls += 1;
          if (getUpdatesCalls === 1) {
            send({
              ok: true,
              result: [messageUpdate('привет', { updateId: 100 })],
            });
            return;
          }
          // Give the test time to abort instead of hammering the server.
          setTimeout(() => send({ ok: true, result: [] }), 25);
          return;
        }
        if (method === 'sendMessage') {
          send({ ok: true, result: { message_id: 2 } });
          return;
        }
        send({ ok: true, result: true });
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as AddressInfo;
    process.env.TELEGRAM_BOT_API_BASE = `http://127.0.0.1:${address.port}`;

    const harness = createHarness();
    const bot = botRow();
    const controller = new AbortController();
    const loop = (
      harness.service as unknown as {
        loop(
          bot: TelegramBotModel,
          token: string,
          signal: AbortSignal,
        ): Promise<void>;
      }
    ).loop(bot, TOKEN, controller.signal);

    await vi.waitFor(() => {
      expect(harness.agent.run).toHaveBeenCalledTimes(1);
    });

    controller.abort();
    await loop;

    expect(paths).toContain('deleteWebhook');
    expect(paths).toContain('getUpdates');
    expect(paths).toContain('sendChatAction');
    expect(paths).toContain('sendMessage');
    expect(harness.bots.setPolling).toHaveBeenCalledWith(bot.id, {
      lastUpdateId: 101n,
      lastError: null,
    });

    const settledCalls = getUpdatesCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(getUpdatesCalls).toBe(settledCalls);
  });

  it('aborts tracked loops and clears the supervisor on module destroy', () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      const controller = new AbortController();
      const internals = harness.service as unknown as {
        loops: Map<string, AbortController>;
        onModuleInit(): void;
        onModuleDestroy(): void;
      };
      internals.onModuleInit();
      internals.loops.set('bot-1', controller);
      expect(vi.getTimerCount()).toBe(1);

      internals.onModuleDestroy();

      expect(controller.signal.aborted).toBe(true);
      expect(internals.loops.size).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
