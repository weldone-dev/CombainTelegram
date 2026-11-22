/**
 * Plain DTO mapping for chats and messages.
 *
 * The input types are structural (only the fields we read), so these functions
 * can be tested with plain fake objects and also accept mtcute's `Dialog` /
 * `Message` classes, whose fields are getters.
 */

export interface PeerLike {
  id: number;
  type: string;
  displayName: string;
  username: string | null;
  /** mtcute chat subtype; optional so plain test peers stay valid. */
  chatType?: string;
  /**
   * Current user's permissions. Only `group`/`supergroup`/`channel` peers can
   * have them; `null`/`undefined` means no restriction information.
   */
  permissions?: { canSendMessages: boolean } | null;
  isAdmin?: boolean;
  isCreator?: boolean;
}

export interface DialogLike {
  peer: PeerLike;
  lastMessage: MessageLike | null;
  unreadCount: number;
  isPinned: boolean;
  isMuted: boolean | null;
  isArchived: boolean;
  /** Raw dialog, used for the `readInboxMaxId` boundary. */
  raw?: { readInboxMaxId?: number };
}

export interface MessageLike {
  id: number;
  text: string;
  date: Date;
  isOutgoing: boolean;
  sender: PeerLike;
  chat: PeerLike;
  replyToMessage: { id: number | null } | null;
  /**
   * Only the fields we read are structural. `fileName` / `mimeType` are
   * getters on mtcute's document classes and `fileSize` lives on
   * `FileLocation`, so they stay optional for plain test fixtures. Poll
   * getters (`isClosed`, `isQuiz`, ...) are optional for the same reason.
   */
  media: {
    type: string;
    fileName?: string | null;
    mimeType?: string | null;
    fileSize?: number;
    id?: unknown;
    question?: unknown;
    answers?: unknown;
    voters?: unknown;
    isClosed?: unknown;
    isQuiz?: unknown;
    isMultiple?: unknown;
    hideResultsUntilClose?: unknown;
    solution?: unknown;
  } | null;
  /**
   * Reactions on the message (mtcute's `MessageReactions`). Structural so
   * plain fixtures can pass `{ reactions: [...] }`; `emoji` can be a plain
   * string or a `tl.Long` for custom emoji.
   */
  reactions?: {
    reactions?: ReadonlyArray<{
      emoji?: unknown;
      count?: unknown;
      order?: unknown;
    }>;
  } | null;
  /**
   * Comment thread info (mtcute's `MessageRepliesInfo`). Structural so plain
   * fixtures work; getters are read defensively.
   */
  replies?: {
    hasComments?: boolean;
    count?: number;
    discussion?: number | null;
  } | null;
  /**
   * Raw TL message. `_` (the TL constructor) is required so both
   * `RawMessage` and `RawMessageService` structurally match; only `editDate`
   * and `replies.channelId` are read.
   */
  raw: {
    _: string;
    editDate?: unknown;
    replies?: { channelId?: number | null } | null;
  };
}

export interface MessageMediaView {
  kind: 'photo' | 'document' | 'voice' | 'other';
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  downloadable: boolean;
}

export interface MessageReactionView {
  /** Unicode emoji, or `custom:<id>` for Telegram custom emoji. */
  emoji: string;
  count: number;
  /** Whether the current account reacted with this emoji. */
  chosen: boolean;
}

export interface MessagePollAnswerView {
  /** Position in `poll.answers`, i.e. the value sent back when voting. */
  index: number;
  text: string;
  voters: number;
  chosen: boolean;
  correct: boolean;
}

export interface MessagePollView {
  id: string;
  question: string;
  closed: boolean;
  quiz: boolean;
  multiple: boolean;
  voters: number;
  hideResultsUntilClose: boolean;
  answers: MessagePollAnswerView[];
  solution: string | null;
}

export interface MessageThreadInfo {
  /** Total number of comments in the linked discussion group. */
  comments: number;
  /** True when this channel post has a linked comments thread. */
  hasComments: boolean;
  /** Marked id of the discussion group, or `null` when unknown. */
  discussionChatId: number | null;
}

/** Comment thread payload of `GET .../messages/:messageId/thread`. */
export interface MessageThreadView {
  chatId: number;
  messageId: number;
  discussionChatId: number | null;
  /** Newest-first comments. `nextOffsetId` loads the next (older) page. */
  comments: MessageView[];
  nextOffsetId: number | null;
}

export interface MessageView {
  id: number;
  chatId: number;
  text: string;
  date: string;
  outgoing: boolean;
  edited: boolean;
  senderId: number;
  senderName: string;
  replyToId: number | null;
  /** Kept for older clients; `media` is the structured descriptor. */
  mediaType: string | null;
  media: MessageMediaView | null;
  /** Reaction counts, only non-zero entries, in Telegram's order. */
  reactions: MessageReactionView[];
  /** Poll descriptor when the message carries a poll; otherwise `null`. */
  poll: MessagePollView | null;
  /** Convenience flag for the voice-note UI (`media.kind === 'voice'`). */
  isVoice: boolean;
  /**
   * Channel-post comment thread; `null` for everything that is not a channel
   * post with a linked discussion group.
   */
  thread: MessageThreadInfo | null;
}

