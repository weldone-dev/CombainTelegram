import type { tl } from '@mtcute/node';

/**
 * Pure mapping of mtcute's raw `updateMessageReactions` into the same
 * `message.reaction` payload the TDLib bridge will publish.
 *
 * mtcute 0.32 has no high-level reaction event, so `UpdatesService` listens to
 * `onRawUpdate` and this module owns the shape/dedupe logic (and the tests).
 *
 * `updateMessageReactions` is an aggregate update: it lists the reactions that
 * currently exist plus a few recent reactors. We only publish the recent
 * reactors (that is where the emoji + author live), and the dedupe key includes
 * the reaction `date`, so replaying the same aggregate update does not create
 * a second event while a later remove/re-add does.
 */

export interface ReactionEventPayload {
  accountId: string;
  sessionId: string;
  chatId: number;
  threadId: number;
  messageId: number;
  emoji: string;
  /** Marked peer id of the reactor; `null` when Telegram hid it. */
  fromId: number | null;
  /** True when the reaction was sent by this account (the persona). */
  outgoing: boolean;
  /** Whether the reacted-to message was sent by the persona, when known. */
  targetIsMine?: boolean;
  /** Telegram update timestamp, seconds. */
  date: number;
}

export interface ReactionEvent {
  payload: ReactionEventPayload;
  dedupeKey: string;
}

export interface ReactionUpdateContext {
  accountId: string;
  sessionId: string;
  /** `undefined` when the message was not seen in this process. */
  targetIsMine?: boolean;
}

/**
 * Marked peer id, matching `Chat.id` / `message.chat.id` for this codebase:
 * users stay positive, basic chats become `-id`, channels `-100…`.
 */
export function markedPeerId(peer: tl.TypePeer | null | undefined): number | null {
  if (!peer) return null;
  switch (peer._) {
    case 'peerUser':
      return peer.userId;
    case 'peerChat':
      return -peer.chatId;
    case 'peerChannel':
      return -(1_000_000_000_000 + peer.channelId);
    default:
      return null;
  }
}

/** Emoji of a plain reaction; custom/paid reactions are not persona material. */
export function reactionEmoji(reaction: tl.TypeReaction): string | null {
  if (reaction._ !== 'reactionEmoji') return null;
  const emoji = reaction.emoticon.trim();
  return emoji || null;
}

export function reactionEventsFromRawUpdate(
  update: tl.RawUpdateMessageReactions,
  context: ReactionUpdateContext,
): ReactionEvent[] {
  const chatId = markedPeerId(update.peer);
  if (chatId === null) return [];

  const threadId =
    typeof update.topMsgId === 'number' && update.topMsgId > 0
      ? update.topMsgId
      : 0;
  const messageId = Number(update.msgId);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return [];

  const recent = update.reactions?.recentReactions ?? [];
  const events: ReactionEvent[] = [];
  const seen = new Set<string>();

  for (const item of recent) {
    const emoji = reactionEmoji(item.reaction);
    if (!emoji) continue;

    const fromId = markedPeerId(item.peerId);
    const outgoing = item.my === true;
    const date = Number.isFinite(item.date) ? item.date : 0;
    const dedupeKey = [
      'message.reaction',
      context.accountId,
      chatId,
      threadId,
      messageId,
      emoji,
      fromId ?? '',
      outgoing ? 'out' : 'in',
      date,
    ].join(':');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    events.push({
      dedupeKey,
      payload: {
        accountId: context.accountId,
        sessionId: context.sessionId,
        chatId,
        threadId,
        messageId,
        emoji,
        fromId,
        outgoing,
        ...(context.targetIsMine !== undefined
          ? { targetIsMine: context.targetIsMine }
          : {}),
        date,
      },
    });
  }

  return events;
}
