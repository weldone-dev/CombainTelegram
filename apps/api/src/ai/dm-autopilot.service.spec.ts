import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoulModel, TelegramAccountModel } from '@repo/database';
import type { MessageView } from '../messaging/message-view.js';
import type { RealtimeEvent } from '../realtime/realtime.service.js';
import { DEFAULT_SOUL_SETTINGS } from './ai.types.js';
import { DmAutopilotService } from './dm-autopilot.service.js';
import { SoulsService } from './souls.service.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');
const CHAT_ID = 42;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function message(overrides: Partial<MessageView> = {}): MessageView {
  return {
    id: 1001,
    chatId: CHAT_ID,
    text: 'Hi there',
    date: NOW.toISOString(),
    outgoing: false,
    edited: false,
    senderId: CHAT_ID,
    senderName: 'Peer',
    replyToId: null,
    mediaType: null,
    media: null,
    reactions: [],
    poll: null,
    isVoice: false,
    thread: null,
    ...overrides,
  };
}

function accountRow(
  overrides: Partial<TelegramAccountModel> = {},
): TelegramAccountModel {
  return {
    id: 'account-1',
    userId: 'user-1',
    tgUserId: BigInt('999'),
    firstName: 'Owner',
    ...overrides,
  } as unknown as TelegramAccountModel;
}

