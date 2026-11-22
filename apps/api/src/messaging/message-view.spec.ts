import { toChatView, toMessageView } from './message-view.js';
import type { DialogLike, MessageLike } from './message-view.js';

function fakeMessage(overrides: Partial<MessageLike> = {}): MessageLike {
  return {
    id: 10,
    text: 'hello',
    date: new Date('2026-11-16T10:00:00.000Z'),
    isOutgoing: false,
    sender: {
      id: 42,
      type: 'user',
      displayName: 'Alice',
      username: 'alice',
    },
    chat: {
      id: 42,
      type: 'user',
      displayName: 'Alice',
      username: 'alice',
    },
    replyToMessage: null,
    media: null,
    raw: { _: 'message', editDate: undefined },
    ...overrides,
  };
}

describe('message DTO mapping', () => {
  it('maps a plain message', () => {
    expect(toMessageView(fakeMessage())).toEqual({
      id: 10,
      chatId: 42,
      text: 'hello',
      date: '2026-11-16T10:00:00.000Z',
      outgoing: false,
      edited: false,
      senderId: 42,
      senderName: 'Alice',
      replyToId: null,
      mediaType: null,
    });
  });

  it('maps edits, replies and media', () => {
    const message = fakeMessage({
      id: 11,
      text: 'caption',
      isOutgoing: true,
      replyToMessage: { id: 7 },
      media: { type: 'photo' },
      raw: { _: 'message', editDate: 1_760_000_000 },
    });

    expect(toMessageView(message)).toMatchObject({
      id: 11,
      outgoing: true,
      edited: true,
      replyToId: 7,
      mediaType: 'photo',
    });
  });

  it('maps a dialog with its last message', () => {
    const dialog: DialogLike = {
      peer: {
        id: -1001234567890,
        type: 'supergroup',
        displayName: 'Team',
        username: 'team',
      },
      lastMessage: fakeMessage({
        id: 99,
        chat: {
          id: -1001234567890,
          type: 'supergroup',
          displayName: 'Team',
          username: 'team',
        },
      }),
      unreadCount: 3,
      isPinned: true,
      isMuted: null,
      isArchived: false,
      raw: { readInboxMaxId: 42 },
    };

    expect(toChatView(dialog)).toEqual({
      id: -1001234567890,
      type: 'supergroup',
      title: 'Team',
      username: 'team',
      lastMessage: expect.objectContaining({ id: 99, chatId: -1001234567890 }),
      unreadCount: 3,
      pinned: true,
      muted: false,
      archived: false,
      readInboxMaxId: 42,
    });
  });

  it('maps a dialog without messages', () => {
    const dialog: DialogLike = {
      peer: {
        id: 5,
        type: 'user',
        displayName: 'Bob',
        username: null,
      },
      lastMessage: null,
      unreadCount: 0,
      isPinned: false,
      isMuted: true,
      isArchived: true,
    };

    expect(toChatView(dialog)).toMatchObject({
      id: 5,
      lastMessage: null,
      muted: true,
      archived: true,
    });
  });
});
