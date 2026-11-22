import { Injectable } from '@nestjs/common';
import {
  InputMedia,
  SearchFilters,
  tl,
  type Dialog,
  type Message,
  type Peer,
  type SendableTypingStatus,
  type TelegramClient,
} from '@mtcute/node';
import { AccountsService } from '../accounts/accounts.service.js';
import type { AvatarImage } from '../accounts/accounts.service.js';
import { raiseTelegramError } from '../auth/telegram-error.js';
import { apiError, notFound } from '../common/api-error.js';
import {
  MAX_MEDIA_THUMB_BYTES,
  MEDIA_CACHE_MAX_BYTES,
  MEDIA_CACHE_MAX_ENTRY_BYTES,
  MEDIA_CACHE_TTL_MS,
  MEDIA_THUMB_CACHE_TTL_MS,
  assertMediaDownloadSize,
  assertMediaUpload,
  contentDisposition,
  isImageMime,
  isInlineSafeMime,
  mediaKindForMime,
  normalizeMimeType,
  pickThumbnail,
  sanitizeFileName,
} from './media.js';
import {
  toChatInfoFromFullChat,
  toChatInfoFromPeer,
  toChatInfoFromUser,
} from './chat-info.js';
import type { ChatInfoView, ChatPeerView } from './chat-info.js';
import {
  mergeDialogsById,
  toChatView,
  toChatViewFromPeer,
  toFolderView,
  toMessageMediaView,
  toMessagePollView,
  toMessageView,
} from './message-view.js';
import type {
  ChatView,
  FolderView,
  MessageMediaView,
  MessagePollView,
  MessageThreadView,
  MessageView,
} from './message-view.js';
import {
  extractFirstUrl,
  normalizeUsername,
  parseChatId,
  parseChatInfoKind,
  parseDeleteOptions,
  parseDeleteMessageOptions,
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
  parsePollOptions,
  parseReactionEmoji,
  parseSearchQuery,
  parseThumbFlag,
  parseTranslateLanguage,
} from './params.js';
import type { ChatInfoKind } from './params.js';

export type { ChatInfoView, ChatPeerView } from './chat-info.js';

export interface ChatInfoPollView {
  question: string;
  options: string[];
  totalVoters: number;
}

export interface ChatInfoItemView {
  messageId: number;
  date: string;
  text: string;
  media: MessageMediaView | null;
  url: string | null;
  poll: ChatInfoPollView | null;
}

export interface ChatInfoMediaView {
  items: ChatInfoItemView[];
  nextOffsetId: number | null;
}

export interface SimilarChatView {
  id: number;
  title: string;
  username: string | null;
  memberCount: number | null;
}

