import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Client } from 'tdlib-native';
import type { ChatList, chat, message, user } from 'tdlib-native/types';
import type {
  TelegramAccountModel,
  TelegramSessionModel,
} from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { apiError, notFound } from '../common/api-error.js';
import type { AvatarImage } from '../accounts/accounts.service.js';
import type { ChatInfoView, ChatPeerView } from '../messaging/chat-info.js';
import {
  canSendMessages,
  toMessagePollView,
} from '../messaging/message-view.js';
import type {
  ChatView,
  FolderView,
  MessagePollView,
  MessageView,
  PeerLike,
} from '../messaging/message-view.js';
import type {
  ChatSearchView,
  DeletedMessageView,
  ForwardView,
  GlobalSearchView,
  MessageHistoryView,
  ReadAllView,
  ReadView,
  SearchUserView,
} from '../messaging/messaging.service.js';
import {
  MAX_MEDIA_THUMB_BYTES,
  isInlineSafeMime,
  mediaKindForMime,
  normalizeMimeType,
  sanitizeFileName,
} from '../messaging/media.js';
import { TdChatRegistry } from './td-chat-registry.js';
import { TdFilesService } from './td-files.service.js';
import { TdClientManagerService } from './td-client-manager.service.js';
import {
  chatInfoKindFromTdChatType,
  peerIdFromTdChatId,
  peerIdFromTdChatType,
} from './td-peer.js';
import {
  mediaFileInfo,
  peerOfTdChat,
  peerOfTdUser,
  tdUsername,
  toChatViewFromTd,
  toMessageViewFromTd,
} from './td-message-view.js';

/** Dialogs handled per `read-all` call, mirroring the mtcute cap. */
const MAX_READ_ALL_DIALOGS = 200;
/** How long a send waits for TDLib to replace the temporary message id. */
const SEND_WAIT_TIMEOUT_MS = 30_000;
const READ_ALL_BATCH_SIZE = 10;

/** Per-message download payload handed back to `MessagingService` for caching. */
export interface TdDownloadPayload {
  data: Buffer;
  mimeType: string;
  fileName: string;
  inline: boolean;
  thumb: boolean;
}

export interface TdListChatsQuery {
  limit: number;
  folderId?: number;
  archived?: boolean;
}

export interface TdListMessagesQuery {
  limit: number;
  offsetId?: number;
  newerThanId?: number;
}

export interface TdSendMessageInput {
  text: string;
  replyToId?: number;
}

export interface TdSendMediaInput {
  buffer: Buffer;
  fileName: string;
  mimeType: string;
  size: number;
  caption?: string;
  replyToId?: number;
}

export interface TdSearchMessagesQuery {
  q: string;
  limit: number;
  offsetId?: number;
}

export interface TdSearchGlobalQuery {
  q: string;
  limit: number;
}

export interface TdForwardInput {
  fromChatId: number;
  messageIds: number[];
}

/** Typing statuses accepted by the REST controller. */
export type TdTypingStatus =
  | 'typing'
  | 'record_video'
  | 'record_voice'
  | 'upload_photo'
  | 'upload_document'
  | 'cancel';

/**
 * One account's TDLib facade. `MessagingService` calls exactly these methods
 * when a TDLib session is live; any throw is logged there and the mtcute path
 * runs instead.
 */
export interface TdMessenger {
  listChats(query: TdListChatsQuery): Promise<ChatView[]>;
  listFolders(): Promise<FolderView[]>;
  getChat(peerId: number): Promise<ChatPeerView>;
  getChatInfo(peerId: number): Promise<ChatInfoView>;
  listMessages(
    peerId: number,
    query: TdListMessagesQuery,
  ): Promise<MessageHistoryView>;
  searchMessages(
    peerId: number,
    query: TdSearchMessagesQuery,
  ): Promise<ChatSearchView>;
  searchGlobal(query: TdSearchGlobalQuery): Promise<GlobalSearchView>;
  chatAvatar(peerId: number): Promise<AvatarImage | null>;
  downloadMedia(
    peerId: number,
    messageId: number,
    options: { thumb: boolean; maxBytes: number },
  ): Promise<TdDownloadPayload>;
  sendMessage(peerId: number, input: TdSendMessageInput): Promise<MessageView>;
  sendMedia(peerId: number, input: TdSendMediaInput): Promise<MessageView>;
  sendReaction(
    peerId: number,
    messageId: number,
    emoji: string | null,
  ): Promise<MessageView | null>;
  editMessage(
    peerId: number,
    messageId: number,
    text: string,
  ): Promise<MessageView>;
  deleteMessage(
    peerId: number,
    messageId: number,
    revoke: boolean,
  ): Promise<DeletedMessageView>;
  markRead(peerId: number, maxId?: number): Promise<ReadView>;
  markAllRead(): Promise<ReadAllView>;
  sendTyping(
    peerId: number,
    status: TdTypingStatus,
  ): Promise<{ status: TdTypingStatus }>;
  forwardMessages(peerId: number, input: TdForwardInput): Promise<ForwardView>;
  votePoll(
    peerId: number,
    messageId: number,
    options: number[] | null,
  ): Promise<MessagePollView>;
}

