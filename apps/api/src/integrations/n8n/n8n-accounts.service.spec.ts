import { describe, expect, it, vi } from 'vitest';
import { N8nAccountsService } from './n8n-accounts.service.js';

const ACCOUNT = {
  id: 'acc-1',
  firstName: 'Роман',
  lastName: 'Петров',
  username: 'roman',
  tgUserId: BigInt(9001),
  isActive: true,
  workflowId: 'wf-1',
  aiVariables: JSON.stringify({ promo: 'spring' }),
  soul: {
    name: 'Sales',
    mode: 'auto',
    temperature: 0.7,
    model: 'gpt-5',
    settings: JSON.stringify({
      maxPerHour: 20,
      maxPerChatPerDay: 100,
      replyDelayMs: 500,
      typing: false,
      typingSpeed: 420,
    }),
  },
  workflow: { id: 'wf-1', name: 'Sales', enabled: true },
};

function harness() {
  const prisma = {
    telegramAccount: {
      findMany: vi.fn(async () => [
        ACCOUNT,
        {
          id: 'acc-2',
          firstName: 'Без',
          lastName: null,
          username: null,
          isActive: false,
          workflowId: null,
          aiVariables: 'not-json',
          soul: null,
          workflow: null,
        },
      ]),
      findFirst: vi.fn(
        async ({ where, select }: { where: { id: string }; select?: unknown }) => {
          if (where.id !== 'acc-1') return null;
          if (select) return { aiVariables: ACCOUNT.aiVariables };
          return ACCOUNT;
        },
      ),
      update: vi.fn(async ({ data }: { data: { aiVariables: string } }) => ({
        ...ACCOUNT,
        aiVariables: data.aiVariables,
      })),
    },
    aiChatAccess: {
      findMany: vi.fn(async () => [
        { chatId: BigInt(42) },
        { chatId: BigInt(42) },
        { chatId: BigInt(43) },
      ]),
    },
    aiChatTag: {
      findMany: vi.fn(async () => [{ chatId: BigInt(44) }]),
    },
    aiChatSetting: {
      findMany: vi.fn(async () => [{ chatId: BigInt(42) }]),
    },
  };
  const messaging = {
    listChats: vi.fn(async () => [
      {
        id: 42,
        type: 'user',
        title: 'Роман',
        username: 'peer',
        unreadCount: 3,
        lastMessage: null,
        pinned: false,
        muted: false,
        archived: false,
        readInboxMaxId: 0,
        canSendMessages: true,
      },
    ]),
    listMessages: vi.fn(async () => ({
      messages: [
        {
          id: 900,
          chatId: 42,
          text: 'Привет',
          date: '2026-11-25T12:00:00.000Z',
          outgoing: false,
          edited: false,
          senderId: 42,
          senderName: 'Роман',
          replyToId: null,
          mediaType: null,
          media: null,
          reactions: [],
          poll: null,
          isVoice: false,
          thread: null,
        },
      ],
      nextOffsetId: null,
    })),
  };
  const aiState = {
    variables: vi.fn(async (userId: string, accountId: string) => ({
      accountId,
      variables: { promo: 'spring' },
    })),
    setVariables: vi.fn(
      async (_userId: string, accountId: string, body: { variables?: unknown }) => ({
        accountId,
        variables: body.variables as Record<string, string>,
      }),
    ),
  };
  const context = {
    account: vi.fn(async () => ({ phone: '+15551234567' })),
    chat: vi.fn(
      async (
        _userId: string,
        _accountId: string,
        chatId: number,
        threadId = 0,
      ) => ({
        id: chatId,
        threadId,
        title: 'Клиент',
        username: 'client',
        type: 'user',
        tags: ['vip'],
        access: { allowed: true, blocked: false, warnings: 1, reason: null },
      }),
    ),
    chatSettings: vi.fn(async () => ({ typing: 'natural', maxParts: 3 })),
    invalidateAccount: vi.fn(),
    invalidateChat: vi.fn(),
  };
  return {
    service: new N8nAccountsService(
      prisma as never,
      messaging as never,
      context as never,
      aiState as never,
    ),
    prisma,
    messaging,
    context,
    aiState,
  };
}

