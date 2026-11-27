import type { tl } from '@mtcute/node';
import { describe, expect, it } from 'vitest';
import {
  markedPeerId,
  reactionEmoji,
  reactionEventsFromRawUpdate,
} from './reactions.js';

function rawUpdate(
  overrides: Partial<tl.RawUpdateMessageReactions> = {},
): tl.RawUpdateMessageReactions {
  return {
    _: 'updateMessageReactions',
    peer: { _: 'peerUser', userId: 555 },
    msgId: 42,
    reactions: {
      _: 'messageReactions',
      results: [],
      recentReactions: [
        {
          _: 'messagePeerReaction',
          peerId: { _: 'peerUser', userId: 555 },
          date: 1_700_000_000,
          reaction: { _: 'reactionEmoji', emoticon: '❤️' },
        },
      ],
    },
    ...overrides,
  } as tl.RawUpdateMessageReactions;
}

describe('markedPeerId', () => {
  it('maps users, basic chats and channels to marked ids', () => {
    expect(markedPeerId({ _: 'peerUser', userId: 7 })).toBe(7);
    expect(markedPeerId({ _: 'peerChat', chatId: 7 })).toBe(-7);
    expect(markedPeerId({ _: 'peerChannel', channelId: 7 })).toBe(
      -1_000_000_000_007,
    );
    expect(markedPeerId(null)).toBeNull();
  });
});

describe('reactionEmoji', () => {
  it('keeps plain emoji and drops custom/paid reactions', () => {
    expect(reactionEmoji({ _: 'reactionEmoji', emoticon: '🔥' })).toBe('🔥');
    expect(
      reactionEmoji({ _: 'reactionCustomEmoji', documentId: 1n as never }),
    ).toBeNull();
  });
});

describe('reactionEventsFromRawUpdate', () => {
  it('maps a recent reaction into a message.reaction payload', () => {
    const [event] = reactionEventsFromRawUpdate(rawUpdate(), {
      accountId: 'acc-1',
      sessionId: 'ses-1',
      targetIsMine: true,
    });

    expect(event?.payload).toEqual({
      accountId: 'acc-1',
      sessionId: 'ses-1',
      chatId: 555,
      threadId: 0,
      messageId: 42,
      emoji: '❤️',
      fromId: 555,
      outgoing: false,
      targetIsMine: true,
      date: 1_700_000_000,
    });
    expect(event?.dedupeKey).toBe(
      'message.reaction:acc-1:555:0:42:❤️:555:in:1700000000',
    );
  });

  it('uses the forum topic id as threadId', () => {
    const [event] = reactionEventsFromRawUpdate(rawUpdate({ topMsgId: 9 }), {
      accountId: 'acc-1',
      sessionId: 'ses-1',
    });

    expect(event?.payload.threadId).toBe(9);
    expect(event?.payload).not.toHaveProperty('targetIsMine');
  });

  it('marks own reactions as outgoing', () => {
    const [event] = reactionEventsFromRawUpdate(
      rawUpdate({
        reactions: {
          _: 'messageReactions',
          results: [],
          recentReactions: [
            {
              _: 'messagePeerReaction',
              peerId: { _: 'peerUser', userId: 555 },
              date: 1_700_000_000,
              my: true,
              reaction: { _: 'reactionEmoji', emoticon: '👍' },
            },
          ],
        },
      }),
      { accountId: 'acc-1', sessionId: 'ses-1' },
    );

    expect(event?.payload.outgoing).toBe(true);
  });

  it('returns nothing without recent reactors or an emoji reaction', () => {
    expect(
      reactionEventsFromRawUpdate(
        rawUpdate({
          reactions: { _: 'messageReactions', results: [], recentReactions: [] },
        }),
        { accountId: 'acc-1', sessionId: 'ses-1' },
      ),
    ).toEqual([]);
    expect(
      reactionEventsFromRawUpdate(
        rawUpdate({
          reactions: {
            _: 'messageReactions',
            results: [],
            recentReactions: [
              {
                _: 'messagePeerReaction',
                peerId: { _: 'peerUser', userId: 1 },
                date: 1_700_000_000,
                reaction: {
                  _: 'reactionCustomEmoji',
                  documentId: 1n as never,
                },
              },
            ],
          },
        }),
        { accountId: 'acc-1', sessionId: 'ses-1' },
      ),
    ).toEqual([]);
  });

  it('dedupes the same reactor entry inside one aggregate update', () => {
    const item = {
      _: 'messagePeerReaction' as const,
      peerId: { _: 'peerUser' as const, userId: 555 },
      date: 1_700_000_000,
      reaction: { _: 'reactionEmoji' as const, emoticon: '🔥' },
    };
    const events = reactionEventsFromRawUpdate(
      rawUpdate({
        reactions: {
          _: 'messageReactions',
          results: [],
          recentReactions: [item, { ...item }],
        },
      }),
      { accountId: 'acc-1', sessionId: 'ses-1' },
    );

    expect(events).toHaveLength(1);
  });
});
