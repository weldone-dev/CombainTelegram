import { Injectable } from '@nestjs/common';
import {
  InputMedia,
  type Message,
  type Peer,
  type SendableTypingStatus,
  type TelegramClient,
  type tl,
} from '@mtcute/node';
import { AccountsService } from '../accounts/accounts.service.js';
import type { AvatarImage } from '../accounts/accounts.service.js';
import { raiseTelegramError } from '../auth/telegram-error.js';
import { apiError, notFound } from '../common/api-error.js';
import {
  MEDIA_CACHE_MAX_ENTRIES,
  MEDIA_CACHE_TTL_MS,
  assertMediaUpload,
  contentDisposition,
  isImageMime,
  mediaKindForMime,
  sanitizeFileName,
} from './media.js';
import {
  toChatView,
  toChatViewFromPeer,
  toFolderView,
  toMessageMediaView,
  toMessageView,
} from './message-view.js';
import type { ChatView, FolderView, MessageView } from './message-view.js';
import {
  normalizeUsername,
  parseChatId,
  parseFolderId,
  parseLimit,
  parseMessageId,
  parseMessageIds,
  parseMessageText,
  parseOffsetId,
  parseOptionalBoolean,
  parseOptionalCaption,
  parseOptionalMessageId,
  parseOptionalSessionId,
  parseSearchQuery,
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

export interface ForwardView {
  forwarded: number;
}

export interface MediaUploadInput {
  buffer: Buffer;
  fileName?: string | null;
  mimeType?: string | null;
  size?: number;
  caption?: unknown;
  replyToId?: unknown;
  sessionId?: unknown;
}

export interface MediaDownloadView {
  data: Buffer;
  mimeType: string;
  fileName: string;
  disposition: string;
  length: number;
}

export interface ChatSearchView {
  messages: MessageView[];
  nextOffsetId: number | null;
}

export interface SearchUserView {
  id: number;
  title: string;
  username: string | null;
}

export interface GlobalSearchView {
  chats: ChatView[];
  users: SearchUserView[];
}

export interface FoldersView {
  folders: FolderView[];
}

export interface ChatRemovedView {
  removed: boolean;
  cleared: number | null;
}

export interface ReadAllView {
  read: number;
}

/** Upper bound for `POST /chats/read-all` to keep the fan-out bounded. */
const MAX_READ_ALL_DIALOGS = 200;

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

function parseTypingStatus(value: unknown): AllowedTypingStatus {
  if (value === undefined || value === null || value === '') return 'typing';
  if (
    typeof value === 'string' &&
    (ALLOWED_TYPING_STATUSES as string[]).includes(value)
  ) {
    return value as AllowedTypingStatus;
  }
  throw apiError(
    'VALIDATION_ERROR',
    'status is not a supported typing status',
    400,
    {
      details: { allowed: ALLOWED_TYPING_STATUSES },
    },
  );
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

  private readonly downloads = new Map<
    string,
    {
      data: Buffer;
      mimeType: string;
      fileName: string;
      inline: boolean;
      at: number;
    }
  >();

  constructor(private readonly accounts: AccountsService) {}

  async listChats(
    userId: string,
    accountId: string,
    query: {
      limit?: unknown;
      folderId?: unknown;
      archived?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatView[]> {
    const sessionId = parseOptionalSessionId(query.sessionId);
    const limit = parseLimit(query.limit);
    const folderId = parseFolderId(query.folderId);
    const archived = parseOptionalBoolean(query.archived, 'archived');
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    // No params keeps the historical behaviour: recent dialogs from every
    // folder (archived included). A folder overrides `archived`, because
    // Telegram folders already describe their own archived section.
    const archivedMode: 'keep' | 'exclude' | 'only' =
      archived === true ? 'only' : archived === false ? 'exclude' : 'keep';

    try {
      const chats: ChatView[] = [];
      for await (const dialog of client.iterDialogs({
        limit,
        archived: archivedMode,
        ...(folderId !== undefined ? { folder: folderId } : {}),
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
    body: { text?: unknown; replyToId?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageView> {
    const chatId = parseChatId(rawChatId);
    const text = parseMessageText(body.text);
    const replyToId = parseOptionalMessageId(body.replyToId);
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const message: Message = await client.sendText(
        chatId,
        text,
        replyToId !== undefined ? { replyTo: replyToId } : {},
      );
      return toMessageView(message);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /**
   * Upload one photo or document and send it with an optional caption.
   * Images go through `InputMedia.photo`, everything else is sent as a
   * document. The buffer comes from the multipart interceptor (memory).
   */
  async sendMedia(
    userId: string,
    accountId: string,
    rawChatId: string,
    input: MediaUploadInput,
  ): Promise<MessageView> {
    const chatId = parseChatId(rawChatId);
    const caption = parseOptionalCaption(input.caption);
    const replyToId = parseOptionalMessageId(input.replyToId);
    const sessionId = parseOptionalSessionId(input.sessionId);
    const size = input.size ?? input.buffer.byteLength;
    assertMediaUpload(size);

    const fileName = sanitizeFileName(
      input.fileName,
      isImageMime(input.mimeType) ? 'photo.jpg' : 'file',
    );
    const mimeType =
      input.mimeType && input.mimeType.trim()
        ? input.mimeType.trim()
        : 'application/octet-stream';
    const kind = mediaKindForMime(mimeType);

    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const media =
        kind === 'photo'
          ? InputMedia.photo(input.buffer, {
              fileName,
              fileMime: mimeType,
              fileSize: size,
              ...(caption !== undefined ? { caption } : {}),
            })
          : InputMedia.document(input.buffer, {
              fileName,
              fileMime: mimeType,
              fileSize: size,
              ...(caption !== undefined ? { caption } : {}),
            });
      const message: Message = await client.sendMedia(
        chatId,
        media,
        replyToId !== undefined ? { replyTo: replyToId } : {},
      );
      return toMessageView(message);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /**
   * Download the media attached to one message. Photos and generic documents
   * are supported; the last few results are cached in memory for 5 minutes.
   */
  async downloadMedia(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    sessionIdParam?: unknown,
    filenameParam?: unknown,
  ): Promise<MediaDownloadView> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const cacheKey = `${accountId}:${chatId}:${messageId}`;

    let cached = this.downloads.get(cacheKey);
    if (cached && Date.now() - cached.at < MEDIA_CACHE_TTL_MS) {
      this.downloads.delete(cacheKey);
      this.downloads.set(cacheKey, cached);
    } else {
      cached = undefined;
    }

    const requestedName =
      typeof filenameParam === 'string' && filenameParam.trim()
        ? filenameParam.trim()
        : null;

    if (cached) {
      const fileName = sanitizeFileName(
        requestedName ?? cached.fileName,
        cached.fileName,
      );
      return {
        data: cached.data,
        mimeType: cached.mimeType,
        fileName,
        disposition: contentDisposition(fileName, cached.inline),
        length: cached.data.byteLength,
      };
    }

    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    let message: Message | null = null;
    try {
      [message] = await client.getMessages(chatId, [messageId]);
    } catch (error) {
      raiseTelegramError(error);
    }

    const media = message?.media ?? null;
    const descriptor = toMessageMediaView(media);
    if (
      !message ||
      !media ||
      !descriptor?.downloadable ||
      (media.type !== 'photo' && media.type !== 'document')
    ) {
      throw notFound(
        'MEDIA_NOT_FOUND',
        'This message has no downloadable photo or document',
      );
    }

    try {
      const data = Buffer.from(await client.downloadAsBuffer(media));
      const mimeType =
        descriptor.mimeType ??
        (descriptor.kind === 'photo'
          ? 'image/jpeg'
          : 'application/octet-stream');
      const defaultFileName = sanitizeFileName(
        descriptor.fileName,
        descriptor.kind === 'photo' ? 'photo.jpg' : 'document',
      );
      const fileName = sanitizeFileName(
        requestedName ?? defaultFileName,
        defaultFileName,
      );
      const inline = isImageMime(mimeType);

      this.downloads.delete(cacheKey);
      this.downloads.set(cacheKey, {
        data,
        mimeType,
        fileName: defaultFileName,
        inline,
        at: Date.now(),
      });
      while (this.downloads.size > MEDIA_CACHE_MAX_ENTRIES) {
        const oldest = this.downloads.keys().next().value;
        if (oldest === undefined) break;
        this.downloads.delete(oldest);
      }

      return {
        data,
        mimeType,
        fileName,
        disposition: contentDisposition(fileName, inline),
        length: data.byteLength,
      };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async forwardMessages(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: {
      fromChatId?: unknown;
      messageIds?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ForwardView> {
    const chatId = parseChatId(rawChatId);
    const fromChatId = parseChatId(body.fromChatId, 'fromChatId');
    const messageIds = parseMessageIds(body.messageIds);
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const forwarded = await client.forwardMessagesById({
        toChatId: chatId,
        fromChatId,
        messages: messageIds,
      });
      return { forwarded: forwarded.length };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async searchMessages(
    userId: string,
    accountId: string,
    rawChatId: string,
    query: {
      q?: unknown;
      limit?: unknown;
      offsetId?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatSearchView> {
    const chatId = parseChatId(rawChatId);
    const text = parseSearchQuery(query.q);
    const limit = parseLimit(query.limit);
    const offsetId = parseOffsetId(query.offsetId);
    const sessionId = parseOptionalSessionId(query.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const result = await client.searchMessages({
        chatId,
        query: text,
        limit,
        ...(offsetId !== undefined ? { offset: offsetId } : {}),
      });
      return {
        messages: result.map((message) => toMessageView(message)),
        nextOffsetId: result.next ?? null,
      };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /**
   * Global search over messages, whose results are folded into chats and
   * users. mtcute 0.32 has no dedicated contact/dialog search call, so
   * `searchGlobal` is the best available source (it covers dialogs too).
   */
  async searchGlobal(
    userId: string,
    accountId: string,
    query: { q?: unknown; limit?: unknown; sessionId?: unknown } = {},
  ): Promise<GlobalSearchView> {
    const text = parseSearchQuery(query.q);
    const limit = parseLimit(query.limit);
    const sessionId = parseOptionalSessionId(query.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const result = await client.searchGlobal({ query: text, limit });
      const chats = new Map<number, ChatView>();
      const users = new Map<number, SearchUserView>();

      for (const message of result) {
        for (const peer of [message.chat, message.sender]) {
          if (!peer || !('id' in peer)) continue;
          if (peer.type === 'user') {
            if (!users.has(peer.id)) {
              users.set(peer.id, {
                id: peer.id,
                title: peer.displayName,
                username: peer.username,
              });
            }
          } else if (!chats.has(peer.id)) {
            chats.set(peer.id, toChatViewFromPeer(peer));
          }
        }
      }

      return { chats: [...chats.values()], users: [...users.values()] };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /** Resolve `@name` / `name` / `t.me/name` / `https://t.me/name` to a chat. */
  async resolveChat(
    userId: string,
    accountId: string,
    query: { username?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatView> {
    const username = normalizeUsername(query.username);
    const sessionId = parseOptionalSessionId(query.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const peer = await client.getPeer(username);
      return toChatViewFromPeer(peer);
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

  /**
   * Apply dialog flags. mtcute 0.32 has no high-level pin/mute helpers, so
   * those two use the corresponding raw TL calls; archive and unread use the
   * high-level methods. Each flag is optional and only applied when present.
   */
  async updateChat(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: {
      pinned?: unknown;
      muted?: unknown;
      archived?: unknown;
      unread?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatView> {
    const chatId = parseChatId(rawChatId);
    const pinned = parseOptionalBoolean(body.pinned, 'pinned');
    const muted = parseOptionalBoolean(body.muted, 'muted');
    const archived = parseOptionalBoolean(body.archived, 'archived');
    const unread = parseOptionalBoolean(body.unread, 'unread');
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      if (pinned !== undefined) {
        const peer = await client.resolvePeer(chatId);
        await client.call({
          _: 'messages.toggleDialogPin',
          pinned,
          peer: { _: 'inputDialogPeer', peer },
        });
      }

      if (muted !== undefined) {
        const peer = await client.resolvePeer(chatId);
        await client.call({
          _: 'account.updateNotifySettings',
          peer: { _: 'inputNotifyPeer', peer },
          settings: {
            _: 'inputPeerNotifySettings',
            silent: muted,
            // 0x7FFFFFFF means "muted forever"; 0 clears the mute.
            muteUntil: muted ? 0x7fffffff : 0,
          },
        });
      }

      if (archived === true) {
        await client.archiveChats(chatId);
      } else if (archived === false) {
        await client.unarchiveChats(chatId);
      }

      if (unread === true) {
        await client.markChatUnread(chatId);
      } else if (unread === false) {
        await client.readHistory(chatId);
      }

      return await this.refreshChatView(client, chatId);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /**
   * `clearHistory=true` deletes messages but keeps the dialog. Otherwise the
   * dialog is removed: private chats and legacy groups use `deleteHistory`
   * (with `revoke` controlling deletion for everyone), while channels and
   * supergroups are left.
   */
  async deleteChat(
    userId: string,
    accountId: string,
    rawChatId: string,
    query: {
      revoke?: unknown;
      clearHistory?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatRemovedView> {
    const chatId = parseChatId(rawChatId);
    const revoke = parseOptionalBoolean(query.revoke, 'revoke') ?? true;
    const clearHistory =
      parseOptionalBoolean(query.clearHistory, 'clearHistory') ?? false;
    const sessionId = parseOptionalSessionId(query.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      if (clearHistory) {
        await client.deleteHistory(chatId, { mode: 'clear' });
        return { removed: false, cleared: null };
      }

      const peer = await client.getPeer(chatId);
      if (
        peer.type === 'user' ||
        (peer.type === 'chat' && peer.chatType === 'group')
      ) {
        await client.deleteHistory(chatId, {
          mode: revoke ? 'revoke' : 'delete',
        });
      } else {
        await client.leaveChat(chatId, { clear: revoke });
      }
      return { removed: true, cleared: null };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /** Mark every unread dialog read, capped at 200 dialogs per request. */
  async markAllRead(
    userId: string,
    accountId: string,
    body: { sessionId?: unknown } = {},
  ): Promise<ReadAllView> {
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      let read = 0;
      for await (const dialog of client.iterDialogs({
        limit: MAX_READ_ALL_DIALOGS,
        archived: 'keep',
      })) {
        if (dialog.unreadCount > 0 || dialog.isManuallyUnread) {
          await client.readHistory(dialog.peer.inputPeer);
          read += 1;
        }
      }
      return { read };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async listFolders(
    userId: string,
    accountId: string,
    sessionIdParam?: unknown,
  ): Promise<FoldersView> {
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const result: tl.messages.RawDialogFilters = await client.getFolders();
      const folders = result.filters
        .filter(
          (filter): filter is tl.RawDialogFilter | tl.RawDialogFilterChatlist =>
            filter._ === 'dialogFilter' || filter._ === 'dialogFilterChatlist',
        )
        .map((filter) => toFolderView(filter));
      return { folders };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /** Reload a dialog after a mutation; fall back to a bare peer DTO. */
  private async refreshChatView(
    client: TelegramClient,
    chatId: number,
  ): Promise<ChatView> {
    try {
      const [dialog] = await client.findDialogs(chatId);
      if (dialog) return toChatView(dialog);
    } catch {
      // Dialog listing can fail for freshly created or inaccessible peers;
      // the peer lookup below is still enough for the response shape.
    }
    const peer = await client.getPeer(chatId);
    return toChatViewFromPeer(peer);
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