interface ChatExtras {
  username: string | null;
  isAdmin: boolean;
  isCreator: boolean;
}

interface SupergroupInfo {
  username: string | null;
  isAdmin: boolean;
  isCreator: boolean;
}

/** Structural input for both `api.getChats` and `api.loadChats`. */
interface ChatListRequest {
  chat_list?: ChatList | null;
  limit?: number;
}

/**
 * One live TDLib session: client, chat registry, user cache and helper methods.
 *
 * Registries and caches are per session, so switching accounts never leaks a
 * chat id or a username between them. The context lives as long as the client.
 */
export class TdSessionMessenger implements TdMessenger {
  readonly registry: TdChatRegistry;
  private readonly users = new Map<number, user>();
  private readonly userRequests = new Map<number, Promise<user | null>>();
  private readonly supergroups = new Map<number, Promise<SupergroupInfo>>();
  private readonly extras = new Map<string, ChatExtras>();
  private readonly unsubscribers: Array<() => void> = [];

  constructor(
    readonly session: TelegramSessionModel,
    readonly client: Client,
    private readonly files: TdFilesService,
  ) {
    this.registry = new TdChatRegistry(client);
    this.registry.attach();
    this.unsubscribers.push(
      client.updates.subscribe((update) => {
        if (update._ === 'updateUser')
          this.users.set(update.user.id, update.user);
      }),
    );
    void this.registry.seed().catch(() => undefined);
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    this.registry.dispose();
  }

  // ---------------------------------------------------------------- entities

  private async chatFor(chatId: number): Promise<chat> {
    const cached = this.registry.get(chatId);
    // `last_message` may be unknown in a cached `updateNewChat` snapshot until
    // `updateChatLastMessage` arrives, so a chat without it is refetched once.
    if (cached && cached.last_message != null) return cached;
    const entry = await this.client.api.getChat({ chat_id: chatId });
    this.registry.put(entry);
    return entry;
  }

  private async ensureUser(userId: number): Promise<user | null> {
    const cached = this.users.get(userId);
    if (cached) return cached;
    const inflight = this.userRequests.get(userId);
    if (inflight) return inflight;
    const request = this.client.api
      .getUser({ user_id: userId })
      .then((entry) => {
        this.users.set(entry.id, entry);
        return entry;
      })
      .catch(() => null)
      .finally(() => this.userRequests.delete(userId));
    this.userRequests.set(userId, request);
    return request;
  }

  private async supergroupInfo(supergroupId: number): Promise<SupergroupInfo> {
    const cached = this.supergroups.get(supergroupId);
    if (cached) return cached;
    const request = this.client.api
      .getSupergroup({ supergroup_id: supergroupId })
      .then((entry) => {
        const status = entry.status?._;
        return {
          username: tdUsername(entry.usernames),
          isAdmin:
            status === 'chatMemberStatusAdministrator' ||
            status === 'chatMemberStatusCreator',
          isCreator: status === 'chatMemberStatusCreator',
        };
      })
      .catch(() => ({ username: null, isAdmin: false, isCreator: false }));
    this.supergroups.set(supergroupId, request);
    return request;
  }

  private async extrasFor(entry: chat): Promise<ChatExtras> {
    const key = String(entry.id);
    const cached = this.extras.get(key);
    if (cached) return cached;

    let result: ChatExtras = {
      username: null,
      isAdmin: false,
      isCreator: false,
    };
    const type = entry.type;
    if (type._ === 'chatTypePrivate' || type._ === 'chatTypeSecret') {
      const owner = await this.ensureUser(type.user_id);
      result = {
        username: tdUsername(owner?.usernames ?? null),
        isAdmin: false,
        isCreator: false,
      };
    } else if (type._ === 'chatTypeSupergroup') {
      const info = await this.supergroupInfo(type.supergroup_id);
      result = {
        username: info.username,
        isAdmin: info.isAdmin,
        isCreator: info.isCreator,
      };
    }
    this.extras.set(key, result);
    return result;
  }

  private peerOf(entry: chat): PeerLike {
    return peerOfTdChat(entry, this.extras.get(String(entry.id)));
  }

  private peerIdOf(entry: chat): number {
    const fromType = peerIdFromTdChatType(entry.type);
    if (fromType !== null) return fromType;
    const fallback = peerIdFromTdChatId(entry.id);
    if (fallback === null) {
      throw apiError(
        'TD_PEER_UNSUPPORTED',
        'This TDLib chat type is unsupported',
      );
    }
    return fallback;
  }

