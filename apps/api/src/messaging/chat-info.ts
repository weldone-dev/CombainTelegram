/**
 * Plain DTO mapping for the chat info panel.
 *
 * Inputs are structural (only the fields we read), so plain fake objects and
 * mtcute's `FullUser` / `FullChat` classes both fit, and the mappers stay
 * unit-testable without a Telegram connection.
 */

import { canSendMessages } from './message-view.js';
import type { PeerLike } from './message-view.js';

export interface ChatPeerView {
  id: number;
  type: string;
  title: string;
  username: string | null;
}

export interface ChatInfoView extends ChatPeerView {
  about: string | null;
  memberCount: number | null;
  onlineCount: number | null;
  isChannel: boolean;
  isGroup: boolean;
  isAdmin: boolean;
  isCreator: boolean;
  canSendMessages: boolean;
  inviteLink: string | null;
}

/** Structural subset of mtcute's full-user record (`getFullUser`). */
export interface FullUserLike {
  id: number;
  type: string;
  displayName: string;
  username: string | null;
  /** User bio; empty for most accounts. */
  bio?: string | null;
}

/** Structural subset of mtcute's full-chat record (`getFullChat`). */
export interface FullChatLike extends PeerLike {
  chatType: string;
  bio?: string | null;
  membersCount?: number | null;
  onlineCount?: number | null;
  inviteLink?: { link: string } | null;
}

/** Fallback peer fields; `membersCount` is only present on some peers. */
export interface PeerInfoLike extends PeerLike {
  membersCount?: number | null;
}

function positiveOrNull(value: number | null | undefined): number | null {
  return value !== undefined && value !== null && value > 0 ? value : null;
}

/**
 * Info for a private chat or bot. Telegram has no full-chat record for users:
 * the bio is `about`, member/online counts and invite links do not apply, and
 * a private chat is always writable.
 */
export function toChatInfoFromUser(user: FullUserLike): ChatInfoView {
  return {
    id: user.id,
    type: user.type,
    title: user.displayName,
    username: user.username,
    about: user.bio || null,
    memberCount: null,
    onlineCount: null,
    isChannel: false,
    isGroup: false,
    isAdmin: false,
    isCreator: false,
    canSendMessages: true,
    inviteLink: null,
  };
}

/** Info for a group, supergroup or channel from `getFullChat`. */
export function toChatInfoFromFullChat(full: FullChatLike): ChatInfoView {
  const type = full.chatType;
  return {
    id: full.id,
    type,
    title: full.displayName,
    username: full.username,
    about: full.bio || null,
    memberCount: positiveOrNull(full.membersCount),
    onlineCount: positiveOrNull(full.onlineCount),
    isChannel: type === 'channel',
    isGroup: type === 'group' || type === 'supergroup' || type === 'gigagroup',
    isAdmin: full.isAdmin === true,
    isCreator: full.isCreator === true,
    canSendMessages: canSendMessages(full),
    inviteLink:
      full.inviteLink?.link ??
      (full.username ? `https://t.me/${full.username}` : null),
  };
}

/**
 * Last-resort view built from `getPeer` fields only. Used when `getFullUser` /
 * `getFullChat` fails partially: counts and bio stay `null` instead of
 * turning the whole info panel into an error.
 */
export function toChatInfoFromPeer(peer: PeerInfoLike): ChatInfoView {
  const type = peer.chatType ?? peer.type;
  return {
    id: peer.id,
    type,
    title: peer.displayName,
    username: peer.username,
    about: null,
    memberCount: positiveOrNull(peer.membersCount),
    onlineCount: null,
    isChannel: type === 'channel',
    isGroup: type === 'group' || type === 'supergroup' || type === 'gigagroup',
    isAdmin: peer.isAdmin === true,
    isCreator: peer.isCreator === true,
    canSendMessages: canSendMessages(peer),
    inviteLink: peer.username ? `https://t.me/${peer.username}` : null,
  };
}
