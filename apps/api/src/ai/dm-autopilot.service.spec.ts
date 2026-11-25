import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiChatAccessModel,
  AiChatBlockModel,
  SoulModel,
  TelegramAccountModel,
} from '@repo/database';
import type { AiAccessDecision } from '../ai-access/ai-access.service.js';
import type { MessageView } from '../messaging/message-view.js';
import type { RealtimeEvent } from '../realtime/realtime.service.js';
import { setLogSink } from '../logs/log-sink.js';
import type { LogInput } from '../logs/log-sink.js';
import type { AgentRunInput } from './ai.types.js';
import { DEFAULT_SOUL_SETTINGS } from './ai.types.js';
import { DmAutopilotService } from './dm-autopilot.service.js';
import { ChatStateService } from './chat-state.service.js';
import { SoulsService } from './souls.service.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');
/**
 * Two genuinely separate, long bubbles. The bubble policy force-merges a
 * reply whose total is under 200 characters or that contains a part under 40,
 * so multi-bubble tests need realistic lengths.
 */
const PART_ONE =
  'Первый вариант ответа получился достаточно длинным, чтобы жить отдельным сообщением в переписке, а не слипаться с остальными пузырями.';
const PART_TWO =
  'Второй вариант тоже содержит отдельную мысль и потому заслуживает собственного пузыря в чате, даже если чат этого совсем не ждал.';
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
    threadId?: number,
  ): Promise<void>;
  nextToken(chatKey: string): number;
}

function emptyAccess(): AiAccessDecision {
  return { allowed: false, access: null, block: null, warnings: 0 };
}

function decision(overrides: Partial<AiAccessDecision> = {}): AiAccessDecision {
  return { ...emptyAccess(), ...overrides };
}

