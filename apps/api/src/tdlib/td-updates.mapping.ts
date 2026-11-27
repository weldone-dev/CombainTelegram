/**
 * Pure TDLib update → realtime event mapping.
 *
 * The service layer owns clients, listeners and the dedupe window; this module
 * only translates a TDLib update into the same event name/payload that the
 * mtcute `UpdatesService` publishes, so the dashboard cannot tell which engine
 * produced an event. Chat ids in payloads are marked peer ids, exactly like
 * mtcute's `message.chat.id` (`peerIdFromTdChatId`).
 */

import type {
  chat,
  message,
  updateChatAction,
  updateChatReadInbox,
  updateChatReadOutbox,
  updateDeleteMessages,
  updateMessageContent,
  updateMessageEdited,
  updateMessageInteractionInfo,
  updateNewMessage,
} from 'tdlib-native/types';
import type { PeerLike } from '../messaging/message-view.js';
import { toMessageViewFromTd } from './td-message-view.js';
import type { TdPeerResolver } from './td-message-view.js';
import { peerIdFromTdChatId } from './td-peer.js';

/** TDLib updates this realtime bridge understands. */
export type TdHandledUpdate =
  | updateNewMessage
  | updateMessageContent
  | updateMessageEdited
  | updateDeleteMessages
  | updateMessageInteractionInfo
  | updateChatReadInbox
  | updateChatReadOutbox
  | updateChatAction;

/** Chat kind used by mtcute's `chat.typing` payload. */
export type TdTypingChatType = 'user' | 'chat' | 'channel';

/** Session-owned lookups the mapper needs; all optional for pure tests. */
export interface TdUpdateContext {
  accountId: string;
  sessionId: string;
  /** Cached chat object by TDLib `chat_id` (from `TdChatRegistry`). */
  chat?: (chatId: number) => chat | undefined;
  /** Cached chat kind by TDLib `chat_id`. */
  chatType?: (chatId: number) => TdTypingChatType | undefined;
  /** Sender peer resolved from the session's user/chat caches. */
  resolveSender?: TdPeerResolver;
  /** Display name of a user/chat, used for forward origins. */
  userName?: (userId: number) => string | undefined;
  chatName?: (chatId: number) => string | undefined;
  /** Facts about a message seen earlier in this process (delete/reaction). */
  recentMessage?: (
    chatId: number,
    messageId: number,
  ) => { outgoing: boolean; text?: string; date?: string } | undefined;
  /** This account's Telegram user id, so its own reactions are marked. */
  selfUserId?: number;
}

export interface TdMappedEvent {
  type: 'event';
  event:
    | 'message.new'
    | 'message.edited'
    | 'message.deleted'
    | 'message.reaction'
    | 'message.read'
    | 'chat.typing';
  payload: Record<string, unknown>;
  dedupeKey: string;
}

/** An edit/content update only points at a message; the caller fetches it. */
export interface TdFetchMessageRequest {
  type: 'fetch';
  event: 'message.edited';
  tdChatId: number;
  messageId: number;
  dedupeKey: string;
}

export type TdMappedUpdate = TdMappedEvent | TdFetchMessageRequest;

/** mtcute `BasicPeerType` of a TDLib chat type. */
export function chatTypeFromTdChatType(type: {
  _: string;
  is_channel?: boolean;
}): TdTypingChatType {
  switch (type?._) {
    case 'chatTypePrivate':
    case 'chatTypeSecret':
      return 'user';
    case 'chatTypeSupergroup':
      return type.is_channel === true ? 'channel' : 'chat';
    default:
      return 'chat';
  }
}

/** Typing statuses TDLib can report, translated to mtcute's `TypingStatus`. */
const TYPING_STATUS: Record<string, string> = {
  chatActionTyping: 'typing',
  chatActionCancel: 'cancel',
  chatActionRecordingVideo: 'record_video',
  chatActionRecordingVoiceNote: 'record_voice',
  chatActionUploadingPhoto: 'upload_photo',
  chatActionUploadingVideo: 'upload_video',
  chatActionUploadingVoiceNote: 'upload_voice',
  chatActionUploadingDocument: 'upload_document',
  chatActionChoosingLocation: 'geo',
  chatActionChoosingContact: 'contact',
  chatActionChoosingSticker: 'sticker',
  chatActionRecordingVideoNote: 'record_round',
  chatActionUploadingVideoNote: 'upload_round',
  chatActionWatchingAnimations: 'game',
};

function peerIdOfChat(chatId: number): number {
  return peerIdFromTdChatId(chatId) ?? chatId;
}

