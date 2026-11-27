import type { message } from 'tdlib-native/types';
import { describe, expect, it } from 'vitest';
import { EventDeduplicator } from '../realtime/dedupe.js';
import {
  chatTypeFromTdChatType,
  mapEditedMessage,
  mapTdUpdate,
  reactionEventsFromInteraction,
} from './td-updates.mapping.js';
import type { TdUpdateContext } from './td-updates.mapping.js';

const context: TdUpdateContext = {
  accountId: 'acc-1',
  sessionId: 'session-1',
};

/** Structural subset of a TDLib message, as delivered by `updateNewMessage`. */
function textMessage(id: number, chatId: number): message {
  return {
    _: 'message',
    id,
    chat_id: chatId,
    date: 1_700_000_000,
    is_outgoing: false,
    sender_id: { _: 'messageSenderUser', user_id: 42 },
    content: {
      _: 'messageText',
      text: { _: 'formattedText', text: 'hello', entities: [] },
      link_preview_options: null,
    },
    reply_to: null,
    interaction_info: null,
  } as unknown as message;
}

describe('mapTdUpdate — message.new', () => {
  it('uses the marked peer id of a supergroup chat', () => {
    const mapped = mapTdUpdate(
      {
        _: 'updateNewMessage',
        message: textMessage(7, -1_000_000_000_123),
      },
      context,
    );

    expect(mapped).toMatchObject({
      type: 'event',
      event: 'message.new',
      dedupeKey: 'acc-1:-1000000000123:7:new',
      payload: {
        accountId: 'acc-1',
        sessionId: 'session-1',
        chatId: -1_000_000_000_123,
        message: { id: 7, text: 'hello', outgoing: false },
      },
    });
  });

  it('maps a private user chat and a basic group chat', () => {
    const user = mapTdUpdate(
      { _: 'updateNewMessage', message: textMessage(1, 42) },
      context,
    );
    const group = mapTdUpdate(
      { _: 'updateNewMessage', message: textMessage(2, -77) },
      context,
    );

    expect(user?.type).toBe('event');
    expect((user as { payload: { chatId: number } }).payload.chatId).toBe(42);
    expect((group as { payload: { chatId: number } }).payload.chatId).toBe(77);
  });

  it('resolves chat and sender peers through the context', () => {
    const mapped = mapTdUpdate(
      { _: 'updateNewMessage', message: textMessage(3, 42) },
      {
        ...context,
        chat: () =>
          ({
            _: 'chat',
            id: 42,
            title: 'Alice',
            type: { _: 'chatTypePrivate', user_id: 42 },
          }) as never,
      },
    );

    expect(mapped).toMatchObject({
      payload: {
        chatId: 42,
        message: { id: 3, chatId: 42 },
      },
    });
  });
});

describe('mapTdUpdate — edits', () => {
  it('asks for a refetch and keeps the mtcute dedupe key', () => {
    const content = mapTdUpdate(
      {
        _: 'updateMessageContent',
        chat_id: 42,
        message_id: 9,
        new_content: { _: 'messageText' } as never,
      },
      context,
    );
    const edited = mapTdUpdate(
      {
        _: 'updateMessageEdited',
        chat_id: 42,
        message_id: 9,
        edit_date: 1_700_000_100,
        reply_markup: null,
      },
      context,
    );

    expect(content).toEqual({
      type: 'fetch',
      event: 'message.edited',
      tdChatId: 42,
      messageId: 9,
      dedupeKey: 'acc-1:42:9:edited',
    });
    expect(edited).toEqual(content);
  });

  it('maps a fetched message to message.edited', () => {
    const mapped = mapEditedMessage(textMessage(9, 42), context);

    expect(mapped).toMatchObject({
      type: 'event',
      event: 'message.edited',
      dedupeKey: 'acc-1:42:9:edited',
      payload: { chatId: 42, message: { id: 9 } },
    });
  });
});

