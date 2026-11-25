import { describe, expect, it, vi } from 'vitest';
import { AccountsController } from './accounts.controller.js';

function harness() {
  const accounts = {
    list: vi.fn(),
    activate: vi.fn(),
    remove: vi.fn(),
    avatar: vi.fn(),
    listTelegramSessions: vi.fn(),
    detachSession: vi.fn(),
    updateSession: vi.fn(),
    activateSession: vi.fn(),
  };
  const aiState = {
    variables: vi.fn(async (_userId: string, accountId: string) => ({
      accountId,
      variables: { promo: 'spring' },
    })),
    setVariables: vi.fn(async (_userId: string, accountId: string) => ({
      accountId,
      variables: {},
    })),
    chatSettings: vi.fn(async () => ({ settings: {} })),
    setChatSettings: vi.fn(async () => ({ settings: {} })),
  };
  return {
    controller: new AccountsController(accounts as never, aiState as never),
    accounts,
    aiState,
    user: { id: 'user-1' } as never,
  };
}

describe('AccountsController AI state routes', () => {
  it('serves and replaces account variables for the current user', async () => {
    const h = harness();
    await expect(h.controller.aiVariables(h.user, 'acc-1')).resolves.toEqual({
      accountId: 'acc-1',
      variables: { promo: 'spring' },
    });
    expect(h.aiState.variables).toHaveBeenCalledWith('user-1', 'acc-1');

    const body = { variables: { promo: 'autumn' } };
    await h.controller.setAiVariables(h.user, 'acc-1', body);
    expect(h.aiState.setVariables).toHaveBeenCalledWith(
      'user-1',
      'acc-1',
      body,
    );
  });

  it('serves and upserts per-chat settings with the thread id', async () => {
    const h = harness();
    await h.controller.aiChatSettings(h.user, 'acc-1', '42', '7');
    expect(h.aiState.chatSettings).toHaveBeenCalledWith(
      'user-1',
      'acc-1',
      '42',
      '7',
    );

    const body = { threadId: 7, settings: { typing: 'natural' } };
    await h.controller.setAiChatSettings(h.user, 'acc-1', '42', body);
    expect(h.aiState.setChatSettings).toHaveBeenCalledWith(
      'user-1',
      'acc-1',
      '42',
      body,
    );
  });
});