export interface ChatView {
  id: number;
  type: string;
  title: string;
  username: string | null;
  lastMessage: MessageView | null;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
  archived: boolean;
  /** Highest incoming message id already marked as read by this account. */
  readInboxMaxId: number;
  /** Whether this account may send messages to the chat right now. */
  canSendMessages: boolean;
}

/**
 * Whether the current account can post in a peer.
 *
 * Private chats, bots and legacy groups are writable unless the peer carries
 * an explicit `canSendMessages: false` permission. Supergroups follow their
 * permission object; broadcast channels additionally require admin/creator
 * rights, because followers cannot post there.
 */
export function canSendMessages(peer: PeerLike): boolean {
  // mtcute's `Peer.type` is `user`/`chat`; the concrete subtype lives in
  // `chatType`, so prefer it when it is available.
  const type =
    peer.type === 'chat' && peer.chatType ? peer.chatType : peer.type;
  const allowed = peer.permissions?.canSendMessages !== false;
  if (type === 'channel') {
    return allowed && (peer.isAdmin === true || peer.isCreator === true);
  }
  return allowed;
}

/**
 * Reads a getter that some media classes do not have. Missing or throwing
 * getters become `null` instead of failing the whole message mapping.
 */
function readMediaField<T>(
  media: NonNullable<MessageLike['media']>,
  key: 'fileName' | 'mimeType' | 'fileSize',
): T | null {
  try {
    const value = media[key] as T | null | undefined;
    return value ?? null;
  } catch {
    return null;
  }
}

/**
 * Structured media descriptor. Photos, generic documents and voice notes are
 * downloadable; everything else keeps a kind of `other` so the client can
 * still show `mediaType` without pretending to support it.
 */
export function toMessageMediaView(
  media: MessageLike['media'],
): MessageMediaView | null {
  if (!media) return null;
  const type = typeof media.type === 'string' ? media.type : null;
  const kind: MessageMediaView['kind'] =
    type === 'photo'
      ? 'photo'
      : type === 'document'
        ? 'document'
        : type === 'voice'
          ? 'voice'
          : 'other';
  const mimeType = readMediaField<string>(media, 'mimeType');
  return {
    kind,
    // Voice notes are always OGG/Opus; the getter is optional structurally.
    mimeType: mimeType ?? (kind === 'voice' ? 'audio/ogg' : null),
    fileName: readMediaField<string>(media, 'fileName'),
    size: readMediaField<number>(media, 'fileSize'),
    downloadable: kind === 'photo' || kind === 'document' || kind === 'voice',
  };
}

