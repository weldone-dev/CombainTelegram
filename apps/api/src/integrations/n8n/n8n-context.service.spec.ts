import { describe, expect, it, vi } from 'vitest';
import { RealtimeService } from '../../realtime/realtime.service.js';
import { N8nContextService } from './n8n-context.service.js';

const ACCOUNT_ROW = {
  id: 'acc-1',
  firstName: 'Роман',
  lastName: 'Петров',
  username: 'roman',
  tgUserId: BigInt(9001),
  workflowId: 'wf-1',
  aiVariables: JSON.stringify({ promo: 'spring', tier: 'gold' }),
  phoneEncrypted: new Uint8Array([1]),
  phoneNonce: new Uint8Array([2]),
  phoneTag: new Uint8Array([3]),
  soul: { name: 'Sales', mode: 'auto', temperature: 0.7 },
};

function harness() {
  const prisma = {
    telegramAccount: {
      findUnique: vi.fn(async () => ACCOUNT_ROW),
    },
    aiChatSetting: {
      findMany: vi.fn(async () => [
        { threadId: 0, settings: JSON.stringify({ typing: 'instant' }) },
        { threadId: 7, settings: JSON.stringify({ maxParts: 2 }) },
      ]),
    },
  };
  const crypto = {
    deserialize: vi.fn(() => ({})),
    decrypt: vi.fn(() => Buffer.from('79123456789')),
  };
  const messaging = {
    getChat: vi.fn(async () => ({
      id: 42,
      type: 'user',
      title: 'Клиент',
      username: 'client',
    })),
  };
  const tags = { list: vi.fn(async () => ['vip', 'lead']) };
  const access = {
    view: vi.fn(async () => ({
      allowed: true,
      blocked: false,
      warnings: 2,
      reason: null,
      soulId: null,
      note: null,
      threadId: 0,
    })),
  };
  const realtime = new RealtimeService();
  return {
    service: new N8nContextService(
      prisma as never,
      crypto as never,
      messaging as never,
      tags as never,
      access as never,
      realtime,
    ),
    prisma,
    crypto,
    messaging,
    tags,
    access,
    realtime,
  };
}

describe('N8nContextService', () => {
  it('builds the account block with parsed variables and a decrypted phone', async () => {
    const h = harness();
    const account = await h.service.account('acc-1');
    expect(account).toEqual({
      id: 'acc-1',
      title: 'Роман Петров',
      firstName: 'Роман',
      lastName: 'Петров',
      username: 'roman',
      phone: '+79123456789',
      tgUserId: '9001',
      workflowId: 'wf-1',
      variables: { promo: 'spring', tier: 'gold' },
      soul: { name: 'Sales', mode: 'auto', temperature: 0.7 },
    });
    expect(h.crypto.decrypt).toHaveBeenCalledWith({}, 'phone:acc-1');

    // Cached: a burst of events does not hammer the database.
    await h.service.account('acc-1');
    expect(h.prisma.telegramAccount.findUnique).toHaveBeenCalledTimes(1);
  });

  it('degrades a missing account and a broken phone envelope to null', async () => {
    const h = harness();
    h.prisma.telegramAccount.findUnique.mockResolvedValueOnce(null as never);
    expect(await h.service.account('acc-x')).toBeNull();

    h.prisma.telegramAccount.findUnique.mockResolvedValueOnce({
      ...ACCOUNT_ROW,
      soul: null,
      aiVariables: 'not-json',
    } as never);
    h.crypto.decrypt.mockImplementationOnce(() => {
      throw new Error('bad key');
    });
    const account = await h.service.account('acc-1');
    expect(account?.phone).toBeNull();
    expect(account?.soul).toBeNull();
    expect(account?.variables).toEqual({});
  });

  it('builds the chat block with identity, tags and access', async () => {
    const h = harness();
    const chat = await h.service.chat('user-1', 'acc-1', 42, 7);
    expect(chat).toEqual({
      id: 42,
      threadId: 7,
      title: 'Клиент',
      username: 'client',
      type: 'user',
      tags: ['vip', 'lead'],
      access: { allowed: true, blocked: false, warnings: 2, reason: null },
    });
    expect(h.access.view).toHaveBeenCalledWith('user-1', 'acc-1', 42, 7);

    await h.service.chat('user-1', 'acc-1', 42, 7);
    expect(h.messaging.getChat).toHaveBeenCalledTimes(1);
    expect(h.tags.list).toHaveBeenCalledTimes(1);
    expect(h.access.view).toHaveBeenCalledTimes(1);
  });

  it('normalises thread ids and returns null without a chat id', async () => {
    const h = harness();
    expect(await h.service.chat('user-1', 'acc-1', 42, -5)).toMatchObject({
      threadId: 0,
    });
    expect(await h.service.chat('user-1', 'acc-1', 0)).toBeNull();
    expect(h.messaging.getChat).toHaveBeenCalledTimes(1);
  });

  it('never fails an event when Telegram or the AI tables are unavailable', async () => {
    const h = harness();
    h.messaging.getChat.mockRejectedValueOnce(new Error('peer not found'));
    h.tags.list.mockRejectedValueOnce(new Error('db down'));
    h.access.view.mockRejectedValueOnce(new Error('db down'));

    const chat = await h.service.chat('user-1', 'acc-1', 42);
    expect(chat).toEqual({
      id: 42,
      threadId: 0,
      title: '',
      username: null,
      type: 'unknown',
      tags: [],
      access: { allowed: false, blocked: false, warnings: 0, reason: null },
    });
  });

  it('drops cache entries on the shared AI state bus event', async () => {
    const h = harness();
    h.service.onModuleInit();
    await h.service.account('acc-1');
    await h.service.chat('user-1', 'acc-1', 42);

    h.realtime.emitToUser('user-1', 'ai.state.changed', {
      accountId: 'acc-1',
      chatId: 42,
      threadId: 0,
    });
    await h.service.account('acc-1');
    await h.service.chat('user-1', 'acc-1', 42);

    expect(h.prisma.telegramAccount.findUnique).toHaveBeenCalledTimes(2);
    expect(h.tags.list).toHaveBeenCalledTimes(2);
    h.service.onModuleDestroy();
  });

  it('refreshes the cache after an invalidation', async () => {
    const h = harness();
    await h.service.chat('user-1', 'acc-1', 42);
    h.service.invalidateChat('acc-1', 42);
    await h.service.chat('user-1', 'acc-1', 42);
    expect(h.tags.list).toHaveBeenCalledTimes(2);

    await h.service.account('acc-1');
    h.service.invalidateAccount('acc-1');
    await h.service.account('acc-1');
    expect(h.prisma.telegramAccount.findUnique).toHaveBeenCalledTimes(2);
  });

  it('reads per-chat settings with a whole-chat fallback', async () => {
    const h = harness();
    expect(await h.service.chatSettings('acc-1', 42, 7)).toEqual({
      maxParts: 2,
    });
    expect(await h.service.chatSettings('acc-1', 42, 0)).toEqual({
      typing: 'instant',
    });

    h.prisma.aiChatSetting.findMany.mockResolvedValueOnce([
      { threadId: 0, settings: 'not-json' },
    ]);
    expect(await h.service.chatSettings('acc-1', 42, 5)).toEqual({});
  });
});
