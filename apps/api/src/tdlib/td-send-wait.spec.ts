import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { chat, message, user } from 'tdlib-native/types';
import type { TelegramSessionModel } from '@repo/database';
import { setLogSink } from '../logs/log-sink.js';
import type { LogInput } from '../logs/log-sink.js';
import {
  TdSessionMessenger,
  sendWaitTimeoutMs,
} from './td-messaging.service.js';

const USER_ID = 1830539716;
const CHAT_ID = USER_ID;
const TEMP_ID = 900_001;
const REAL_ID = 555_001;
const NOW = 1_700_000_000;
const DEFAULT_WAIT_MS = 20_000;
const LATE_WATCH_MS = 300_000;

const ORIGINAL_WAIT = process.env.SEND_WAIT_TIMEOUT_MS;

function chatFixture(): chat {
  return {
    _: 'chat',
    id: CHAT_ID,
    type: { _: 'chatTypePrivate', user_id: USER_ID },
    title: 'Bob',
    photo: null,
    permissions: { _: 'chatPermissions', can_send_basic_messages: true },
    last_message: null,
    positions: [],
    chat_lists: [],
    notification_settings: null,
    unread_count: 0,
    last_read_inbox_message_id: 0,
  } as unknown as chat;
}

function userFixture(): user {
  return {
    _: 'user',
    id: USER_ID,
    first_name: 'Bob',
    last_name: '',
    usernames: { active_usernames: [], editable_username: null },
    profile_photo: null,
  } as unknown as user;
}

function messageFixture(
  id: number,
  overrides: Record<string, unknown> = {},
): message {
  return {
    _: 'message',
    id,
    sender_id: { _: 'messageSenderUser', user_id: USER_ID },
    chat_id: CHAT_ID,
    sending_state: null,
    is_outgoing: true,
    date: NOW,
    edit_date: 0,
    reply_to: null,
    topic_id: null,
    content: {
      _: 'messageText',
      text: { _: 'formattedText', text: 'hello from the soul', entities: [] },
      link_preview: null,
      link_preview_options: null,
    },
    ...overrides,
  } as unknown as message;
}

function pendingMessage(): message {
  return messageFixture(TEMP_ID, {
    sending_state: { _: 'messageSendingStatePending', sending_id: 1 },
  });
}

function createMessenger(sent: message = pendingMessage()) {
  const listeners = new Set<(update: unknown) => void>();
  const emit = (update: unknown): void => {
    for (const listener of listeners) listener(update);
  };

  const api = {
    loadChats: vi.fn(async () => undefined),
    getChats: vi.fn(async () => ({ chat_ids: [] })),
    getChat: vi.fn(async () => chatFixture()),
    getUser: vi.fn(async () => userFixture()),
    sendMessage: vi.fn(async () => sent),
  };

  const subscribe = vi.fn((listener: (update: unknown) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  });

  const client = { api, updates: { subscribe } };

  const messenger = new TdSessionMessenger(
    {} as TelegramSessionModel,
    client as never,
    {} as never,
  );
  messenger.registry.put(chatFixture());
  return { messenger, api, subscribe, listeners, emit };
}

/** Lets the async `sendMessage` chain reach `awaitSent` under fake timers. */
async function armWait(): Promise<void> {
  for (let attempt = 0; attempt < 10 && vi.getTimerCount() === 0; attempt += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(vi.getTimerCount()).toBeGreaterThan(0);
}

let logs: LogInput[] = [];

beforeEach(() => {
  logs = [];
  delete process.env.SEND_WAIT_TIMEOUT_MS;
  setLogSink((entry) => {
    logs.push(entry);
  });
});

afterEach(() => {
  vi.useRealTimers();
  setLogSink(null);
  if (ORIGINAL_WAIT === undefined) delete process.env.SEND_WAIT_TIMEOUT_MS;
  else process.env.SEND_WAIT_TIMEOUT_MS = ORIGINAL_WAIT;
});

describe('sendWaitTimeoutMs', () => {
  it('defaults to 20 s when the env var is missing or empty', () => {
    expect(sendWaitTimeoutMs({})).toBe(DEFAULT_WAIT_MS);
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: '' })).toBe(
      DEFAULT_WAIT_MS,
    );
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: '   ' })).toBe(
      DEFAULT_WAIT_MS,
    );
  });

  it('honours a valid override, whitespace included', () => {
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: '45000' })).toBe(45_000);
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: ' 30000 ' })).toBe(
      30_000,
    );
  });

  it('clamps to 5 s..600 s', () => {
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: '1' })).toBe(5_000);
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: '4999' })).toBe(5_000);
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: '600001' })).toBe(
      600_000,
    );
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: '1e9' })).toBe(600_000);
  });

  it('falls back to the default for garbage values', () => {
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: 'abc' })).toBe(
      DEFAULT_WAIT_MS,
    );
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: '20s' })).toBe(
      DEFAULT_WAIT_MS,
    );
    expect(sendWaitTimeoutMs({ SEND_WAIT_TIMEOUT_MS: 'NaN' })).toBe(
      DEFAULT_WAIT_MS,
    );
  });

  it('reads process.env at call time', () => {
    process.env.SEND_WAIT_TIMEOUT_MS = '25000';
    expect(sendWaitTimeoutMs()).toBe(25_000);
    process.env.SEND_WAIT_TIMEOUT_MS = '35000';
    expect(sendWaitTimeoutMs()).toBe(35_000);
  });
});