function accessRow(overrides: { enabled: boolean; threadId?: number }) {
  return {
    id: 'access-1',
    userId: 'user-1',
    accountId: 'account-1',
    chatId: BigInt(CHAT_ID),
    threadId: overrides.threadId ?? 0,
    soulId: null,
    enabled: overrides.enabled,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as AiChatAccessModel;
}

function blockRow(overrides: { threadId?: number; reason?: string } = {}) {
  return {
    id: 'block-1',
    userId: 'user-1',
    accountId: 'account-1',
    chatId: BigInt(CHAT_ID),
    threadId: overrides.threadId ?? 0,
    reason: overrides.reason ?? null,
    warnings: 0,
    blockedBy: 'user',
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as AiChatBlockModel;
}

function harness(
  options: {
    account?: TelegramAccountModel | null;
    soul?: SoulModel | null;
    perHour?: number;
    perChat?: number;
    skills?: { slugs: string[]; source: 'chat' | 'soul' };
    accessFor?: (
      chatId: number,
      threadId: number,
    ) => AiAccessDecision | Promise<AiAccessDecision>;
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
    soul: {
      findMany: vi.fn(async () => [] as never[]),
    },
    aiChatAccess: {
      findMany: vi.fn(async () => [] as never[]),
      upsert: vi.fn(async () => ({})),
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
    messageFrames: vi.fn(async () => ({
      data: Buffer.from('collage-jpeg'),
      mimeType: 'image/jpeg',
      fileName: 'frames.jpg',
      disposition: 'inline; filename="frames.jpg"',
      length: 12,
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
    listMessages: vi.fn(async () => ({
      messages: [] as MessageView[],
      nextOffsetId: null,
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
    run: vi.fn(async (_input: AgentRunInput) => ({
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
  const speech = {
    available: vi.fn(() => true),
    transcribe: vi.fn(async () => ({
      text: 'расшифровка голосового',
      language: 'ru',
      durationMs: 1200,
    })),
  };
  const souls = new SoulsService({} as never, {} as never);
  const soul = options.soul === undefined ? soulRow() : options.soul;
  const modelSpy = vi
    .spyOn(souls, 'model')
    .mockResolvedValue(soul);
  const aiAccess = {
    accessFor: vi.fn(
      async (
        _userId: string,
        _accountId: string,
        chatId: number,
        threadId: number,
      ) =>
        options.accessFor
          ? options.accessFor(chatId, threadId)
          : emptyAccess(),
    ),
  };
  const agentRuns = { attachMessages: vi.fn(async () => undefined) };
  const chatSkills = {
    resolve: vi.fn(
      async () => options.skills ?? { slugs: [] as string[], source: 'soul' },
    ),
  };

  const states = new ChatStateService(realtime as never);
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
    speech as never,
    aiAccess as never,
    agentRuns as never,
    chatSkills as never,
    states,
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
    speech,
    modelSpy,
    aiAccess,
    agentRuns,
    chatSkills,
    states,
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

describe('DmAutopilotService access gate', () => {
  it('drops a blocked chat before reading, typing or scheduling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      accessFor: () =>
        decision({
          block: blockRow({ reason: 'spam' }),
          warnings: 2,
        }),
    });

    await h.internals.onMessage('user-1', payload());

    expect(h.aiAccess.accessFor).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      CHAT_ID,
      0,
    );
    expect(h.presence.incoming).not.toHaveBeenCalled();
    expect(h.messaging.markRead).not.toHaveBeenCalled();
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.agent.run).not.toHaveBeenCalled();
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps a disabled access row above allowAllChats', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          allowAllChats: true,
          replyDelayMs: 0,
        }),
      }),
      accessFor: () => decision({ access: accessRow({ enabled: false }) }),
    });

    await h.internals.onMessage('user-1', payload());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.agent.run).not.toHaveBeenCalled();
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to allowAllChats when there is no access row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          allowAllChats: true,
          chatIds: [],
          replyDelayMs: 0,
        }),
      }),
    });

    await h.internals.onMessage('user-1', payload());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.agent.run).toHaveBeenCalledTimes(1);
    expect(h.messaging.sendMessage).toHaveBeenCalled();
  });

  it('falls back to the soul chat allowlist when there is no access row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    await h.internals.onMessage('user-1', payload());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.agent.run).toHaveBeenCalledTimes(1);
  });

  it('closes only the blocked thread, not the whole chat', async () => {
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
      accessFor: (_chatId, threadId) =>
        threadId === 7
          ? decision({ block: blockRow({ threadId: 7 }) })
          : decision(),
    });

    await h.internals.onMessage('user-1', {
      accountId: 'account-1',
      chatId: CHAT_ID,
      threadId: 7,
      message: message({ id: 1001 }),
    });
    expect(h.aiAccess.accessFor).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      CHAT_ID,
      7,
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.agent.run).not.toHaveBeenCalled();

    await h.internals.onMessage('user-1', payload({ id: 1002 }));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(h.agent.run).toHaveBeenCalledTimes(1);
    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('reuses access decisions briefly and re-reads them after the TTL', async () => {
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

    await h.internals.onMessage('user-1', payload({ id: 1001 }));
    await h.internals.onMessage('user-1', payload({ id: 1002 }));
    expect(h.aiAccess.accessFor).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10_001);
    await h.internals.onMessage('user-1', payload({ id: 1003 }));

    expect(h.aiAccess.accessFor).toHaveBeenCalledTimes(2);
  });

  it('seeds access rows for chats already allowlisted by souls', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    h.prisma.soul.findMany.mockResolvedValueOnce([
      {
        accountId: 'account-1',
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID, 7, 7],
        }),
        account: { userId: 'user-1' },
      },
    ] as never[]);
    h.prisma.aiChatAccess.findMany.mockResolvedValueOnce([
      { accountId: 'account-1', chatId: BigInt(CHAT_ID), threadId: 0 },
    ] as never[]);

    await h.service.onModuleInit();

    // CHAT_ID already has a row; only chat 7 is created (once).
    expect(h.prisma.aiChatAccess.upsert).toHaveBeenCalledTimes(1);
    expect(h.prisma.aiChatAccess.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_chatId_threadId: {
            accountId: 'account-1',
            chatId: BigInt(7),
            threadId: 0,
          },
        },
        create: expect.objectContaining({
          userId: 'user-1',
          accountId: 'account-1',
          chatId: BigInt(7),
          threadId: 0,
          enabled: true,
        }),
      }),
    );
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
        prompt: expect.stringContaining('Предложи ответ от своего лица'),
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
        prompt: expect.stringContaining('Ответь от своего лица, как Душа'),
        history: [],
      }),
    );
    const input = h.agent.run.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.prompt).toContain('Ты — Душа');
    expect(input.prompt).not.toContain('от лица владельца');
    expect(input.systemExtra).toContain('Ты сама ведёшь этот аккаунт');
    expect(input.systemExtra).toContain(
      'Не будь душной: без морализаторства, нотаций и непрошеных оговорок',
    );
    expect(input.systemExtra).toContain(
      'Проявляй интерес к собеседнику: цепляйся за детали, задавай конкретный вопрос по его словам, вспоминай, что он говорил раньше.',
    );
    expect(input.systemExtra).toContain(
      'Когда рассказываешь о себе — коротко, живо, с деталью и эмоцией; в конце оставь крючок: спроси его мнение или подколи.',
    );
    expect(input.systemExtra).not.toContain('от лица владельца');
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

  it('answers from its own face when the soul has no name', async () => {
    vi.useFakeTimers();
    const h = harness({ soul: soulRow({ name: '' }) });

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

    const input = h.agent.run.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.prompt).toContain('Ответь от своего лица');
    expect(input.prompt).not.toContain('Ты — ,');
    expect(input.prompt).not.toContain('от лица владельца');
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
          maxParts: 3,
        }),
      }),
    });
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: `[#1] ${PART_ONE}\nцитата: «первое сообщение»\n---\n${PART_TWO}`,
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
      { text: PART_ONE, replyToId: 1001, quote: 'первое сообщение' },
    );
    expect(h.messaging.sendMessage).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: PART_TWO, replyToId: 1002 },
    );

    const assistantTurns = h.memory.append.mock.calls.filter(
      (call) => call[2] === 'assistant',
    );
    expect(assistantTurns).toEqual([
      [
        'account-1',
        CHAT_ID,
        'assistant',
        PART_ONE,
        { messageId: 2002, runId: 'run-1' },
      ],
      [
        'account-1',
        CHAT_ID,
        'assistant',
        PART_TWO,
        { messageId: 2003, runId: 'run-1' },
      ],
    ]);
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.reply',
      expect.objectContaining({
        text: PART_ONE,
        message: expect.objectContaining({ id: 2002 }),
      }),
    );
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.reply',
      expect.objectContaining({
        text: PART_TWO,
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
          maxParts: 3,
        }),
      }),
    });
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: `${PART_ONE}\n---\n${PART_TWO}`,
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
      { text: PART_ONE, replyToId: 1001 },
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

  it('forwards a frame collage of an animated sticker with a hint', async () => {
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
      kind: 'sticker' as const,
      mimeType: 'application/x-tgsticker',
      fileName: null,
      size: 10_000,
      downloadable: true,
      emoji: '🐷',
      isAnimated: true,
      width: 512,
      height: 512,
    };
    const logs: LogInput[] = [];
    setLogSink((entry) => logs.push(entry));

    try {
      const pending = h.internals.reply(
        'user-1',
        'account-1',
        CHAT_ID,
        message({ id: 1001, text: '', mediaType: 'sticker', media }),
        'Peer',
        h.tokenFor(),
        [{ id: 1001, text: '[стикер 🐷]', media }],
      );
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      setLogSink(null);
    }

    expect(h.messaging.messageFrames).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      '1001',
    );
    expect(h.messaging.downloadMedia).not.toHaveBeenCalled();
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [
          { mime: 'image/jpeg', data: Buffer.from('collage-jpeg') },
        ],
        prompt: expect.stringContaining(
          'Собеседник прислал стикер/анимированное эмодзи/GIF — ниже кадры по порядку; пойми эмоцию/шутку и ответь уместно.',
        ),
      }),
    );
    expect(logs).toContainEqual(
      expect.objectContaining({
        action: 'dm.autopilot.sticker',
        details: expect.objectContaining({
          messageId: 1001,
          kind: 'sticker',
          emoji: '🐷',
          frames: true,
        }),
      }),
    );
  });

  it('builds at most one collage per burst', async () => {
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
    const sticker = {
      kind: 'sticker' as const,
      mimeType: 'application/x-tgsticker',
      fileName: null,
      size: 10,
      downloadable: true,
      emoji: '🐷',
      isAnimated: true,
    };
    const gif = {
      kind: 'animation' as const,
      mimeType: 'video/mp4',
      fileName: 'cat.mp4',
      size: 10,
      downloadable: true,
      isAnimated: true,
    };

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1003, text: '', mediaType: 'video', media: gif }),
      'Peer',
      h.tokenFor(),
      [
        { id: 1001, text: '[стикер 🐷]', media: sticker },
        { id: 1002, text: 'смотри', media: gif },
      ],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.messageFrames).toHaveBeenCalledTimes(1);
    // The newest animated item wins.
    expect(h.messaging.messageFrames).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      '1002',
    );
  });

  it('sends a static webp sticker as a plain image, not a collage', async () => {
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
    h.messaging.downloadMedia.mockResolvedValue({
      data: Buffer.from('webp-sticker'),
      mimeType: 'image/webp',
      fileName: 'sticker.webp',
      disposition: 'inline',
      length: 12,
    });
    const media = {
      kind: 'sticker' as const,
      mimeType: 'image/webp',
      fileName: 'sticker.webp',
      size: 12,
      downloadable: true,
      emoji: '🐷',
    };

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1001, text: '', mediaType: 'sticker', media }),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: '[стикер 🐷]', media }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.messageFrames).not.toHaveBeenCalled();
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [{ mime: 'image/webp', data: Buffer.from('webp-sticker') }],
      }),
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.not.objectContaining({
        prompt: expect.stringContaining('ниже кадры по порядку'),
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

  it('transcribes a voice note and puts it in the prompt', async () => {
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
    const media = {
      kind: 'voice' as const,
      mimeType: 'audio/ogg',
      fileName: null,
      size: 5,
      downloadable: true,
    };
    h.messaging.downloadMedia.mockResolvedValueOnce({
      data: Buffer.from('voice'),
      mimeType: 'audio/ogg',
      fileName: 'voice.ogg',
      disposition: 'inline',
      length: 5,
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1001, text: '[voice]', mediaType: 'voice', media }),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: '[voice]', media }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.downloadMedia).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      '1001',
    );
    expect(h.speech.transcribe).toHaveBeenCalledWith({
      data: Buffer.from('voice'),
      mimeType: 'audio/ogg',
      fileName: 'voice.ogg',
    });
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('[голосовое] «расшифровка голосового»'),
      }),
    );
    expect(h.memory.append).toHaveBeenCalledWith(
      'account-1',
      CHAT_ID,
      'user',
      '[голосовое] «расшифровка голосового»',
      { messageId: 1001 },
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining('наушник'),
      }),
    );
  });

  it('transcribes audio sent as a document', async () => {
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
    const media = {
      kind: 'document' as const,
      mimeType: 'audio/mpeg',
      fileName: 'song.mp3',
      size: 5,
      downloadable: true,
    };
    h.messaging.downloadMedia.mockResolvedValueOnce({
      data: Buffer.from('song'),
      mimeType: 'audio/mpeg',
      fileName: 'song.mp3',
      disposition: 'attachment',
      length: 4,
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1001, text: '[audio]', mediaType: 'document', media }),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: '[audio]', media }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.speech.transcribe).toHaveBeenCalled();
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('[голосовое] «расшифровка голосового»'),
      }),
    );
  });

  it('keeps an honest placeholder when the voice note cannot be transcribed', async () => {
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
    h.speech.transcribe.mockResolvedValueOnce(null);
    const media = {
      kind: 'voice' as const,
      mimeType: 'audio/ogg',
      fileName: null,
      size: 5,
      downloadable: true,
    };

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1001, text: '[voice]', mediaType: 'voice', media }),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: '[voice]', media }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          '[голосовое сообщение, расшифровать не удалось]',
        ),
      }),
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('не расслышал'),
      }),
    );
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.not.stringContaining('нет наушников'),
      }),
    );
    expect(h.memory.append).toHaveBeenCalledWith(
      'account-1',
      CHAT_ID,
      'user',
      '[голосовое сообщение, расшифровать не удалось]',
      { messageId: 1001 },
    );
    // The failure never blocks the reply.
    expect(h.messaging.sendMessage).toHaveBeenCalled();
  });

  it('does not download audio when no speech engine is installed', async () => {
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
    h.speech.available.mockReturnValue(false);
    const media = {
      kind: 'voice' as const,
      mimeType: 'audio/ogg',
      fileName: null,
      size: 5,
      downloadable: true,
    };

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1001, text: '[voice]', mediaType: 'voice', media }),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: '[voice]', media }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.messaging.downloadMedia).not.toHaveBeenCalled();
    expect(h.speech.transcribe).not.toHaveBeenCalled();
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining(
          '[голосовое сообщение, расшифровать не удалось]',
        ),
      }),
    );
  });

  it('keeps text and voice in a burst together', async () => {
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
    const media = {
      kind: 'voice' as const,
      mimeType: 'audio/ogg',
      fileName: null,
      size: 5,
      downloadable: true,
    };
    h.messaging.downloadMedia.mockResolvedValueOnce({
      data: Buffer.from('voice'),
      mimeType: 'audio/ogg',
      fileName: 'voice.ogg',
      disposition: 'inline',
      length: 5,
    });

    const pending = h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message({ id: 1002, text: 'и ещё вопрос' }),
      'Peer',
      h.tokenFor(),
      [
        { id: 1001, text: '[voice]', media },
        { id: 1002, text: 'и ещё вопрос' },
      ],
    );
    await vi.runAllTimersAsync();
    await pending;

    const prompt = vi.mocked(h.agent.run).mock.calls[0][0].prompt;
    expect(prompt).toContain('1. [голосовое] «расшифровка голосового»');
    expect(prompt).toContain('2. и ещё вопрос');
    expect(h.messaging.downloadMedia).toHaveBeenCalledTimes(1);
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

  it('smart: waits typingStartDelayMs after the read, then types during thinking', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typingMode: 'smart',
          typingStartDelayMs: 600,
          typingHeartbeatMs: 4000,
        }),
      }),
    });
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
    // Debounce 200 ms + start delay 600 ms: nothing yet at 500 ms.
    await vi.advanceTimersByTimeAsync(500);
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { status: 'typing' },
    );

    // The heartbeat refreshes the action while the model is still thinking.
    await vi.advanceTimersByTimeAsync(4000);
    const typingCalls = h.messaging.sendTyping.mock.calls.filter(
      (call) => (call[3] as { status?: string }).status === 'typing',
    );
    expect(typingCalls.length).toBeGreaterThanOrEqual(2);

    thinking.resolve();
    await vi.runAllTimersAsync();

    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('records the ids of every sent bubble on the run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
          maxParts: 3,
        }),
      }),
    });
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: `${PART_ONE}\n---\n${PART_TWO}`,
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
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
    );
    await vi.runAllTimersAsync();
    await pending;

    expect(h.agentRuns.attachMessages).toHaveBeenCalledWith('run-1', [
      2002, 2003,
    ]);
  });

  it('keeps reasoning out of Telegram and on the WS payload', async () => {
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
      text: 'Hello back',
      reasoning: 'SECRET THOUGHTS',
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

    // Reasoning is metadata for the dashboard, never a Telegram text.
    const sentTexts = h.messaging.sendMessage.mock.calls.map(
      (call) => (call[3] as { text: string }).text,
    );
    expect(sentTexts.join('\n')).not.toContain('SECRET THOUGHTS');
    expect(sentTexts).toEqual(['Hello back']);
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.reply',
      expect.objectContaining({
        text: 'Hello back',
        runId: 'run-1',
        reasoning: 'SECRET THOUGHTS',
      }),
    );
  });

  it('emits ai.thinking start, throttled deltas and done, never to Telegram', async () => {
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
    const reasoning =
      'короткий ещё немного текстадальше и ещё одна фраза';
    h.agent.run.mockImplementation(async (input: AgentRunInput) => {
      input.onRunStart?.('run-1');
      input.onReasoningDelta?.('короткий'); // 8 chars: buffered
      vi.advanceTimersByTime(200);
      input.onReasoningDelta?.(' ещё немного текста'); // flush
      vi.advanceTimersByTime(50);
      input.onReasoningDelta?.('дальше'); // too soon and too short
      vi.advanceTimersByTime(150);
      input.onReasoningDelta?.(' и ещё одна фраза'); // flush
      return {
        runId: 'run-1',
        text: 'Ответ',
        reasoning,
        model: 'main-model',
        steps: 1,
        trace: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      };
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

    const thinking = h.realtime.emitToUser.mock.calls
      .filter(([, event]) => event === 'ai.thinking')
      .map(([, , payload]) => payload);
    expect(thinking).toEqual([
      {
        accountId: 'account-1',
        chatId: CHAT_ID,
        runId: 'run-1',
        phase: 'start',
      },
      {
        accountId: 'account-1',
        chatId: CHAT_ID,
        runId: 'run-1',
        delta: 'короткий ещё немного текста',
      },
      {
        accountId: 'account-1',
        chatId: CHAT_ID,
        runId: 'run-1',
        delta: 'дальше и ещё одна фраза',
      },
      {
        accountId: 'account-1',
        chatId: CHAT_ID,
        runId: 'run-1',
        phase: 'done',
        reasoning,
      },
    ]);

    // Reasoning stays on the dashboard side; Telegram gets the answer only.
    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.messaging.sendMessage).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Ответ', replyToId: 1001 },
    );
    const sentTexts = h.messaging.sendMessage.mock.calls.map(
      (call) => (call[3] as { text: string }).text,
    );
    expect(sentTexts.join('\n')).not.toContain('ещё немного');
  });

  it('reuses the last voice transcript for a text-only follow-up', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logs: LogInput[] = [];
    setLogSink((entry) => logs.push(entry));
    try {
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
        kind: 'voice' as const,
        mimeType: 'audio/ogg',
        fileName: null,
        size: 5,
        downloadable: true,
      };
      h.messaging.downloadMedia.mockResolvedValueOnce({
        data: Buffer.from('voice'),
        mimeType: 'audio/ogg',
        fileName: 'voice.ogg',
        disposition: 'inline',
        length: 5,
      });
      h.speech.transcribe.mockResolvedValueOnce({
        text: 'меня зовут Роман',
        language: 'ru',
        durationMs: 1000,
      });

      await h.internals.reply(
        'user-1',
        'account-1',
        CHAT_ID,
        message({ id: 1001, text: '[voice]', mediaType: 'voice', media }),
        'Peer',
        h.tokenFor(),
        [{ id: 1001, text: '[voice]', media }],
      );
      h.agent.run.mockClear();

      await h.internals.reply(
        'user-1',
        'account-1',
        CHAT_ID,
        message({ id: 1002, text: 'Что я сказал в этом голосовом?' }),
        'Peer',
        h.tokenFor(),
        [{ id: 1002, text: 'Что я сказал в этом голосовом?' }],
      );

      const prompt = (
        h.agent.run.mock.calls[0]?.[0] as { prompt: string } | undefined
      )?.prompt;
      expect(prompt).toContain('меня зовут Роман');
      expect(prompt).toContain('уже расшифровано');
      // No "не расслышал" excuse when the transcript is at hand.
      expect(prompt).not.toContain('не расслышал');
      expect(logs).toContainEqual(
        expect.objectContaining({
          action: 'dm.autopilot.voice',
          status: 'ok',
          details: expect.objectContaining({ reused: true }),
        }),
      );
    } finally {
      setLogSink(null);
    }
  });
});