function soulRow(overrides: Partial<SoulModel> = {}): SoulModel {
  return {
    id: 'soul-1',
    accountId: 'account-1',
    name: 'Душа',
    essence: '',
    tone: '',
    goals: '',
    boundaries: '',
    language: 'ru',
    systemPrompt: null,
    mode: 'auto',
    settings: JSON.stringify({
      ...DEFAULT_SOUL_SETTINGS,
      allowAllChats: false,
      chatIds: [CHAT_ID],
      replyDelayMs: 0,
    }),
    model: null,
    temperature: 0.7,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as unknown as SoulModel;
}

interface Internals {
  onMessage(userId: string, payload: unknown): Promise<void>;
  reply(
    userId: string,
    accountId: string,
    chatId: number,
    message: MessageView,
    senderName: string,
    token: number,
    texts: Array<{ id: number; text: string }>,
  ): Promise<void>;
  nextToken(chatKey: string): number;
}

function harness(
  options: {
    account?: TelegramAccountModel | null;
    soul?: SoulModel | null;
    perHour?: number;
    perChat?: number;
  } = {},
) {
  const prisma = {
    telegramAccount: {
      findUnique: vi.fn(async () =>
        options.account === undefined ? accountRow() : options.account,
      ),
    },
    soulTurn: {
      count: vi.fn(async ({ where }: { where: { chatId?: bigint } }) =>
        where.chatId === undefined
          ? (options.perHour ?? 0)
          : (options.perChat ?? 0),
      ),
    },
  };
  const users = { get: vi.fn(async () => ({ id: 'user-1' })) };
  const messaging = {
    sendTyping: vi.fn(async () => undefined),
    sendMessage: vi.fn(async () => message({ id: 2002, outgoing: true })),
    markRead: vi.fn(async () => ({ read: true, maxId: null })),
    downloadMedia: vi.fn(async () => ({
      data: Buffer.from('fake-image'),
      mimeType: 'image/png',
      fileName: 'photo.png',
      disposition: 'inline',
      length: 10,
    })),
    getChatInfo: vi.fn(async () => ({
      id: CHAT_ID,
      type: 'user',
      title: 'Роман',
      username: 'username_dev',
      about: 'Пишу код и тестирую ботов',
      memberCount: null,
      onlineCount: null,
      isChannel: false,
      isGroup: false,
      isAdmin: false,
      isCreator: false,
      canSendMessages: true,
      inviteLink: null,
    })),
  };
  const events = new Subject<RealtimeEvent>();
  const realtime = {
    events$: events.asObservable(),
    emitToUser: vi.fn(),
  };
  const updates = { startForUser: vi.fn(async () => undefined) };
  const tdUpdates = { startForUser: vi.fn(async () => undefined) };
  const agent = {
    run: vi.fn(async () => ({
      runId: 'run-1',
      text: 'Hello back',
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    })),
  };
  const memory = {
    recentTurns: vi.fn(async () => [] as never[]),
    append: vi.fn(
      async (
        accountId: string,
        chatId: number,
        role: string,
        content: string,
        options: { messageId?: number; runId?: string } = {},
      ) => ({
        id: `turn-${role}`,
        role,
        content,
        messageId: options.messageId ?? null,
        createdAt: NOW.toISOString(),
      }),
    ),
    maybeCompact: vi.fn(async () => true),
  };

  const presence = {
    incoming: vi.fn(async () => ({ readDelayMs: 0, typingDelayMs: 0 })),
    touch: vi.fn(),
  };
  const souls = new SoulsService({} as never, {} as never);
  const soul = options.soul === undefined ? soulRow() : options.soul;
  const modelSpy = vi
    .spyOn(souls, 'model')
    .mockResolvedValue(soul);

  const service = new DmAutopilotService(
    prisma as never,
    users as never,
    messaging as never,
    realtime as never,
    updates as never,
    tdUpdates as never,
    agent as never,
    memory as never,
    souls,
    presence as never,
  );
  const internals = service as unknown as Internals;
  const tokenFor = (): number => internals.nextToken(`account-1:${CHAT_ID}`);

  return {
    tokenFor,
    service,
    internals,
    prisma,
    messaging,
    realtime,
    events,
    updates,
    tdUpdates,
    agent,
    memory,
    souls,
    presence,
    modelSpy,
  };
}

function payload(messageOverrides: Partial<MessageView> = {}) {
  return {
    accountId: 'account-1',
    chatId: CHAT_ID,
    message: message(messageOverrides),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DmAutopilotService.onMessage filters', () => {
  it('ignores outgoing, service, group and old messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    await h.internals.onMessage(
      'user-1',
      payload({ outgoing: true }),
    );
    await h.internals.onMessage(
      'user-1',
      payload({ service: true }),
    );

    const group = harness();
    await group.internals.onMessage('user-1', {
      accountId: 'account-1',
      chatId: -100123,
      message: message({ chatId: -100123 }),
    });

    const old = harness();
    await old.internals.onMessage(
      'user-1',
      payload({ date: new Date(NOW.getTime() - 121_000).toISOString() }),
    );

    for (const harnessed of [h, group, old]) {
      expect(harnessed.agent.run).not.toHaveBeenCalled();
      expect(harnessed.messaging.markRead).not.toHaveBeenCalled();
    }
    expect(h.prisma.telegramAccount.findUnique).not.toHaveBeenCalled();
    expect(group.prisma.telegramAccount.findUnique).not.toHaveBeenCalled();
    expect(old.prisma.telegramAccount.findUnique).not.toHaveBeenCalled();
  });

  it('ignores unknown accounts and Saved Messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const unknown = harness({ account: null });
    await unknown.internals.onMessage('user-1', payload());
    expect(unknown.souls.model.mock.calls).toEqual([]);

    const saved = harness({ account: accountRow({ tgUserId: BigInt(CHAT_ID) }) });
    await saved.internals.onMessage('user-1', payload());
    expect(saved.souls.model.mock.calls).toEqual([]);
    expect(saved.agent.run).not.toHaveBeenCalled();
  });

  it('ignores souls with mode off or chats outside the allowlist', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const off = harness({ soul: soulRow({ mode: 'off' }) });
    await off.internals.onMessage('user-1', payload());
    expect(off.agent.run).not.toHaveBeenCalled();

    const broken = harness({ soul: soulRow({ mode: 'unexpected' }) });
    await broken.internals.onMessage('user-1', payload());
    expect(broken.agent.run).not.toHaveBeenCalled();

    const missing = harness({ soul: null });
    await missing.internals.onMessage('user-1', payload());
    expect(missing.agent.run).not.toHaveBeenCalled();

    const notAllowed = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [7],
          replyDelayMs: 0,
        }),
      }),
    });
    await notAllowed.internals.onMessage('user-1', payload());
    expect(notAllowed.agent.run).not.toHaveBeenCalled();
    expect(notAllowed.messaging.markRead).not.toHaveBeenCalled();
  });

  it('marks the chat read immediately, before generating the reply', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    await h.internals.onMessage('user-1', payload());

    expect(h.messaging.markRead).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { maxId: 1001 },
    );
    // The debounce timer has not fired yet: the receipt is already visible.
    expect(h.agent.run).not.toHaveBeenCalled();

    await vi.runAllTimersAsync();
    expect(h.agent.run).toHaveBeenCalled();
  });

  it('reads after the presence delay when the account was offline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    h.presence.incoming.mockResolvedValueOnce({
      readDelayMs: 10_000,
      typingDelayMs: 3_000,
    });

    await h.internals.onMessage('user-1', payload({ id: 1001 }));

    expect(h.presence.incoming).toHaveBeenCalledWith('account-1', CHAT_ID);
    expect(h.messaging.markRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.messaging.markRead).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(h.messaging.markRead).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { maxId: 1001 },
    );
    // The reply starts after the read plus the typing delay.
    expect(h.agent.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_200);
    expect(h.agent.run).toHaveBeenCalled();
  });

  it('keeps working when the read receipt fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    h.messaging.markRead.mockRejectedValueOnce(new Error('flood wait'));

    await h.internals.onMessage('user-1', payload());
    await vi.runAllTimersAsync();

    expect(h.agent.run).toHaveBeenCalled();
    expect(h.messaging.sendMessage).toHaveBeenCalled();
  });
});

