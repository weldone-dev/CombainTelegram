import { Injectable } from '@nestjs/common';
import type { Message, Peer, SendableTypingStatus } from '@mtcute/node';
import { AccountsService } from '../accounts/accounts.service.js';
import type { AvatarImage } from '../accounts/accounts.service.js';
import { raiseTelegramError } from '../auth/telegram-error.js';
import { apiError } from '../common/api-error.js';
import { toChatView, toMessageView } from './message-view.js';
import type { ChatView, MessageView } from './message-view.js';
import {
  parseChatId,
  parseLimit,
  parseMessageId,
  parseMessageText,
  parseOffsetId,
  parseOptionalSessionId,
} from './params.js';

export interface ChatInfoView {
  id: number;
  type: string;
  title: string;
  username: string | null;
}

export interface MessageHistoryView {
  messages: MessageView[];
  nextOffsetId: number | null;
}

export interface DeletedMessageView {
  deleted: boolean;
  messageId: number;
}

export interface ReadView {
  read: boolean;
  maxId: number | null;
}

export type AllowedTypingStatus =
  | 'typing'
  | 'record_video'
  | 'record_voice'
  | 'upload_photo'
  | 'upload_document'
  | 'cancel';

export const ALLOWED_TYPING_STATUSES: AllowedTypingStatus[] = [
  'typing',
  'record_video',
  'record_voice',
  'upload_photo',
  'upload_document',
  'cancel',
];

function parseTypingStatus(value: unknown): AllowedTypingStatus {  if (value === undefined || value === null || value === '') return 'typing';
  if (
    typeof value === 'string' &&
    (ALLOWED_TYPING_STATUSES as string[]).includes(value)
  ) {
    return value as AllowedTypingStatus;
  }
  throw apiError('VALIDATION_ERROR', 'status is not a supported typing status', 400, {
    details: { allowed: ALLOWED_TYPING_STATUSES },
  });
}

/**
 * Messaging on top of an attached Telegram session.
 *
 * Every method takes `userId` first: the account is looked up by
 * `(id, userId)` and the session by `(accountId, sessionId)`, so one user can
 * never read or write another user's chats. `sessionId` is optional; without
 * it the account's most recent session is used.
 */