describe('mapTdUpdate — delete and read', () => {
  it('maps deletes to marked chat ids', () => {
    const mapped = mapTdUpdate(
      {
        _: 'updateDeleteMessages',
        chat_id: -1_000_000_000_123,
        message_ids: [4, 5],
        is_permanent: true,
        from_cache: false,
      },
      context,
    );

    expect(mapped).toMatchObject({
      event: 'message.deleted',
      dedupeKey: 'acc-1:-1000000000123:4.5:deleted',
      payload: {
        chatId: -1_000_000_000_123,
        sessionId: 'session-1',
        messageIds: [4, 5],
      },
    });
  });

  it('maps read inbox and outbox to message.read', () => {
    const inbox = mapTdUpdate(
      {
        _: 'updateChatReadInbox',
        chat_id: 42,
        last_read_inbox_message_id: 11,
        unread_count: 3,
      },
      context,
    );
    const outbox = mapTdUpdate(
      {
        _: 'updateChatReadOutbox',
        chat_id: 42,
        last_read_outbox_message_id: 12,
      },
      context,
    );

    expect(inbox).toMatchObject({
      event: 'message.read',
      dedupeKey: 'acc-1:42:11:read_inbox',
      payload: { maxId: 11, outbox: false, unread: 3 },
    });
    expect(outbox).toMatchObject({
      event: 'message.read',
      dedupeKey: 'acc-1:42:12:read_outbox',
      payload: { maxId: 12, outbox: true, unread: 0 },
    });
  });
});

describe('mapTdUpdate — typing', () => {
  it('maps a user action to chat.typing with mtcute statuses', () => {
    const mapped = mapTdUpdate(
      {
        _: 'updateChatAction',
        chat_id: 42,
        topic_id: null,
        sender_id: { _: 'messageSenderUser', user_id: 42 },
        action: { _: 'chatActionRecordingVoiceNote' },
      },
      { ...context, chatType: () => 'user' },
    );

    expect(mapped).toMatchObject({
      event: 'chat.typing',
      dedupeKey: 'acc-1:42:42:typing:record_voice',
      payload: {
        chatId: 42,
        userId: 42,
        status: 'record_voice',
        chatType: 'user',
      },
    });
  });

  it('uses the marked chat id for a chat sender and maps cancel', () => {
    const mapped = mapTdUpdate(
      {
        _: 'updateChatAction',
        chat_id: -1_000_000_000_123,
        topic_id: null,
        sender_id: { _: 'messageSenderChat', chat_id: -1_000_000_000_123 },
        action: { _: 'chatActionCancel' },
      },
      context,
    );

    expect(mapped).toMatchObject({
      payload: {
        chatId: -1_000_000_000_123,
        userId: -1_000_000_000_123,
        status: 'cancel',
        chatType: 'chat',
      },
    });
  });

  it('ignores actions with no mtcute equivalent', () => {
    const mapped = mapTdUpdate(
      {
        _: 'updateChatAction',
        chat_id: 42,
        topic_id: null,
        sender_id: { _: 'messageSenderUser', user_id: 42 },
        action: { _: 'chatActionStartPlayingGame' },
      },
      context,
    );

    expect(mapped).toBeNull();
  });

  it('maps chat types like mtcute BasicPeerType', () => {
    expect(chatTypeFromTdChatType({ _: 'chatTypePrivate' })).toBe('user');
    expect(chatTypeFromTdChatType({ _: 'chatTypeSecret' })).toBe('user');
    expect(chatTypeFromTdChatType({ _: 'chatTypeBasicGroup' })).toBe('chat');
    expect(
      chatTypeFromTdChatType({
        _: 'chatTypeSupergroup',
        is_channel: true,
      }),
    ).toBe('channel');
    expect(chatTypeFromTdChatType({ _: 'chatTypeSupergroup' })).toBe('chat');
  });
});

describe('dedupe keys', () => {
  it('suppresses the same update seen from two TDLib sessions for 10 s', () => {
    const dedupe = new EventDeduplicator();
    const first = mapTdUpdate(
      { _: 'updateNewMessage', message: textMessage(5, 42) },
      context,
    );
    const second = mapTdUpdate(
      { _: 'updateNewMessage', message: textMessage(5, 42) },
      { ...context, sessionId: 'session-2' },
    );

    expect(first?.dedupeKey).toBe(second?.dedupeKey);
    expect(dedupe.shouldEmit(first!.dedupeKey)).toBe(true);
    expect(dedupe.shouldEmit(second!.dedupeKey)).toBe(false);
  });
});

