import { describe, expect, it, vi } from 'vitest';
import {
  AccountAiStateService,
  CHAT_SETTINGS_MAX_BYTES,
  validateChatSettings,
  validateVariables,
  VARIABLES_MAX_BYTES,
  VARIABLES_MAX_KEYS,
  VARIABLES_MAX_VALUE_CHARS,
} from './account-ai-state.service.js';

function harness() {
  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'acc-1'
          ? { id: 'acc-1', aiVariables: JSON.stringify({ promo: 'spring' }) }
          : null,
      ),
      update: vi.fn(async () => ({})),
    },
    aiChatSetting: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
  };
  const realtime = { emitToUser: vi.fn() };
  return {
    service: new AccountAiStateService(prisma as never, realtime as never),
    prisma,
    realtime,
  };
}

describe('validateVariables', () => {
  it('accepts a plain object of strings, including an empty one', () => {
    expect(validateVariables({ a: '1', b: '' })).toEqual({ a: '1', b: '' });
    expect(validateVariables({})).toEqual({});
  });

  it('enforces the key, value-length and total-size limits', () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: VARIABLES_MAX_KEYS + 1 }, (_, index) => [
        `k${index}`,
        'v',
      ]),
    );
    expect(() => validateVariables(tooMany)).toThrow(/at most 32 keys/);

    expect(() =>
      validateVariables({ big: 'x'.repeat(VARIABLES_MAX_VALUE_CHARS + 1) }),
    ).toThrow(/at most 2000 characters/);

    const huge = Object.fromEntries(
      Array.from({ length: VARIABLES_MAX_KEYS }, (_, index) => [
        `k${index}`,
        'x'.repeat(VARIABLES_MAX_VALUE_CHARS),
      ]),
    );
    expect(Buffer.byteLength(JSON.stringify(huge), 'utf8')).toBeGreaterThan(
      VARIABLES_MAX_BYTES,
    );
    expect(() => validateVariables(huge)).toThrow(/at most 16384 bytes/);

    expect(() => validateVariables({ ' ': 'v' })).toThrow(/must not be empty/);
  });

  it('rejects non-objects and non-string values', () => {
    for (const raw of [undefined, null, [], 'text', 5]) {
      expect(() => validateVariables(raw)).toThrow(/plain JSON object/);
    }
    expect(() => validateVariables({ n: 5 })).toThrow(/must be a string/);
  });
});

describe('validateChatSettings', () => {
  it('accepts a plain object of any JSON values, empty included', () => {
    expect(validateChatSettings({})).toEqual({});
    expect(
      validateChatSettings({ typing: 'natural', maxParts: 2, quiet: true }),
    ).toEqual({ typing: 'natural', maxParts: 2, quiet: true });
  });

  it('rejects non-objects and objects over the 4 KB bound', () => {
    for (const raw of [undefined, null, [], 'text', 7]) {
      expect(() => validateChatSettings(raw)).toThrow(/plain JSON object/);
    }
    expect(() =>
      validateChatSettings({ big: 'x'.repeat(CHAT_SETTINGS_MAX_BYTES) }),
    ).toThrow(new RegExp(`at most ${CHAT_SETTINGS_MAX_BYTES} bytes`));
  });
});

describe('AccountAiStateService variables', () => {
  it('reads the stored variables and returns a parsed object', async () => {
    const h = harness();
    expect(await h.service.variables('user-1', 'acc-1')).toEqual({
      accountId: 'acc-1',
      variables: { promo: 'spring' },
    });
    expect(h.prisma.telegramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: 'acc-1', userId: 'user-1' },
      select: { aiVariables: true },
    });
  });

  it('replaces them and announces the change on the bus', async () => {
    const h = harness();
    const result = await h.service.setVariables('user-1', 'acc-1', {
      variables: { promo: 'autumn' },
    });
    expect(result).toEqual({
      accountId: 'acc-1',
      variables: { promo: 'autumn' },
    });
    expect(h.prisma.telegramAccount.update).toHaveBeenCalledWith({
      where: { id: 'acc-1' },
      data: { aiVariables: JSON.stringify({ promo: 'autumn' }) },
    });
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.state.changed',
      { accountId: 'acc-1', chatId: null, threadId: null },
    );
  });

  it('validates the body and treats another user\'s account as missing', async () => {
    const h = harness();
    await expect(
      h.service.setVariables('user-1', 'acc-1', { variables: [] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.service.setVariables('user-1', 'acc-x', { variables: {} }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.telegramAccount.update).not.toHaveBeenCalled();
  });
});

describe('AccountAiStateService chat settings', () => {
  it('returns an empty object when the chat/thread has no row', async () => {
    const h = harness();
    expect(await h.service.chatSettings('user-1', 'acc-1', '42')).toEqual({
      settings: {},
    });
    expect(h.prisma.aiChatSetting.findUnique).toHaveBeenCalledWith({
      where: {
        accountId_chatId_threadId: {
          accountId: 'acc-1',
          chatId: BigInt(42),
          threadId: 0,
        },
      },
    });
  });

  it('reads the row of exactly that chat and thread', async () => {
    const h = harness();
    h.prisma.aiChatSetting.findUnique.mockResolvedValueOnce({
      settings: JSON.stringify({ typing: 'natural' }),
    } as never);

    expect(await h.service.chatSettings('user-1', 'acc-1', '42', '7')).toEqual({
      settings: { typing: 'natural' },
    });
    expect(h.prisma.aiChatSetting.findUnique).toHaveBeenCalledWith({
      where: {
        accountId_chatId_threadId: {
          accountId: 'acc-1',
          chatId: BigInt(42),
          threadId: 7,
        },
      },
    });
  });

  it('upserts settings from the body threadId and announces the change', async () => {
    const h = harness();
    const result = await h.service.setChatSettings('user-1', 'acc-1', '42', {
      threadId: 7,
      settings: { typing: 'instant', maxParts: 2 },
    });
    expect(result).toEqual({ settings: { typing: 'instant', maxParts: 2 } });
    expect(h.prisma.aiChatSetting.upsert).toHaveBeenCalledWith({
      where: {
        accountId_chatId_threadId: {
          accountId: 'acc-1',
          chatId: BigInt(42),
          threadId: 7,
        },
      },
      create: {
        accountId: 'acc-1',
        chatId: BigInt(42),
        threadId: 7,
        settings: JSON.stringify({ typing: 'instant', maxParts: 2 }),
      },
      update: { settings: JSON.stringify({ typing: 'instant', maxParts: 2 }) },
    });
    expect(h.realtime.emitToUser).toHaveBeenCalledWith(
      'user-1',
      'ai.state.changed',
      { accountId: 'acc-1', chatId: 42, threadId: 7 },
    );
  });

  it('rejects bad settings, bad thread ids and unowned accounts', async () => {
    const h = harness();
    await expect(
      h.service.setChatSettings('user-1', 'acc-1', '42', { settings: [] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.service.setChatSettings('user-1', 'acc-1', '42', {
        settings: {},
        threadId: -1,
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      h.service.setChatSettings('user-1', 'acc-x', '42', { settings: {} }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.prisma.aiChatSetting.upsert).not.toHaveBeenCalled();
  });
});