const AVATAR_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class MessagingService {
  private readonly avatars = new Map<
    string,
    { data: Buffer | null; at: number }
  >();

  constructor(private readonly accounts: AccountsService) {}

  async listChats(
    userId: string,
    accountId: string,
    query: { limit?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatView[]> {
    const sessionId = parseOptionalSessionId(query.sessionId);
    const limit = parseLimit(query.limit);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const chats: ChatView[] = [];
      for await (const dialog of client.iterDialogs({
        limit,
        archived: 'keep',
      })) {
        chats.push(toChatView(dialog));
        if (chats.length >= limit) break;
      }
      return chats;
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async getChat(
    userId: string,
    accountId: string,
    rawChatId: string,
    sessionIdParam?: unknown,
  ): Promise<ChatInfoView> {
    const chatId = parseChatId(rawChatId);
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    let peer: Peer;
    try {
      peer = await client.getPeer(chatId);
    } catch (error) {
      raiseTelegramError(error);
    }
    return {
      id: peer.id,
      type: peer.type,
      title: peer.displayName,
      username: peer.username,
    };
  }

  /** Small profile photo of a chat/user/channel, cached briefly in memory. */
  async chatAvatar(
    userId: string,
    accountId: string,
    rawChatId: string,
    sessionIdParam?: unknown,
  ): Promise<AvatarImage | null> {
    const chatId = parseChatId(rawChatId);
    const key = `${accountId}:${chatId}`;
    const cached = this.avatars.get(key);
    if (cached && Date.now() - cached.at < AVATAR_TTL_MS) {
      return cached.data ? { data: cached.data, mime: 'image/jpeg' } : null;
    }

    const sessionId = parseOptionalSessionId(sessionIdParam);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    let photo: { small: unknown } | null = null;
    try {
      const peer = await client.getPeer(chatId);
      photo = peer.photo;
    } catch (error) {
      raiseTelegramError(error);
    }
    if (!photo) {
      this.avatars.set(key, { data: null, at: Date.now() });
      return null;
    }

    try {
      const data = Buffer.from(
        await client.downloadAsBuffer(
          photo.small as Parameters<typeof client.downloadAsBuffer>[0],
        ),
      );
      this.avatars.set(key, { data, at: Date.now() });
      return { data, mime: 'image/jpeg' };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async listMessages(
    userId: string,
    accountId: string,
    rawChatId: string,
    query: {
      limit?: unknown;
      offsetId?: unknown;
      newerThanId?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<MessageHistoryView> {
    const chatId = parseChatId(rawChatId);
    const limit = parseLimit(query.limit);
    const offsetId = parseOffsetId(query.offsetId);
    const newerThanId = parseOffsetId(query.newerThanId);
    const sessionId = parseOptionalSessionId(query.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      // `newerThanId` loads the *oldest unread* batch (`readInboxMaxId` as the
      // boundary) instead of the newest page, so opening a chat with a large
      // unread counter does not immediately mark older unread messages as read.
      if (newerThanId && !offsetId) {
        const unread = await client.getHistory(chatId, {
          limit,
          offset: { id: newerThanId, date: 0 },
          addOffset: -limit,
        });
        const messages = unread.map((message) => toMessageView(message));
        let nextOffsetId: number | null = unread.next?.id ?? null;

        // Few unread messages: top up with older (already read) history so the
        // chat does not open with a single lonely bubble.
        if (messages.length < limit) {
          const oldestId = unread[unread.length - 1]?.id;
          if (oldestId) {
            const older = await client.getHistory(chatId, {
              limit: limit - messages.length,
              offset: { id: oldestId, date: 0 },
            });
            messages.push(...older.map((message) => toMessageView(message)));
            nextOffsetId = older.next?.id ?? nextOffsetId;
          }
        }

        return { messages, nextOffsetId };
      }

      const result = await client.getHistory(chatId, {
        limit,
        ...(offsetId ? { offset: { id: offsetId, date: 0 } } : {}),
      });
      return {
        messages: result.map((message) => toMessageView(message)),
        nextOffsetId: result.next?.id ?? null,
      };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async sendMessage(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: { text?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageView> {
    const chatId = parseChatId(rawChatId);
    const text = parseMessageText(body.text);
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const message: Message = await client.sendText(chatId, text);
      return toMessageView(message);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async editMessage(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    body: { text?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageView> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const text = parseMessageText(body.text);
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const message = await client.editMessage({
        chatId,
        message: messageId,
        text,
      });
      return toMessageView(message);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async deleteMessage(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    sessionIdParam?: unknown,
  ): Promise<DeletedMessageView> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      await client.deleteMessagesById(chatId, [messageId]);
      return { deleted: true, messageId };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async markRead(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: { maxId?: unknown; sessionId?: unknown } = {},
  ): Promise<ReadView> {
    const chatId = parseChatId(rawChatId);
    const maxId =
      body.maxId === undefined || body.maxId === null || body.maxId === ''
        ? undefined
        : parseMessageId(body.maxId);
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      await client.readHistory(chatId, maxId !== undefined ? { maxId } : {});
      return { read: true, maxId: maxId ?? null };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async sendTyping(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: { status?: unknown; sessionId?: unknown } = {},
  ): Promise<{ status: AllowedTypingStatus }> {
    const chatId = parseChatId(rawChatId);
    const status = parseTypingStatus(body.status);
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      await client.sendTyping(chatId, status as SendableTypingStatus);
      return { status };
    } catch (error) {
      raiseTelegramError(error);
    }
  }
}
