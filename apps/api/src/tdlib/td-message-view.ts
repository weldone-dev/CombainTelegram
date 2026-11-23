/**
 * TDLib → API view mapping.
 *
 * The REST/WS DTOs are owned by `messaging/message-view.ts`; this module only
 * translates TDLib objects into the same structural inputs those mappers
 * already accept, so both engines produce byte-identical JSON shapes.
 *
 * TDLib generated types use snake_case (`message.chat_id`,
 * `update.authorization_state`) and plain seconds for dates.
 */

import type { chat, file, message, user } from 'tdlib-native/types';
import {
  canSendMessages,
  toChatView,
  toMessageView,
} from '../messaging/message-view.js';
import type {
  ChatView,
  DialogLike,
  MessageLike,
  MessageView,
  PeerLike,
} from '../messaging/message-view.js';
import {
  chatInfoKindFromTdChatType,
  peerIdFromTdChatId,
  peerIdFromTdChatType,
  peerTypeFromTdChatType,
} from './td-peer.js';

/** Sender/chat peer resolved by the caller (users and chats caches live there). */
export type TdPeerResolver = (entry: message) => PeerLike | undefined;

export interface TdMessageViewContext {
  chat?: chat | null;
  chatPeer?: PeerLike;
  resolveSender?: TdPeerResolver;
}

export interface TdChatViewOptions {
  username?: string | null;
  isAdmin?: boolean;
  isCreator?: boolean;
  resolveSender?: TdPeerResolver;
}

/** Content constructors that are real messages (not service events). */
const REGULAR_CONTENT = new Set([
  'messageText',
  'messageRichMessage',
  'messageAnimation',
  'messageAudio',
  'messageDocument',
  'messagePaidMedia',
  'messagePhoto',
  'messageSticker',
  'messageVideo',
  'messageVideoNote',
  'messageVoiceNote',
  'messageExpiredPhoto',
  'messageExpiredVideo',
  'messageExpiredVideoNote',
  'messageExpiredVoiceNote',
  'messageLiveLocation',
  'messageLocation',
  'messageVenue',
  'messageContact',
  'messageAnimatedEmoji',
  'messageDice',
  'messageGame',
  'messagePoll',
  'messageStakeDice',
  'messageStory',
  'messageWidget',
  'messageChecklist',
  'messageInvoice',
  'messageUnsupported',
]);

/** Service constructors that carry no user-visible text of their own. */
const SERVICE_CONTENT = new Set([
  'messageBasicGroupChatCreate',
  'messageSupergroupChatCreate',
  'messagePinMessage',
  'messageScreenshotTaken',
  'messageCustomServiceAction',
  'messageGameScore',
  'messagePollOptionAdded',
  'messagePollOptionDeleted',
  'messageContactRegistered',
  'messageCall',
  'messageGroupCall',
  'messageVideoChatScheduled',
  'messageVideoChatStarted',
  'messageVideoChatEnded',
  'messageInviteVideoChatParticipants',
  'messageSuggestProfilePhoto',
  'messageSuggestBirthdate',
  'messageManagedBotCreated',
  'messagePaymentSuccessful',
  'messagePaymentSuccessfulBot',
  'messagePaymentRefunded',
  'messageGiftedPremium',
  'messagePremiumGiftCode',
  'messageGiveawayCreated',
  'messageGiveaway',
  'messageGiveawayCompleted',
  'messageGiveawayWinners',
  'messageGiftedStars',
  'messageGiftedGrams',
  'messageGiveawayPrizeStars',
  'messageTonWalletTransfer',
  'messageTonConnectRequest',
  'messageGift',
  'messageUpgradedGift',
  'messageRefundedUpgradedGift',
  'messageUpgradedGiftPurchaseOffer',
  'messageUpgradedGiftPurchaseOfferRejected',
  'messagePaidMessagesRefunded',
  'messagePaidMessagePriceChanged',
  'messageDirectMessagePriceChanged',
  'messageUnpaidMessagesAllowedByLink',
  'messageChecklistTasksDone',
  'messageChecklistTasksAdded',
  'messageSuggestedPostApprovalFailed',
  'messageSuggestedPostApproved',
  'messageSuggestedPostDeclined',
  'messageSuggestedPostPaid',
  'messageSuggestedPostRefunded',
  'messageChatBoost',
  'messageUsersShared',
  'messageChatShared',
  'messageBotWriteAccessAllowed',
  'messageWebAppDataSent',
  'messageWebAppDataReceived',
  'messagePassportDataSent',
  'messagePassportDataReceived',
  'messageProximityAlertTriggered',
]);