describe('DmAutopilotService voice follow-up lookup', () => {
  const VOICE_MEDIA = {
    kind: 'voice' as const,
    mimeType: 'audio/ogg',
    fileName: null,
    size: 5,
    downloadable: true,
  };
  const FILE_MEDIA = {
    kind: 'document' as const,
    mimeType: 'application/pdf',
    fileName: 'file.pdf',
    size: 5,
    downloadable: true,
  };
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;

  function fastSoul(): SoulModel {
    return soulRow({
      settings: JSON.stringify({
        ...DEFAULT_SOUL_SETTINGS,
        chatIds: [CHAT_ID],
        replyDelayMs: 0,
        typing: false,
      }),
    });
  }

  function voiceAt(id: number, date = NOW.toISOString()): MessageView {
    return message({
      id,
      text: '',
      date,
      mediaType: 'voice',
      media: VOICE_MEDIA,
      isVoice: true,
    });
  }

  function question(id: number, text: string, replyToId: number | null = null) {
    return message({ id, text, replyToId });
  }

  function promptOf(h: ReturnType<typeof harness>): string {
    const input = h.agent.run.mock.calls[0]?.[0] as
      | { prompt: string }
      | undefined;
    return input?.prompt ?? '';
  }

  it('transcribes the voice message the peer replied to', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logs: LogInput[] = [];
    setLogSink((entry) => logs.push(entry));
    try {
      const h = harness({ soul: fastSoul() });
      h.messaging.listMessages.mockResolvedValueOnce({
        messages: [voiceAt(900)],
        nextOffsetId: null,
      });
      h.speech.transcribe.mockResolvedValueOnce({
        text: 'я сказал что позвоню вечером',
        language: 'ru',
        durationMs: 900,
      });

      const text = 'что я сказал в этом голосовом?';
      await h.internals.reply(
        'user-1',
        'account-1',
        CHAT_ID,
        question(1002, text, 900),
        'Peer',
        h.tokenFor(),
        [{ id: 1002, text, replyToId: 900 }],
      );

      // The quoted message is read directly, not the whole history.
      expect(h.messaging.listMessages).toHaveBeenCalledWith(
        'user-1',
        'account-1',
        String(CHAT_ID),
        { limit: 1, offsetId: 901 },
      );
      expect(h.messaging.downloadMedia).toHaveBeenCalledWith(
        'user-1',
        'account-1',
        String(CHAT_ID),
        '900',
      );
      const prompt = promptOf(h);
      expect(prompt).toContain('я сказал что позвоню вечером');
      expect(prompt).toContain('уже расшифровано');
      expect(prompt).not.toContain('не расслышал');
      expect(logs).toContainEqual(
        expect.objectContaining({
          action: 'dm.autopilot.voice',
          status: 'ok',
          details: expect.objectContaining({
            messageId: 900,
            source: 'onDemand',
          }),
        }),
      );
    } finally {
      setLogSink(null);
    }
  });

  it('finds the newest voice note when the question is not a reply', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({ soul: fastSoul() });
    h.messaging.listMessages.mockResolvedValueOnce({
      messages: [
        message({ id: 1005, text: 'смотри' }),
        voiceAt(1004, new Date(NOW.getTime() - 5 * MINUTE).toISOString()),
        voiceAt(1003, new Date(NOW.getTime() - 10 * MINUTE).toISOString()),
      ],
      nextOffsetId: null,
    });
    h.speech.transcribe.mockResolvedValueOnce({
      text: 'свежая расшифровка',
      language: 'ru',
      durationMs: 800,
    });

    const text = 'прослушай то что я тебе скинул';
    await h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      question(1100, text),
      'Peer',
      h.tokenFor(),
      [{ id: 1100, text }],
    );

    expect(h.messaging.listMessages).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { limit: 50 },
    );
    // The newest voice note, not the older one and not the text message.
    expect(h.messaging.downloadMedia).toHaveBeenCalledTimes(1);
    expect(h.messaging.downloadMedia).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      '1004',
    );
    expect(promptOf(h)).toContain('свежая расшифровка');
  });

  it('ignores a voice note older than 24 hours', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({ soul: fastSoul() });
    h.messaging.listMessages.mockResolvedValueOnce({
      messages: [
        voiceAt(1004, new Date(NOW.getTime() - 25 * HOUR).toISOString()),
      ],
      nextOffsetId: null,
    });

    const text = 'что я сказал в голосовом?';
    await h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      question(1100, text),
      'Peer',
      h.tokenFor(),
      [{ id: 1100, text }],
    );

    expect(h.messaging.downloadMedia).not.toHaveBeenCalled();
    expect(h.speech.transcribe).not.toHaveBeenCalled();
    const prompt = promptOf(h);
    expect(prompt).not.toContain('уже расшифровано');
    expect(prompt).not.toContain('не расслышал');
  });

  it('does not treat «скинул файл» as a voice reference without audio nearby', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({ soul: fastSoul() });
    h.messaging.listMessages.mockResolvedValueOnce({
      messages: [
        message({
          id: 1005,
          text: 'файл',
          mediaType: 'document',
          media: FILE_MEDIA,
        }),
        message({ id: 1004, text: 'вот документ' }),
      ],
      nextOffsetId: null,
    });

    const text = 'я скинул файл, посмотри';
    await h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      question(1100, text),
      'Peer',
      h.tokenFor(),
      [{ id: 1100, text }],
    );

    expect(h.messaging.listMessages).toHaveBeenCalled();
    expect(h.messaging.downloadMedia).not.toHaveBeenCalled();
    expect(h.speech.transcribe).not.toHaveBeenCalled();
    const prompt = promptOf(h);
    expect(prompt).not.toContain('голосовое сообщение, которое уже расшифровано');
    expect(prompt).not.toContain('не расслышал');
  });

  it('adds an honest line when the on-demand transcription fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logs: LogInput[] = [];
    setLogSink((entry) => logs.push(entry));
    try {
      const h = harness({ soul: fastSoul() });
      h.messaging.listMessages.mockResolvedValueOnce({
        messages: [voiceAt(1004)],
        nextOffsetId: null,
      });
      h.speech.transcribe.mockResolvedValueOnce(null);

      const text = 'прослушай голосовое';
      await h.internals.reply(
        'user-1',
        'account-1',
        CHAT_ID,
        question(1100, text),
        'Peer',
        h.tokenFor(),
        [{ id: 1100, text }],
      );

      const prompt = promptOf(h);
      expect(prompt).toContain('Голосовое не удалось расшифровать');
      expect(prompt).toContain('не расслышал');
      // The model is never told that headphones or sound are missing.
      expect(prompt).not.toContain('нет наушников');
      expect(prompt).not.toContain('наушников нет');
      expect(logs).toContainEqual(
        expect.objectContaining({
          action: 'dm.autopilot.voice',
          status: 'failed',
          details: expect.objectContaining({
            messageId: 1004,
            source: 'failed',
          }),
        }),
      );
      // The failure never blocks the reply.
      expect(h.messaging.sendMessage).toHaveBeenCalled();
    } finally {
      setLogSink(null);
    }
  });

  it('caches a transcript per message for a day and downloads it once', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const logs: LogInput[] = [];
    setLogSink((entry) => logs.push(entry));
    try {
      const h = harness({ soul: fastSoul() });
      h.messaging.listMessages.mockResolvedValue({
        messages: [
          voiceAt(1004, new Date(NOW.getTime() - HOUR).toISOString()),
        ],
        nextOffsetId: null,
      });
      h.messaging.downloadMedia.mockResolvedValue({
        data: Buffer.from('voice'),
        mimeType: 'audio/ogg',
        fileName: 'voice.ogg',
        disposition: 'inline',
        length: 5,
      });
      h.speech.transcribe.mockResolvedValue({
        text: 'текст голосового',
        language: 'ru',
        durationMs: 700,
      });

      const first = 'что я сказал в голосовом?';
      await h.internals.reply(
        'user-1',
        'account-1',
        CHAT_ID,
        question(1100, first),
        'Peer',
        h.tokenFor(),
        [{ id: 1100, text: first }],
      );
      expect(h.messaging.downloadMedia).toHaveBeenCalledTimes(1);
      expect(promptOf(h)).toContain('текст голосового');

      // Four minutes later the 3-minute prompt cache is stale, but the
      // per-message transcript is still fresh.
      vi.setSystemTime(new Date(NOW.getTime() + 4 * MINUTE));
      h.agent.run.mockClear();

      const second = 'а что там было в голосовом?';
      await h.internals.reply(
        'user-1',
        'account-1',
        CHAT_ID,
        question(1101, second),
        'Peer',
        h.tokenFor(),
        [{ id: 1101, text: second }],
      );

      expect(h.messaging.downloadMedia).toHaveBeenCalledTimes(1);
      expect(h.speech.transcribe).toHaveBeenCalledTimes(1);
      expect(promptOf(h)).toContain('текст голосового');
      expect(logs).toContainEqual(
        expect.objectContaining({
          action: 'dm.autopilot.voice',
          status: 'ok',
          details: expect.objectContaining({
            messageId: 1004,
            source: 'cached',
          }),
        }),
      );
    } finally {
      setLogSink(null);
    }
  });
});