describe('TdSessionMessenger.sendMessage send wait', () => {
  it('settles with the real id when the confirmation arrives in time', async () => {
    vi.useFakeTimers();
    const { messenger, listeners, emit } = createMessenger();

    const pending = messenger.sendMessage(CHAT_ID, { text: 'hello' });
    await armWait();
    emit({
      _: 'updateMessageSendSucceeded',
      old_message_id: TEMP_ID,
      message: messageFixture(REAL_ID),
    });
    await vi.advanceTimersByTimeAsync(1_000);

    const view = await pending;
    expect(view.id).toBe(REAL_ID);
    expect(logs.map((entry) => entry.action)).not.toContain(
      'tdlib.send.timeout',
    );
    // Constructor + registry subscriptions only: the send watcher is gone.
    expect(listeners.size).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    messenger.dispose();
  });

  it('returns the temporary id after 20 s without calling it a failure', async () => {
    vi.useFakeTimers();
    const { messenger, listeners, emit } = createMessenger();

    const pending = messenger.sendMessage(CHAT_ID, { text: 'hello' });
    await armWait();
    await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_MS);

    const view = await pending;
    expect(view.id).toBe(TEMP_ID);

    const timeout = logs.find((entry) => entry.action === 'tdlib.send.timeout');
    expect(timeout).toMatchObject({
      level: 'warn',
      chatId: CHAT_ID,
      details: { tempId: TEMP_ID, timeoutMs: DEFAULT_WAIT_MS },
    });
    expect(timeout?.message).toContain('still queued');
    expect(timeout?.message).toContain(`${DEFAULT_WAIT_MS} ms`);

    // The watcher is still armed for the late confirmation.
    expect(listeners.size).toBe(3);
    expect(vi.getTimerCount()).toBe(1);

    emit({
      _: 'updateMessageSendSucceeded',
      old_message_id: TEMP_ID,
      message: messageFixture(REAL_ID),
    });
    const late = logs.find((entry) => entry.action === 'tdlib.send.late');
    expect(late).toMatchObject({
      level: 'info',
      status: 'ok',
      chatId: CHAT_ID,
      details: { tempId: TEMP_ID, messageId: REAL_ID },
    });
    expect(late?.durationMs).toBeGreaterThanOrEqual(DEFAULT_WAIT_MS);

    // Late confirmation unsubscribes and clears the watch timer.
    expect(listeners.size).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    messenger.dispose();
  });

  it('stops watching when the queued message fails late', async () => {
    vi.useFakeTimers();
    const { messenger, listeners, emit } = createMessenger();

    const pending = messenger.sendMessage(CHAT_ID, { text: 'hello' });
    await armWait();
    await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_MS);
    await pending;

    emit({
      _: 'updateMessageSendFailed',
      old_message_id: TEMP_ID,
      error: { code: 500, message: 'Internal server error' },
    });

    const failed = logs.find(
      (entry) => entry.action === 'tdlib.send.late-failed',
    );
    expect(failed).toMatchObject({
      level: 'warn',
      status: 'failed',
      chatId: CHAT_ID,
      details: { tempId: TEMP_ID, errorMessage: 'Internal server error' },
    });
    expect(listeners.size).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    messenger.dispose();
  });

  it('stops watching five minutes after the timeout', async () => {
    vi.useFakeTimers();
    const { messenger, listeners } = createMessenger();

    const pending = messenger.sendMessage(CHAT_ID, { text: 'hello' });
    await armWait();
    await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_MS);
    await pending;

    await vi.advanceTimersByTimeAsync(LATE_WATCH_MS);

    expect(listeners.size).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(logs.some((entry) => entry.action === 'tdlib.send.late')).toBe(
      false,
    );
    messenger.dispose();
  });

  it('dispose stops a watcher that is still awaiting a timed-out send', async () => {
    vi.useFakeTimers();
    const { messenger, listeners } = createMessenger();

    const pending = messenger.sendMessage(CHAT_ID, { text: 'hello' });
    await armWait();
    await vi.advanceTimersByTimeAsync(DEFAULT_WAIT_MS);
    await pending;

    expect(vi.getTimerCount()).toBe(1);
    messenger.dispose();

    expect(listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