function peerOfCachedChat(entry: chat | undefined): PeerLike | undefined {
  if (!entry) return undefined;
  const id = peerIdOfChat(entry.id);
  const type = entry.type;
  return {
    id,
    type:
      type._ === 'chatTypePrivate' || type._ === 'chatTypeSecret'
        ? 'user'
        : 'chat',
    displayName: entry.title || String(id),
    username: null,
    permissions: { canSendMessages: true },
  };
}

/** `message.new` event for one complete TDLib message. */
export function mapNewMessage(
  entry: message,
  context: TdUpdateContext,
): TdMappedEvent {
  const chatId = peerIdOfChat(entry.chat_id);
  return {
    type: 'event',
    event: 'message.new',
    payload: {
      accountId: context.accountId,
      sessionId: context.sessionId,
      chatId,
      message: toMessageViewFromTd(entry, {
        chat: context.chat?.(entry.chat_id) ?? null,
        chatPeer: peerOfCachedChat(context.chat?.(entry.chat_id)),
        resolveSender: context.resolveSender,
        userName: context.userName,
        chatName: context.chatName,
      }),
    },
    dedupeKey: `${context.accountId}:${chatId}:${entry.id}:new`,
  };
}

/** `message.edited` event for a freshly fetched TDLib message. */
export function mapEditedMessage(
  entry: message,
  context: TdUpdateContext,
): TdMappedEvent {
  const chatId = peerIdOfChat(entry.chat_id);
  return {
    type: 'event',
    event: 'message.edited',
    payload: {
      accountId: context.accountId,
      sessionId: context.sessionId,
      chatId,
      message: toMessageViewFromTd(entry, {
        chat: context.chat?.(entry.chat_id) ?? null,
        chatPeer: peerOfCachedChat(context.chat?.(entry.chat_id)),
        resolveSender: context.resolveSender,
        userName: context.userName,
        chatName: context.chatName,
      }),
    },
    dedupeKey: `${context.accountId}:${chatId}:${entry.id}:edited`,
  };
}

/** Emoji of a TDLib reaction type; custom/paid reactions are not persona material. */
function reactionEmoji(type: { _: string; emoji?: string }): string | null {
  if (type?._ !== 'reactionTypeEmoji') return null;
  const emoji = typeof type.emoji === 'string' ? type.emoji.trim() : '';
  return emoji || null;
}

function senderIdOf(sender: {
  _: string;
  user_id?: number;
  chat_id?: number;
}): number | null {
  if (sender?._ === 'messageSenderUser') {
    return Number(sender.user_id) || null;
  }
  if (sender?._ === 'messageSenderChat') {
    return peerIdOfChat(Number(sender.chat_id));
  }
  return null;
}

/**
 * `message.reaction` events from `updateMessageInteractionInfo`.
 *
 * TDLib reports aggregate reactions, not the delta: each `messageReaction`
 * carries at most three recent senders. We publish one event per seen sender
 * (that is where the author lives), skip this account's own reaction, and mark
 * whether the reacted-to message belongs to the persona via the recent index.
 */
export function reactionEventsFromInteraction(
  update: updateMessageInteractionInfo,
  context: TdUpdateContext,
): TdMappedEvent[] {
  const info = update.interaction_info;
  const reactions = info?.reactions?.reactions;
  if (!Array.isArray(reactions) || reactions.length === 0) return [];
  const chatId = peerIdOfChat(update.chat_id);
  const messageId = Number(update.message_id);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) return [];
  const target = context.recentMessage?.(update.chat_id, messageId);
  const events: TdMappedEvent[] = [];
  const seen = new Set<string>();

  for (const reaction of reactions) {
    const emoji = reactionEmoji(reaction.type);
    if (!emoji) continue;
    const senders = Array.isArray(reaction.recent_sender_ids)
      ? reaction.recent_sender_ids
      : [];
    // `recent_sender_ids` is empty outside private/basic/supergroup chats. An
    // aggregate with no author still has to reach Eve, otherwise reactions in
    // those chats disappear on TDLib accounts; mark it as an unknown author.
    const ids = senders.length > 0 ? senders.map(senderIdOf) : [null];
    for (const fromId of ids) {
      const outgoing =
        context.selfUserId !== undefined && fromId === context.selfUserId;
      if (outgoing) continue;
      const dedupeKey = [
        'message.reaction',
        context.accountId,
        chatId,
        messageId,
        emoji,
        fromId ?? '',
      ].join(':');
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      events.push({
        type: 'event',
        event: 'message.reaction',
        payload: {
          accountId: context.accountId,
          sessionId: context.sessionId,
          chatId,
          threadId: 0,
          messageId,
          emoji,
          fromId,
          outgoing: false,
          ...(target ? { targetIsMine: target.outgoing } : {}),
          date: 0,
        },
        dedupeKey,
      });
    }
  }
  return events;
}