describe('DmAutopilotService per-chat skills', () => {
  function skillHarness(skills: { slugs: string[]; source: 'chat' | 'soul' }) {
    return harness({
      skills,
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typing: false,
        }),
      }),
    });
  }

  it('uses the chat override instead of the soul skill set', async () => {
    const logs: LogInput[] = [];
    setLogSink((entry) => logs.push(entry));
    try {
      const h = skillHarness({ slugs: ['chat-skill'], source: 'chat' });

      await h.internals.reply(
        'user-1',
        'account-1',
        CHAT_ID,
        message(),
        'Peer',
        h.tokenFor(),
        [{ id: 1001, text: 'Hi there' }],
      );

      expect(h.chatSkills.resolve).toHaveBeenCalledWith(
        'account-1',
        CHAT_ID,
        0,
      );
      expect(h.agent.run).toHaveBeenCalledWith(
        expect.objectContaining({
          skillSlugs: ['chat-skill'],
          // The override is authoritative: soul skills are not added on top.
          replaceSoulSkills: true,
        }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          action: 'dm.autopilot.reply',
          details: expect.objectContaining({
            skillsSource: 'chat',
            skills: ['chat-skill'],
          }),
        }),
      );
    } finally {
      setLogSink(null);
    }
  });

  it('resolves the override of the forum topic the access gate saw', async () => {
    const h = skillHarness({ slugs: ['topic-skill'], source: 'chat' });

    await h.internals.reply(
      'user-1',
      'account-1',
      CHAT_ID,
      message(),
      'Peer',
      h.tokenFor(),
      [{ id: 1001, text: 'Hi there' }],
      7,
    );

    expect(h.aiAccess.accessFor).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      CHAT_ID,
      7,
    );
    expect(h.chatSkills.resolve).toHaveBeenCalledWith('account-1', CHAT_ID, 7);
    expect(h.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({ skillSlugs: ['topic-skill'] }),
    );
  });

  it('falls back to the soul skills when no override exists', async () => {
    const logs: LogInput[] = [];
    setLogSink((entry) => logs.push(entry));
    try {
      const h = skillHarness({ slugs: ['soul-skill'], source: 'soul' });

      await h.internals.reply(
        'user-1',
        'account-1',
        CHAT_ID,
        message(),
        'Peer',
        h.tokenFor(),
        [{ id: 1001, text: 'Hi there' }],
      );

      expect(h.agent.run).toHaveBeenCalledWith(
        expect.objectContaining({ skillSlugs: ['soul-skill'] }),
      );
      expect(logs).toContainEqual(
        expect.objectContaining({
          action: 'dm.autopilot.reply',
          details: expect.objectContaining({ skillsSource: 'soul' }),
        }),
      );
    } finally {
      setLogSink(null);
    }
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

describe('DmAutopilotService workflow gate', () => {
  it('stays silent when the account is assigned to a workflow', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      account: accountRow({ workflowId: 'workflow-1' } as never),
    });
    const before = h.internals.nextToken('account-1:42');

    await h.internals.onMessage('user-1', payload());

    // The gate runs before anything visible: no read receipt and no typing for
    // an account the workflow engine owns. It still resolves access, because
    // only an allowed chat stores the incoming turn for `generate` to read.
    expect(h.aiAccess.accessFor).toHaveBeenCalled();
    expect(h.presence.incoming).not.toHaveBeenCalled();
    expect(h.messaging.markRead).not.toHaveBeenCalled();
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
    expect(h.memory.append).toHaveBeenCalledWith(
      'account-1',
      CHAT_ID,
      'user',
      'Hi there',
      { messageId: 1001 },
    );

    // A newer message still bumps the run token, so an in-flight `replyNow`
    // is reported as superseded by the Action API.
    expect(h.internals.nextToken('account-1:42')).toBe(before + 2);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.agent.run).not.toHaveBeenCalled();
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('does not store an incoming turn outside the soul allowlist', async () => {
    const h = harness({
      account: accountRow({ workflowId: 'workflow-1' } as never),
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [],
          replyDelayMs: 0,
        }),
      }),
      accessFor: () => emptyAccess(),
    });

    await h.internals.onMessage('user-1', payload());

    expect(h.memory.append).not.toHaveBeenCalled();
    expect(h.messaging.markRead).not.toHaveBeenCalled();
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
  });

  it('turns the legacy autopilot off when AI_WORKFLOW_STRICT is on', async () => {
    vi.stubEnv('AI_WORKFLOW_STRICT', '1');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    await h.internals.onMessage('user-1', payload());
    await vi.advanceTimersByTimeAsync(5_000);

    expect(h.aiAccess.accessFor).not.toHaveBeenCalled();
    expect(h.agent.run).not.toHaveBeenCalled();
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the legacy reply when no workflow is set and strict is off', async () => {
    vi.stubEnv('AI_WORKFLOW_STRICT', '');
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    await h.internals.onMessage('user-1', payload());
    await vi.runAllTimersAsync();

    expect(h.agent.run).toHaveBeenCalled();
    expect(h.messaging.sendMessage).toHaveBeenCalled();
  });
});

