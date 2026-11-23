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
  ): Promise<void>;
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
  );
  const internals = service as unknown as Internals;

  return {
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
  });
});

describe('DmAutopilotService.reply', () => {
  it('stores a draft and does not send in draft mode', async () => {
    const h = harness({ soul: soulRow({ mode: 'draft' }) });

    await h.internals.reply('user-1', 'account-1', CHAT_ID, message(), 'Peer');

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
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Ответь от лица владельца'),
        history: [],
      }),
    );
    expect(h.messaging.sendTyping).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'account-1',
      String(CHAT_ID),
    );
    expect(h.messaging.sendTyping).toHaveBeenNthCalledWith(
      2,
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

  it('refuses to reply for an unknown mode', async () => {
    const h = harness({ soul: soulRow({ mode: 'weird' }) });

    await h.internals.reply('user-1', 'account-1', CHAT_ID, message(), 'Peer');

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
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
    expect(h.memory.append).not.toHaveBeenCalled();
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
    );
    await vi.runAllTimersAsync();
    await pending;
    expect(unlimited.agent.run).toHaveBeenCalledTimes(1);
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