  private senderPeer(entry: message): PeerLike | undefined {
    const sender = entry.sender_id;
    if (sender?._ === 'messageSenderUser') {
      const cached = this.users.get(sender.user_id);
      return cached ? peerOfTdUser(cached, sender.user_id) : undefined;
    }
    if (sender?._ === 'messageSenderChat') {
      const cached = this.registry.get(sender.chat_id);
      if (cached) return this.peerOf(cached);
    }
    return undefined;
  }

  /** Fetches sender users so the sync mapper can use real names. */
  private async warmMessages(messages: message[]): Promise<void> {
    const ids = new Set<number>();
    for (const entry of messages) {
      if (!entry) continue;
      if (entry.sender_id?._ === 'messageSenderUser') {
        ids.add(entry.sender_id.user_id);
      }
    }
    await Promise.all([...ids].map((id) => this.ensureUser(id)));
  }

  private mapMessage(entry: chat, raw: message): MessageView {
    return toMessageViewFromTd(raw, {
      chat: entry,
      chatPeer: this.peerOf(entry),
      resolveSender: (value) => this.senderPeer(value),
    });
  }

  /** Maps a batch and records chat extras used by `ChatView`. */
  private async mapMessages(
    entry: chat,
    raws: message[],
  ): Promise<MessageView[]> {
    await Promise.all([this.extrasFor(entry), this.warmMessages(raws)]);
    return raws.map((raw) => this.mapMessage(entry, raw));
  }

  // ------------------------------------------------------------------ chats

  private chatIdsForList(list: ChatList, limit: number): Promise<number[]> {
    const request: ChatListRequest = { chat_list: list, limit };
    return this.client.api
      .getChats(request)
      .then((result) => result.chat_ids)
      .catch(async () => {
        await this.client.api.loadChats(request).catch(() => undefined);
        return this.client.api
          .getChats(request)
          .then((result) => result.chat_ids)
          .catch(() => []);
      });
  }

  private listForQuery(query: TdListChatsQuery): ChatList[] {
    if (query.folderId !== undefined) {
      return [{ _: 'chatListFolder', chat_folder_id: query.folderId }];
    }
    if (query.archived === true) return [{ _: 'chatListArchive' }];
    if (query.archived === false) return [{ _: 'chatListMain' }];
    return [{ _: 'chatListMain' }, { _: 'chatListArchive' }];
  }

  async listChats(query: TdListChatsQuery): Promise<ChatView[]> {
    const seen = new Set<number>();
    const entries: chat[] = [];
    for (const list of this.listForQuery(query)) {
      const ids = await this.chatIdsForList(list, query.limit);
      for (const id of ids) {
        if (entries.length >= query.limit) break;
        let entry: chat;
        try {
          entry = await this.chatFor(id);
        } catch {
          continue;
        }
        let peerId: number;
        try {
          peerId = this.peerIdOf(entry);
        } catch {
          continue;
        }
        if (seen.has(peerId)) continue;
        seen.add(peerId);
        entries.push(entry);
      }
      if (entries.length >= query.limit) break;
    }

    await Promise.all(entries.map((entry) => this.extrasFor(entry)));
    const lastMessages = entries
      .map((entry) => entry.last_message)
      .filter((value): value is message => value !== null && value !== undefined);
    await this.warmMessages(lastMessages);

    return entries.map((entry) =>
      toChatViewFromTd(entry, {
        ...this.extras.get(String(entry.id)),
        resolveSender: (value) => this.senderPeer(value),
      }),
    );
  }

  /**
   * Telegram folders from the `updateChatFolders` cache. TDLib has no
   * request/response folder-list method; the update is sent after login.
   */
  async listFolders(): Promise<FolderView[]> {
    return this.registry.folders().map((folder) => ({
      id: folder.id,
      title: folder.name?.text?.text ?? '',
      emoticon: null,
    }));
  }

  async getChat(peerId: number): Promise<ChatPeerView> {
    const chatId = await this.registry.resolve(peerId);
    const entry = await this.chatFor(chatId);
    const extras = await this.extrasFor(entry);
    const peer = peerOfTdChat(entry, extras);
    return {
      id: peer.id,
      type: peer.type,
      title: peer.displayName,
      username: peer.username,
    };
  }

