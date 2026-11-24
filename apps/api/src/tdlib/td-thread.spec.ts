import { describe, expect, it, vi } from 'vitest';
import type { chat, message, user } from 'tdlib-native/types';
import type { TelegramSessionModel } from '@repo/database';
import { TdSessionMessenger } from './td-messaging.service.js';

const POST_SUPERGROUP_ID = 111;
const POST_CHAT_ID = -(1_000_000_000_000 + POST_SUPERGROUP_ID);
const DISCUSSION_SUPERGROUP_ID = 3_765_406_749;
const DISCUSSION_CHAT_ID = -(1_000_000_000_000 + DISCUSSION_SUPERGROUP_ID);
const THREAD_ROOT_ID = 900;
const USER_ID = 501;
const NOW = 1_700_000_000;

const text = (value: string) => ({
  _: 'formattedText',
  text: value,
  entities: [],
});

function chatFixture(id: number, supergroupId: number, isChannel: boolean) {
  return {
    _: 'chat',
    id,
    type: {
      _: 'chatTypeSupergroup',
      supergroup_id: supergroupId,
      is_channel: isChannel,
    },
    title: isChannel ? 'Channel' : 'Comments',
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

function messageFixture(
  id: number,
  body: string,
  overrides: Record<string, unknown> = {},
): message {
  return {
    _: 'message',
    id,
    sender_id: { _: 'messageSenderUser', user_id: USER_ID },
    chat_id: DISCUSSION_CHAT_ID,
    sending_state: null,
    is_outgoing: false,
    date: NOW,
    edit_date: 0,
    reply_to: null,
    topic_id: null,
    content: {
      _: 'messageText',
      text: text(body),
      link_preview: null,
      link_preview_options: null,
    },
    ...overrides,
  } as unknown as message;
}

function userFixture(): user {
  return {
    _: 'user',
    id: USER_ID,
    first_name: 'Bob',
    last_name: '',
    usernames: { active_usernames: ['bob'], editable_username: 'bob' },
    profile_photo: null,
  } as unknown as user;
}

function createMessenger(overrides: Record<string, unknown> = {}) {
  const chats = new Map<number, chat>([
    [POST_CHAT_ID, chatFixture(POST_CHAT_ID, POST_SUPERGROUP_ID, true)],
    [
      DISCUSSION_CHAT_ID,
      chatFixture(DISCUSSION_CHAT_ID, DISCUSSION_SUPERGROUP_ID, false),
    ],
  ]);
  const listeners = new Set<(update: unknown) => void>();
  const emit = (update: unknown): void => {
    for (const listener of listeners) listener(update);
  };

  const api = {
    loadChats: vi.fn(async () => undefined),
    getChats: vi.fn(async () => ({ chat_ids: [] })),
    getChat: vi.fn(async ({ chat_id }: { chat_id: number }) => {
      const entry = chats.get(chat_id);
      if (!entry) throw new Error(`unknown chat ${chat_id}`);
      return entry;
    }),
    getUser: vi.fn(async () => userFixture()),
    getSupergroup: vi.fn(async () => ({
      usernames: { active_usernames: [], editable_username: null },
      status: { _: 'chatMemberStatusMember' },
    })),
    getMessageThread: vi.fn(async () => {
      throw new Error('Message thread not found');
    }),
    getMessageThreadHistory: vi.fn(async () => ({ messages: [] })),
    sendMessage: vi.fn(),
    ...overrides,
  };

  const client = {
    api,
    updates: {
      subscribe: vi.fn((listener: (update: unknown) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    },
  };

  const messenger = new TdSessionMessenger(
    {} as TelegramSessionModel,
    client as never,
    {} as never,
  );
  messenger.registry.put(chats.get(POST_CHAT_ID) as chat);
  messenger.registry.put(chats.get(DISCUSSION_CHAT_ID) as chat);
  return { messenger, api, emit };
}

/** Captured live shape: chat_id is the discussion group, root first. */
function liveThread() {
  return {
    _: 'messageThreadInfo',
    chat_id: DISCUSSION_CHAT_ID,
    message_thread_id: THREAD_ROOT_ID,
    reply_info: {
      _: 'messageReplyInfo',
      reply_count: 2,
      recent_replier_ids: [],
      last_read_inbox_message_id: 0,
      last_read_outbox_message_id: 0,
      last_message_id: 902,
    },
    unread_message_count: 0,
    messages: [
      messageFixture(THREAD_ROOT_ID, 'channel post', {
        chat_id: POST_CHAT_ID,
        sender_id: { _: 'messageSenderChat', chat_id: POST_CHAT_ID },
      }),
      messageFixture(901, 'первый комментарий'),
      messageFixture(902, 'второй комментарий'),
    ],
    draft_message: null,
  };
}

describe('TdSessionMessenger.getMessageThread', () => {
  it('maps comments of the linked discussion group and drops the root', async () => {
    const { messenger, api } = createMessenger({
      getMessageThread: vi.fn(async () => liveThread()),
    });

    const thread = await messenger.getMessageThread(POST_CHAT_ID, 42, {
      limit: 2,
    });

    expect(api.getMessageThread).toHaveBeenCalledWith({
      chat_id: POST_CHAT_ID,
      message_id: 42,
    });
    expect(api.getChat).toHaveBeenCalledWith({ chat_id: DISCUSSION_CHAT_ID });
    expect(thread).toEqual({
      chatId: POST_CHAT_ID,
      messageId: 42,
      discussionChatId: DISCUSSION_CHAT_ID,
      comments: [
        expect.objectContaining({
          id: 901,
          chatId: DISCUSSION_CHAT_ID,
          text: 'первый комментарий',
          senderName: 'Bob',
        }),
        expect.objectContaining({
          id: 902,
          chatId: DISCUSSION_CHAT_ID,
          text: 'второй комментарий',
        }),
      ],
      nextOffsetId: 902,
    });
    expect(thread.comments.map((comment) => comment.id)).not.toContain(
      THREAD_ROOT_ID,
    );
  });

  it('pages older comments from offsetId through the thread history', async () => {
    const historyMessages = [
      messageFixture(902, 'второй комментарий'),
      messageFixture(901, 'первый комментарий'),
      messageFixture(THREAD_ROOT_ID, 'channel post'),
    ];
    const { messenger, api } = createMessenger({
      getMessageThread: vi.fn(async () => liveThread()),
      getMessageThreadHistory: vi.fn(async () => ({
        messages: historyMessages,
      })),
    });

    const thread = await messenger.getMessageThread(POST_CHAT_ID, 42, {
      limit: 2,
      offsetId: 903,
    });

    expect(api.getMessageThreadHistory).toHaveBeenCalledWith({
      chat_id: DISCUSSION_CHAT_ID,
      message_id: THREAD_ROOT_ID,
      from_message_id: 903,
      offset: 0,
      limit: 3,
    });
    expect(thread.comments.map((comment) => comment.id)).toEqual([902, 901]);
    expect(thread.nextOffsetId).toBe(901);
  });

  it('returns an empty thread when the post has no discussion group', async () => {
    const { messenger, api } = createMessenger();

    const thread = await messenger.getMessageThread(POST_CHAT_ID, 42, {
      limit: 20,
    });

    expect(thread).toEqual({
      chatId: POST_CHAT_ID,
      messageId: 42,
      discussionChatId: null,
      comments: [],
      nextOffsetId: null,
    });
    expect(api.getChat).not.toHaveBeenCalled();
    expect(api.getMessageThreadHistory).not.toHaveBeenCalled();
  });
});

describe('TdSessionMessenger.sendMessage', () => {
  it('attaches a manual quote to the reply', async () => {
    const { messenger, api } = createMessenger({
      sendMessage: vi.fn(async () => messageFixture(910, 'ответ')),
    });

    const sent = await messenger.sendMessage(DISCUSSION_CHAT_ID, {
      text: 'ответ',
      replyToId: 901,
      quote: 'первый комментарий',
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: DISCUSSION_CHAT_ID,
        reply_to: {
          _: 'inputMessageReplyToMessage',
          message_id: 901,
          quote: {
            _: 'inputTextQuote',
            text: {
              _: 'formattedText',
              text: 'первый комментарий',
              entities: [],
            },
            rich_texts: [],
            position: 0,
          },
          checklist_task_id: 0,
          poll_option_id: '',
        },
      }),
    );
    expect(sent).toMatchObject({ id: 910, text: 'ответ' });
  });

  it('passes no quote when the input has none', async () => {
    const { messenger, api } = createMessenger({
      sendMessage: vi.fn(async () => messageFixture(911, 'ответ')),
    });

    await messenger.sendMessage(DISCUSSION_CHAT_ID, {
      text: 'ответ',
      replyToId: 901,
    });

    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        reply_to: expect.objectContaining({ quote: null }),
      }),
    );
  });
});

