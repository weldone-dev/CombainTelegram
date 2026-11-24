import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SoulModel } from '@repo/database';
import type { RealtimeEvent } from '../realtime/realtime.service.js';
import { DEFAULT_SOUL_SETTINGS } from './ai.types.js';
import { PresenceService } from './presence.service.js';

const ACCOUNT = 'account-1';
const CHAT = 42;

function soul(overrides: Record<string, unknown> = {}): SoulModel {
  return {
    id: 'soul-1',
    accountId: ACCOUNT,
    name: 'Душа',
    settings: JSON.stringify({
      ...DEFAULT_SOUL_SETTINGS,
      presenceIdleMinutes: 5,
      presenceReadDelaySeconds: 0,
      presenceTypingDelaySeconds: 3,
      ...overrides,
    }),
  } as unknown as SoulModel;
}

function harness(soulRow: SoulModel | null = soul()) {
  const users = { get: vi.fn(async () => ({ id: 'user-1' })) };
  const messaging = {
    setOnline: vi.fn(async (_userId: string, _accountId: string, online: boolean) => ({
      online,
    })),
  };
  const events = new Subject<RealtimeEvent>();
  const realtime = { events$: events.asObservable() };
  const souls = {
    model: vi.fn(async () => soulRow),
    list: vi.fn(async () => (soulRow ? [{ accountId: ACCOUNT }] : [])),
  };
  const service = new PresenceService(
    users as never,
    realtime as never,
    souls as never,
    messaging as never,
  );
  return { service, users, messaging, events, souls, soulRow };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PresenceService', () => {
  it('goes offline after the idle window and comes back on an incoming message', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.service.onModuleInit();

    // The boot timer is armed from "now" because nothing has happened yet.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.messaging.setOnline).toHaveBeenCalledWith(
      'user-1',
      ACCOUNT,
      false,
    );

    const gate = await h.service.incoming(ACCOUNT, CHAT);

    // Online after 5 s, read the moment it is online, typing 3 s later.
    expect(gate).toEqual({ readDelayMs: 5_000, typingDelayMs: 3_000 });
    expect(h.messaging.setOnline).toHaveBeenCalledTimes(1);
    expect(h.messaging.setOnline).toHaveBeenLastCalledWith(
      'user-1',
      ACCOUNT,
      false,
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(h.messaging.setOnline).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(h.messaging.setOnline).toHaveBeenLastCalledWith(
      'user-1',
      ACCOUNT,
      true,
    );
  });

  it('does not restart the online delay on a second message', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.service.onModuleInit();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const first = await h.service.incoming(ACCOUNT, CHAT);
    await vi.advanceTimersByTimeAsync(2_000);
    const second = await h.service.incoming(ACCOUNT, CHAT);

    expect(first).toEqual({ readDelayMs: 5_000, typingDelayMs: 3_000 });
    expect(second).toEqual({ readDelayMs: 3_000, typingDelayMs: 3_000 });

    await vi.advanceTimersByTimeAsync(3_000);
    expect(h.messaging.setOnline).toHaveBeenLastCalledWith(
      'user-1',
      ACCOUNT,
      true,
    );

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(
      h.messaging.setOnline.mock.calls.filter((call) => call[2] === true),
    ).toHaveLength(1);
  });

  it('goes online immediately when the online delay is zero', async () => {
    vi.useFakeTimers();
    const h = harness(soul({ presenceOnlineDelaySeconds: 0 }));
    await h.service.onModuleInit();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const gate = await h.service.incoming(ACCOUNT, CHAT);
    await vi.advanceTimersByTimeAsync(0);

    expect(gate).toEqual({ readDelayMs: 0, typingDelayMs: 3_000 });
    expect(h.messaging.setOnline).toHaveBeenLastCalledWith(
      'user-1',
      ACCOUNT,
      true,
    );
  });

  it('returns no delay while the account is already online', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.service.onModuleInit();

    const gate = await h.service.incoming(ACCOUNT, CHAT);

    expect(gate).toEqual({ readDelayMs: 0, typingDelayMs: 0 });
    expect(h.messaging.setOnline).not.toHaveBeenCalled();
  });

  it('keeps the account online when the idle window is disabled', async () => {
    vi.useFakeTimers();
    const h = harness(soul({ presenceIdleMinutes: 0 }));
    await h.service.onModuleInit();

    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);

    expect(h.messaging.setOnline).not.toHaveBeenCalled();
  });

  it('does nothing for accounts without a soul', async () => {
    vi.useFakeTimers();
    const h = harness(null);
    await h.service.onModuleInit();

    const gate = await h.service.incoming(ACCOUNT, CHAT);
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    expect(gate).toEqual({ readDelayMs: 0, typingDelayMs: 0 });
    expect(h.messaging.setOnline).not.toHaveBeenCalled();
  });

  it('resets the idle timer on activity', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.service.onModuleInit();

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    h.service.touch(ACCOUNT);
    await vi.advanceTimersByTimeAsync(4 * 60_000);

    expect(h.messaging.setOnline).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.messaging.setOnline).toHaveBeenCalledWith(
      'user-1',
      ACCOUNT,
      false,
    );
  });
});
