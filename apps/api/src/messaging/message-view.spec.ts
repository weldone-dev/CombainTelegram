import {
  canSendMessages,
  mergeDialogsById,
  toChatView,
  toChatViewFromPeer,
  toFolderView,
  toMessageMediaView,
  toMessagePollView,
  toMessageThreadInfo,
  toMessageView,
} from './message-view.js';
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
      media: null,
      reactions: [],
      poll: null,
      isVoice: false,
      service: false,
      thread: null,
      sendingState: null,
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
      media: {
        kind: 'photo',
        mimeType: null,
        fileName: null,
        size: null,
        downloadable: true,
      },
    });
  });

  it('maps document media with file name, MIME type and size', () => {
    const media = {
      type: 'document',
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      fileSize: 1234,
    };

    expect(toMessageMediaView(media)).toEqual({
      kind: 'document',
      mimeType: 'application/pdf',
      fileName: 'report.pdf',
      size: 1234,
      downloadable: true,
    });
    expect(toMessageView(fakeMessage({ media }))).toMatchObject({
      mediaType: 'document',
      media: { kind: 'document' },
    });
  });

  it('maps unsupported media as other and keeps it non-downloadable', () => {
    expect(
      toMessageMediaView({
        type: 'webpage',
        fileName: null,
        mimeType: null,
        fileSize: 0,
      }),
    ).toEqual({
      kind: 'other',
      mimeType: null,
      fileName: null,
      size: 0,
      downloadable: false,
    });
  });

  it('maps video, round video notes and GIFs to distinct kinds', () => {
    expect(
      toMessageMediaView({
        type: 'video',
        fileName: 'clip.mp4',
        mimeType: 'video/mp4',
        fileSize: 99,
      }),
    ).toEqual({
      kind: 'video',
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
      size: 99,
      downloadable: false,
    });

    expect(
      toMessageMediaView({
        type: 'video',
        mimeType: 'video/mp4',
        isRound: true,
      }),
    ).toMatchObject({ kind: 'video_note', downloadable: true });

    expect(
      toMessageMediaView({
        type: 'video',
        mimeType: 'video/mp4',
        isAnimation: true,
      }),
    ).toMatchObject({
      kind: 'animation',
      isAnimated: true,
      downloadable: true,
    });
  });

  it('maps an animated sticker with emoji, size and sticker set', () => {
    const view = toMessageMediaView({
      type: 'sticker',
      mimeType: 'application/x-tgsticker',
      fileSize: 20_000,
      emoji: '🐷',
      sourceType: 'animated',
      width: 512,
      height: 512,
      inputStickerSet: { shortName: 'pink_pigs' },
    });

    expect(view).toEqual({
      kind: 'sticker',
      mimeType: 'application/x-tgsticker',
      fileName: null,
      size: 20_000,
      downloadable: true,
      emoji: '🐷',
      isAnimated: true,
      width: 512,
      height: 512,
      stickerSet: 'pink_pigs',
    });
  });

  it('survives media getters that throw', () => {
    const media = {
      type: 'document',
      get fileName(): string {
        throw new Error('no filename');
      },
      get mimeType(): string {
        throw new Error('no mime');
      },
      get fileSize(): number {
        throw new Error('no size');
      },
    };

    expect(toMessageMediaView(media)).toEqual({
      kind: 'document',
      mimeType: null,
      fileName: null,
      size: null,
      downloadable: true,
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
      canSendMessages: true,
    });
  });

  it('maps a bare peer to a neutral chat view', () => {
    expect(
      toChatViewFromPeer({
        id: -1001234567890,
        type: 'channel',
        displayName: 'News',
        username: 'news',
      }),
    ).toEqual({
      id: -1001234567890,
      type: 'channel',
      title: 'News',
      username: 'news',
      lastMessage: null,
      unreadCount: 0,
      pinned: false,
      muted: false,
      archived: false,
      readInboxMaxId: 0,
      canSendMessages: false,
    });
  });

  it('maps folders', () => {
    expect(
      toFolderView({ id: 2, title: { text: 'Work' }, emoticon: '💼' }),
    ).toEqual({ id: 2, title: 'Work', emoticon: '💼' });
    expect(toFolderView({ id: 3, title: { text: 'No icon' } })).toEqual({
      id: 3,
      title: 'No icon',
      emoticon: null,
    });
  });

  it('maps a dialog without messages', () => {    const dialog: DialogLike = {
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
      canSendMessages: true,
    });
  });
});