describe('DmAutopilotService.replyNow', () => {
  const reply = {
    userId: 'user-1',
    accountId: 'account-1',
    chatId: CHAT_ID,
    prompt: 'Позови собеседника на кофе',
  };

  it('generates through the pipeline and returns the text without sending', async () => {
    const h = harness();

    const result = await h.service.replyNow({ ...reply, returnText: true });

    expect(result).toEqual({
      sent: false,
      superseded: false,
      text: 'Hello back',
      messageIds: [],
      state: 'composing',
    });
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
    // The owner prompt is not stored as a peer turn.
    expect(h.memory.append).not.toHaveBeenCalled();
    const input = h.agent.run.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.prompt).toContain('Задание от владельца для этого чата:');
    expect(input.prompt).toContain('Позови собеседника на кофе');
    expect(input.prompt).toContain('ответ в чат пишешь ты сама');
    expect(input.prompt).not.toContain('от лица владельца');
    expect(input.skillSlugs).toEqual([]);
  });

  it('sends when returnText is off', async () => {
    const h = harness();

    const result = await h.service.replyNow(reply);

    expect(result).toMatchObject({ sent: true, superseded: false });
    expect(result.messageIds).toEqual([2002]);
    expect(h.messaging.sendMessage).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Hello back' },
    );
    expect(h.memory.append).toHaveBeenCalledWith(
      'account-1',
      CHAT_ID,
      'assistant',
      'Hello back',
      { messageId: 2002, runId: 'run-1' },
    );
  });

  it('reports a newer message as superseded instead of throwing', async () => {
    const h = harness();
    const gate = deferred<{
      runId: string;
      text: string;
      model: string;
      steps: number;
      trace: unknown[];
      usage: { promptTokens: number; completionTokens: number };
    }>();
    h.agent.run.mockImplementationOnce(async () => gate.promise);

    const run = h.service.replyNow(reply);
    await vi.waitFor(() => expect(h.agent.run).toHaveBeenCalled());
    // Exactly what `onMessage` does when the next message arrives.
    h.internals.nextToken('account-1:42');
    gate.resolve({
      runId: 'run-1',
      text: 'Hello back',
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    await expect(run).resolves.toEqual({
      sent: false,
      superseded: true,
      text: 'Hello back',
      messageIds: [],
      state: 'superseded',
    });
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a blocked chat before generating', async () => {
    const h = harness({
      accessFor: () => decision({ block: blockRow({ reason: 'spam' }) }),
    });

    await expect(h.service.replyNow(reply)).rejects.toMatchObject({
      status: 403,
    });
    expect(h.agent.run).not.toHaveBeenCalled();
  });

  it('refuses a chat outside the soul allowlist before generating', async () => {
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [],
          replyDelayMs: 0,
        }),
      }),
      accessFor: () => emptyAccess(),
    });

    await expect(h.service.replyNow(reply)).rejects.toMatchObject({
      status: 403,
      response: { code: 'CHAT_NOT_ALLOWED' },
    });
    expect(h.agent.run).not.toHaveBeenCalled();
    expect(h.memory.append).not.toHaveBeenCalled();
  });
});

