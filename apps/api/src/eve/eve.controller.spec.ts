import { describe, expect, it, vi } from 'vitest';
import { EveController } from './eve.controller.js';

/**
 * `memory/retrieve` used to receive Eve's `memscope1_…` hash, while Nest keys
 * relationships by `account:<id>:chat:<id>`. The controller must resolve the
 * real key from the address before asking the lifecycle service.
 */
describe('EveController.memory/retrieve', () => {
  function build() {
    const scope = vi.fn(async () => ({
      scopeKey: 'account:acc-1:chat:42',
    }));
    const retrieve = vi.fn(async () => ({ facts: [] }));
    const controller = new EveController(
      { scope } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { retrieve } as never,
      {} as never,
      {} as never,
    );
    return { controller, scope, retrieve };
  }

  it('resolves the relationship scopeKey from accountId/chatId', async () => {
    const { controller, scope, retrieve } = build();
    await controller.retrieve({
      personaId: 'persona-1',
      accountId: 'acc-1',
      chatId: '42',
      threadId: 7,
      scopeKey: 'memscope1_deadbeef',
      query: 'соревнования',
    });

    expect(scope).toHaveBeenCalledWith('persona-1', 'acc-1', '42', 7);
    expect(retrieve).toHaveBeenCalledWith(
      'persona-1',
      'account:acc-1:chat:42',
      'соревнования',
      expect.anything(),
    );
  });

  it('keeps the provided key when the address is incomplete', async () => {
    const { controller, scope, retrieve } = build();
    await controller.retrieve({
      personaId: 'persona-1',
      scopeKey: 'memscope1_deadbeef',
      query: 'что-то',
    });

    expect(scope).not.toHaveBeenCalled();
    expect(retrieve).toHaveBeenCalledWith(
      'persona-1',
      'memscope1_deadbeef',
      'что-то',
      expect.anything(),
    );
  });
});