/** Media file pointers of one message content, reused by the file service. */
export interface TdMediaFileInfo {
  /** mtcute-compatible media type (`photo`, `document`, `voice`, …). */
  type: string;
  fileName: string | null;
  mimeType: string | null;
  size: number | null;
  /** Full-size file, or `null` for content without a downloadable file. */
  file: file | null;
  /** Best preview thumbnail, or `null` when Telegram has none. */
  thumb: file | null;
}

/** Primary username, matching what the mtcute path reports. */
export function tdUsername(usernames: user['usernames']): string | null {
  if (!usernames) return null;
  return (
    usernames.active_usernames?.[0] ??
    usernames.editable_username ??
    usernames.collectible_usernames?.[0] ??
    null
  );
}

/** Display name of a TDLib user (never empty). */
export function tdUserName(entry: user | null | undefined): string {
  if (!entry) return '';
  const name = [entry.first_name, entry.last_name]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean)
    .join(' ');
  return name || tdUsername(entry.usernames) || String(entry.id);
}

/** Structural `PeerLike` for a TDLib user. */
export function peerOfTdUser(
  entry: user | null | undefined,
  fallbackId: number,
): PeerLike {
  return {
    id: entry?.id ?? fallbackId,
    type: 'user',
    displayName: tdUserName(entry) || String(fallbackId),
    username: tdUsername(entry?.usernames ?? null),
    chatType: 'private',
    permissions: { canSendMessages: true },
  };
}

/**
 * Structural `PeerLike` for a TDLib chat.
 *
 * `type` stays `chat` for every group/channel (mtcute's convention); the
 * concrete kind lives in `chatType`, exactly like mtcute dialogs.
 */
export function peerOfTdChat(
  entry: chat | null | undefined,
  extra: {
    peerId?: number;
    username?: string | null;
    isAdmin?: boolean;
    isCreator?: boolean;
  } = {},
): PeerLike {
  const type = entry?.type;
  const peerId =
    extra.peerId ?? (type ? peerIdFromTdChatType(type) : null) ?? 0;
  const kind = type ? chatInfoKindFromTdChatType(type) : null;
  const permissions = entry?.permissions?.can_send_basic_messages !== false;
  return {
    id: peerId,
    type: type ? (peerTypeFromTdChatType(type) ?? 'chat') : 'chat',
    displayName: entry?.title || String(peerId),
    username: extra.username ?? null,
    chatType:
      kind === 'group' || kind === 'supergroup' || kind === 'channel'
        ? kind
        : 'private',
    permissions: { canSendMessages: permissions },
    isAdmin: extra.isAdmin,
    isCreator: extra.isCreator,
  };
}

/** Fallback peer when only the raw TDLib chat id is known. */
function peerOfTdChatId(chatId: number): PeerLike {
  const peerId = peerIdFromTdChatId(chatId) ?? chatId;
  return {
    id: peerId,
    // Positive raw chat ids are users, negative ones are groups/channels.
    type: chatId > 0 ? 'user' : 'chat',
    displayName: String(peerId),
    username: null,
    permissions: { canSendMessages: true },
  };
}

function peerOfSender(entry: message): PeerLike {
  const sender = entry.sender_id;
  if (sender?._ === 'messageSenderUser') {
    return peerOfTdUser(undefined, sender.user_id);
  }
  if (sender?._ === 'messageSenderChat') {
    return peerOfTdChatId(sender.chat_id);
  }
  return peerOfTdChatId(entry.chat_id);
}

/** Largest available photo size (full-size download). */
export function largestPhotoSize(
  photo: { sizes?: Array<{ width: number; photo: file }> } | null,
): file | null {
  const sizes = photo?.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  return [...sizes].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0].photo;
}

/** Best preview photo size: closest to 320px wide, never the full-size one. */
export function photoThumbnail(
  photo: {
    sizes?: Array<{ type?: string; width: number; photo: file }>;
  } | null,
  maxWidth = 320,
): file | null {
  const sizes = photo?.sizes;
  if (!Array.isArray(sizes) || sizes.length === 0) return null;
  const sorted = [...sizes].sort((a, b) => (a.width ?? 0) - (b.width ?? 0));
  const within = sorted.filter((size) => (size.width ?? 0) <= maxWidth);
  const chosen =
    within[within.length - 1] ?? (sorted.length > 1 ? sorted[0] : null);
  return chosen?.photo ?? null;
}

/**
 * File pointers of a message content. Unknown/service content yields `null`,
 * media without a file (poll, location) yields an info object with `file:null`.
 */
