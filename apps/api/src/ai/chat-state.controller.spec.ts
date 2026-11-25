import { describe, expect, it, vi } from 'vitest';
import { ChatStateController } from './ai.controller.js';
import { ChatStateService } from './chat-state.service.js';
import type { SoulModel } from '@repo/database';

function harness(soul: Partial<SoulModel> | null = {}) {
  const realtime = { emitToUser: vi.fn() };
  const states = new ChatStateService(realtime as never);
  const souls = {
    model: vi.fn(async () => soul as SoulModel | null),
  };
  const controller = new ChatStateController(states as never, souls as never);
  return { controller, states, souls };
}

describe('ChatStateController', () => {
  it('returns idle plus the soul typing mode before any run', async () => {
    const h = harness({
      settings: JSON.stringify({ typingMode: 'on_compose' }),
    } as Partial<SoulModel>);

    const view = await h.controller.state('account-1', '42');

    expect(view).toEqual({
      accountId: 'account-1',
      chatId: 42,
      state: 'idle',
      since: 0,
      runId: null,
      messageId: null,
      part: 0,
      total: 0,
      typingMode: 'on_compose',
    });
    expect(h.souls.model).toHaveBeenCalledWith('account-1');
  });

  it('returns the live record of the chat', async () => {
    const h = harness();
    h.states.transition({
      accountId: 'account-1',
      chatId: 42,
      userId: 'user-1',
      state: 'composing',
      runId: 'run-1',
      messageId: 1001,
      total: 2,
      typingMode: 'off',
    });

    const view = await h.controller.state('account-1', '42');

    expect(view).toMatchObject({
      state: 'composing',
      runId: 'run-1',
      messageId: 1001,
      part: 0,
      total: 2,
      typingMode: 'off',
    });
    // The stored policy wins over the soul lookup.
    expect(h.souls.model).not.toHaveBeenCalled();
  });

  it('falls back to smart when the account has no soul', async () => {
    const h = harness(null);
    const view = await h.controller.state('account-1', '42');
    expect(view.state).toBe('idle');
    expect(view.typingMode).toBeNull();
  });

  it('rejects an invalid chat id', async () => {
    const h = harness();
    await expect(h.controller.state('account-1', 'zero')).rejects.toMatchObject(
      { status: 400 },
    );
  });
});