describe('TdSessionMessenger.sendComment', () => {
  it('replies to the thread root and returns the message with its final id', async () => {
    const pending = messageFixture(12345, 'новый комментарий', {
      sending_state: { _: 'messageSendingStatePending', sending_id: 1 },
    });
    const final = messageFixture(777, 'новый комментарий');
    const { messenger, api, emit } = createMessenger({
      getMessageThread: vi.fn(async () => liveThread()),
      sendMessage: vi.fn(async () => {
        setTimeout(() => {
          emit({
            _: 'updateMessageSendSucceeded',
            old_message_id: 12345,
            message: final,
          });
        }, 0);
        return pending;
      }),
    });

    const created = await messenger.sendComment(
      POST_CHAT_ID,
      42,
      'новый комментарий',
    );

    expect(api.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: DISCUSSION_CHAT_ID,
        topic_id: null,
        reply_to: expect.objectContaining({
          _: 'inputMessageReplyToMessage',
          message_id: THREAD_ROOT_ID,
        }),
        input_message_content: expect.objectContaining({
          _: 'inputMessageText',
          text: expect.objectContaining({ text: 'новый комментарий' }),
        }),
      }),
    );
    expect(created).toMatchObject({
      id: 777,
      chatId: DISCUSSION_CHAT_ID,
      text: 'новый комментарий',
      senderName: 'Bob',
    });
  });

  it('rejects a comment on a post without a discussion group', async () => {
    const { messenger, api } = createMessenger();

    await expect(
      messenger.sendComment(POST_CHAT_ID, 42, 'привет'),
    ).rejects.toMatchObject({
      status: 404,
      response: { code: 'THREAD_NOT_FOUND' },
    });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