describe('mergeDialogsById', () => {
  const dialog = (id: number) => ({ peer: { id } });

  it('merges main and archive folders without duplicates', () => {
    const merged = mergeDialogsById([
      [dialog(1), dialog(2)],
      [dialog(2), dialog(3)],
    ]);
    expect(merged.map((entry) => entry.peer.id)).toEqual([1, 2, 3]);
  });

  it('keeps the first occurrence order and honours the limit', () => {
    const merged = mergeDialogsById(
      [
        [dialog(10), dialog(11)],
        [dialog(11), dialog(12), dialog(13)],
      ],
      3,
    );
    expect(merged.map((entry) => entry.peer.id)).toEqual([10, 11, 12]);
  });

  it('handles empty folders and a zero limit', () => {
    expect(mergeDialogsById([[], []])).toEqual([]);
    expect(mergeDialogsById([[dialog(1)]], 0)).toEqual([]);
  });
});

describe('canSendMessages', () => {
  const peer = (
    overrides: Partial<DialogLike['peer']> = {},
  ): DialogLike['peer'] => ({
    id: 1,
    type: 'user',
    displayName: 'Peer',
    username: null,
    ...overrides,
  });

  it('allows private chats and bots unless explicitly restricted', () => {
    expect(canSendMessages(peer())).toBe(true);
    expect(canSendMessages(peer({ type: 'bot' }))).toBe(true);
    expect(
      canSendMessages(peer({ permissions: { canSendMessages: false } })),
    ).toBe(false);
  });

  it('allows legacy groups without permission info', () => {
    expect(canSendMessages(peer({ type: 'group' }))).toBe(true);
  });

  it('follows the permission object for supergroups', () => {
    expect(
      canSendMessages(
        peer({ type: 'supergroup', permissions: { canSendMessages: true } }),
      ),
    ).toBe(true);
    expect(
      canSendMessages(
        peer({ type: 'supergroup', permissions: { canSendMessages: false } }),
      ),
    ).toBe(false);
  });

  it('requires admin or creator rights in broadcast channels', () => {
    expect(canSendMessages(peer({ type: 'channel' }))).toBe(false);
    expect(canSendMessages(peer({ type: 'channel', isAdmin: true }))).toBe(
      true,
    );
    expect(canSendMessages(peer({ type: 'channel', isCreator: true }))).toBe(
      true,
    );
    expect(
      canSendMessages(
        peer({
          type: 'channel',
          isAdmin: true,
          permissions: { canSendMessages: false },
        }),
      ),
    ).toBe(false);
  });
});

describe('message reactions', () => {
  it('maps reaction counts, marking the chosen one', () => {
    const message = fakeMessage({
      reactions: {
        reactions: [
          { emoji: '👍', count: 3, order: null },
          { emoji: '❤️', count: 1, order: 0 },
        ],
      },
    });

    expect(toMessageView(message).reactions).toEqual([
      { emoji: '👍', count: 3, chosen: false },
      { emoji: '❤️', count: 1, chosen: true },
    ]);
  });

  it('strings custom emoji Longs as custom:<id>', () => {
    const custom = { toString: () => '5368324170671202286' };
    expect(
      toMessageView(
        fakeMessage({
          reactions: { reactions: [{ emoji: custom, count: 2, order: null }] },
        }),
      ).reactions,
    ).toEqual([
      { emoji: 'custom:5368324170671202286', count: 2, chosen: false },
    ]);
  });

  it('drops zero counts and empty reaction sets', () => {
    expect(
      toMessageView(
        fakeMessage({
          reactions: {
            reactions: [
              { emoji: '👍', count: 0, order: null },
              { emoji: '', count: 4, order: null },
            ],
          },
        }),
      ).reactions,
    ).toEqual([]);
    expect(
      toMessageView(fakeMessage({ reactions: { reactions: [] } })).reactions,
    ).toEqual([]);
    expect(toMessageView(fakeMessage({ reactions: null })).reactions).toEqual(
      [],
    );
  });
});