  async getChatInfo(peerId: number): Promise<ChatInfoView> {
    const chatId = await this.registry.resolve(peerId);
    const entry = await this.chatFor(chatId);
    const extras = await this.extrasFor(entry);
    const kind = chatInfoKindFromTdChatType(entry.type);
    const canSend = canSendMessages(peerOfTdChat(entry, extras));

    if (kind === 'user') {
      const type = entry.type;
      const userId = type._ === 'chatTypePrivate' ? type.user_id : undefined;
      let about: string | null = null;
      if (userId !== undefined) {
        try {
          const full = await this.client.api.getUserFullInfo({
            user_id: userId,
          });
          about = full.bio?.text || null;
        } catch {
          about = null;
        }
      }
      return {
        id: peerId,
        type: 'user',
        title: entry.title,
        username: extras.username,
        about,
        memberCount: null,
        onlineCount: null,
        isChannel: false,
        isGroup: false,
        isAdmin: false,
        isCreator: false,
        canSendMessages: canSend,
        inviteLink: extras.username ? `https://t.me/${extras.username}` : null,
      };
    }

    let about: string | null = null;
    let memberCount: number | null = null;
    let inviteLink: string | null = extras.username
      ? `https://t.me/${extras.username}`
      : null;
    const type = entry.type;
    if (type._ === 'chatTypeBasicGroup') {
      try {
        const group = await this.client.api.getBasicGroup({
          basic_group_id: type.basic_group_id,
        });
        memberCount = group.member_count > 0 ? group.member_count : null;
        extras.isAdmin =
          group.status?._ === 'chatMemberStatusAdministrator' ||
          group.status?._ === 'chatMemberStatusCreator';
        extras.isCreator = group.status?._ === 'chatMemberStatusCreator';
      } catch {
        // Member count/rights are optional.
      }
      try {
        const full = await this.client.api.getBasicGroupFullInfo({
          basic_group_id: type.basic_group_id,
        });
        about = full.description || null;
        memberCount = memberCount ?? (full.members?.length || null);
        inviteLink = inviteLink ?? full.invite_link?.invite_link ?? null;
      } catch {
        // Keep the basic fields instead of failing the whole panel.
      }
    } else if (type._ === 'chatTypeSupergroup') {
      try {
        const full = await this.client.api.getSupergroupFullInfo({
          supergroup_id: type.supergroup_id,
        });
        about = full.description || null;
        memberCount = full.member_count > 0 ? full.member_count : null;
        inviteLink = inviteLink ?? full.invite_link?.invite_link ?? null;
      } catch {
        // Same degradation as mtcute's getFullChat failure.
      }
    }

    this.extras.set(String(entry.id), extras);
    return {
      id: peerId,
      type: kind ?? 'group',
      title: entry.title,
      username: extras.username,
      about,
      memberCount,
      onlineCount: null,
      isChannel: kind === 'channel',
      isGroup: kind === 'group' || kind === 'supergroup',
      isAdmin: extras.isAdmin,
      isCreator: extras.isCreator,
      canSendMessages: canSend,
      inviteLink,
    };
  }

  // --------------------------------------------------------------- messages

  async listMessages(
    peerId: number,
    query: TdListMessagesQuery,
  ): Promise<MessageHistoryView> {
    const chatId = await this.registry.resolve(peerId);
    const entry = await this.chatFor(chatId);

    if (query.newerThanId && !query.offsetId) {
      const unread = await this.client.api.getChatHistory({
        chat_id: chatId,
        from_message_id: query.newerThanId,
        offset: -query.limit,
        limit: query.limit,
      });
      // `newerThanId` is the last read boundary: the unread window starts
      // after it, so the boundary message itself must not be echoed.
      const raws = (unread.messages ?? []).filter(
        (value) => value.id > (query.newerThanId as number),
      );
      let nextOffsetId = raws[raws.length - 1]?.id ?? null;

      if (raws.length < query.limit) {
        const oldestId = raws[raws.length - 1]?.id;
        if (oldestId) {
          const older = await this.client.api.getChatHistory({
            chat_id: chatId,
            from_message_id: oldestId,
            offset: 0,
            limit: query.limit - raws.length,
          });
          const extra = (older.messages ?? []).filter(
            (value) => value.id < oldestId,
          );
          raws.push(...extra);
          nextOffsetId = extra[extra.length - 1]?.id ?? nextOffsetId;
        }
      }

      return {
        messages: await this.mapMessages(entry, raws),
        nextOffsetId,
      };
    }

    const offsetId = query.offsetId;
    const result = await this.client.api.getChatHistory({
      chat_id: chatId,
      from_message_id: offsetId ?? 0,
      offset: 0,
      limit: offsetId ? query.limit + 1 : query.limit,
    });
    const raws = (result.messages ?? [])
      .filter((value) => (offsetId ? value.id < offsetId : true))
      .slice(0, query.limit);

    return {
      messages: await this.mapMessages(entry, raws),
      nextOffsetId: raws[raws.length - 1]?.id ?? null,
    };
  }

  async searchMessages(
    peerId: number,
    query: TdSearchMessagesQuery,
  ): Promise<ChatSearchView> {
    const chatId = await this.registry.resolve(peerId);
    const entry = await this.chatFor(chatId);
    const offsetId = query.offsetId;
    const result = await this.client.api.searchChatMessages({
      chat_id: chatId,
      query: query.q,
      from_message_id: offsetId ?? 0,
      offset: 0,
      limit: offsetId ? query.limit + 1 : query.limit,
    });
    const raws = (result.messages ?? [])
      .filter((value) => (offsetId ? value.id < offsetId : true))
      .slice(0, query.limit);

    return {
      messages: await this.mapMessages(entry, raws),
      nextOffsetId: raws[raws.length - 1]?.id ?? null,
    };
  }