/** Builds an event for a TDLib update that carries all of its data. */
export function mapTdUpdate(
  update: TdHandledUpdate,
  context: TdUpdateContext,
): TdMappedUpdate | null {
  switch (update._) {
    case 'updateNewMessage':
      return mapNewMessage(update.message, context);

    case 'updateMessageContent':
    case 'updateMessageEdited': {
      const chatId = peerIdOfChat(update.chat_id);
      return {
        type: 'fetch',
        event: 'message.edited',
        tdChatId: update.chat_id,
        messageId: update.message_id,
        dedupeKey: `${context.accountId}:${chatId}:${update.message_id}:edited`,
      };
    }

    case 'updateDeleteMessages': {
      // TDLib emits this for its own local cache eviction (`from_cache`) and
      // for messages that merely became inaccessible (`is_permanent: false`),
      // not only for a user deleting a message. Those updates repeat with a
      // growing id list and must not start a "he deleted it" turn.
      if (update.from_cache === true || update.is_permanent !== true) {
        return null;
      }
      const chatId = peerIdOfChat(update.chat_id);
      // The TDLib update only carries ids. The session's recent index supplies
      // text/date/outgoing, so the deletion policy can tell "saw and read" from
      // "missed" and quote what was deleted.
      const messages: Array<{
        id: number;
        outgoing?: boolean;
        text?: string;
        date?: string;
      }> = update.message_ids.map((id) => {
        const fact = context.recentMessage?.(update.chat_id, id);
        return {
          id,
          ...(fact?.outgoing !== undefined ? { outgoing: fact.outgoing } : {}),
          ...(fact?.text ? { text: fact.text } : {}),
          ...(fact?.date ? { date: fact.date } : {}),
        };
      });
      const known = messages.filter(
        (entry) => entry.outgoing !== undefined,
      );
      const outgoing =
        known.length > 0 && known.length === messages.length
          ? known.every((entry) => entry.outgoing === true)
          : undefined;
      return {
        type: 'event',
        event: 'message.deleted',
        payload: {
          accountId: context.accountId,
          sessionId: context.sessionId,
          chatId,
          messageIds: update.message_ids,
          messages,
          ...(outgoing !== undefined ? { outgoing } : {}),
        },
        dedupeKey: `${context.accountId}:${chatId}:${update.message_ids.join('.')}:deleted`,
      };
    }

    case 'updateMessageInteractionInfo': {
      // Handled separately by `reactionEventsFromInteraction` (several events
      // per update), so the single-event switch has nothing to return.
      return null;
    }

    case 'updateChatReadInbox': {
      const chatId = peerIdOfChat(update.chat_id);
      const maxId = update.last_read_inbox_message_id;
      return {
        type: 'event',
        event: 'message.read',
        payload: {
          accountId: context.accountId,
          sessionId: context.sessionId,
          chatId,
          maxId,
          outbox: false,
          unread: update.unread_count,
        },
        dedupeKey: `${context.accountId}:${chatId}:${maxId}:read_inbox`,
      };
    }

    case 'updateChatReadOutbox': {
      const chatId = peerIdOfChat(update.chat_id);
      const maxId = update.last_read_outbox_message_id;
      return {
        type: 'event',
        event: 'message.read',
        payload: {
          accountId: context.accountId,
          sessionId: context.sessionId,
          chatId,
          maxId,
          outbox: true,
          unread: 0,
        },
        dedupeKey: `${context.accountId}:${chatId}:${maxId}:read_outbox`,
      };
    }

    case 'updateChatAction': {
      const action = TYPING_STATUS[update.action._];
      if (action === undefined) return null;
      const sender = update.sender_id;
      const userId =
        sender._ === 'messageSenderUser'
          ? sender.user_id
          : peerIdOfChat(sender.chat_id);
      const chatId = peerIdOfChat(update.chat_id);
      const cachedChat = context.chat?.(update.chat_id);
      const chatType =
        context.chatType?.(update.chat_id) ??
        (cachedChat
          ? chatTypeFromTdChatType(cachedChat.type)
          : update.chat_id > 0
            ? 'user'
            : 'chat');
      return {
        type: 'event',
        event: 'chat.typing',
        payload: {
          accountId: context.accountId,
          sessionId: context.sessionId,
          chatId,
          userId,
          status: action,
          chatType,
        },
        dedupeKey: `${context.accountId}:${chatId}:${userId}:typing:${action}`,
      };
    }

    default:
      return null;
  }
}
