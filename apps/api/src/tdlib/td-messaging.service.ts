import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Client } from 'tdlib-native';
import type {
  ChatList,
  chat,
  message,
  messageThreadInfo,
  SearchMessagesFilter,
  SpeechRecognitionResult,
  user,
} from 'tdlib-native/types';
import type {
  TelegramAccountModel,
  TelegramSessionModel,
} from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { apiError, notFound } from '../common/api-error.js';
import { emitLog } from '../logs/log-sink.js';
import type { AvatarImage } from '../accounts/accounts.service.js';
import { resolveActiveSession } from '../accounts/active-session.js';
import type { ChatInfoView, ChatPeerView } from '../messaging/chat-info.js';
import {
  canSendMessages,
  toMessagePollView,
} from '../messaging/message-view.js';
import type {
  ChatView,
  FolderView,
  MessagePollView,
  MessageThreadView,
  MessageView,
  PeerLike,
} from '../messaging/message-view.js';
import type {
  ChatInfoItemView,
  ChatInfoMediaView,
  ChatInfoPollView,
  ChatInfoSimilarView,
  ChatSearchView,
  DeletedMessageView,
  ForwardView,
  GlobalSearchView,
  MessageHistoryView,
  MessageTranscriptionView,
  MessageTranslationView,
  ReadAllView,
  ReadView,
  SearchUserView,
  SimilarChatView,
} from '../messaging/messaging.service.js';
import { extractFirstUrl } from '../messaging/params.js';
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
const SEND_WAIT_TIMEOUT_MS = 120_000;
/** A confirmation slower than this is worth a log line. */
const SEND_SLOW_MS = 10_000;
/** Upper bound for waiting on a speech-recognition update. */
const SPEECH_WAIT_TIMEOUT_MS = 30_000;
const READ_ALL_BATCH_SIZE = 10;
/**
 * Second refetch delay when TDLib's cached message still shows the reaction
 * state from before the add/remove (the cache catches up just after the call).
 */
const REACTION_REFRESH_RETRY_MS = 150;

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

export interface TdMessageThreadQuery {
  limit: number;
  offsetId?: number;
}

export interface TdSearchGlobalQuery {
  q: string;
  limit: number;
}

