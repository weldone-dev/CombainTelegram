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
   * `FileLocation`, so they stay optional for plain test fixtures.
   */
  media: {
    type: string;
    fileName?: string | null;
    mimeType?: string | null;
    fileSize?: number;
  } | null;
  /**
   * Raw TL message. `_` (the TL constructor) is required so both
   * `RawMessage` and `RawMessageService` structurally match; only `editDate`
   * is read (`edited`).
   */
  raw: { _: string; editDate?: unknown };
}

export interface MessageMediaView {
  kind: 'photo' | 'document' | 'other';
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  downloadable: boolean;
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
 * Structured media descriptor. Only photos and generic documents are
 * downloadable; everything else keeps a kind of `other` so the client can
 * still show `mediaType` without pretending to support it.
 */
export function toMessageMediaView(
  media: MessageLike['media'],
): MessageMediaView | null {
  if (!media) return null;
  const type = typeof media.type === 'string' ? media.type : null;
  const kind: MessageMediaView['kind'] =
    type === 'photo' ? 'photo' : type === 'document' ? 'document' : 'other';
  return {
    kind,
    mimeType: readMediaField<string>(media, 'mimeType'),
    fileName: readMediaField<string>(media, 'fileName'),
    size: readMediaField<number>(media, 'fileSize'),
    downloadable: kind === 'photo' || kind === 'document',
  };
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