  async searchGlobal(query: TdSearchGlobalQuery): Promise<GlobalSearchView> {
    const result = await this.client.api.searchMessages({
      chat_list: null,
      query: query.q,
      limit: query.limit,
    });
    const raws = result.messages ?? [];
    await this.warmMessages(raws);

    const chats = new Map<number, ChatView>();
    const users = new Map<number, SearchUserView>();

    for (const raw of raws) {
      const chatEntry = await this.chatFor(raw.chat_id).catch(() => null);
      if (chatEntry) {
        const extras = await this.extrasFor(chatEntry);
        const peer = peerOfTdChat(chatEntry, extras);
        if (peer.type === 'user') {
          if (!users.has(peer.id)) {
            users.set(peer.id, {
              id: peer.id,
              title: peer.displayName,
              username: peer.username,
            });
          }
        } else if (!chats.has(peer.id)) {
          chats.set(
            peer.id,
            toChatViewFromTd(chatEntry, {
              ...extras,
              resolveSender: (value) => this.senderPeer(value),
            }),
          );
        }
      }

      const sender = this.senderPeer(raw);
      if (!sender) continue;
      if (sender.type === 'user') {
        if (!users.has(sender.id)) {
          users.set(sender.id, {
            id: sender.id,
            title: sender.displayName,
            username: sender.username,
          });
        }
      } else if (!chats.has(sender.id)) {
        chats.set(sender.id, {
          id: sender.id,
          type: sender.type,
          title: sender.displayName,
          username: sender.username,
          lastMessage: null,
          unreadCount: 0,
          pinned: false,
          muted: false,
          archived: false,
          readInboxMaxId: 0,
          canSendMessages: canSendMessages(sender),
        });
      }
    }

    return { chats: [...chats.values()], users: [...users.values()] };
  }

  // ------------------------------------------------------------------ files

  async chatAvatar(peerId: number): Promise<AvatarImage | null> {
    const chatId = await this.registry.resolve(peerId);
    const entry = await this.chatFor(chatId);
    let target = entry.photo?.small ?? null;

    const type = entry.type;
    if (
      !target &&
      (type._ === 'chatTypePrivate' || type._ === 'chatTypeSecret')
    ) {
      const owner = await this.ensureUser(type.user_id);
      target = owner?.profile_photo?.small ?? null;
    }
    if (!target) return null;

    try {
      const { data } = await this.files.download(this.client, target);
      return { data, mime: 'image/jpeg' };
    } catch {
      const type = entry.type;
      if (type._ === 'chatTypePrivate' || type._ === 'chatTypeSecret') {
        const owner = await this.ensureUser(type.user_id);
        const big = owner?.profile_photo?.big;
        if (big && big.id !== target.id) {
          const { data } = await this.files.download(this.client, big);
          return { data, mime: 'image/jpeg' };
        }
      }
      return null;
    }
  }

  async downloadMedia(
    peerId: number,
    messageId: number,
    options: { thumb: boolean; maxBytes: number },
  ): Promise<TdDownloadPayload> {
    const chatId = await this.registry.resolve(peerId);
    const raw = await this.client.api.getMessage({
      chat_id: chatId,
      message_id: messageId,
    });
    const info = mediaFileInfo(raw);
    if (!info?.file && !info?.thumb) {
      throw notFound(
        'MEDIA_NOT_FOUND',
        'This message has no downloadable media',
      );
    }

    if (options.thumb) {
      if (info.thumb) {
        try {
          const { data } = await this.files.download(this.client, info.thumb, {
            maxBytes: Math.min(options.maxBytes, MAX_MEDIA_THUMB_BYTES),
          });
          return {
            data,
            mimeType: 'image/jpeg',
            fileName: 'thumb.jpg',
            inline: true,
            thumb: true,
          };
        } catch {
          // A missing/broken preview falls back to the full media below.
        }
      }
    }

    if (!info.file) {
      throw notFound(
        'MEDIA_NOT_FOUND',
        'This message has no downloadable file',
      );
    }
    const { data } = await this.files.download(this.client, info.file, {
      maxBytes: options.maxBytes,
    });
    const mimeType = normalizeMimeType(
      info.mimeType ??
        (info.type === 'photo'
          ? 'image/jpeg'
          : info.type === 'voice'
            ? 'audio/ogg'
            : null),
    );
    const fileName = sanitizeFileName(
      info.fileName,
      info.type === 'photo'
        ? 'photo.jpg'
        : info.type === 'voice'
          ? 'voice.ogg'
          : 'document',
    );
    return {
      data,
      mimeType,
      fileName,
      inline: isInlineSafeMime(mimeType) || info.type === 'voice',
      thumb: false,
    };
  }

  // ------------------------------------------------------------------ write

  private formattedText(text: string) {
    return { _: 'formattedText' as const, text, entities: [] };
  }