describe('mapTdUpdate — TDLib reactions', () => {
  const reactionUpdate = {
    _: 'updateMessageInteractionInfo',
    chat_id: 42,
    message_id: 7,
    interaction_info: {
      _: 'messageInteractionInfo',
      view_count: 0,
      forward_count: 0,
      reply_info: null,
      reactions: {
        _: 'messageReactions',
        reactions: [
          {
            _: 'messageReaction',
            type: { _: 'reactionTypeEmoji', emoji: '❤' },
            total_count: 1,
            is_chosen: false,
            used_sender_id: null,
            recent_sender_ids: [
              { _: 'messageSenderUser', user_id: 42 },
            ],
          },
        ],
        are_tags: false,
        paid_reactors: [],
        can_get_added_reactions: false,
      },
    },
  } as const;

  it('maps an incoming reaction with the message author facts', () => {
    const events = reactionEventsFromInteraction(
      reactionUpdate as never,
      {
        ...context,
        selfUserId: 99,
        recentMessage: () => ({
          outgoing: true,
          text: 'её сообщение',
          date: '2026-11-27T10:00:00.000Z',
        }),
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'event',
      event: 'message.reaction',
      payload: {
        accountId: 'acc-1',
        chatId: 42,
        messageId: 7,
        emoji: '❤',
        fromId: 42,
        outgoing: false,
        targetIsMine: true,
      },
    });
  });

  it('skips the account’s own reaction and non-emoji kinds', () => {
    const own = reactionEventsFromInteraction(
      reactionUpdate as never,
      { ...context, selfUserId: 42, recentMessage: () => ({ outgoing: false }) },
    );
    expect(own).toHaveLength(0);

    const custom = reactionEventsFromInteraction(
      {
        ...reactionUpdate,
        interaction_info: {
          ...reactionUpdate.interaction_info,
          reactions: {
            ...reactionUpdate.interaction_info.reactions,
            reactions: [
              {
                ...reactionUpdate.interaction_info.reactions.reactions[0],
                type: { _: 'reactionTypeCustomEmoji', custom_emoji_id: '1' },
              },
            ],
          },
        },
      } as never,
      { ...context, selfUserId: 99 },
    );
    expect(custom).toHaveLength(0);
  });

  it('enriches updateDeleteMessages from the recent index', () => {
    const mapped = mapTdUpdate(
      { _: 'updateDeleteMessages', chat_id: 42, message_ids: [7], is_permanent: true, from_cache: false },
      {
        ...context,
        recentMessage: () => ({
          outgoing: false,
          text: 'секрет',
          date: '2026-11-27T10:00:00.000Z',
        }),
      },
    );

    expect(mapped).toMatchObject({
      event: 'message.deleted',
      payload: {
        chatId: 42,
        messageIds: [7],
        outgoing: false,
        messages: [
          {
            id: 7,
            outgoing: false,
            text: 'секрет',
            date: '2026-11-27T10:00:00.000Z',
          },
        ],
      },
    });
  });

  it('drops a cache-eviction delete (from_cache) instead of a turn', () => {
    const mapped = mapTdUpdate(
      {
        _: 'updateDeleteMessages',
        chat_id: 42,
        message_ids: [7, 8, 9],
        is_permanent: false,
        from_cache: true,
      },
      context,
    );

    expect(mapped).toBeNull();
  });

  it('drops a delete that only made messages inaccessible', () => {
    const mapped = mapTdUpdate(
      {
        _: 'updateDeleteMessages',
        chat_id: 42,
        message_ids: [7],
        is_permanent: false,
        from_cache: false,
      },
      context,
    );

    expect(mapped).toBeNull();
  });

  it('leaves outgoing unknown when a deleted id was never seen', () => {
    const mapped = mapTdUpdate(
      { _: 'updateDeleteMessages', chat_id: 42, message_ids: [7], is_permanent: true, from_cache: false },
      context,
    );
    expect(mapped).toMatchObject({
      event: 'message.deleted',
      payload: { messages: [{ id: 7 }] },
    });
    expect(
      (mapped as { payload: Record<string, unknown> }).payload.outgoing,
    ).toBeUndefined();
  });
});
