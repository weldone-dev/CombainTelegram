import { afterEach, describe, expect, it, vi } from 'vitest';
import type { chat, message, user } from 'tdlib-native/types';
import type { TelegramSessionModel } from '@repo/database';
import { TdSessionMessenger } from './td-messaging.service.js';

const SUPERGROUP_ID = 111;
const CHAT_ID = -(1_000_000_000_000 + SUPERGROUP_ID);
const PEER_ID = CHAT_ID;
const MESSAGE_ID = 77;
const SENDER_ID = 501;
const NOW = 1_700_000_000;

function chatFixture(): chat {
  return {
    _: 'chat',
    id: CHAT_ID,
    type: {
      _: 'chatTypeSupergroup',
      supergroup_id: SUPERGROUP_ID,
      is_channel: true,
    },
    title: 'Channel',
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
    id: SENDER_ID,
    first_name: 'Bob',
    last_name: '',
    usernames: { active_usernames: ['bob'], editable_username: 'bob' },
    profile_photo: null,
  } as unknown as user;
}

type ReactionFixture = Record<string, unknown>;

function emojiReaction(emoji: string, isChosen: boolean): ReactionFixture {
  return {
    _: 'messageReaction',
    type: { _: 'reactionTypeEmoji', emoji },
    total_count: 1,
    is_chosen: isChosen,
    used_sender_id: null,
    recent_sender_ids: [],
  };
}

const paidReaction: ReactionFixture = {
  _: 'messageReaction',
  type: { _: 'reactionTypePaid' },
  total_count: 1,
  is_chosen: true,
  used_sender_id: null,
  recent_sender_ids: [],
};

function messageFixture(reactions: ReactionFixture[]): message {
  return {
    _: 'message',
    id: MESSAGE_ID,
    sender_id: { _: 'messageSenderUser', user_id: SENDER_ID },
    chat_id: CHAT_ID,
    sending_state: null,
    is_outgoing: false,
    date: NOW,
    edit_date: 0,
    reply_to: null,
    topic_id: null,
    content: {
      _: 'messageText',
      text: { _: 'formattedText', text: 'channel post', entities: [] },
      link_preview: null,
      link_preview_options: null,
    },
    interaction_info: {
      _: 'messageInteractionInfo',
      view_count: 0,
      forward_count: 0,
      reply_info: null,
      reactions: {
        _: 'messageReactions',
        reactions,
        are_tags: false,
        paid_reactors: [],
        can_get_added_reactions: false,
      },
    },
  } as unknown as message;
}

function createMessenger(overrides: Record<string, unknown> = {}) {
  const api = {
    loadChats: vi.fn(async () => undefined),
    getChats: vi.fn(async () => ({ chat_ids: [] })),
    getChat: vi.fn(async () => chatFixture()),
    getUser: vi.fn(async () => userFixture()),
    getSupergroup: vi.fn(async () => ({
      usernames: { active_usernames: [], editable_username: null },
      status: { _: 'chatMemberStatusMember' },
    })),
    getMessage: vi.fn(async () => messageFixture([])),
    addMessageReaction: vi.fn(async () => undefined),
    removeMessageReaction: vi.fn(async () => undefined),
    ...overrides,
  };

  const client = {
    api,
    updates: {
      subscribe: vi.fn(() => () => undefined),
    },
  };

  const messenger = new TdSessionMessenger(
    {} as TelegramSessionModel,
    client as never,
    {} as never,
  );
  messenger.registry.put(chatFixture());
  return { messenger, api };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TdSessionMessenger.sendReaction', () => {
  it('refreshes once and retries the add when TDLib says the reaction is unavailable', async () => {
    const addMessageReaction = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("The reaction isn't available for the message"),
      )
      .mockResolvedValueOnce(undefined);
    const { messenger, api } = createMessenger({
      getMessage: vi
        .fn()
        .mockResolvedValueOnce(messageFixture([]))
        .mockResolvedValueOnce(messageFixture([]))
        .mockResolvedValueOnce(messageFixture([emojiReaction('❤️', true)])),
      addMessageReaction,
    });

    const view = await messenger.sendReaction(PEER_ID, MESSAGE_ID, '❤️');

    expect(addMessageReaction).toHaveBeenCalledTimes(2);
    expect(api.getMessage).toHaveBeenCalledTimes(3);
    expect(addMessageReaction).toHaveBeenLastCalledWith(
      expect.objectContaining({
        chat_id: CHAT_ID,
        message_id: MESSAGE_ID,
        reaction_type: { _: 'reactionTypeEmoji', emoji: '❤️' },
      }),
    );
    expect(view).toMatchObject({ id: MESSAGE_ID });
  });

  it('propagates a failed remove instead of swallowing it', async () => {
    const removeMessageReaction = vi.fn(async () => {
      throw new Error('Cannot remove the reaction');
    });
    const addMessageReaction = vi.fn(async () => undefined);
    const { messenger } = createMessenger({
      getMessage: vi
        .fn()
        .mockResolvedValueOnce(messageFixture([emojiReaction('👍', true)])),
      removeMessageReaction,
      addMessageReaction,
    });

    await expect(
      messenger.sendReaction(PEER_ID, MESSAGE_ID, null),
    ).rejects.toThrow('Cannot remove the reaction');
    expect(removeMessageReaction).toHaveBeenCalledTimes(1);
    expect(addMessageReaction).not.toHaveBeenCalled();
  });

  it('retries the refetch once when TDLib still reports the previous state', async () => {
    vi.useFakeTimers();
    const { messenger, api } = createMessenger({
      getMessage: vi
        .fn()
        .mockResolvedValueOnce(messageFixture([emojiReaction('👍', true)]))
        // Still the old state right after the removal.
        .mockResolvedValueOnce(messageFixture([emojiReaction('👍', true)]))
        .mockResolvedValueOnce(messageFixture([])),
    });

    const pending = messenger.sendReaction(PEER_ID, MESSAGE_ID, null);
    await vi.advanceTimersByTimeAsync(150);
    const view = await pending;

    expect(api.getMessage).toHaveBeenCalledTimes(3);
    expect(view).toMatchObject({ id: MESSAGE_ID });
  });

  it('returns the message without touching reactions when the emoji is already chosen', async () => {
    const { messenger, api } = createMessenger({
      getMessage: vi
        .fn()
        .mockResolvedValueOnce(messageFixture([emojiReaction('👍', true)])),
    });

    const view = await messenger.sendReaction(PEER_ID, MESSAGE_ID, '👍');

    expect(api.removeMessageReaction).not.toHaveBeenCalled();
    expect(api.addMessageReaction).not.toHaveBeenCalled();
    expect(view).toMatchObject({ id: MESSAGE_ID });
  });

  it('leaves paid reactions untouched while removing the chosen emoji', async () => {
    const { messenger, api } = createMessenger({
      getMessage: vi
        .fn()
        .mockResolvedValueOnce(
          messageFixture([paidReaction, emojiReaction('👍', true)]),
        )
        .mockResolvedValueOnce(messageFixture([paidReaction])),
    });

    await messenger.sendReaction(PEER_ID, MESSAGE_ID, null);

    expect(api.removeMessageReaction).toHaveBeenCalledTimes(1);
    expect(api.removeMessageReaction).toHaveBeenCalledWith({
      chat_id: CHAT_ID,
      message_id: MESSAGE_ID,
      reaction_type: { _: 'reactionTypeEmoji', emoji: '👍' },
    });
  });
});