  /**
   * TDLib returns a message with a temporary id and `sending_state` while the
   * send is in flight; the real server id arrives with
   * `updateMessageSendSucceeded`. Editing/deleting the temp id later fails, so
   * the response must carry the final message.
   */
  private async awaitSent(raw: message): Promise<message> {
    if (!raw.sending_state) return raw;
    const tempId = raw.id;
    return new Promise<message>((resolve) => {
      const finish = (value: message): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const timer = setTimeout(() => finish(raw), SEND_WAIT_TIMEOUT_MS);
      const unsubscribe = this.client.updates.subscribe((update) => {
        if (update._ === 'updateMessageSendSucceeded') {
          if (update.old_message_id === tempId) finish(update.message);
          return;
        }
        if (
          update._ === 'updateMessageSendFailed' &&
          update.old_message_id === tempId
        ) {
          finish(raw);
        }
      });
    });
  }

  private async sentMessage(
    chatId: number,
    rawMessage: message,
  ): Promise<MessageView> {
    const raw = await this.awaitSent(rawMessage);
    const entry = await this.chatFor(chatId).catch(() => null);
    if (!entry) {
      // The message still maps without chat extras.
      return toMessageViewFromTd(raw, {
        resolveSender: (v) => this.senderPeer(v),
      });
    }
    await Promise.all([this.extrasFor(entry), this.warmMessages([raw])]);
    return this.mapMessage(entry, raw);
  }

  async sendMessage(
    peerId: number,
    input: TdSendMessageInput,
  ): Promise<MessageView> {
    const chatId = await this.registry.resolve(peerId);
    const sent = await this.client.api.sendMessage({
      chat_id: chatId,
      reply_to:
        input.replyToId !== undefined
          ? {
              _: 'inputMessageReplyToMessage',
              message_id: input.replyToId,
              quote: null,
              checklist_task_id: 0,
              poll_option_id: '',
            }
          : null,
      options: null,
      reply_markup: null,
      input_message_content: {
        _: 'inputMessageText',
        text: this.formattedText(input.text),
        link_preview_options: null,
        clear_draft: false,
      },
    });
    return this.sentMessage(chatId, sent);
  }

  private caption(text: string | undefined) {
    return text ? this.formattedText(text) : null;
  }

  private localFile(path: string) {
    return { _: 'inputFileLocal' as const, path };
  }

  async sendMedia(
    peerId: number,
    input: TdSendMediaInput,
  ): Promise<MessageView> {
    const chatId = await this.registry.resolve(peerId);
    const uploadPath = await this.files.writeUpload(
      input.buffer,
      input.fileName,
    );

    const mime = input.mimeType.toLowerCase();
    const kind = mediaKindForMime(input.mimeType);
    const file = this.localFile(uploadPath);
    const caption = this.caption(input.caption);

    let content;
    if (mime === 'image/gif') {
      content = {
        _: 'inputMessageAnimation' as const,
        animation: {
          _: 'inputAnimation' as const,
          animation: file,
          thumbnail: null,
          added_sticker_file_ids: [],
          duration: 0,
          width: 0,
          height: 0,
        },
        caption,
        show_caption_above_media: false,
        has_spoiler: false,
      };
    } else if (kind === 'photo') {
      content = {
        _: 'inputMessagePhoto' as const,
        photo: {
          _: 'inputPhoto' as const,
          photo: file,
          thumbnail: null,
          video: null,
          added_sticker_file_ids: [],
          width: 0,
          height: 0,
        },
        caption,
        show_caption_above_media: false,
        self_destruct_type: null,
        has_spoiler: false,
      };
    } else if (mime.startsWith('video/')) {
      content = {
        _: 'inputMessageVideo' as const,
        video: {
          _: 'inputVideo' as const,
          video: file,
          thumbnail: null,
          cover: null,
          start_timestamp: 0,
          added_sticker_file_ids: [],
          duration: 0,
          width: 0,
          height: 0,
          supports_streaming: true,
        },
        caption,
        show_caption_above_media: false,
        self_destruct_type: null,
        has_spoiler: false,
      };
    } else if (mime === 'audio/ogg' || mime === 'audio/opus') {
      content = {
        _: 'inputMessageVoiceNote' as const,
        voice_note: {
          _: 'inputVoiceNote' as const,
          voice_note: file,
          duration: 0,
          waveform: '',
        },
        caption,
        self_destruct_type: null,
      };
    } else if (mime.startsWith('audio/')) {
      content = {
        _: 'inputMessageAudio' as const,
        audio: {
          _: 'inputAudio' as const,
          audio: file,
          album_cover_thumbnail: null,
          duration: 0,
          title: '',
          performer: '',
        },
        caption,
      };
    } else {
      content = {
        _: 'inputMessageDocument' as const,
        document: {
          _: 'inputDocument' as const,
          document: file,
          thumbnail: null,
          disable_content_type_detection: false,
        },
        caption,
      };
    }

    try {
      const sent = await this.client.api.sendMessage({
        chat_id: chatId,
        reply_to:
          input.replyToId !== undefined
            ? {
                _: 'inputMessageReplyToMessage',
                message_id: input.replyToId,
                quote: null,
                checklist_task_id: 0,
                poll_option_id: '',
              }
            : null,
        options: null,
        reply_markup: null,
        input_message_content: content,
      });
      return this.sentMessage(chatId, sent);
    } finally {
      await this.files.cleanup(uploadPath);
    }
  }