describe('DmAutopilotService.reply', () => {
  it('stores a draft and does not send in draft mode', async () => {
    const h = harness({ soul: soulRow({ mode: 'draft' }) });

    await h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );

    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
    expect(h.memory.append).toHaveBeenNthCalledWith(
      1,
      'account-1',
      CHAT_ID,
      'user',
      'Hi there',
      { messageId: 1001 },
    );
    expect(h.memory.append).toHaveBeenNthCalledWith(
      2,
      'account-1',
      CHAT_ID,
      'draft',
      'Hello back',
      { runId: 'run-1' },
    );
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.draft',
      expect.objectContaining({ text: 'Hello back', runId: 'run-1' }),
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        accountId: 'account-1',
        chatId: CHAT_ID,
        source: 'dm',
        tools: [],
        prompt: expect.stringContaining('Предложи ответ'),
      }),
    );
    expect(h.memory.maybeCompact).not.toHaveBeenCalled();
  });

  it('sends in auto mode and records both turns', async () => {
    vi.useFakeTimers();
    const h = harness();

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Ответь от лица владельца'),
        history: [],
      }),
    );
    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { status: 'typing' },
    );
    expect(h.messaging.sendMessage).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Hello back', replyToId: 1001 },
    );
    // A plain single-message output still produces exactly one message.
    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.memory.append).toHaveBeenNthCalledWith(
      2,
      'account-1',
      CHAT_ID,
      'assistant',
      'Hello back',
      { messageId: 2002, runId: 'run-1' },
    );
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.reply',
      expect.objectContaining({ text: 'Hello back' }),
    );
    expect(h.memory.maybeCompact).toHaveBeenCalledWith('account-1', CHAT_ID);
  });

  it('sends a multi-part reply as separate messages with index and quote', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: '[#1] Первый\nцитата: «первое сообщение»\n---\nВторой',
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    h.messaging.sendMessage
      .mockResolvedValueOnce(message({ id: 2002, outgoing: true }))
      .mockResolvedValueOnce(message({ id: 2003, outgoing: true }));

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1002 }),
      'Peer',
      h.tokenFor(),
      [
        { id: 1001, text: 'первое сообщение' },
        { id: 1002, text: 'второе' },
      ],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('1. первое сообщение'),
      }),
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Формат ответа'),
      }),
    );
    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.messaging.sendMessage).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Первый', replyToId: 1001, quote: 'первое сообщение' },
    );
    expect(h.messaging.sendMessage).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Второй', replyToId: 1002 },
    );

    const assistantTurns = h.memory.append.mock.calls.filter(
      (call) => call[2] === 'assistant',
    );
    expect(assistantTurns).toEqual([
      [
        'account-1',
        CHAT_ID,
        'assistant',
        'Первый',
        { messageId: 2002, runId: 'run-1' },
      ],
      [
        'account-1',
        CHAT_ID,
        'assistant',
        'Второй',
        { messageId: 2003, runId: 'run-1' },
      ],
    ]);
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.reply',
      expect.objectContaining({
        text: 'Первый',
        message: expect.objectContaining({ id: 2002 }),
      }),
    );
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.reply',
      expect.objectContaining({
        text: 'Второй',
        message: expect.objectContaining({ id: 2003 }),
      }),
    );
    expect(h.memory.maybeCompact).toHaveBeenCalledTimes(1);
  });

  it('stops the remaining parts when a newer message arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: 'Первый\n---\nВторой',
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });
    h.messaging.sendMessage.mockImplementationOnce(async () => {
      // The peer writes again while the first part is in flight.
      h.internals.nextToken(`account-1:${CHAT_ID}`);
      return message({ id: 2002, outgoing: true });
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1001 }),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.messaging.sendMessage).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Первый', replyToId: 1001 },
    );
    const assistantTurns = h.memory.append.mock.calls.filter(
      (call) => call[2] === 'assistant',
    );
    expect(assistantTurns).toHaveLength(1);
    expect(h.realtime.emitToUser).not.toHaveBeenCalledWith(
      'user-1',
      'ai.reply',
      expect.objectContaining({ text: 'Второй' }),
    );
  });

  it('joins a multi-part reply into one draft', async () => {
    const h = harness({ soul: soulRow({ mode: 'draft' }) });
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: 'Первая часть\n---\nВторая часть',
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    await h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );

    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
    expect(h.memory.append).toHaveBeenCalledWith(
      'account-1',
      CHAT_ID,
      'draft',
      'Первая часть\n\nВторая часть',
      { runId: 'run-1' },
    );
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.draft',
      expect.objectContaining({ text: 'Первая часть\n\nВторая часть' }),
    );
  });

  it('forwards an attached image to the vision model', async () => {
    vi.useFakeTimers();
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({
        text: '',
        mediaType: 'photo',
        media: {
          kind: 'photo',
          mimeType: 'image/png',
          fileName: null,
          size: 10,
          downloadable: true,
        },
      }),
      'Peer',
      h.tokenFor(),
      [
        {
          id: 1001,
          text: '[изображение]',
          media: {
            kind: 'photo',
            mimeType: 'image/png',
            fileName: null,
            size: 10,
            downloadable: true,
          },
        },
      ],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.downloadMedia).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      '1001',
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ mime: 'image/png', data: Buffer.from('fake-image') }],
        prompt: expect.stringContaining('изображение'),
      }),
    );
  });

  it('reuses the last image for a follow-up text question', async () => {
    vi.useFakeTimers();
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });
    const media = {
      kind: 'photo' as const,
      mimeType: 'image/png',
      fileName: null,
      size: 10,
      downloadable: true,
    };

    const first = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1001, text: '', mediaType: 'photo', media }),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: '[изображение]', media }],
    );
    await vi.runAllTimersAsync();
    await first;
    h.agent.run.mockClear();
    h.messaging.downloadMedia.mockClear();

    const second = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1002, text: 'Что тут находится?' }),
      'Peer',
      h.tokenFor(),
      [{ id: 1002, text: 'Что тут находится?' }],
    );
    await vi.runAllTimersAsync();
    await second;

    expect(h.messaging.downloadMedia).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      '1001',
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ mime: 'image/png', data: Buffer.from('fake-image') }],
        prompt: expect.stringContaining('Что тут находится?'),
      }),
    );
  });

  it('tells the model there is no image when the text asks about a picture', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // A fresh service has a cold `lastImages` cache, so no picture is attached.
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1001, text: 'Что тут находится?' }),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Что тут находится?' }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.downloadMedia).not.toHaveBeenCalled();
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [],
        prompt: expect.stringContaining('Изображения к этому сообщению нет'),
      }),
    );
  });

  it('does not add the no-image note to an ordinary text message', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1001, text: 'привет, как дела' }),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'привет, как дела' }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [],
        prompt: expect.not.stringContaining('Изображения к этому сообщению нет'),
      }),
    );
  });

  it('passes the peer username and bio to the agent', async () => {
    vi.useFakeTimers();
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.getChatInfo).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        systemExtra: expect.stringContaining('Роман (@username_dev)'),
      }),
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        systemExtra: expect.stringContaining('Пишу код и тестирую ботов'),
      }),
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        systemExtra: expect.stringContaining('назови их прямо'),
      }),
    );
  });

  it('never fetches the peer profile when the option is off', async () => {
    vi.useFakeTimers();
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
          peerProfile: false,
        }),
      }),
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.getChatInfo).not.toHaveBeenCalled();
    expect(h.messaging.sendMessage).toHaveBeenCalled();
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        systemExtra: expect.not.stringContaining('назови их прямо'),
      }),
    );
  });

  it('still replies when the peer profile cannot be fetched', async () => {
    vi.useFakeTimers();
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });
    h.messaging.getChatInfo.mockRejectedValueOnce(new Error('FLOOD_WAIT_5'));

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        systemExtra: expect.not.stringContaining('Собеседник в Telegram'),
      }),
    );
    expect(h.messaging.sendMessage).toHaveBeenCalled();
  });

  it('refuses to reply for an unknown mode', async () => {
    const h = harness({ soul: soulRow({ mode: 'weird' }) });

    await h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );

    expect(h.agent.run).not.toHaveBeenCalled();
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('skips abstains in auto mode', async () => {
    vi.useFakeTimers();
    const h = harness();
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: '   ',
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
    // The incoming turn is stored, the abstain itself is not.
    expect(h.memory.append).toHaveBeenCalledTimes(1);
    expect(h.memory.append).toHaveBeenCalledWith(
      'account-1',
      CHAT_ID,
      'user',
      'Hi there',
      { messageId: 1001 },
    );
  });

  it('respects the per-hour and per-chat limits', async () => {
    const perHour = harness({
      perHour: 12,
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          maxPerHour: 12,
        }),
      }),
    });
    await perHour.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      perHour.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    expect(perHour.agent.run).not.toHaveBeenCalled();
    expect(perHour.messaging.sendMessage).not.toHaveBeenCalled();

    const perChat = harness({
      perChat: 3,
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          maxPerChatPerDay: 3,
        }),
      }),
    });
    await perChat.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      perChat.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    expect(perChat.agent.run).not.toHaveBeenCalled();

    // A zero limit disables the guard.
    const unlimited = harness({
      perHour: 99,
      perChat: 99,
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          maxPerHour: 0,
          maxPerChatPerDay: 0,
        }),
      }),
    });
    vi.useFakeTimers();
    const pending = unlimited.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      unlimited.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    await vi.runAllTimersAsync();
    await pending;
    expect(unlimited.agent.run).toHaveBeenCalledTimes(1);
  });

  it('answers the latest message when two arrive before the reply', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });

    await h.internals.onMessage('user-1', payload({ id: 1001, text: 'first' }));
    await h.internals.onMessage('user-1', payload({ id: 1002, text: 'second' }));
    await vi.runAllTimersAsync();

    expect(h.agent.run).toHaveBeenCalledTimes(1);
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('second'),
      }),
    );
    expect(h.memory.append).toHaveBeenCalledWith(
      'account-1',
      CHAT_ID,
      'user',
      'first',
      { messageId: 1001 },
    );
    expect(h.memory.append).toHaveBeenCalledWith(
      'account-1',
      CHAT_ID,
      'user',
      'second',
      { messageId: 1002 },
    );
    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.messaging.sendMessage).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Hello back', replyToId: 1002 },
    );
  });

  it('cancels the in-flight reply when a newer message arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    const slow = deferred<void>();
    h.agent.run.mockImplementationOnce(async () => {
      await slow.promise;
      return {
        runId: 'run-1',
        text: 'old reply',
        model: 'main-model',
        steps: 1,
        trace: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    });

    await h.internals.onMessage('user-1', payload({ id: 1001, text: 'first' }));
    await vi.advanceTimersByTimeAsync(300);
    expect(h.agent.run).toHaveBeenCalledTimes(1);

    await h.internals.onMessage('user-1', payload({ id: 1002, text: 'second' }));
    // Thinking is silent: no "typing…" was sent yet, so nothing to cancel.
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();

    slow.resolve();
    await vi.runAllTimersAsync();

    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.messaging.sendMessage).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Hello back', replyToId: 1002 },
    );
    expect(h.memory.append).not.toHaveBeenCalledWith(
      'account-1',
      CHAT_ID,
      'assistant',
      'old reply',
      expect.anything(),
    );
    expect(h.realtime.emitToUser).not.toHaveBeenCalledWith(
      'user-1',
      'ai.reply',
      expect.objectContaining({ text: 'old reply' }),
    );
  });

  it('stays silent while the model is thinking and types only afterwards', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    const thinking = deferred<void>();
    h.agent.run.mockImplementationOnce(async () => {
      await thinking.promise;
      return {
        runId: 'run-1',
        text: 'Hello back',
        model: 'main-model',
        steps: 1,
        trace: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    });

    await h.internals.onMessage('user-1', payload({ id: 1001, text: 'hi' }));
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(9_000);

    expect(h.messaging.sendTyping).not.toHaveBeenCalled();

    thinking.resolve();
    await vi.runAllTimersAsync();

    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { status: 'typing' },
    );
    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('DmAutopilotService debounce and lifecycle', () => {
  it('debounces bursts in one chat and drops duplicate message ids', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    const replySpy = vi.fn(async () => undefined);
    (h.internals as unknown as { reply: typeof replySpy }).reply = replySpy;

    await h.internals.onMessage('user-1', payload({ id: 1, text: 'one' }));
    await h.internals.onMessage('user-1', payload({ id: 2, text: 'two' }));

    expect(replySpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500);
    expect(replySpy).toHaveBeenCalledTimes(1);
    expect(replySpy.mock.calls[0]?.[3]).toMatchObject({ id: 2, text: 'two' });

    await h.internals.onMessage('user-1', payload({ id: 2, text: 'two' }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(replySpy).toHaveBeenCalledTimes(1);
  });

  it('starts updates at boot and clears pending work on destroy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    const replySpy = vi.fn(async () => undefined);
    (h.internals as unknown as { reply: typeof replySpy }).reply = replySpy;

    await h.service.onModuleInit();
    expect(h.updates.startForUser).toHaveBeenCalledWith('user-1');
    expect(h.tdUpdates.startForUser).toHaveBeenCalledWith('user-1');
    expect(h.events.observed).toBe(true);

    await h.internals.onMessage('user-1', payload());
    h.service.onModuleDestroy();

    expect(h.events.observed).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(replySpy).not.toHaveBeenCalled();
  });
});