/** `ai.state` events of one harness, in emission order. */
function stateEvents(h: ReturnType<typeof harness>): Array<Record<string, unknown>> {
  return h.realtime.emitToUser.mock.calls
    .filter(([, event]) => event === 'ai.state')
    .map(([, , payload]) => payload as Record<string, unknown>);
}

/** State names without consecutive duplicates (`thinking` is emitted twice). */
function stateSequence(h: ReturnType<typeof harness>): string[] {
  const names = stateEvents(h).map((payload) => String(payload.state));
  return names.filter((name, index) => name !== names[index - 1]);
}

describe('DmAutopilotService state machine', () => {
  it('walks received → read → waiting → thinking → composing → sending → sent → idle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    h.agent.run.mockImplementation(async (input: AgentRunInput) => {
      input.onRunStart?.('run-1');
      return {
        runId: 'run-1',
        text: 'Hello back',
        model: 'main-model',
        steps: 1,
        trace: [],
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    });

    await h.internals.onMessage('user-1', payload({ id: 1001 }));
    expect(stateSequence(h)).toEqual(['received', 'read', 'waiting']);

    await vi.runAllTimersAsync();

    expect(stateSequence(h)).toEqual([
      'received',
      'read',
      'waiting',
      'thinking',
      'composing',
      'sending',
      'sent',
      'idle',
    ]);

    const first = stateEvents(h)[0];
    expect(first).toEqual({
      accountId: 'account-1',
      chatId: CHAT_ID,
      state: 'received',
      since: expect.any(Number),
      runId: null,
      messageId: 1001,
      part: 0,
      total: 0,
    });
    // The policy is part of the record, never of the WS payload.
    expect(first).not.toHaveProperty('typingMode');
    expect(h.states.get('account-1', CHAT_ID).typingMode).toBe('smart');
  });

  it('reports a blocked chat without reading or generating', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      accessFor: () => decision({ block: blockRow({ reason: 'spam' }) }),
    });

    await h.internals.onMessage('user-1', payload({ id: 1001 }));

    expect(stateSequence(h)).toEqual(['blocked']);
    expect(h.messaging.markRead).not.toHaveBeenCalled();
    expect(h.agent.run).not.toHaveBeenCalled();
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
  });

  it('marks the running answer superseded when a newer message arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    const slow = deferred<void>();
    h.agent.run.mockImplementationOnce(async (input: AgentRunInput) => {
      input.onRunStart?.('run-1');
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
    expect(h.states.stateOf('account-1', CHAT_ID)).toBe('thinking');

    await h.internals.onMessage('user-1', payload({ id: 1002, text: 'second' }));
    const names = stateEvents(h).map((payload) => payload.state);
    const supersededAt = names.indexOf('superseded');
    expect(supersededAt).toBeGreaterThan(-1);
    expect(names.slice(supersededAt)).toContain('received');
    expect(h.states.get('account-1', CHAT_ID).messageId).toBe(1002);

    slow.resolve();
    await vi.runAllTimersAsync();
    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
    expect(stateSequence(h)).toContain('sent');
  });

  it('reports error when generation fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();
    h.agent.run.mockRejectedValueOnce(new Error('llm down'));

    await h.internals.onMessage('user-1', payload({ id: 1001 }));
    await vi.runAllTimersAsync();

    expect(h.states.stateOf('account-1', CHAT_ID)).toBe('error');
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
  });
});

