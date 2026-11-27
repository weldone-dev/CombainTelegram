import { describe, expect, it, vi } from 'vitest';
import { AccountsController } from './accounts.controller.js';

function harness() {
  const accounts = {
    list: vi.fn(async () => []),
    activate: vi.fn(async (_userId: string, id: string) => ({ id })),
    remove: vi.fn(async (_userId: string, id: string) => ({ id })),
    avatar: vi.fn(),
    listTelegramSessions: vi.fn(async () => []),
    detachSession: vi.fn(),
    updateSession: vi.fn(),
    activateSession: vi.fn(),
  };
  return {
    controller: new AccountsController(accounts as never),
    accounts,
    user: { id: 'user-1' } as never,
  };
}

describe('AccountsController', () => {
  it('lists accounts for the current user', async () => {
    const h = harness();
    await expect(h.controller.list(h.user)).resolves.toEqual([]);
    expect(h.accounts.list).toHaveBeenCalledWith('user-1');
  });

  it('activates the account for the current user', async () => {
    const h = harness();
    await expect(h.controller.activate(h.user, 'acc-1')).resolves.toEqual({
      id: 'acc-1',
    });
    expect(h.accounts.activate).toHaveBeenCalledWith('user-1', 'acc-1');
  });

  it('parses the session revoke flag on delete', async () => {
    const h = harness();
    await h.controller.detachSession(h.user, 'acc-1', 'ses-1', 'true');
    expect(h.accounts.detachSession).toHaveBeenCalledWith(
      'user-1',
      'acc-1',
      'ses-1',
      true,
    );
  });

  it('pins a session as the active transport', async () => {
    const h = harness();
    await h.controller.activateSession(h.user, 'acc-1', 'ses-1');
    expect(h.accounts.activateSession).toHaveBeenCalledWith(
      'user-1',
      'acc-1',
      'ses-1',
    );
  });
});