export function mediaFileInfo(
  entry: message | null | undefined,
): TdMediaFileInfo | null {
  const content = entry?.content;
  if (!content) return null;
  switch (content._) {
    case 'messagePhoto': {
      const photo = content.photo;
      return {
        type: 'photo',
        fileName: null,
        mimeType: 'image/jpeg',
        size: largestPhotoSize(photo)?.size ?? null,
        file: largestPhotoSize(photo),
        thumb: photoThumbnail(photo),
      };
    }
    case 'messageVideo': {
      const video = content.video;
      return {
        type: 'video',
        fileName: video.file_name || null,
        mimeType: video.mime_type || 'video/mp4',
        size: video.video.size || null,
        file: video.video,
        thumb: video.thumbnail?.file ?? null,
      };
    }
    case 'messageVideoNote': {
      const note = content.video_note;
      return {
        type: 'video',
        fileName: null,
        mimeType: 'video/mp4',
        size: note.video.size || null,
        file: note.video,
        thumb: note.thumbnail?.file ?? null,
      };
    }
    case 'messageVoiceNote': {
      const voice = content.voice_note;
      return {
        type: 'voice',
        fileName: null,
        mimeType: voice.mime_type || 'audio/ogg',
        size: voice.voice.size || null,
        file: voice.voice,
        thumb: null,
      };
    }
    case 'messageAudio': {
      const audio = content.audio;
      return {
        type: 'audio',
        fileName: audio.file_name || null,
        mimeType: audio.mime_type || null,
        size: audio.audio.size || null,
        file: audio.audio,
        thumb: audio.album_cover_thumbnail?.file ?? null,
      };
    }
    case 'messageDocument': {
      const doc = content.document;
      return {
        type: 'document',
        fileName: doc.file_name || null,
        mimeType: doc.mime_type || null,
        size: doc.document.size || null,
        file: doc.document,
        thumb: doc.thumbnail?.file ?? null,
      };
    }
    case 'messageSticker': {
      const sticker = content.sticker;
      return {
        type: 'sticker',
        fileName: null,
        mimeType: 'image/webp',
        size: sticker.sticker.size || null,
        file: sticker.sticker,
        thumb: sticker.thumbnail?.file ?? null,
      };
    }
    case 'messageAnimation': {
      const animation = content.animation;
      return {
        type: 'video',
        fileName: animation.file_name || null,
        mimeType: animation.mime_type || 'video/mp4',
        size: animation.animation.size || null,
        file: animation.animation,
        thumb: animation.thumbnail?.file ?? null,
      };
    }
    case 'messagePoll':
      return {
        type: 'poll',
        fileName: null,
        mimeType: null,
        size: null,
        file: null,
        thumb: null,
      };
    default:
      return null;
  }
}

/** Caption/text of a content constructor; empty for media without caption. */
function contentText(entry: message): string {
  const content = entry.content;
  switch (content._) {
    case 'messageText':
      return content.text?.text ?? '';
    case 'messageRichMessage':
      return '';
    case 'messagePhoto':
    case 'messageVideo':
    case 'messageAnimation':
    case 'messageAudio':
    case 'messageDocument':
    case 'messageVoiceNote':
      return content.caption?.text ?? '';
    case 'messagePoll':
      return content.poll?.question?.text ?? '';
    case 'messageLocation':
      return `📍 ${content.location.latitude}, ${content.location.longitude}`;
    case 'messageVenue':
      return [`📍 ${content.venue.title}`, content.venue.address]
        .filter(Boolean)
        .join('\n');
    case 'messageContact':
      return [
        `👤 ${[content.contact.first_name, content.contact.last_name].filter(Boolean).join(' ')}`,
        content.contact.phone_number,
      ]
        .filter(Boolean)
        .join('\n');
    case 'messageDice':
      return `${content.emoji}${content.value ? ` ${content.value}` : ''}`.trim();
    case 'messageUnsupported':
      return '[Unsupported message]';
    case 'messageExpiredPhoto':
      return '[Photo expired]';
    case 'messageExpiredVideo':
    case 'messageExpiredVideoNote':
      return '[Video expired]';
    case 'messageExpiredVoiceNote':
      return '[Voice message expired]';
    default:
      return content._.startsWith('messageChat') ||
        content._.startsWith('messageForum') ||
        SERVICE_CONTENT.has(content._)
        ? ''
        : '[Unsupported message]';
  }
}

/** Poll payload in the `MessageLike` structural shape. */
function pollMedia(
  content: Extract<message['content'], { _: 'messagePoll' }>,
): NonNullable<MessageLike['media']> {
  const poll = content.poll;
  const quiz = poll.type._ === 'pollTypeQuiz' ? poll.type : null;
  return {
    type: 'poll',
    id: poll.id,
    question: poll.question?.text ?? '',
    answers: poll.options.map((option, index) => ({
      text: option.text?.text ?? '',
      voters: option.voter_count ?? 0,
      chosen: option.is_chosen === true,
      correct: quiz?.correct_option_ids?.includes(index) === true,
    })),
    voters: poll.total_voter_count ?? 0,
    isClosed: poll.is_closed === true,
    isQuiz: quiz !== null,
    isMultiple: poll.allows_multiple_answers === true,
    hideResultsUntilClose: !poll.can_see_results && !poll.is_closed,
    solution: quiz?.explanation?.text || null,
  };
}