  async sendReaction(
    peerId: number,
    messageId: number,
    emoji: string | null,
  ): Promise<MessageView | null> {
    const chatId = await this.registry.resolve(peerId);
    const current = await this.client.api.getMessage({
      chat_id: chatId,
      message_id: messageId,
    });
    const chosen =
      current.interaction_info?.reactions?.reactions.filter(
        (reaction) => reaction.is_chosen,
      ) ?? [];

    for (const reaction of chosen) {
      const same =
        emoji !== null &&
        reaction.type._ === 'reactionTypeEmoji' &&
        reaction.type.emoji === emoji;
      if (same) return this.sentMessage(chatId, current);
      if (reaction.type._ === 'reactionTypePaid') continue;
      await this.client.api
        .removeMessageReaction({
          chat_id: chatId,
          message_id: messageId,
          reaction_type: reaction.type,
        })
        .catch(() => undefined);
    }

    if (emoji !== null) {
      await this.client.api.addMessageReaction({
        chat_id: chatId,
        message_id: messageId,
        reaction_type: { _: 'reactionTypeEmoji', emoji },
        is_big: false,
        update_recent_reactions: true,
      });
    }

    try {
      const updated = await this.client.api.getMessage({
        chat_id: chatId,
        message_id: messageId,
      });
      return this.sentMessage(chatId, updated);
    } catch {
      return null;
    }
  }

  async editMessage(
    peerId: number,
    messageId: number,
    text: string,
  ): Promise<MessageView> {
    const chatId = await this.registry.resolve(peerId);
    const edited = await this.client.api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: null,
      input_message_content: {
        _: 'inputMessageText',
        text: this.formattedText(text),
        link_preview_options: null,
        clear_draft: false,
      },
    });
    return this.sentMessage(chatId, edited);
  }

  async deleteMessage(
    peerId: number,
    messageId: number,
    revoke: boolean,
  ): Promise<DeletedMessageView> {
    const chatId = await this.registry.resolve(peerId);
    await this.client.api.deleteMessages({
      chat_id: chatId,
      message_ids: [messageId],
      revoke,
    });
    return { deleted: true, messageId };
  }

  async markRead(peerId: number, maxId?: number): Promise<ReadView> {
    const chatId = await this.registry.resolve(peerId);
    let boundary = maxId;
    if (boundary === undefined) {
      const entry = await this.chatFor(chatId);
      boundary = entry.last_message?.id;
    }
    if (boundary !== undefined) {
      await this.client.api.viewMessages({
        chat_id: chatId,
        message_ids: [boundary],
        source: null,
        force_read: true,
      });
    }
    return { read: true, maxId: maxId ?? null };
  }

  async markAllRead(): Promise<ReadAllView> {
    const ids = new Set<number>();
    for (const list of [
      { _: 'chatListMain' },
      { _: 'chatListArchive' },
    ] as ChatList[]) {
      const chatIds = await this.chatIdsForList(list, MAX_READ_ALL_DIALOGS);
      for (const id of chatIds) ids.add(id);
    }

    const unread: chat[] = [];
    for (const id of ids) {
      if (unread.length >= MAX_READ_ALL_DIALOGS) break;
      try {
        const entry = await this.chatFor(id);
        if (entry.unread_count > 0 || entry.is_marked_as_unread) {
          unread.push(entry);
        }
      } catch {
        // Skip chats that vanished.
      }
    }

    let read = 0;
    let failed = 0;
    for (let i = 0; i < unread.length; i += READ_ALL_BATCH_SIZE) {
      const batch = unread.slice(i, i + READ_ALL_BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (entry) => {
          const messageId = entry.last_message?.id;
          if (!messageId) throw new Error('No messages to read');
          await this.client.api.viewMessages({
            chat_id: entry.id,
            message_ids: [messageId],
            source: null,
            force_read: true,
          });
        }),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') read += 1;
        else failed += 1;
      }
    }
    return { read, failed };
  }

  async sendTyping(
    peerId: number,
    status: TdTypingStatus,
  ): Promise<{ status: TdTypingStatus }> {
    const chatId = await this.registry.resolve(peerId);
    const action = (() => {
      switch (status) {
        case 'record_video':
          return { _: 'chatActionRecordingVideo' as const };
        case 'record_voice':
          return { _: 'chatActionRecordingVoiceNote' as const };
        case 'upload_photo':
          return { _: 'chatActionUploadingPhoto' as const, progress: 0 };
        case 'upload_document':
          return { _: 'chatActionUploadingDocument' as const, progress: 0 };
        case 'cancel':
          return { _: 'chatActionCancel' as const };
        default:
          return { _: 'chatActionTyping' as const };
      }
    })();
    await this.client.api.sendChatAction({
      chat_id: chatId,
      topic_id: null,
      action,
    });
    return { status };
  }

  async forwardMessages(
    peerId: number,
    input: TdForwardInput,
  ): Promise<ForwardView> {
    const chatId = await this.registry.resolve(peerId);
    const fromChatId = await this.registry.resolve(input.fromChatId);
    const result = await this.client.api.forwardMessages({
      chat_id: chatId,
      topic_id: null,
      from_chat_id: fromChatId,
      message_ids: input.messageIds,
      options: null,
      send_copy: false,
      remove_caption: false,
    });
    return { forwarded: result.messages?.length ?? input.messageIds.length };
  }

  async votePoll(
    peerId: number,
    messageId: number,
    options: number[] | null,
  ): Promise<MessagePollView> {
    const chatId = await this.registry.resolve(peerId);
    await this.client.api.setPollAnswer({
      chat_id: chatId,
      message_id: messageId,
      option_ids: options ?? [],
    });
    const raw = await this.client.api.getMessage({
      chat_id: chatId,
      message_id: messageId,
    });
    const content = raw.content;
    if (content._ !== 'messagePoll') {
      throw apiError('TELEGRAM_ERROR', 'This message has no poll');
    }
    const poll = content.poll;
    const quiz = poll.type._ === 'pollTypeQuiz' ? poll.type : null;
    const view = toMessagePollView({
      type: 'poll',
      id: poll.id,
      question: poll.question?.text ?? '',
      voters: poll.total_voter_count,
      isClosed: poll.is_closed,
      isQuiz: quiz !== null,
      isMultiple: poll.allows_multiple_answers,
      hideResultsUntilClose: !poll.can_see_results && !poll.is_closed,
      answers: poll.options.map((option, index) => ({
        text: option.text?.text ?? '',
        voters: option.voter_count,
        chosen: option.is_chosen,
        correct: quiz?.correct_option_ids?.includes(index) === true,
      })),
      solution: quiz?.explanation?.text || null,
    });
    if (!view) {
      throw apiError('TELEGRAM_ERROR', 'TDLib returned an unusable poll');
    }
    return view;
  }
}