describe('message polls', () => {
  const pollMedia = {
    type: 'poll',
    id: { toString: () => '123456' },
    question: 'Which one?',
    answers: [
      { text: 'A', voters: 4, chosen: true, correct: true },
      { text: 'B', voters: 1, chosen: false, correct: false },
    ],
    voters: 5,
    isClosed: false,
    isQuiz: true,
    isMultiple: false,
    hideResultsUntilClose: false,
    solution: 'Because A',
  };

  it('maps a poll including answer indexes and quiz data', () => {
    const view = toMessageView(fakeMessage({ media: pollMedia }));

    expect(view.poll).toEqual({
      id: '123456',
      question: 'Which one?',
      closed: false,
      quiz: true,
      multiple: false,
      voters: 5,
      hideResultsUntilClose: false,
      answers: [
        { index: 0, text: 'A', voters: 4, chosen: true, correct: true },
        { index: 1, text: 'B', voters: 1, chosen: false, correct: false },
      ],
      solution: 'Because A',
    });
  });

  it('leaves poll null for non-poll media and plain messages', () => {
    expect(toMessageView(fakeMessage()).poll).toBeNull();
    expect(
      toMessageView(fakeMessage({ media: { type: 'photo' } })).poll,
    ).toBeNull();
  });

  it('survives a malformed poll without throwing', () => {
    const malformed = {
      type: 'poll',
      get answers(): never {
        throw new Error('broken poll');
      },
    };
    expect(() =>
      toMessageView(fakeMessage({ media: malformed })),
    ).not.toThrow();
    expect(toMessageView(fakeMessage({ media: malformed })).poll).toBeNull();
  });

  it('rejects a poll without an answers array', () => {
    expect(
      toMessagePollView({ type: 'poll', question: 'Q', answers: undefined }),
    ).toBeNull();
  });
});

describe('voice messages', () => {
  it('maps voice media as downloadable audio/ogg', () => {
    const message = fakeMessage({
      media: { type: 'voice', fileSize: 2048 },
    });

    expect(toMessageView(message)).toMatchObject({
      mediaType: 'voice',
      isVoice: true,
      media: {
        kind: 'voice',
        mimeType: 'audio/ogg',
        size: 2048,
        downloadable: true,
      },
    });
  });

  it('keeps isVoice false for other media', () => {
    expect(toMessageView(fakeMessage({ media: { type: 'photo' } })).isVoice).toBe(
      false,
    );
  });
});

describe('comment threads', () => {
  it('returns null for messages without replies info', () => {
    expect(toMessageView(fakeMessage()).thread).toBeNull();
  });

  it('maps a channel post with a linked discussion group', () => {
    const message = fakeMessage({
      replies: {
        hasComments: true,
        count: 12,
        discussion: -1001234567890,
      },
    });

    expect(toMessageThreadInfo(message)).toEqual({
      comments: 12,
      hasComments: true,
      discussionChatId: -1001234567890,
    });
  });

  it('falls back to the raw channel id for the discussion chat', () => {
    const message = fakeMessage({
      replies: { hasComments: true, count: 3, discussion: null },
      raw: { _: 'message', replies: { channelId: 1234567890 } },
    });

    expect(toMessageThreadInfo(message)).toEqual({
      comments: 3,
      hasComments: true,
      discussionChatId: -1001234567890,
    });
  });

  it('ignores group reply info without a comments section', () => {
    const message = fakeMessage({
      replies: { hasComments: false, count: 5, discussion: null },
    });

    expect(toMessageThreadInfo(message)).toBeNull();
  });

  it('degrades to a thread with no discussions when getters throw', () => {
    const replies = {
      get hasComments(): boolean {
        return true;
      },
      get count(): number {
        throw new Error('broken');
      },
      get discussion(): number | null {
        throw new Error('broken');
      },
    };

    expect(toMessageThreadInfo(fakeMessage({ replies }))).toEqual({
      comments: 0,
      hasComments: true,
      discussionChatId: null,
    });
  });
});