/** Media descriptor in the `MessageLike` structural shape. */
function messageMedia(entry: message): MessageLike['media'] {
  if (entry.content._ === 'messagePoll') return pollMedia(entry.content);
  const info = mediaFileInfo(entry);
  if (!info) {
    switch (entry.content._) {
      case 'messageLocation':
      case 'messageLiveLocation':
        return { type: 'location' };
      case 'messageVenue':
        return { type: 'venue' };
      case 'messageContact':
        return { type: 'contact' };
      case 'messageDice':
      case 'messageStakeDice':
        return { type: 'dice' };
      default:
        return null;
    }
  }
  return {
    type: info.type,
    fileName: info.fileName,
    mimeType: info.mimeType,
    fileSize: info.size ?? 0,
  };
}

/** Reaction chips from `messageInteractionInfo.reactions`. */
function messageReactions(entry: message): MessageLike['reactions'] {
  const reactions = entry.interaction_info?.reactions?.reactions;
  if (!Array.isArray(reactions) || reactions.length === 0) return null;
  return {
    reactions: reactions.map((reaction) => ({
      emoji:
        reaction.type._ === 'reactionTypeEmoji'
          ? reaction.type.emoji
          : reaction.type._ === 'reactionTypeCustomEmoji'
            ? `custom:${reaction.type.custom_emoji_id}`
            : 'paid',
      count: reaction.total_count,
      // `toMessageReactions` reads a non-null order as "chosen by me".
      order: reaction.is_chosen ? 0 : null,
    })),
  };
}

/** Comment-thread info from the reply summary TDLib keeps on the message. */
function messageReplies(entry: message): MessageLike['replies'] {
  const reply = entry.interaction_info?.reply_info;
  if (!reply || reply.reply_count <= 0) return null;
  return {
    hasComments: true,
    count: reply.reply_count,
    discussion: null,
  };
}

function messageLike(
  entry: message,
  context: TdMessageViewContext,
): MessageLike {
  const chatPeer =
    context.chatPeer ??
    (context.chat ? peerOfTdChat(context.chat) : peerOfTdChatId(entry.chat_id));
  const sender = context.resolveSender?.(entry) ?? peerOfSender(entry);
  const reply = entry.reply_to;
  const text = contentText(entry);
  const service = !REGULAR_CONTENT.has(entry.content._);
  return {
    id: entry.id,
    text,
    date: new Date((entry.date || 0) * 1000),
    isOutgoing: entry.is_outgoing === true,
    sender,
    chat: chatPeer,
    replyToMessage:
      reply?._ === 'messageReplyToMessage' ? { id: reply.message_id } : null,
    media: messageMedia(entry),
    reactions: messageReactions(entry),
    replies: messageReplies(entry),
    raw: {
      _: service ? 'messageService' : 'message',
      editDate: entry.edit_date || undefined,
      replies: null,
    },
  };
}

/** `MessageView` of one TDLib message. Never throws on unknown content. */
export function toMessageViewFromTd(
  entry: message,
  context: TdMessageViewContext = {},
): MessageView {
  return toMessageView(messageLike(entry, context));
}

/** `ChatView` of one TDLib chat (dialog). */
export function toChatViewFromTd(
  entry: chat,
  options: TdChatViewOptions = {},
): ChatView {
  const peer = peerOfTdChat(entry, {
    username: options.username ?? null,
    isAdmin: options.isAdmin,
    isCreator: options.isCreator,
  });
  const dialog: DialogLike = {
    peer,
    lastMessage: entry.last_message
      ? messageLike(entry.last_message, {
          chat: entry,
          chatPeer: peer,
          resolveSender: options.resolveSender,
        })
      : null,
    unreadCount: entry.unread_count ?? 0,
    isPinned: entry.positions?.some((position) => position.is_pinned) ?? false,
    isMuted:
      entry.notification_settings?.use_default_mute_for === true
        ? false
        : (entry.notification_settings?.mute_for ?? 0) > 0,
    isArchived:
      entry.chat_lists?.some((list) => list._ === 'chatListArchive') ?? false,
    raw: { readInboxMaxId: entry.last_read_inbox_message_id ?? 0 },
  };
  return toChatView(dialog);
}

/** Whether the account may post in a TDLib chat (same rule as mtcute). */
export function canSendInTdChat(
  entry: chat,
  extra: { isAdmin?: boolean; isCreator?: boolean } = {},
): boolean {
  return canSendMessages(
    peerOfTdChat(entry, {
      isAdmin: extra.isAdmin,
      isCreator: extra.isCreator,
    }),
  );
}