/** Decimal string for a `tl.Long`, or `null` when the value is unusable. */
function stringifyId(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object') {
    try {
      const text = String(value);
      return text && text !== '[object Object]' ? text : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Reaction emoji: a plain unicode string, or `custom:<id>` for a `tl.Long`. */
function reactionEmoji(value: unknown): string | null {
  if (typeof value === 'string') return value || null;
  if (value && typeof value === 'object') {
    const id = stringifyId(value);
    return id ? `custom:${id}` : null;
  }
  return null;
}

/**
 * Reaction chips of a message, in Telegram's order. Getters are read inside
 * `try` because plain fixtures and partial raw objects may throw.
 */
export function toMessageReactions(
  message: MessageLike,
): MessageReactionView[] {
  const raw = message.reactions?.reactions;
  if (!Array.isArray(raw)) return [];
  const views: MessageReactionView[] = [];
  for (const reaction of raw) {
    try {
      const count =
        typeof reaction?.count === 'number' && Number.isFinite(reaction.count)
          ? reaction.count
          : 0;
      if (count <= 0) continue;
      const emoji = reactionEmoji(reaction?.emoji);
      if (!emoji) continue;
      views.push({
        emoji,
        count,
        chosen: reaction?.order !== null && reaction?.order !== undefined,
      });
    } catch {
      // A single broken reaction must not drop the whole message.
    }
  }
  return views;
}

/**
 * Poll descriptor for a message whose media is a poll. Malformed or partial
 * polls become `null` instead of throwing.
 */
export function toMessagePollView(media: unknown): MessagePollView | null {
  if (!media || typeof media !== 'object') return null;
  try {
    const candidate = media as NonNullable<MessageLike['media']>;
    if (candidate.type !== 'poll') return null;
    const rawAnswers = candidate.answers;
    if (!Array.isArray(rawAnswers)) return null;

    const answers: MessagePollAnswerView[] = rawAnswers.map(
      (answer, index) => {
        const entry =
          answer && typeof answer === 'object'
            ? (answer as {
                text?: unknown;
                voters?: unknown;
                chosen?: unknown;
                correct?: unknown;
              })
            : {};
        return {
          index,
          text: typeof entry.text === 'string' ? entry.text : '',
          voters:
            typeof entry.voters === 'number' && Number.isFinite(entry.voters)
              ? entry.voters
              : 0,
          chosen: entry.chosen === true,
          correct: entry.correct === true,
        };
      },
    );

    return {
      id: stringifyId(candidate.id) ?? '',
      question: typeof candidate.question === 'string' ? candidate.question : '',
      closed: candidate.isClosed === true,
      quiz: candidate.isQuiz === true,
      multiple: candidate.isMultiple === true,
      voters:
        typeof candidate.voters === 'number' &&
        Number.isFinite(candidate.voters)
          ? candidate.voters
          : 0,
      hideResultsUntilClose: candidate.hideResultsUntilClose === true,
      answers,
      solution:
        typeof candidate.solution === 'string' ? candidate.solution : null,
    };
  } catch {
    return null;
  }
}

/**
 * Comment-thread info of a channel post. Only channel posts with a linked
 * discussion group have one; regular chats and groups (whose `replies` can
 * also be present) map to `null`.
 *
 * `MessageRepliesInfo` getters are memoized and may throw on partial fixtures,
 * so each field is read defensively.
 */
export function toMessageThreadInfo(
  message: MessageLike,
): MessageThreadInfo | null {
  const replies = message.replies;
  if (!replies) return null;

  let hasComments = false;
  let count = 0;
  let discussionChatId: number | null = null;
  try {
    hasComments = replies.hasComments === true;
  } catch {
    hasComments = false;
  }
  try {
    if (typeof replies.count === 'number' && Number.isFinite(replies.count)) {
      count = Math.max(replies.count, 0);
    }
  } catch {
    count = 0;
  }
  try {
    if (typeof replies.discussion === 'number') {
      discussionChatId = replies.discussion;
    }
  } catch {
    discussionChatId = null;
  }

  // Older/partial messages only carry the raw channel id; rebuild the marked
  // id instead of returning a thread without a chat to load comments from.
  if (discussionChatId === null) {
    const channelId = message.raw.replies?.channelId;
    if (typeof channelId === 'number') {
      discussionChatId = -(1_000_000_000_000 + channelId);
    }
  }

  if (!hasComments) return null;
  return { comments: count, hasComments, discussionChatId };
}

/** Message DTO shared by REST responses and WS events. */
export function toMessageView(message: MessageLike): MessageView {
  return {
    id: message.id,
    chatId: message.chat.id,
    text: message.text,
    date: message.date.toISOString(),
    outgoing: message.isOutgoing,
    edited: !!message.raw.editDate,
    senderId: message.sender.id,
    senderName: message.sender.displayName,
    replyToId: message.replyToMessage?.id ?? null,
    mediaType: message.media?.type ?? null,
    media: toMessageMediaView(message.media),
    reactions: toMessageReactions(message),
    poll:
      message.media?.type === 'poll'
        ? toMessagePollView(message.media)
        : null,
    isVoice: message.media?.type === 'voice',
    thread: toMessageThreadInfo(message),
  };
}

/**
 * Merges dialog lists fetched from several Telegram folders (0 = main,
 * 1 = archive) into one list, dropping repeats of the same peer id while
 * keeping the first occurrence's order. A `limit` caps the merged result.
 */
export function mergeDialogsById<T extends { peer: { id: number } }>(
  groups: ReadonlyArray<ReadonlyArray<T>>,
  limit = Number.POSITIVE_INFINITY,
): T[] {
  if (limit <= 0) return [];
  const seen = new Set<number>();
  const merged: T[] = [];
  for (const group of groups) {
    for (const dialog of group) {
      if (seen.has(dialog.peer.id)) continue;
      seen.add(dialog.peer.id);
      merged.push(dialog);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

/**
 * Chat DTO for a bare peer (e.g. `getPeer` or a global-search hit), where no
 * dialog state is available. Flags default to their neutral values.
 */
export function toChatViewFromPeer(peer: PeerLike): ChatView {
  return {
    id: peer.id,
    type: peer.type,
    title: peer.displayName,
    username: peer.username,
    lastMessage: null,
    unreadCount: 0,
    pinned: false,
    muted: false,
    archived: false,
    readInboxMaxId: 0,
    canSendMessages: canSendMessages(peer),
  };
}

export interface FolderLike {
  id: number;
  title: { text: string };
  emoticon?: string;
}

export interface FolderView {
  id: number;
  title: string;
  emoticon: string | null;
}

/** Folder DTO for `GET /accounts/:accountId/folders`. */
export function toFolderView(folder: FolderLike): FolderView {
  return {
    id: folder.id,
    title: folder.title.text,
    emoticon: folder.emoticon ?? null,
  };
}

/** Dialog DTO for `GET /accounts/:accountId/chats`. */
export function toChatView(dialog: DialogLike): ChatView {
  return {
    id: dialog.peer.id,
    type: dialog.peer.type,
    title: dialog.peer.displayName,
    username: dialog.peer.username,
    lastMessage: dialog.lastMessage ? toMessageView(dialog.lastMessage) : null,
    unreadCount: dialog.unreadCount,
    pinned: dialog.isPinned,
    muted: dialog.isMuted ?? false,
    archived: dialog.isArchived,
    readInboxMaxId: dialog.raw?.readInboxMaxId ?? 0,
    canSendMessages: canSendMessages(dialog.peer),
  };
}
