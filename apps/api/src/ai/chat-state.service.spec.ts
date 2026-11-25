import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHAT_STATE_TTL_MS,
  ChatStateService,
  SENT_TO_IDLE_MS,
  isActiveState,
} from './chat-state.service.js';
import type { ChatStateTransition } from './chat-state.service.js';

const ACCOUNT = 'account-1';
const CHAT = 42;

function harness() {
  const realtime = { emitToUser: vi.fn() };
  const service = new ChatStateService(realtime as never);
  const internals = service as unknown as {
    sweep(now?: number): void;
    records: Map<string, unknown>;
  };
  const stateEvents = (): Array<Record<string, unknown>> =>
    realtime.emitToUser.mock.calls
      .filter(([, event]) => event === 'ai.state')
      .map(([, , payload]) => payload as Record<string, unknown>);
  const apply = (input: Partial<ChatStateTransition> = {}) =>
    service.transition({
      accountId: ACCOUNT,
      chatId: CHAT,
      userId: 'user-1',
      state: 'received',
      ...input,
    });
  return { service, realtime, internals, stateEvents, apply };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ChatStateService', () => {
  it('reports idle for a chat nothing has run in', () => {
    const h = harness();
    expect(h.service.get(ACCOUNT, CHAT)).toEqual({
      accountId: ACCOUNT,
      chatId: CHAT,
      state: 'idle',
      since: 0,
      runId: null,
      messageId: null,
      part: 0,
      total: 0,
      typingMode: null,
    });
    expect(h.realtime.emitToUser).not.toHaveBeenCalled();
  });

  it('records a transition and emits ai.state to the owner room', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T10:00:00.000Z'));
    const h = harness();
    const record = h.apply({
      state: 'received',
      messageId: 1001,
      typingMode: 'smart',
    });

    expect(record).toMatchObject({
      accountId: ACCOUNT,
      chatId: CHAT,
      state: 'received',
      messageId: 1001,
      runId: null,
      part: 0,
      total: 0,
      typingMode: 'smart',
    });
    expect(record.since).toBe(Date.now());
    expect(h.realtime.emitToUser).toHaveBeenCalledWith('user-1', 'ai.state', {
      accountId: ACCOUNT,
      chatId: CHAT,
      state: 'received',
      since: record.since,
      runId: null,
      messageId: 1001,
      part: 0,
      total: 0,
    });
  });

  it('keeps the typing mode while a run moves through its states', () => {
    const h = harness();
    h.apply({ state: 'received', typingMode: 'on_compose' });
    h.apply({ state: 'read' });
    const record = h.apply({
      state: 'thinking',
      runId: 'run-1',
      messageId: 1001,
    });
    expect(record.typingMode).toBe('on_compose');
  });

  it('resets the fields of the previous run on a new transition', () => {
    const h = harness();
    h.apply({
      state: 'sending',
      runId: 'run-1',
      messageId: 1001,
      part: 2,
      total: 3,
    });
    const next = h.apply({ state: 'read', messageId: 1002 });
    expect(next).toMatchObject({
      runId: null,
      part: 0,
      total: 0,
      messageId: 1002,
    });
  });

  it('goes back to idle two seconds after sent', () => {
    vi.useFakeTimers();
    const h = harness();
    h.apply({ state: 'sent', runId: 'run-1', messageId: 1001, part: 1, total: 1 });
    expect(h.service.stateOf(ACCOUNT, CHAT)).toBe('sent');

    vi.advanceTimersByTime(SENT_TO_IDLE_MS - 1);
    expect(h.service.stateOf(ACCOUNT, CHAT)).toBe('sent');

    vi.advanceTimersByTime(1);
    expect(h.service.stateOf(ACCOUNT, CHAT)).toBe('idle');
    expect(h.stateEvents().map((event) => event.state)).toEqual([
      'sent',
      'idle',
    ]);
  });

  it('does not drop a newer state when an old sent timer fires', () => {
    vi.useFakeTimers();
    const h = harness();
    h.apply({ state: 'sent', runId: 'run-1', messageId: 1001 });
    h.apply({ state: 'received', messageId: 1002 });
    vi.advanceTimersByTime(SENT_TO_IDLE_MS);
    expect(h.service.stateOf(ACCOUNT, CHAT)).toBe('received');
  });

  it('treats blocked, superseded, error and idle as terminal', () => {
    for (const state of [
      'received',
      'read',
      'waiting',
      'thinking',
      'composing',
      'sending',
    ] as const) {
      expect(isActiveState(state)).toBe(true);
    }
    for (const state of [
      'idle',
      'sent',
      'blocked',
      'superseded',
      'error',
    ] as const) {
      expect(isActiveState(state)).toBe(false);
    }
  });

  it('drops records untouched for the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const h = harness();
    h.apply({ state: 'error' });
    h.internals.sweep(1_000 + CHAT_STATE_TTL_MS - 1);
    expect(h.internals.records.size).toBe(1);
    h.internals.sweep(1_000 + CHAT_STATE_TTL_MS + 1);
    expect(h.internals.records.size).toBe(0);
  });

  it('forgets a chat on clear and on destroy', () => {
    const h = harness();
    h.apply({ state: 'thinking' });
    h.service.clear(ACCOUNT, CHAT);
    expect(h.service.stateOf(ACCOUNT, CHAT)).toBe('idle');
    h.apply({ state: 'thinking' });
    h.service.onModuleDestroy();
    expect(h.service.stateOf(ACCOUNT, CHAT)).toBe('idle');
  });
});