describe('N8nAccountsService', () => {
  it('lists accounts with workflow, soul, variables and enabled state', async () => {
    const h = harness();
    const accounts = await h.service.list('user-1');
    expect(accounts).toEqual([
      {
        id: 'acc-1',
        title: 'Роман Петров',
        username: 'roman',
        workflowId: 'wf-1',
        workflowName: 'Sales',
        soulMode: 'auto',
        enabled: true,
        variables: { promo: 'spring' },
        soul: { name: 'Sales', mode: 'auto', temperature: 0.7 },
      },
      {
        id: 'acc-2',
        title: 'Без',
        username: null,
        workflowId: null,
        workflowName: null,
        soulMode: 'off',
        enabled: false,
        variables: {},
        soul: null,
      },
    ]);
  });

  it('returns the full account view with soul, limits and chat count', async () => {
    const h = harness();
    const detail = await h.service.detail('user-1', 'acc-1');
    expect(detail).toMatchObject({
      id: 'acc-1',
      tgUserId: '9001',
      title: 'Роман Петров',
      firstName: 'Роман',
      lastName: 'Петров',
      username: 'roman',
      phone: '+15551234567',
      isActive: true,
      workflow: { id: 'wf-1', name: 'Sales', enabled: true },
      variables: { promo: 'spring' },
      limits: {
        maxPerHour: 20,
        maxPerChatPerDay: 100,
        replyDelayMs: 500,
        typing: false,
        typingSpeed: 420,
      },
      chatCount: 3,
    });
    expect(detail.soul).toMatchObject({
      name: 'Sales',
      mode: 'auto',
      temperature: 0.7,
      model: 'gpt-5',
      settings: { maxPerHour: 20, typing: false },
    });
  });

  it('derives default limits when the soul has no settings and treats a missing account as 404', async () => {
    const h = harness();
    h.prisma.telegramAccount.findFirst.mockResolvedValueOnce({
      ...ACCOUNT,
      soul: { ...ACCOUNT.soul, settings: '{}' },
    } as never);
    const detail = await h.service.detail('user-1', 'acc-1');
    expect(detail.limits).toEqual({
      maxPerHour: 12,
      maxPerChatPerDay: 40,
      replyDelayMs: 1200,
      typing: true,
      typingSpeed: 300,
    });

    await expect(h.service.detail('user-1', 'acc-x')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('reads one chat with tags, access, settings and its last messages', async () => {
    const h = harness();
    const view = await h.service.chat('user-1', 'acc-1', '42', '7', '5');
    expect(h.context.chat).toHaveBeenCalledWith('user-1', 'acc-1', 42, 7);
    expect(h.context.chatSettings).toHaveBeenCalledWith('acc-1', 42, 7);
    expect(h.messaging.listMessages).toHaveBeenCalledWith(
      'user-1',
      'acc-1',
      '42',
      { limit: 5 },
    );
    expect(view.chat).toMatchObject({
      id: 42,
      threadId: 7,
      title: 'Клиент',
      tags: ['vip'],
      access: { allowed: true, blocked: false, warnings: 1, reason: null },
      settings: { typing: 'natural', maxParts: 3 },
    });
    expect(view.messages).toEqual([
      {
        id: 900,
        date: '2026-11-25T12:00:00.000Z',
        text: 'Привет',
        outgoing: false,
        transcript: null,
      },
    ]);
  });

  it('defaults the chat read to ten messages and rejects a bad thread id', async () => {
    const h = harness();
    await h.service.chat('user-1', 'acc-1', '42', undefined, undefined);
    expect(h.messaging.listMessages).toHaveBeenCalledWith(
      'user-1',
      'acc-1',
      '42',
      { limit: 10 },
    );
    await expect(
      h.service.chat('user-1', 'acc-1', '42', '-1', undefined),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('maps the chat list to the n8n shape', async () => {
    const h = harness();
    const chats = await h.service.chats('user-1', 'acc-1', '10');
    expect(h.messaging.listChats).toHaveBeenCalledWith('user-1', 'acc-1', {
      limit: 10,
    });
    expect(chats).toEqual([
      {
        id: 42,
        title: 'Роман',
        type: 'user',
        username: 'peer',
        unread: 3,
      },
    ]);
  });

  it('treats an unknown account as missing', async () => {
    const h = harness();
    await expect(h.service.chats('user-1', 'acc-x')).rejects.toMatchObject({
      status: 404,
    });
  });

  it('delegates variables reads and writes to the shared AI state service', async () => {
    const h = harness();
    expect(await h.service.variables('user-1', 'acc-1')).toEqual({
      accountId: 'acc-1',
      variables: { promo: 'spring' },
    });
    expect(h.aiState.variables).toHaveBeenCalledWith('user-1', 'acc-1');

    const body = { variables: { promo: 'autumn', tier: 'gold' } };
    expect(await h.service.setVariables('user-1', 'acc-1', body)).toEqual({
      accountId: 'acc-1',
      variables: { promo: 'autumn', tier: 'gold' },
    });
    expect(h.aiState.setVariables).toHaveBeenCalledWith(
      'user-1',
      'acc-1',
      body,
    );
  });
});
