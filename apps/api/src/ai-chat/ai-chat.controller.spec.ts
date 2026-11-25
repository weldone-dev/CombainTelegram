import { describe, expect, it, vi } from 'vitest';
import type { UserModel } from '@repo/database';
import { AiChatController } from './ai-chat.controller.js';

const USER = { id: 'local' } as UserModel;
const ACCOUNT = 'account-1';
const CHAT = '42';

function harness() {
  const tags = {
    requireAccount: vi.fn(async () => undefined),
    list: vi.fn(async () => ['lead', 'vip']),
    add: vi.fn(async () => ['lead', 'vip']),
    remove: vi.fn(async () => ({ removed: true, tags: ['vip'] })),
  };
  const memory = {
    view: vi.fn(async () => ({
      accountId: ACCOUNT,
      chatId: 42,
      shortTerm: [],
      longTerm: { summary: '', facts: [] },
    })),
    clear: vi.fn(async () => ({ cleared: true as const, chatId: 42 })),
  };
  const controller = new AiChatController(
    {} as never,
    tags as never,
    memory as never,
    {} as never,
  );
  return { controller, tags, memory };
}

describe('AiChatController tags routes', () => {
  it('GET lists the tags of an owned chat', async () => {
    const { controller, tags } = harness();

    await expect(
      controller.tagsList(USER, ACCOUNT, CHAT),
    ).resolves.toEqual({ accountId: ACCOUNT, chatId: 42, tags: ['lead', 'vip'] });
    expect(tags.requireAccount).toHaveBeenCalledWith(USER.id, ACCOUNT);
    expect(tags.list).toHaveBeenCalledWith(ACCOUNT, 42);
  });

  it('POST adds body.tag to the chat', async () => {
    const { controller, tags } = harness();

    await expect(
      controller.tagsAdd(USER, ACCOUNT, CHAT, { tag: ' VIP ' }),
    ).resolves.toEqual({ accountId: ACCOUNT, chatId: 42, tags: ['lead', 'vip'] });
    expect(tags.add).toHaveBeenCalledWith(ACCOUNT, 42, ' VIP ');
  });

  it('POST refuses a request without a tag', async () => {
    const { controller, tags } = harness();
    tags.add.mockImplementation(async (_accountId: string, _chatId: number, tag: unknown) => {
      if (typeof tag !== 'string') throw new Error('tag must be a string');
      return [];
    });

    await expect(controller.tagsAdd(USER, ACCOUNT, CHAT, {})).rejects.toThrow(
      'tag must be a string',
    );
  });

  it('DELETE removes the ?tag= query tag', async () => {
    const { controller, tags } = harness();

    await expect(
      controller.tagsRemove(USER, ACCOUNT, CHAT, 'lead'),
    ).resolves.toEqual({
      accountId: ACCOUNT,
      chatId: 42,
      removed: true,
      tags: ['vip'],
    });
    expect(tags.remove).toHaveBeenCalledWith(ACCOUNT, 42, 'lead');
  });

  it('checks the chat id and ownership before reading tags', async () => {
    const { controller, tags } = harness();
    tags.requireAccount.mockRejectedValueOnce(new Error('not found'));

    await expect(controller.tagsList(USER, ACCOUNT, '0')).rejects.toThrow(
      /must not be zero/,
    );
    await expect(controller.tagsList(USER, ACCOUNT, CHAT)).rejects.toThrow(
      'not found',
    );
    expect(tags.list).not.toHaveBeenCalled();
  });
});

describe('AiChatController memory routes', () => {
  it('DELETE clears the context of the chat for the current user', async () => {
    const { controller, memory } = harness();

    await expect(controller.memoryClear(USER, ACCOUNT, CHAT)).resolves.toEqual({
      cleared: true,
      chatId: 42,
    });
    expect(memory.clear).toHaveBeenCalledWith(USER.id, ACCOUNT, 42);
  });

  it('rejects a zero chat id before touching memory', async () => {
    const { controller, memory } = harness();

    await expect(controller.memoryClear(USER, ACCOUNT, '0')).rejects.toThrow(
      /must not be zero/,
    );
    expect(memory.clear).not.toHaveBeenCalled();
  });
});