export interface ChatInfoSimilarView {
  chats: SimilarChatView[];
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

export interface MessageTranslationView {
  text: string;
  to: string;
}

export interface MessageTranscriptionView {
  text: string;
  pending: boolean;
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
}

export interface ReadAllView {
  read: number;
  failed: number;
}

/** Upper bound for `POST /chats/read-all` to keep the fan-out bounded. */
const MAX_READ_ALL_DIALOGS = 200;
/** Concurrent `readHistory` calls per batch in `read-all`. */
const READ_ALL_BATCH_SIZE = 10;
/** Small avatars are cheap to keep, but the map must still be bounded. */
const AVATAR_CACHE_MAX_ENTRIES = 100;

/** `limit` cap for the chat info tabs. */
const CHAT_INFO_LIMIT = 50;

/** `limit` cap for the comment thread drawer. */
const THREAD_LIMIT = 100;

/**
 * Dialogs scanned per folder when a peer id cannot be resolved by its access
 * hash; keeps the last-resort lookup bounded instead of crawling all history.
 */
const PEER_DIALOG_SCAN_LIMIT = 500;

/**
 * Whether Telegram's photo pipeline rejected the image. Some valid images
 * (very small PNGs, odd colour profiles) fail as photos but upload fine as
 * documents.
 */
function isImageProcessFailed(error: unknown): boolean {
  return tl.RpcError.is(error) && error.text === 'IMAGE_PROCESS_FAILED';
}

/**
 * Whether the peer is a one-to-one chat. mtcute 0.32 models bots as `User`
 * (`type: 'user'`), but `'bot'` is kept for versions that report it apart.
 */
function isPrivatePeer(peer: Peer): boolean {
  const type: string = peer.type;
  return type === 'user' || type === 'bot';
}

/** Marked chat id from a raw `chat`/`channel` TL object. */
function markedChatId(raw: { _: string; id: number }): number | null {
  switch (raw._) {
    case 'channel':
    case 'channelForbidden':
      return -(1_000_000_000_000 + raw.id);
    case 'chat':
    case 'chatForbidden':
      return raw.id;
    default:
      return null;
  }
}

interface PollMediaLike {
  type: string;
  question?: unknown;
  answers?: ReadonlyArray<{ text?: unknown }>;
  voters?: unknown;
}

/** Poll tab payload; malformed/partial polls keep an empty-but-valid shape. */
function toPollView(media: unknown, text: string): ChatInfoPollView {
  const fallbackQuestion = text.trim() || 'Опрос';
  if (!media || typeof media !== 'object') {
    return { question: fallbackQuestion, options: [], totalVoters: 0 };
  }

  const candidate = media as PollMediaLike;
  if (candidate.type !== 'poll') {
    return { question: fallbackQuestion, options: [], totalVoters: 0 };
  }

  const question =
    typeof candidate.question === 'string' && candidate.question.trim()
      ? candidate.question
      : fallbackQuestion;
  const options = Array.isArray(candidate.answers)
    ? candidate.answers
        .map((answer) => (typeof answer?.text === 'string' ? answer.text : ''))
        .filter((answer) => answer.length > 0)
    : [];
  const totalVoters =
    typeof candidate.voters === 'number' && Number.isFinite(candidate.voters)
      ? candidate.voters
      : 0;

  return { question, options, totalVoters };
}

function toChatInfoItemView(
  message: Message,
  kind: ChatInfoKind,
): ChatInfoItemView {
  return {
    messageId: message.id,
    date: message.date.toISOString(),
    text: message.text,
    media: toMessageMediaView(message.media),
    url: kind === 'links' ? extractFirstUrl(message.text) : null,
    poll: kind === 'polls' ? toPollView(message.media, message.text) : null,
  };
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

interface DownloadCacheEntry {
  data: Buffer;
  mimeType: string;
  fileName: string;
  inline: boolean;
  at: number;
  /** Per-entry lifetime; thumbnails live longer than full files. */
  ttlMs?: number;
}

@Injectable()
export class MessagingService {
  private readonly avatars = new Map<
    string,
    { data: Buffer | null; at: number }
  >();

  private readonly downloads = new Map<string, DownloadCacheEntry>();
  /** Sum of `data.byteLength` over `downloads`, kept in sync with every write. */
  private downloadBytes = 0;

  constructor(private readonly accounts: AccountsService) {}

  private pruneAvatars(now: number): void {
    for (const [key, entry] of this.avatars) {
      if (now - entry.at >= AVATAR_TTL_MS) this.avatars.delete(key);
    }
    while (this.avatars.size > AVATAR_CACHE_MAX_ENTRIES) {
      const oldest = this.avatars.keys().next().value;
      if (oldest === undefined) break;
      this.avatars.delete(oldest);
    }
  }

  private setAvatar(key: string, data: Buffer | null, now = Date.now()): void {
    this.avatars.delete(key);
    this.avatars.set(key, { data, at: now });
    this.pruneAvatars(now);
  }

  private forgetDownload(key: string): void {
    const entry = this.downloads.get(key);
    if (!entry) return;
    this.downloads.delete(key);
    this.downloadBytes -= entry.data.byteLength;
    if (this.downloadBytes < 0) this.downloadBytes = 0;
  }

  private rememberDownload(key: string, entry: DownloadCacheEntry): void {
    this.forgetDownload(key);
    // Huge documents are served but not retained; one of them could evict the
    // whole cache and keep hundreds of MB resident.
    if (entry.data.byteLength > MEDIA_CACHE_MAX_ENTRY_BYTES) return;
    this.downloads.set(key, entry);
    this.downloadBytes += entry.data.byteLength;

    for (const [cachedKey, cached] of this.downloads) {
      if (entry.at - cached.at >= (cached.ttlMs ?? MEDIA_CACHE_TTL_MS)) {
        this.forgetDownload(cachedKey);
      }
    }
    while (this.downloadBytes > MEDIA_CACHE_MAX_BYTES) {
      const oldest = this.downloads.keys().next().value;
      if (oldest === undefined) break;
      this.forgetDownload(oldest);
    }
  }

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
      // mtcute maps `archived: 'keep'` to `folderId = undefined`, i.e. the
      // main folder only — it never asks Telegram for folder 1 (archive). To
      // really cover every folder, fetch main and archive separately and merge.
      const modes: Array<'exclude' | 'only' | 'keep'> =
        folderId === undefined && archivedMode === 'keep'
          ? ['exclude', 'only']
          : [archivedMode];

      const groups: Array<Array<Dialog>> = [];
      for (const mode of modes) {
        const group: Array<Dialog> = [];
        for await (const dialog of client.iterDialogs({
          limit,
          archived: mode,
          ...(folderId !== undefined ? { folder: folderId } : {}),
        })) {
          group.push(dialog);
          if (group.length >= limit) break;
        }
        groups.push(group);
      }

      return mergeDialogsById(groups, limit).map((dialog) =>
        toChatView(dialog),
      );
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async getChat(
    userId: string,
    accountId: string,
    rawChatId: string,
    sessionIdParam?: unknown,
  ): Promise<ChatPeerView> {
    const chatId = parseChatId(rawChatId);
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    let peer: Peer;
    try {
      peer = await this.resolvePeerForChat(client, chatId);
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

  /**
   * Full chat info for the info panel. The peer is resolved first, because
   * `getFullChat` rejects users: private chats and bots use `getFullUser`
   * (bio as `about`), while groups and channels use `getFullChat` (member
   * counts, invite links, permissions). If either full record fails, the view
   * degrades to the plain `getPeer` fields instead of erroring.
   */
  async getChatInfo(
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
      peer = await this.resolvePeerForChat(client, chatId);
    } catch (error) {
      raiseTelegramError(error);
    }

    if (isPrivatePeer(peer)) {
      try {
        const fullUser = await client.getFullUser(chatId);
        return toChatInfoFromUser(fullUser);
      } catch {
        // Restricted account: keep the basic peer fields instead of a 502.
        return toChatInfoFromPeer(peer);
      }
    }

    try {
      const full = await client.getFullChat(chatId);
      return toChatInfoFromFullChat(full);
    } catch {
      // Restricted peer without a full-chat record.
      return toChatInfoFromPeer(peer);
    }
  }

  /**
   * One tab of the chat info panel: photos/videos, links or polls. Message
   * search is paginated by `offsetId`; `limit` is capped at 50 per request.
   */
  async getChatInfoMedia(
    userId: string,
    accountId: string,
    rawChatId: string,
    query: {
      kind?: unknown;
      limit?: unknown;
      offsetId?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatInfoMediaView> {
    const chatId = parseChatId(rawChatId);
    const kind = parseChatInfoKind(query.kind);
    const limit = parseLimit(query.limit, CHAT_INFO_LIMIT);
    const offsetId = parseOffsetId(query.offsetId);
    const sessionId = parseOptionalSessionId(query.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    const filter: tl.TypeMessagesFilter =
      kind === 'media'
        ? SearchFilters.PhotoAndVideo
        : kind === 'links'
          ? SearchFilters.Url
          : { _: 'inputMessagesFilterPoll' };

    try {
      // Warm/confirm the peer first: search resolves the chat id itself, and
      // an uncached private chat would fail before Telegram is asked.
      const peer = await this.resolvePeerForChat(client, chatId);
      const result = await client.searchMessages({
        chatId: peer,
        filter,
        limit,
        ...(offsetId !== undefined ? { offset: offsetId } : {}),
      });
      return {
        items: result.map((message) => toChatInfoItemView(message, kind)),
        nextOffsetId: result.next ?? null,
      };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /**
   * Similar channels for the info panel. Telegram only exposes this as a raw
   * TL call, and it fails for private chats/supergroups; an unsupported peer
   * yields an empty list rather than an error.
   */
  async getChatInfoSimilar(
    userId: string,
    accountId: string,
    rawChatId: string,
    sessionIdParam?: unknown,
  ): Promise<ChatInfoSimilarView> {
    const chatId = parseChatId(rawChatId);
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const peer = await client.resolvePeer(chatId);
      if (peer._ !== 'inputPeerChannel') return { chats: [] };

      const result = await client.call({
        _: 'channels.getChannelRecommendations',
        channel: {
          _: 'inputChannel',
          channelId: peer.channelId,
          accessHash: peer.accessHash,
        },
      });

      const chats: SimilarChatView[] = [];
      for (const raw of result.chats) {
        const id = markedChatId(raw);
        if (id === null) continue;
        const meta = raw as unknown as {
          title?: string;
          username?: string;
          usernames?: Array<{ username: string }>;
          participantsCount?: number;
        };
        chats.push({
          id,
          title: meta.title ?? '',
          username: meta.username ?? meta.usernames?.[0]?.username ?? null,
          memberCount: meta.participantsCount ?? null,
        });
      }
      return { chats };
    } catch {
      return { chats: [] };
    }
  }

  /** Small profile photo of a chat/user/channel, cached briefly in memory. */
  async chatAvatar(
    userId: string,
    accountId: string,
    rawChatId: string,
    sessionIdParam?: unknown,
  ): Promise<AvatarImage | null> {
    const chatId = parseChatId(rawChatId);
    // Ownership/session check first: a cache hit must not bypass it.
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    const key = `${userId}:${accountId}:${chatId}`;
    const cached = this.avatars.get(key);
    if (cached && Date.now() - cached.at < AVATAR_TTL_MS) {
      return cached.data ? { data: cached.data, mime: 'image/jpeg' } : null;
    }

    let photo: { small: unknown } | null = null;
    try {
      const peer = await this.resolvePeerForChat(client, chatId);
      photo = peer.photo;
    } catch (error) {
      raiseTelegramError(error);
    }
    if (!photo) {
      this.setAvatar(key, null);
      return null;
    }

    try {
      const data = Buffer.from(
        await client.downloadAsBuffer(
          photo.small as Parameters<typeof client.downloadAsBuffer>[0],
        ),
      );
      this.setAvatar(key, data);
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

  /**
   * Comment thread of a channel post.
   *
   * mtcute 0.32 has no `threadId` option on `getHistory`; the linked
   * discussion thread is read with `searchMessages({ threadId })` instead.
   * Comments come back **newest first** and `nextOffsetId` (mtcute's
   * `result.next`) is the id to pass as `offsetId` for the next, older page.
   * A post without a linked discussion group is not an error: the response
   * carries `discussionChatId: null` and an empty list.
   */
  async getMessageThread(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    query: { limit?: unknown; offsetId?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageThreadView> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const limit = parseLimit(query.limit, THREAD_LIMIT);
    const offsetId = parseOffsetId(query.offsetId);
    const sessionId = parseOptionalSessionId(query.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    let discussion: Message | null = null;
    try {
      discussion = await client.getDiscussionMessage({
        chatId,
        message: messageId,
      });
    } catch (error) {
      raiseTelegramError(error);
    }
    if (!discussion) {
      return {
        chatId,
        messageId,
        discussionChatId: null,
        comments: [],
        nextOffsetId: null,
      };
    }

    try {
      const result = await client.searchMessages({
        chatId: discussion.chat.id,
        threadId: discussion.id,
        limit,
        ...(offsetId !== undefined ? { offset: offsetId } : {}),
      });
      return {
        chatId,
        messageId,
        discussionChatId: discussion.chat.id,
        // The thread root is not a comment; drop it if Telegram includes it.
        comments: result
          .filter((message) => message.id !== discussion.id)
          .map((message) => toMessageView(message)),
        nextOffsetId: result.next ?? null,
      };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /**
   * Send a comment into the post's linked discussion group. The discussion
   * root message is the reply target, which is how Telegram links comments to
   * a channel post.
   */
  async sendComment(
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

    let discussion: Message | null = null;
    try {
      discussion = await client.getDiscussionMessage({
        chatId,
        message: messageId,
      });
    } catch (error) {
      raiseTelegramError(error);
    }
    if (!discussion) {
      throw notFound('THREAD_NOT_FOUND', 'This message has no comment thread');
    }

    try {
      const message: Message = await client.sendText(
        discussion.chat.id,
        text,
        { replyTo: discussion.id },
      );
      return toMessageView(message);
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

    const sendOptions =
      replyToId !== undefined ? { replyTo: replyToId } : {};

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
        sendOptions,
      );
      return toMessageView(message);
    } catch (error) {
      // Telegram's photo pipeline rejects some valid images (e.g. tiny PNGs)
      // with IMAGE_PROCESS_FAILED. Sending the same bytes as a document is
      // accepted, so retry once instead of surfacing a 502.
      if (kind !== 'photo' || !isImageProcessFailed(error)) {
        raiseTelegramError(error);
      }
      try {
        const fallback = InputMedia.document(input.buffer, {
          fileName,
          fileMime: mimeType,
          fileSize: size,
          ...(caption !== undefined ? { caption } : {}),
        });
        const message: Message = await client.sendMedia(
          chatId,
          fallback,
          sendOptions,
        );
        return toMessageView(message);
      } catch (retryError) {
        // The retry failed too; map that error (IMAGE_PROCESS_FAILED → 400
        // MEDIA_PROCESS_FAILED) so the UI gets a clear reason.
        raiseTelegramError(retryError);
      }
    }
  }

  /** Live cache entry, refreshed to LRU position; `undefined` when stale. */
  private cachedDownload(key: string): DownloadCacheEntry | undefined {
    const entry = this.downloads.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at >= (entry.ttlMs ?? MEDIA_CACHE_TTL_MS)) {
      this.forgetDownload(key);
      return undefined;
    }
    // Re-insert so the LRU pruning sees this key as recently used.
    this.downloads.delete(key);
    this.downloads.set(key, entry);
    return entry;
  }

  /** HTTP payload for a cache entry, honouring a client-supplied name. */
  private toDownloadView(
    entry: DownloadCacheEntry,
    requestedName: string | null,
  ): MediaDownloadView {
    const fileName = sanitizeFileName(
      requestedName ?? entry.fileName,
      entry.fileName,
    );
    return {
      data: entry.data,
      mimeType: entry.mimeType,
      fileName,
      disposition: contentDisposition(fileName, entry.inline),
      length: entry.data.byteLength,
    };
  }

  /**
   * Download the media attached to one message. Photos, generic documents and
   * voice notes are supported; the last few results are cached in memory.
   *
   * `thumb=1|true` asks for a small preview instead: the best thumbnail is
   * downloaded (≤ {@link MAX_MEDIA_THUMB_BYTES}), cached separately under
   * `:thumb` for longer, and served inline. When no usable thumbnail exists —
   * or downloading it fails — the full media is returned instead of a 404.
   */
  async downloadMedia(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    sessionIdParam?: unknown,
    filenameParam?: unknown,
    thumbParam?: unknown,
  ): Promise<MediaDownloadView> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const wantThumb = parseThumbFlag(thumbParam);
    const cacheKey = `${userId}:${accountId}:${chatId}:${messageId}`;
    const thumbKey = `${cacheKey}:thumb`;

    // Ownership/session check first: a cache hit must not bypass it.
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    const requestedName =
      typeof filenameParam === 'string' && filenameParam.trim()
        ? filenameParam.trim()
        : null;

    if (!wantThumb) {
      const cached = this.cachedDownload(cacheKey);
      if (cached) return this.toDownloadView(cached, requestedName);
    } else {
      const cachedThumb = this.cachedDownload(thumbKey);
      if (cachedThumb) return this.toDownloadView(cachedThumb, requestedName);
    }

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
      (media.type !== 'photo' &&
        media.type !== 'document' &&
        media.type !== 'voice')
    ) {
      throw notFound(
        'MEDIA_NOT_FOUND',
        'This message has no downloadable photo, document or voice note',
      );
    }

    if (wantThumb && (media.type === 'photo' || media.type === 'document')) {
      try {
        const thumb = pickThumbnail(
          media as Parameters<typeof pickThumbnail>[0],
        );
        if (thumb) {
          const data = Buffer.from(
            await client.downloadAsBuffer(
              thumb as Parameters<typeof client.downloadAsBuffer>[0],
            ),
          );
          if (data.byteLength > 0 && data.byteLength <= MAX_MEDIA_THUMB_BYTES) {
            const mimeType = 'image/jpeg';
            const fileName = sanitizeFileName(
              requestedName ?? 'thumb.jpg',
              'thumb.jpg',
            );
            this.rememberDownload(thumbKey, {
              data,
              mimeType,
              fileName: 'thumb.jpg',
              inline: true,
              at: Date.now(),
              ttlMs: MEDIA_THUMB_CACHE_TTL_MS,
            });
            return {
              data,
              mimeType,
              fileName,
              disposition: contentDisposition(fileName, true),
              length: data.byteLength,
            };
          }
        }
      } catch {
        // Missing or undownloadable preview: fall back to the full file.
      }
    }

    if (wantThumb) {
      // A previously cached full download is the cheapest fallback.
      const cachedFull = this.cachedDownload(cacheKey);
      if (cachedFull) return this.toDownloadView(cachedFull, requestedName);
    }

    // Telegram documents may be gigabytes; reject before buffering anything.
    assertMediaDownloadSize(descriptor.size);

    try {
      const data = Buffer.from(await client.downloadAsBuffer(media));
      // Never echo the sender's MIME verbatim: `image/svg+xml` would be
      // executable on this origin. Invalid values become octet-stream, and
      // only raster images are served `inline`; voice notes are played from
      // the API origin by an `<audio>` element, so they stay inline too.
      const mimeType = normalizeMimeType(
        descriptor.mimeType ??
          (descriptor.kind === 'photo'
            ? 'image/jpeg'
            : descriptor.kind === 'voice'
              ? 'audio/ogg'
              : null),
      );
      const defaultFileName = sanitizeFileName(
        descriptor.fileName,
        descriptor.kind === 'photo'
          ? 'photo.jpg'
          : descriptor.kind === 'voice'
            ? 'voice.ogg'
            : 'document',
      );
      const fileName = sanitizeFileName(
        requestedName ?? defaultFileName,
        defaultFileName,
      );
      const inline =
        isInlineSafeMime(mimeType) || descriptor.kind === 'voice';

      this.rememberDownload(cacheKey, {
        data,
        mimeType,
        fileName: defaultFileName,
        inline,
        at: Date.now(),
      });

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

  /**
   * Send or remove a reaction. Telegram answers with the edited message only
   * for users; when it is unavailable the caller gets `null` (HTTP 204) and
   * the realtime edit event carries the new state.
   */
  async sendReaction(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    body: { emoji?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageView | null> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const emoji = parseReactionEmoji(body.emoji);
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      await client.sendReaction({ chatId, message: messageId, emoji: emoji ?? null });
    } catch (error) {
      raiseTelegramError(error);
    }

    try {
      const [message] = await client.getMessages(chatId, [messageId]);
      return message ? toMessageView(message) : null;
    } catch {
      // The reaction was accepted; only the re-fetch is best effort.
      return null;
    }
  }

  /** Vote in (or retract a vote from) a poll and return its new state. */
  async votePoll(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    body: { options?: unknown; sessionId?: unknown } = {},
  ): Promise<MessagePollView> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const options = parsePollOptions(body.options);
    const sessionId = parseOptionalSessionId(body.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    let poll;
    try {
      poll = await client.sendVote({ chatId, message: messageId, options });
    } catch (error) {
      raiseTelegramError(error);
    }
    const view = toMessagePollView(poll);
    if (!view) {
      throw apiError('TELEGRAM_ERROR', 'Telegram returned an unusable poll');
    }
    return view;
  }

  /**
   * Translate a message's text into `to` (default `ru`). `message.text`
   * already includes media captions, so there is no separate caption path.
   */
  async translateMessage(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    body: { to?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageTranslationView> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const to = parseTranslateLanguage(body.to);
    const sessionId = parseOptionalSessionId(body.sessionId);
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
    if (!message) {
      throw notFound('MESSAGE_NOT_FOUND', 'This message was not found');
    }
    const text = message.text?.trim();
    if (!text) {
      throw apiError('VALIDATION_ERROR', 'This message has no text to translate');
    }

    try {
      const result = await client.translateText(text, to);
      return { text: result.text, to };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /**
   * Transcribe a voice note. Telegram answers immediately for short notes and
   * with `pending: true` while the server still works; the UI can retry.
   */
  async transcribeVoice(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    sessionIdParam?: unknown,
  ): Promise<MessageTranscriptionView> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      const peer = await client.resolvePeer(chatId);
      const raw = await client.call({
        _: 'messages.transcribeAudio',
        peer,
        msgId: messageId,
      });
      return { text: raw.text ?? '', pending: raw.pending === true };
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

  /**
   * Delete one message. `revoke` defaults to `false` (remove only from this
   * account); `revoke=true` deletes it for everyone. Without the explicit
   * default mtcute would revoke, silently deleting other people's messages
   * where an admin is allowed to.
   */
  async deleteMessage(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawMessageId: string,
    query: { revoke?: unknown; sessionId?: unknown } = {},
  ): Promise<DeletedMessageView> {
    const chatId = parseChatId(rawChatId);
    const messageId = parseMessageId(rawMessageId);
    const { revoke } = parseDeleteMessageOptions(query);
    const sessionId = parseOptionalSessionId(query.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      await client.deleteMessagesById(chatId, [messageId], { revoke });
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
            // `silent` means "no sound", not "muted" — official clients set
            // only `muteUntil` (0x7FFFFFFF = muted forever, 0 clears it).
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
   * dialog is removed: private chats and legacy groups use `deleteHistory`,
   * while channels and supergroups are left.
   *
   * Both flags default to `false`, so a bare `DELETE` only removes the chat
   * for this account. `revoke=true` is the explicit "delete for everyone"
   * (and `leaveChat({ clear: true })` for channels/supergroups).
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
    const { revoke, clearHistory } = parseDeleteOptions(query);
    const sessionId = parseOptionalSessionId(query.sessionId);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    try {
      if (clearHistory) {
        // mtcute's `deleteHistory` resolves `void` (no affected-message count),
        // so there is nothing meaningful to report besides `removed: false`.
        await client.deleteHistory(chatId, { mode: 'clear' });
        return { removed: false };
      }

      const peer = await this.resolvePeerForChat(client, chatId);
      if (
        isPrivatePeer(peer) ||
        (peer.type === 'chat' && peer.chatType === 'group')
      ) {
        await client.deleteHistory(chatId, {
          mode: revoke ? 'revoke' : 'delete',
        });
      } else {
        await client.leaveChat(chatId, { clear: revoke });
      }
      return { removed: true };
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
      // `archived: 'keep'` only fetches folder 0 in mtcute, so ask for the
      // main and archive folders explicitly and merge (dedupe pinned repeats).
      const groups: Array<Array<Dialog>> = [];
      for (const archived of ['exclude', 'only'] as const) {
        const group: Array<Dialog> = [];
        for await (const dialog of client.iterDialogs({
          limit: MAX_READ_ALL_DIALOGS,
          archived,
          pinned: 'exclude',
        })) {
          group.push(dialog);
          if (group.length >= MAX_READ_ALL_DIALOGS) break;
        }
        groups.push(group);
      }

      const unread = mergeDialogsById(groups, MAX_READ_ALL_DIALOGS).filter(
        (dialog) => dialog.unreadCount > 0 || dialog.isManuallyUnread,
      );

      // Batches keep one flood-waited dialog from aborting everything that
      // follows; partial failures are reported instead of thrown.
      let read = 0;
      let failed = 0;
      for (let i = 0; i < unread.length; i += READ_ALL_BATCH_SIZE) {
        const batch = unread.slice(i, i + READ_ALL_BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map((dialog) => client.readHistory(dialog.peer.inputPeer)),
        );
        for (const result of results) {
          if (result.status === 'fulfilled') read += 1;
          else failed += 1;
        }
      }
      return { read, failed };
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

  /**
   * Resolve a numeric chat id to a peer even when it is not in the local peer
   * cache yet (a fresh private chat opened straight from a link or notification).
   * `getPeer` starts from the cached peer, so it can reject with
   * `Peer ... is not found in local cache` before the full-user read runs; the
   * fallback asks Telegram for the id (`force` skips the cache) and then loads
   * the user or chat from that resolution. Cached peers keep the fast path.
   *
   * A forced resolve still needs an access hash, which Telegram only hands out
   * for peers it sent us, so the final fallback scans the visible dialogs: the
   * chat is there by definition if the UI lists it, and returning that peer
   * also warms the cache for `getFullUser` / `getFullChat`.
   */
  private async resolvePeerForChat(
    client: TelegramClient,
    chatId: number,
  ): Promise<Peer> {
    try {
      return await client.getPeer(chatId);
    } catch (error) {
      try {
        const input = await client.resolvePeer(chatId, true);
        if ('userId' in input) return await client.getUser(input);
        return await client.getChat(input);
      } catch {
        const fromDialogs = await this.findPeerInDialogs(client, chatId);
        if (fromDialogs) return fromDialogs;
      }
      raiseTelegramError(error);
    }
  }

  /** Last-resort peer lookup over the dialog list, bounded per folder. */
  private async findPeerInDialogs(
    client: TelegramClient,
    chatId: number,
  ): Promise<Peer | null> {
    // Same folders as `listChats`: `archived: 'keep'` only reads the main one.
    for (const archived of ['exclude', 'only'] as const) {
      let scanned = 0;
      try {
        for await (const dialog of client.iterDialogs({
          limit: PEER_DIALOG_SCAN_LIMIT,
          archived,
        })) {
          if (dialog.peer.id === chatId) return dialog.peer;
          scanned += 1;
          if (scanned >= PEER_DIALOG_SCAN_LIMIT) break;
        }
      } catch {
        // Folders fail independently (e.g. no archive yet); try the next one.
      }
    }
    return null;
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