/**
 * TDLib messaging behind a per-account switch.
 *
 * `forAccount()` returns a facade only when the engine is not forced to
 * `mtcute` and the account owns a live TDLib session. Every failure surfaces to
 * the caller (`MessagingService`), which logs `tdlib.messaging.*` and runs the
 * existing mtcute implementation — the app never breaks because of TDLib.
 */
@Injectable()
export class TdMessagingService implements OnModuleDestroy {
  private readonly contexts = new Map<string, TdSessionMessenger>();
  private readonly opening = new Map<string, Promise<TdSessionMessenger>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramConfigService,
    private readonly tdClients: TdClientManagerService,
    private readonly files: TdFilesService,
  ) {}

  /** Whether TDLib routing is enabled at all for this process. */
  get engineEnabled(): boolean {
    return this.config.engine !== 'mtcute';
  }

  /**
   * Resolves the account's TDLib session (ownership-checked) and returns its
   * facade, or `null` when this account should use mtcute.
   *
   * "Live" means a non-revoked session row with `engine = "tdlib"`; the native
   * client is reopened from its encrypted database when needed. A closed
   * TDLib folder is not a reason to lose the account's message history.
   */
  async forAccount(
    userId: string,
    accountId: string,
    sessionId?: string,
  ): Promise<TdMessenger | null> {
    if (!this.engineEnabled) return null;

    const account = (await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      include: { sessions: { orderBy: { createdAt: 'asc' } } },
    })) as (TelegramAccountModel & { sessions: TelegramSessionModel[] }) | null;
    if (!account) return null;

    const live = account.sessions.filter(
      (row) => row.engine === 'tdlib' && !row.revokedAt,
    );
    let session: TelegramSessionModel | undefined;
    if (sessionId) {
      session = live.find((row) => row.id === sessionId);
    } else {
      session = live
        .slice()
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    }
    if (!session) return null;

    return this.contextFor(session);
  }

  private contextFor(
    session: TelegramSessionModel,
  ): Promise<TdSessionMessenger> {
    const cached = this.contexts.get(session.id);
    if (cached) return Promise.resolve(cached);

    const inflight = this.opening.get(session.id);
    if (inflight) return inflight;

    const promise = this.tdClients
      .clientForSession(session)
      .then((client) => {
        const context = new TdSessionMessenger(session, client, this.files);
        this.contexts.set(session.id, context);
        return context;
      })
      .finally(() => this.opening.delete(session.id));
    this.opening.set(session.id, promise);
    return promise;
  }

  /** Closes every cached facade; clients are owned by `TdClientManagerService`. */
  async onModuleDestroy(): Promise<void> {
    for (const context of this.contexts.values()) context.dispose();
    this.contexts.clear();
  }
}
