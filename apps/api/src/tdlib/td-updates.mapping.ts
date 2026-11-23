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
}

export interface TdMappedEvent {
  type: 'event';
  event:
    | 'message.new'
    | 'message.edited'
    | 'message.deleted'
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
      }),
    },
    dedupeKey: `${context.accountId}:${chatId}:${entry.id}:edited`,
  };
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
      const chatId = peerIdOfChat(update.chat_id);
      return {
        type: 'event',
        event: 'message.deleted',
        payload: {
          accountId: context.accountId,
          sessionId: context.sessionId,
          chatId,
          messageIds: update.message_ids,
        },
        dedupeKey: `${context.accountId}:${chatId}:${update.message_ids.join('.')}:deleted`,
      };
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