/** One tab of the chat info panel, mirroring the mtcute query. */
export interface TdChatInfoMediaQuery {
  kind: 'media' | 'links' | 'polls';
  limit: number;
  offsetId?: number;
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
 * when a TDLib session is live. A throw is logged there: chat-scoped methods
 * fall back to mtcute, message-id-scoped ones surface the mapped error.
 */
export interface TdMessenger {
  listChats(query: TdListChatsQuery): Promise<ChatView[]>;
  listFolders(): Promise<FolderView[]>;
  getChat(peerId: number): Promise<ChatPeerView>;
  getChatInfo(peerId: number): Promise<ChatInfoView>;
  getChatInfoMedia(
    peerId: number,
    query: TdChatInfoMediaQuery,
  ): Promise<ChatInfoMediaView>;
  getChatInfoSimilar(peerId: number): Promise<ChatInfoSimilarView>;
  translateMessage(
    peerId: number,
    messageId: number,
    to: string,
  ): Promise<MessageTranslationView>;
  transcribeVoice(
    peerId: number,
    messageId: number,
  ): Promise<MessageTranscriptionView>;
  listMessages(
    peerId: number,
    query: TdListMessagesQuery,
  ): Promise<MessageHistoryView>;
  searchMessages(
    peerId: number,
    query: TdSearchMessagesQuery,
  ): Promise<ChatSearchView>;
  searchGlobal(query: TdSearchGlobalQuery): Promise<GlobalSearchView>;
  getMessageThread(
    peerId: number,
    messageId: number,
    query: TdMessageThreadQuery,
  ): Promise<MessageThreadView>;
  sendComment(
    peerId: number,
    messageId: number,
    text: string,
  ): Promise<MessageView>;
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
  setOnline(online: boolean): Promise<{ online: boolean }>;
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

/** TDLib message filter behind one chat-info tab. */
function searchFilterForKind(
  kind: TdChatInfoMediaQuery['kind'],
): SearchMessagesFilter {
  switch (kind) {
    case 'media':
      return { _: 'searchMessagesFilterPhotoAndVideo' };
    case 'links':
      return { _: 'searchMessagesFilterUrl' };
    case 'polls':
      return { _: 'searchMessagesFilterPoll' };
  }
}

/** Speech-recognition payload of a voice/video note message, if any. */
function speechResultOf(
  content: message['content'],
): SpeechRecognitionResult | null {
  if (content._ === 'messageVoiceNote') {
    return content.voice_note.speech_recognition_result ?? null;
  }
  if (content._ === 'messageVideoNote') {
    return content.video_note.speech_recognition_result ?? null;
  }
  return null;
}

/**
 * Chat-info item of an already mapped message. `messageId` comes from the same
 * TDLib transcript as downloads, so the dashboard's `GET .../media` hits the
 * right message.
 */
function toChatInfoItemFromTd(
  view: MessageView,
  kind: TdChatInfoMediaQuery['kind'],
): ChatInfoItemView {
  let poll: ChatInfoPollView | null = null;
  if (kind === 'polls') {
    const fallbackQuestion = view.text.trim() || 'Опрос';
    poll = view.poll
      ? {
          question: view.poll.question.trim() || fallbackQuestion,
          options: view.poll.answers
            .map((answer) => answer.text)
            .filter((answer) => answer.length > 0),
          totalVoters: view.poll.voters,
        }
      : { question: fallbackQuestion, options: [], totalVoters: 0 };
  }
  return {
    messageId: view.id,
    date: view.date,
    text: view.text,
    media: view.media,
    url: kind === 'links' ? extractFirstUrl(view.text) : null,
    poll,
  };
}

/** Same error contract as the mtcute transcription endpoint. */
function speechApiError(code: string): Error {
  switch (code) {
    case 'MSG_VOICE_MISSING':
      return apiError(
        'TRANSCRIPTION_UNAVAILABLE',
        'This message is not a voice note that can be transcribed',
        400,
      );
    case 'MSG_VOICE_TOO_LONG':
      return apiError(
        'TRANSCRIPTION_UNAVAILABLE',
        'This voice message is too long to transcribe',
        400,
      );
    case 'PREMIUM_ACCOUNT_REQUIRED':
      return apiError(
        'PREMIUM_REQUIRED',
        'Voice transcription requires a Telegram Premium account',
        403,
      );
    default:
      return apiError(
        'TRANSCRIPTION_FAILED',
        'Telegram could not transcribe this voice message',
        502,
      );
  }
}

/** Chosen reactions of a TDLib message, as a stable comparable signature. */
function chosenReactionSignature(raw: message): string {
  const reactions = raw.interaction_info?.reactions?.reactions ?? [];
  return reactions
    .filter((reaction) => reaction.is_chosen)
    .map((reaction) =>
      reaction.type._ === 'reactionTypeEmoji'
        ? `emoji:${reaction.type.emoji}`
        : reaction.type._,
    )
    .sort()
    .join('|');
}

/**
 * TDLib refuses with "The reaction isn't available for the message" when its
 * cached copy predates the reaction set the server knows. Refetching the
 * message once makes the add succeed.
 */
function isReactionUnavailableError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /reaction/i.test(text) && /availab/i.test(text);
}

/** TDLib reaction failures are logged and then propagated to the caller. */
function logReactionFailure(
  operation: 'add' | 'remove',
  chatId: number,
  messageId: number,
  error: unknown,
): void {
  emitLog({
    level: 'error',
    source: 'messaging',
    action: 'tdlib.messaging.sendReaction',
    message: `TDLib could not ${operation === 'remove' ? 'remove' : 'add'} the reaction: ${(error as Error)?.message ?? 'unknown error'}`,
    status: 'failed',
    chatId,
    errorCode: 'TDLIB_REACTION_FAILED',
    details: {
      operation,
      messageId,
      error: (error as Error)?.message ?? String(error),
    },
  });
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
  /**
   * TDLib returns only locally cached messages and fills the cache in the
   * background, so a cold chat can answer with one message for a `limit` of 20.
   * Retrying briefly yields the full page instead of a one-message transcript.
   */
  private async historyPage(
    chatId: number,
    fromMessageId: number,
    limit: number,
  ): Promise<message[]> {
    let best: message[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await this.client.api.getChatHistory({
        chat_id: chatId,
        from_message_id: fromMessageId,
        offset: 0,
        limit,
      });
      const batch = result.messages ?? [];
      if (batch.length > best.length) best = batch;
      if (best.length >= limit) break;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
    return best;
  }

  private async mapMessages(
    entry: chat,
    raws: message[],
  ): Promise<MessageView[]> {
    await Promise.all([this.extrasFor(entry), this.warmMessages(raws)]);
    return raws.map((raw) => this.mapMessage(entry, raw));
  }

  /**
   * Like `historyPage`, but for a discussion thread: TDLib may answer with only
   * the newest comments until the thread cache fills, so a short page is
   * retried briefly instead of showing a truncated thread.
   */
  private async threadHistoryPage(
    chatId: number,
    threadRootId: number,
    fromMessageId: number,
    limit: number,
  ): Promise<message[]> {
    let best: message[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await this.client.api.getMessageThreadHistory({
        chat_id: chatId,
        message_id: threadRootId,
        from_message_id: fromMessageId,
        offset: 0,
        limit,
      });
      const batch = result.messages ?? [];
      if (batch.length > best.length) best = batch;
      if (best.length >= limit) break;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
    return best;
  }

  /**
   * Linked discussion thread of a channel post, or `null` when the post has
   * none. TDLib answers a post without comments with an error, and that is an
   * empty thread, not a failed request.
   */
  private async threadInfo(
    chatId: number,
    messageId: number,
  ): Promise<messageThreadInfo | null> {
    try {
      const thread = await this.client.api.getMessageThread({
        chat_id: chatId,
        message_id: messageId,
      });
      return thread.chat_id ? thread : null;
    } catch {
      return null;
    }
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
      .filter(
        (value): value is message => value !== null && value !== undefined,
      );
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

  // ------------------------------------------------------------- chat info

  /**
   * One info-panel tab through TDLib's message search. A cold chat cache can
   * answer with a short page (or none), so the request is retried briefly like
   * `historyPage`; ids stay in TDLib space for the media download endpoint.
   */
  async getChatInfoMedia(
    peerId: number,
    query: TdChatInfoMediaQuery,
  ): Promise<ChatInfoMediaView> {
    const chatId = await this.registry.resolve(peerId);
    const entry = await this.chatFor(chatId);
    const filter = searchFilterForKind(query.kind);
    const raws = await this.searchInfoPage(
      chatId,
      filter,
      query.offsetId ?? 0,
      query.limit,
      query.offsetId,
    );
    const items = (await this.mapMessages(entry, raws)).map((view) =>
      toChatInfoItemFromTd(view, query.kind),
    );
    return {
      items,
      nextOffsetId: items[items.length - 1]?.messageId ?? null,
    };
  }

  /**
   * `searchChatMessages` page of an info tab. The boundary message is filtered
   * out when paginating, matching mtcute's "only messages earlier than offset"
   * contract (TDLib may include `from_message_id` itself).
   */
  private async searchInfoPage(
    chatId: number,
    filter: SearchMessagesFilter,
    fromMessageId: number,
    limit: number,
    offsetId?: number,
  ): Promise<message[]> {
    // Ask for one extra row so the boundary filter still fills a full page.
    const requestLimit = offsetId ? limit + 1 : limit;
    let best: message[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const result = await this.client.api.searchChatMessages({
        chat_id: chatId,
        query: '',
        from_message_id: fromMessageId,
        offset: 0,
        limit: requestLimit,
        filter,
      });
      const batch = (result.messages ?? []).filter((value) =>
        offsetId ? value.id < offsetId : true,
      );
      if (batch.length > best.length) best = batch;
      if (best.length >= limit) break;
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)));
    }
    return best.slice(0, limit);
  }

  /**
   * Similar channels of a channel, mapped to the same DTO as mtcute. TDLib
   * rejects the call for non-channel peers, which is an empty tab, not an
   * error.
   */
  async getChatInfoSimilar(peerId: number): Promise<ChatInfoSimilarView> {
    const chatId = await this.registry.resolve(peerId);
    const entry = await this.chatFor(chatId);
    const type = entry.type;
    if (type._ !== 'chatTypeSupergroup' || !type.is_channel) {
      return { chats: [] };
    }

    let chatIds: number[];
    try {
      const result = await this.client.api.getChatSimilarChats({
        chat_id: chatId,
      });
      chatIds = result.chat_ids ?? [];
    } catch {
      return { chats: [] };
    }

    const chats: SimilarChatView[] = [];
    for (const id of chatIds) {
      let similar: chat;
      try {
        similar = await this.chatFor(id);
      } catch {
        continue;
      }
      let markedId: number;
      try {
        markedId = this.peerIdOf(similar);
      } catch {
        continue;
      }
      const extras = await this.extrasFor(similar);
      chats.push({
        id: markedId,
        title: similar.title,
        username: extras.username,
        memberCount: await this.memberCountOf(similar),
      });
    }
    return { chats };
  }

  /** Member count of a supergroup/channel, or `null` when unavailable. */
  private async memberCountOf(entry: chat): Promise<number | null> {
    const type = entry.type;
    if (type._ !== 'chatTypeSupergroup') return null;
    try {
      const full = await this.client.api.getSupergroupFullInfo({
        supergroup_id: type.supergroup_id,
      });
      return full.member_count > 0 ? full.member_count : null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ text

  /** Translate a message's text/caption; returns the same DTO as mtcute. */
  async translateMessage(
    peerId: number,
    messageId: number,
    to: string,
  ): Promise<MessageTranslationView> {
    const chatId = await this.registry.resolve(peerId);
    const result = await this.client.api.translateMessageText({
      chat_id: chatId,
      message_id: messageId,
      to_language_code: to,
      tone: '',
    });
    const text = result.text?.trim();
    if (!text) {
      throw apiError(
        'VALIDATION_ERROR',
        'This message has no text to translate',
        400,
      );
    }
    return { text: result.text, to };
  }

  /**
   * Transcribe a voice/video note. `recognizeSpeech` returns `Ok` and TDLib
   * pushes the result as `updateMessageContent`; a pending result is waited on
   * (bounded) and reported as `pending: true` so the UI can retry, never as a
   * raw TDLib error.
   */
  async transcribeVoice(
    peerId: number,
    messageId: number,
  ): Promise<MessageTranscriptionView> {
    const chatId = await this.registry.resolve(peerId);

    let current: message | null = null;
    try {
      current = await this.client.api.getMessage({
        chat_id: chatId,
        message_id: messageId,
      });
    } catch {
      // The recognition call below reports the canonical error.
    }
    const existing = current ? speechResultOf(current.content) : null;
    if (existing?._ === 'speechRecognitionResultText') {
      return { text: existing.text, pending: false };
    }
    if (existing?._ === 'speechRecognitionResultError') {
      throw speechApiError(existing.error.message);
    }

    // Subscribe before asking Telegram so an immediate update is not missed.
    const waiter = this.waitForSpeechResult(chatId, messageId, existing);
    let returned: unknown;
    try {
      returned = await this.client.api.recognizeSpeech({
        chat_id: chatId,
        message_id: messageId,
      });
    } catch (error) {
      waiter.cancel();
      throw error;
    }

    // Older TDLib versions answer with the result instead of an update.
    const direct = returned as SpeechRecognitionResult | null;
    if (direct && typeof direct === 'object' && '_' in direct) {
      if (direct._ === 'speechRecognitionResultText') {
        waiter.cancel();
        return { text: direct.text, pending: false };
      }
      if (direct._ === 'speechRecognitionResultError') {
        waiter.cancel();
        throw speechApiError(direct.error.message);
      }
    }

    const result = await waiter.result;
    switch (result._) {
      case 'speechRecognitionResultText':
        return { text: result.text, pending: false };
      case 'speechRecognitionResultError':
        throw speechApiError(result.error.message);
      default:
        return { text: result.partial_text ?? '', pending: true };
    }
  }

  /**
   * Resolves with the finished recognition result, or with the last pending
   * one after {@link SPEECH_WAIT_TIMEOUT_MS}. Never rejects.
   */
  private waitForSpeechResult(
    chatId: number,
    messageId: number,
    initial: SpeechRecognitionResult | null,
  ): {
    result: Promise<SpeechRecognitionResult>;
    cancel: () => void;
  } {
    let cleanup = (): void => undefined;
    const result = new Promise<SpeechRecognitionResult>((resolve) => {
      let last: SpeechRecognitionResult = initial ?? {
        _: 'speechRecognitionResultPending',
        partial_text: '',
      };
      const finish = (value: SpeechRecognitionResult): void => {
        cleanup();
        resolve(value);
      };
      const timer = setTimeout(() => finish(last), SPEECH_WAIT_TIMEOUT_MS);
      const unsubscribe = this.client.updates.subscribe((update) => {
        if (update._ !== 'updateMessageContent') return;
        if (update.chat_id !== chatId || update.message_id !== messageId)
          return;
        const next = speechResultOf(update.new_content);
        if (!next) return;
        last = next;
        if (next._ !== 'speechRecognitionResultPending') finish(next);
      });
      cleanup = (): void => {
        clearTimeout(timer);
        unsubscribe();
      };
    });
    return { result, cancel: () => cleanup() };
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
    const result = await this.historyPage(
      chatId,
      offsetId ?? 0,
      offsetId ? query.limit + 1 : query.limit,
    );
    const raws = result
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

  // ----------------------------------------------------------------- threads

  /**
   * Comments of a channel post, read through the post's linked discussion
   * group. The thread root (the auto-forwarded post) is not a comment and is
   * dropped. A post without a discussion group is not an error: the payload
   * carries `discussionChatId: null` and no comments.
   */
  async getMessageThread(
    peerId: number,
    messageId: number,
    query: TdMessageThreadQuery,
  ): Promise<MessageThreadView> {
    const chatId = await this.registry.resolve(peerId);
    const empty: MessageThreadView = {
      chatId: peerId,
      messageId,
      discussionChatId: null,
      comments: [],
      nextOffsetId: null,
    };

    const thread = await this.threadInfo(chatId, messageId);
    if (!thread) return empty;

    const discussionChatId = thread.chat_id;
    let discussion: chat;
    try {
      discussion = await this.client.api.getChat({ chat_id: discussionChatId });
      // Sender/peer mapping reads chats from the registry.
      this.registry.put(discussion);
    } catch {
      return empty;
    }

    const threadRootId = thread.message_thread_id;
    const withoutRoot = (values: message[]): message[] =>
      values.filter((value) => value.id !== threadRootId);

    let raws: message[];
    const offsetId = query.offsetId;
    if (offsetId !== undefined) {
      const result = await this.client.api.getMessageThreadHistory({
        chat_id: discussionChatId,
        message_id: threadRootId,
        from_message_id: offsetId,
        offset: 0,
        limit: query.limit + 1,
      });
      raws = withoutRoot(result.messages ?? [])
        .filter((value) => value.id < offsetId)
        .slice(0, query.limit);
    } else {
      const found = withoutRoot(thread.messages ?? []);
      const seen = new Set(found.map((value) => value.id));
      if (found.length < query.limit) {
        // Fetch older comments, starting at the oldest one already known.
        const fromMessageId = found.reduce(
          (oldest, value) => Math.min(oldest, value.id),
          found[0]?.id ?? 0,
        );
        const older = await this.threadHistoryPage(
          discussionChatId,
          threadRootId,
          fromMessageId,
          query.limit,
        );
        for (const value of withoutRoot(older)) {
          if (seen.has(value.id)) continue;
          seen.add(value.id);
          found.push(value);
        }
      }
      raws = found.slice(0, query.limit);
    }

    return {
      chatId: peerId,
      messageId,
      discussionChatId: this.peerIdOf(discussion),
      comments: await this.mapMessages(discussion, raws),
      nextOffsetId: raws[raws.length - 1]?.id ?? null,
    };
  }

  /**
   * Sends a comment into the post's linked discussion group. The thread root
   * message is the reply target, which is how Telegram links a comment to the
   * channel post.
   */
  async sendComment(
    peerId: number,
    messageId: number,
    text: string,
  ): Promise<MessageView> {
    const chatId = await this.registry.resolve(peerId);
    const thread = await this.threadInfo(chatId, messageId);
    if (!thread) {
      throw notFound('THREAD_NOT_FOUND', 'This message has no comment thread');
    }

    const sent = await this.client.api.sendMessage({
      chat_id: thread.chat_id,
      topic_id: null,
      reply_to: {
        _: 'inputMessageReplyToMessage',
        message_id: thread.message_thread_id,
        quote: null,
        checklist_task_id: 0,
        poll_option_id: '',
      },
      options: null,
      reply_markup: null,
      input_message_content: {
        _: 'inputMessageText',
        text: this.formattedText(text),
        link_preview_options: null,
        clear_draft: false,
      },
    });
    return this.sentMessage(thread.chat_id, sent);
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
  private async awaitSent(chatId: number, raw: message): Promise<message> {
    if (!raw.sending_state) return raw;
    const tempId = raw.id;
    const startedAt = Date.now();
    return new Promise<message>((resolve) => {
      const finish = (value: message): void => {
        clearTimeout(timer);
        unsubscribe();
        resolve(value);
      };
      const timer = setTimeout(() => {
        emitLog({
          level: 'warn',
          source: 'telegram',
          action: 'tdlib.send.timeout',
          message: `Send to ${chatId} was not confirmed in ${SEND_WAIT_TIMEOUT_MS} ms; the returned id stays temporary`,
          status: 'failed',
          chatId,
          details: { tempId, timeoutMs: SEND_WAIT_TIMEOUT_MS },
        });
        finish(raw);
      }, SEND_WAIT_TIMEOUT_MS);
      const unsubscribe = this.client.updates.subscribe((update) => {
        if (update._ === 'updateMessageSendSucceeded') {
          if (update.old_message_id !== tempId) return;
          const durationMs = Date.now() - startedAt;
          if (durationMs > SEND_SLOW_MS) {
            emitLog({
              level: 'info',
              source: 'telegram',
              action: 'tdlib.send.slow',
              message: `Send to ${chatId} confirmed after ${durationMs} ms`,
              status: 'ok',
              chatId,
              durationMs,
              details: { tempId, messageId: update.message.id },
            });
          }
          finish(update.message);
          return;
        }
        if (
          update._ === 'updateMessageSendFailed' &&
          update.old_message_id === tempId
        ) {
          emitLog({
            level: 'warn',
            source: 'telegram',
            action: 'tdlib.send.failed',
            message: `Send to ${chatId} failed: ${update.error.message}`,
            status: 'failed',
            chatId,
            errorCode: String(update.error.code),
            details: { tempId, errorMessage: update.error.message },
          });
          finish(raw);
        }
      });
    });
  }

  private async sentMessage(
    chatId: number,
    rawMessage: message,
  ): Promise<MessageView> {
    const raw = await this.awaitSent(chatId, rawMessage);
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

    // Asking for the emoji that is already chosen is a no-op.
    if (
      emoji !== null &&
      chosen.some(
        (reaction) =>
          reaction.type._ === 'reactionTypeEmoji' &&
          reaction.type.emoji === emoji,
      )
    ) {
      return this.sentMessage(chatId, current);
    }

    // `emoji: null` removes the current reaction, a non-null emoji replaces
    // it. Paid reactions belong to Telegram and stay untouched.
    let mutated = false;
    for (const reaction of chosen) {
      if (reaction.type._ === 'reactionTypePaid') continue;
      try {
        await this.client.api.removeMessageReaction({
          chat_id: chatId,
          message_id: messageId,
          reaction_type: reaction.type,
        });
        mutated = true;
      } catch (error) {
        // Swallowing this used to leave the old emoji in place while the
        // caller believed the reaction had changed.
        logReactionFailure('remove', chatId, messageId, error);
        throw error;
      }
    }

    if (emoji !== null) {
      const add = () =>
        this.client.api.addMessageReaction({
          chat_id: chatId,
          message_id: messageId,
          reaction_type: { _: 'reactionTypeEmoji', emoji },
          is_big: false,
          update_recent_reactions: true,
        });
      try {
        await add();
        mutated = true;
      } catch (error) {
        if (!isReactionUnavailableError(error)) {
          logReactionFailure('add', chatId, messageId, error);
          throw error;
        }
        // TDLib's cached copy of the message predates the reactions the
        // server knows about; one refresh lets the same add through.
        await this.client.api.getMessage({
          chat_id: chatId,
          message_id: messageId,
        });
        try {
          await add();
          mutated = true;
        } catch (retryError) {
          logReactionFailure('add', chatId, messageId, retryError);
          throw retryError;
        }
      }
    }

    if (!mutated) return this.sentMessage(chatId, current);

    return this.refreshedReactionView(
      chatId,
      messageId,
      chosenReactionSignature(current),
    );
  }

  /**
   * Refetch a message after a reaction change. TDLib updates its cache
   * asynchronously, so the first read can still report the previous
   * `is_chosen` state; one more read after a short delay settles it.
   */
  private async refreshedReactionView(
    chatId: number,
    messageId: number,
    previousSignature: string,
  ): Promise<MessageView | null> {
    const read = async (): Promise<message | null> => {
      try {
        return await this.client.api.getMessage({
          chat_id: chatId,
          message_id: messageId,
        });
      } catch {
        // The reaction was accepted; only the re-fetch is best effort.
        return null;
      }
    };

    let updated = await read();
    if (updated && chosenReactionSignature(updated) === previousSignature) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, REACTION_REFRESH_RETRY_MS),
      );
      updated = await read();
    }
    return updated ? this.sentMessage(chatId, updated) : null;
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

  /**
   * TDLib keeps the account online while it runs. The `online` option lets
   * the app look away after idle time; the next interaction sets it back.
   */
  async setOnline(online: boolean): Promise<{ online: boolean }> {
    await this.client.api.setOption({
      name: 'online',
      value: { _: 'optionValueBoolean', value: online },
    });
    // Read the option back: TDLib ignores unknown option names, and a silent
    // mismatch would make the account look online forever.
    try {
      const value = (await this.client.api.getOption({ name: 'online' })) as {
        _?: string;
        value?: boolean;
      };
      if (value?._ === 'optionValueBoolean') {
        return { online: value.value === true };
      }
    } catch {
      // Older TDLib builds without the option: keep the requested value.
    }
    return { online };
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
   * Routing follows the account's active session: TDLib is used only when
   * `resolveActiveSession` picks a live TDLib row. An explicit `sessionId` can
   * narrow that to another live TDLib session of the same account, but it can
   * never route an mtcute-active account to TDLib. The native client is
   * reopened from its encrypted database when needed; a closed TDLib folder is
   * not a reason to lose the account's message history.
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

    const active = resolveActiveSession(account);
    if (!active || active.engine !== 'tdlib') return null;

    const live = account.sessions.filter(
      (row) => row.engine === 'tdlib' && !row.revokedAt,
    );
    const requested = sessionId
      ? live.find((row) => row.id === sessionId)
      : undefined;

    return this.contextFor(requested ?? active);
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