describe('DmAutopilotService typing modes', () => {
  function typingSoul(settings: Record<string, unknown>) {
    return soulRow({
      settings: JSON.stringify({
        ...DEFAULT_SOUL_SETTINGS,
        chatIds: [CHAT_ID],
        replyDelayMs: 0,
        ...settings,
      }),
    });
  }

  it('off: never sends typing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({ soul: typingSoul({ typingMode: 'off' }) });

    await h.internals.onMessage('user-1', payload({ id: 1001 }));
    await vi.runAllTimersAsync();

    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('on_think: starts right after the reply begins, no start delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: typingSoul({
        typingMode: 'on_think',
        typingStartDelayMs: 5_000,
      }),
    });
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

    await h.internals.onMessage('user-1', payload({ id: 1001 }));
    // Right after the read receipt — before the debounce and the model call.
    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { status: 'typing' },
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(h.states.stateOf('account-1', CHAT_ID)).toBe('thinking');

    thinking.resolve();
    await vi.runAllTimersAsync();
  });

  it('stops the heartbeat when the chat becomes blocked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let blocked = false;
    const h = harness({
      soul: typingSoul({ typingMode: 'on_think' }),
      accessFor: () =>
        blocked
          ? decision({ block: blockRow({ reason: 'spam' }) })
          : emptyAccess(),
    });

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
    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { status: 'typing' },
    );

    // Let the 10 s access-decision cache expire; the first run is still
    // waiting for the model, so its heartbeat is what must be stopped.
    await vi.advanceTimersByTimeAsync(10_100);
    blocked = true;
    await h.internals.onMessage('user-1', payload({ id: 1002, text: 'second' }));

    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { status: 'cancel' },
    );
    expect(h.states.stateOf('account-1', CHAT_ID)).toBe('blocked');

    slow.resolve();
    await vi.runAllTimersAsync();
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('on_compose: no typing during the LLM call, typing only with ready text', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: typingSoul({ typingMode: 'on_compose' }),
    });
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

    await h.internals.onMessage('user-1', payload({ id: 1001 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.states.stateOf('account-1', CHAT_ID)).toBe('thinking');
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

  it('clamps the heartbeat to at least 2 s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: typingSoul({
        typingMode: 'on_think',
        typingHeartbeatMs: 500,
      }),
    });
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

    const typingCalls = () =>
      h.messaging.sendTyping.mock.calls.filter(
        (call) => (call[3] as { status?: string }).status === 'typing',
      ).length;

    await h.internals.onMessage('user-1', payload({ id: 1001 }));
    await vi.advanceTimersByTimeAsync(300);
    expect(typingCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_500);
    expect(typingCalls()).toBe(1);

    await vi.advanceTimersByTimeAsync(600);
    expect(typingCalls()).toBe(2);

    thinking.resolve();
    await vi.runAllTimersAsync();
  });

  it('stops the heartbeat when a newer message supersedes the run', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: typingSoul({ typingMode: 'on_think' }),
    });
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
    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { status: 'typing' },
    );

    await h.internals.onMessage('user-1', payload({ id: 1002, text: 'second' }));
    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { status: 'cancel' },
    );
    expect(h.states.stateOf('account-1', CHAT_ID)).toBe('waiting');

    slow.resolve();
    await vi.runAllTimersAsync();
  });
});

