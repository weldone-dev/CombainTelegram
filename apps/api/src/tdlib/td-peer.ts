/**
 * Peer-id translation between TDLib and this API.
 *
 * The REST API speaks mtcute "marked" chat ids (`message.chat.id`):
 * - user:              `user_id`
 * - basic group:       `basic_group_id` (positive)
 * - supergroup/channel `-1000000000000 - supergroup_id`
 *
 * TDLib uses its own `chat_id`:
 * - user:              `user_id`
 * - basic group:       `-basic_group_id`
 * - supergroup/channel `-1000000000000 - supergroup_id`
 *
 * Every TDLib call needs its `chat_id`, so the conversion is explicit and
 * tested in both directions. The helpers accept structural objects so plain
 * fixtures (and `tdlib-native`'s `ChatType`) both fit.
 */

/** Prefix of a TDLib supergroup/channel chat id (`-100…`). */
export const TD_CHANNEL_ID_PREFIX = 1_000_000_000_000;

/** Structural subset of TDLib's `ChatType`. */
export interface TdChatTypeLike {
  _: string;
  user_id?: number;
  basic_group_id?: number;
  supergroup_id?: number;
  is_channel?: boolean;
  secret_chat_id?: number;
}

/** Structural subset of a TDLib `chat` needed for peer-id mapping. */
export interface TdChatIdLike {
  id?: number;
  type?: TdChatTypeLike;
}

export type PeerViewType = 'user' | 'chat';
export type ChatInfoKind = 'user' | 'group' | 'supergroup' | 'channel';

/**
 * mtcute-marked peer id of a TDLib chat type, or `null` for a constructor
 * this API cannot address (unknown/future TDLib types).
 */
export function peerIdFromTdChatType(type: TdChatTypeLike): number | null {
  switch (type?._) {
    case 'chatTypePrivate':
    case 'chatTypeSecret':
      return typeof type.user_id === 'number' ? type.user_id : null;
    case 'chatTypeBasicGroup':
      return typeof type.basic_group_id === 'number'
        ? type.basic_group_id
        : null;
    case 'chatTypeSupergroup':
      return typeof type.supergroup_id === 'number'
        ? -(TD_CHANNEL_ID_PREFIX + type.supergroup_id)
        : null;
    default:
      return null;
  }
}

/**
 * TDLib `chat_id` for a marked peer id of the given chat type, or `null` when
 * the peer id does not match that type (e.g. a positive id for a channel).
 */
export function chatIdFromPeer(
  type: TdChatTypeLike,
  peerId: number,
): number | null {
  if (!Number.isSafeInteger(peerId) || peerId === 0) return null;
  switch (type?._) {
    case 'chatTypePrivate':
    case 'chatTypeSecret':
      return peerId > 0 ? peerId : null;
    case 'chatTypeBasicGroup':
      return peerId > 0 ? -peerId : null;
    case 'chatTypeSupergroup':
      return peerId <= -TD_CHANNEL_ID_PREFIX ? peerId : null;
    default:
      return null;
  }
}

/**
 * TDLib `chat_id` for a marked peer id when the chat type is not known yet.
 * Positive ids may be users or basic groups; negative ids are supergroups or
 * channels. `TdChatRegistry` verifies the guess with `getChat`.
 */
export function guessedChatIdsFromPeer(peerId: number): number[] {
  if (!Number.isSafeInteger(peerId) || peerId === 0) return [];
  return peerId < 0 ? [peerId] : [peerId, -peerId];
}

/**
 * Marked peer id derived from a raw TDLib `chat_id`, used when the full chat
 * object is not available.
 */
export function peerIdFromTdChatId(chatId: number): number | null {
  if (!Number.isSafeInteger(chatId) || chatId === 0) return null;
  if (chatId <= -TD_CHANNEL_ID_PREFIX) return chatId;
  return chatId < 0 ? -chatId : chatId;
}

/** mtcute peer `type`: users are `user`, every group/channel is `chat`. */
export function peerTypeFromTdChatType(
  type: TdChatTypeLike,
): PeerViewType | null {
  switch (type?._) {
    case 'chatTypePrivate':
    case 'chatTypeSecret':
      return 'user';
    case 'chatTypeBasicGroup':
    case 'chatTypeSupergroup':
      return 'chat';
    default:
      return null;
  }
}

/** Concrete chat kind for `ChatInfoView`, matching mtcute's `chatType`. */
export function chatInfoKindFromTdChatType(
  type: TdChatTypeLike,
): ChatInfoKind | null {
  switch (type?._) {
    case 'chatTypePrivate':
    case 'chatTypeSecret':
      return 'user';
    case 'chatTypeBasicGroup':
      return 'group';
    case 'chatTypeSupergroup':
      return type.is_channel === true ? 'channel' : 'supergroup';
    default:
      return null;
  }
}

/** Whether the chat is a broadcast channel (not a supergroup). */
export function isTdChannel(type: TdChatTypeLike): boolean {
  return type?._ === 'chatTypeSupergroup' && type.is_channel === true;
}
