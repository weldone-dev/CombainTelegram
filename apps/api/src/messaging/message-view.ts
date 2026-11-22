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
  media: { type: string } | null;
  /**
   * Raw TL message. `_` (the TL constructor) is required so both
   * `RawMessage` and `RawMessageService` structurally match; only `editDate`
   * is read (`edited`).
   */
  raw: { _: string; editDate?: unknown };
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
  mediaType: string | null;
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
  };
}

/** Dialog DTO for `GET /accounts/:accountId/chats`. */
export function toChatView(dialog: DialogLike): ChatView {
  return {
    id: dialog.peer.id,
    type: dialog.peer.type,
    title: dialog.peer.displayName,
    username: dialog.peer.username,
    lastMessage: dialog.lastMessage
      ? toMessageView(dialog.lastMessage)
      : null,
    unreadCount: dialog.unreadCount,
    pinned: dialog.isPinned,
    muted: dialog.isMuted ?? false,
    archived: dialog.isArchived,
    readInboxMaxId: dialog.raw?.readInboxMaxId ?? 0,
  };
}