describe('DmAutopilotService.generateReply', () => {
  it('returns policy-shaped parts without sending or typing', async () => {
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          maxParts: 3,
        }),
      }),
    });
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: `${PART_ONE}\n---\n${PART_TWO}`,
      reasoning: 'почему так',
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const result = await h.service.generateReply({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      messageId: 1001,
    });

    expect(result).toMatchObject({
      runId: 'run-1',
      reasoning: 'почему так',
      state: 'composing',
      superseded: false,
      duplicate: false,
      blocked: false,
    });
    expect(result.parts).toEqual([
      { text: PART_ONE, replyToMessageId: 1001 },
      { text: PART_TWO, replyToMessageId: 1001 },
    ]);
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
    // The owner prompt is not stored as a peer turn.
    expect(h.memory.append).not.toHaveBeenCalled();
    const input = h.agent.run.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.prompt).toContain('Напиши следующее сообщение');
  });

  it('lets the Action API override the soul bubble cap', async () => {
    const h = harness();
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: `${PART_ONE}\n---\n${PART_TWO}`,
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const result = await h.service.generateReply({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      maxParts: 3,
      prompt: 'Позови на кофе',
    });

    expect(result.parts).toHaveLength(2);
    const input = h.agent.run.mock.calls[0]?.[0] as AgentRunInput;
    expect(input.prompt).toContain('Позови на кофе');
  });

  it('returns one merged bubble with the default cap', async () => {
    const h = harness();
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: `${PART_ONE}\n---\n${PART_TWO}`,
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    const result = await h.service.generateReply({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
    });
    expect(result.parts).toHaveLength(1);
    expect(result.parts[0]?.text).toContain(PART_TWO);
  });

  it('deduplicates the same message within the TTL', async () => {
    const h = harness();
    h.agent.run.mockResolvedValue({
      runId: 'run-1',
      text: 'Hello back',
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    await h.service.generateReply({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      messageId: 1001,
    });
    const second = await h.service.generateReply({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      messageId: 1001,
    });

    expect(second).toMatchObject({ duplicate: true, parts: [] });
    expect(h.agent.run).toHaveBeenCalledTimes(1);
  });

  it('reports a blocked chat instead of throwing', async () => {
    const h = harness({
      accessFor: () => decision({ block: blockRow({ reason: 'spam' }) }),
    });

    const result = await h.service.generateReply({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      messageId: 1001,
    });

    expect(result).toMatchObject({ blocked: true, state: 'blocked', parts: [] });
    expect(h.agent.run).not.toHaveBeenCalled();
  });

  it('reports a chat outside the soul allowlist as blocked', async () => {
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [],
          replyDelayMs: 0,
        }),
      }),
      accessFor: () => emptyAccess(),
    });

    const result = await h.service.generateReply({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      messageId: 1001,
    });

    expect(result).toMatchObject({ blocked: true, state: 'blocked', parts: [] });
    expect(h.agent.run).not.toHaveBeenCalled();
  });

  it('lets an explicit access row enable a chat outside the allowlist', async () => {
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [],
          replyDelayMs: 0,
        }),
      }),
      accessFor: () =>
        decision({ allowed: true, access: accessRow({ enabled: true }) }),
    });

    const result = await h.service.generateReply({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      messageId: 1001,
    });

    expect(result).toMatchObject({ blocked: false, parts: [{ text: 'Hello back' }] });
    expect(h.agent.run).toHaveBeenCalledTimes(1);
  });

  it('reports superseded when a newer message takes over', async () => {
    const h = harness();
    const gate = deferred<{
      runId: string;
      text: string;
      model: string;
      steps: number;
      trace: unknown[];
      usage: { promptTokens: number; completionTokens: number };
    }>();
    h.agent.run.mockImplementationOnce(async () => gate.promise);

    const run = h.service.generateReply({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      messageId: 1001,
    });
    await vi.waitFor(() => expect(h.agent.run).toHaveBeenCalled());
    h.internals.nextToken(`account-1:${CHAT_ID}`);
    gate.resolve({
      runId: 'run-1',
      text: 'Hello back',
      model: 'main-model',
      steps: 1,
      trace: [],
      usage: { promptTokens: 1, completionTokens: 1 },
    });

    await expect(run).resolves.toMatchObject({
      superseded: true,
      parts: [],
      state: 'superseded',
    });
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
  });
});

describe('DmAutopilotService.simulateIncoming', () => {
  it('queues a synthetic incoming message for an allowed chat', async () => {
    const h = harness();

    const result = await h.service.simulateIncoming(
      'user-1',
      'account-1',
      CHAT_ID,
      'тест',
    );

    expect(result.queued).toBe(true);
    expect(result.messageId).toBeGreaterThan(2_000_000_000);
    const call = h.realtime.emitToUser.mock.calls.find(
      ([, event]) => event === 'message.new',
    );
    expect(call?.[0]).toBe('user-1');
    const payload = call?.[2] as {
      accountId: string;
      chatId: number;
      message: MessageView;
    };
    expect(payload.accountId).toBe('account-1');
    expect(payload.chatId).toBe(CHAT_ID);
    expect(payload.message).toMatchObject({
      id: result.messageId,
      outgoing: false,
      text: 'тест',
      senderName: 'Тест',
    });
  });

  it('refuses a chat outside the soul allowlist', async () => {
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [],
          replyDelayMs: 0,
        }),
      }),
      accessFor: () => emptyAccess(),
    });

    await expect(
      h.service.simulateIncoming('user-1', 'account-1', CHAT_ID, 'тест'),
    ).rejects.toMatchObject({
      status: 403,
      response: { code: 'CHAT_NOT_ALLOWED' },
    });
    expect(h.realtime.emitToUser).not.toHaveBeenCalled();
  });
});

describe('DmAutopilotService.sendText', () => {
  it('sends bubbles with typing:auto and reports the state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness({
      soul: soulRow({
        settings: JSON.stringify({
          ...DEFAULT_SOUL_SETTINGS,
          chatIds: [CHAT_ID],
          replyDelayMs: 0,
          typingMode: 'on_compose',
        }),
      }),
    });
    h.messaging.sendMessage
      .mockResolvedValueOnce(message({ id: 3001, outgoing: true }))
      .mockResolvedValueOnce(message({ id: 3002, outgoing: true }));

    const pending = h.service.sendText({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      parts: ['Привет', 'Как дела?'],
      replyToId: 1001,
      typing: 'auto',
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({
      messageIds: [3001, 3002],
      state: 'sent',
      typingMs: 3_000,
    });
    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      'account-1',
      String(CHAT_ID),
      { status: 'typing' },
    );
    expect(h.messaging.sendMessage).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Привет', replyToId: 1001 },
    );
    expect(h.messaging.sendMessage).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'account-1',
      String(CHAT_ID),
      { text: 'Как дела?' },
    );
  });

  it('sends instantly with typing:off', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    const pending = h.service.sendText({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      parts: ['Привет'],
      typing: 'off',
    });
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.messageIds).toEqual([2002]);
    expect(result.typingMs).toBe(0);
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
  });

  it('honours an explicit number of milliseconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    const pending = h.service.sendText({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: CHAT_ID,
      parts: ['Привет'],
      typing: 1200,
    });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(h.messaging.sendMessage).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result.typingMs).toBe(1_200);
    expect(h.messaging.sendMessage).toHaveBeenCalledTimes(1);
  });
});
