import { Injectable } from '@nestjs/common';
import {
  type Peer,
  type TelegramClient,
  type tl,
} from '@mtcute/node';
import { AccountsService } from '../accounts/accounts.service.js';
import { raiseTelegramError } from '../auth/telegram-error.js';
import { apiError } from '../common/api-error.js';
import {
  parseChatId,
  parseLimit,
  parseOptionalSessionId,
} from './params.js';

/** Same cap as `getChatMembers` itself; Telegram ignores larger offsets. */
const MAX_MEMBERS = 200;
/** Telegram's fixed set of allowed slow-mode intervals (seconds). */
export const SLOW_MODE_SECONDS = [
  0, 10, 30, 60, 300, 900, 3600, 10800, 21600, 43200, 86400,
] as const;
/** Admin permission flags exposed by the panel. */
export const ADMIN_RIGHT_KEYS = [
  'changeInfo',
  'deleteMessages',
  'banUsers',
  'inviteUsers',
  'pinMessages',
  'manageCall',
  'postMessages',
  'editMessages',
  'addAdmins',
  'anonymous',
  'manageTopics',
] as const;

export type AdminRightKey = (typeof ADMIN_RIGHT_KEYS)[number];
export type AdminRightsInput = Partial<Record<AdminRightKey, boolean>>;

export type ChatMemberFilter =
  | 'all'
  | 'admins'
  | 'banned'
  | 'recent'
  | 'bots';

const MEMBER_FILTERS: ChatMemberFilter[] = [
  'all',
  'admins',
  'banned',
  'recent',
  'bots',
];

const GROUP_CHAT_TYPES = new Set(['group', 'supergroup', 'gigagroup', 'channel']);

const MAX_TITLE_LENGTH = 255;
const MAX_DESCRIPTION_LENGTH = 255;
const MAX_RANK_LENGTH = 16;
const MAX_MEMBER_QUERY_LENGTH = 256;
const MAX_INVITE_NAME_LENGTH = 32;
const MAX_USAGE_LIMIT = 99_999;

export interface ChatMemberView {
  id: number;
  name: string;
  username: string | null;
  status: string;
  rank: string | null;
  isAdmin: boolean;
  isCreator: boolean;
  joinedAt: string | null;
}

export interface ChatMembersView {
  items: ChatMemberView[];
  total: number | null;
}

export interface ChatInviteView {
  link: string;
  creatorName: string | null;
  isPrimary: boolean;
  isRevoked: boolean;
  usage: number;
  /** `null` means no usage limit (Telegram reports `Infinity`). */
  usageLimit: number | null;
  approvalNeeded: boolean;
  pendingJoinRequests: number;
  expiresAt: string | null;
}

export interface ChatInviteLinksView {
  items: ChatInviteView[];
}

export interface ChatAdminSettingsView {
  title: string;
  about: string;
  slowModeSeconds: number;
}

export interface ChatJoinRequestView {
  userId: number;
  name: string;
  username: string | null;
  about: string | null;
  date: string;
}

export interface ChatJoinRequestsView {
  items: ChatJoinRequestView[];
}

export interface JoinRequestsDecisionView {
  approved: number;
  declined: number;
}

/** Structural subset of mtcute's `ChatMember`. */
export interface ChatMemberLike {
  user: {
    id: number;
    displayName: string;
    username: string | null;
  };
  status: string;
  title?: string | null;
  joinedDate?: Date | null;
}

/** Structural subset of mtcute's `ChatInviteLink`. */
export interface ChatInviteLinkLike {
  link: string;
  creator?: { displayName: string } | null;
  isPrimary: boolean;
  isRevoked: boolean;
  usage: number;
  usageLimit: number;
  approvalNeeded: boolean;
  pendingApprovals: number;
  endDate: Date | null;
}

/** Structural subset of mtcute's `FullChat` used for the admin gate. */
export interface AdminChatLike {
  chatType?: string;
  isAdmin?: boolean;
  isCreator?: boolean;
  displayName?: string;
  bio?: string;
  slowmodeSeconds?: number | null;
}

/**
 * Admin decision for one chat. The creator is an admin for the UI's purposes
 * (they can do everything an admin can plus transfer/delete the chat).
 */
export function isChatAdmin(chat: AdminChatLike): boolean {
  return chat.isAdmin === true || chat.isCreator === true;
}

/** Throws 403 `CHAT_ADMIN_REQUIRED` unless the account administers the chat. */
export function assertChatAdmin(chat: AdminChatLike): void {
  if (isChatAdmin(chat)) return;
  throw apiError(
    'CHAT_ADMIN_REQUIRED',
    'Admin rights are required for this action',
    403,
  );
}

export function isGroupOrChannel(chatType: string | undefined): boolean {
  return chatType !== undefined && GROUP_CHAT_TYPES.has(chatType);
}

/** Throws 400 `NOT_A_GROUP` for private chats, bots and unknown peer types. */
export function assertGroupOrChannel(chatType: string | undefined): void {
  if (isGroupOrChannel(chatType)) return;
  throw apiError(
    'NOT_A_GROUP',
    'This action is only available for groups and channels',
    400,
  );
}

/** Maps a Telegram member to the panel DTO; admins include the creator. */
export function toChatMemberView(member: ChatMemberLike): ChatMemberView {
  const isCreator = member.status === 'creator';
  return {
    id: member.user.id,
    name: member.user.displayName,
    username: member.user.username,
    status: member.status,
    rank: member.title ?? null,
    isAdmin: isCreator || member.status === 'admin',
    isCreator,
    joinedAt: member.joinedDate ? member.joinedDate.toISOString() : null,
  };
}

/** Maps an invite link to the panel DTO; `Infinity` limits become `null`. */
export function toChatInviteView(link: ChatInviteLinkLike): ChatInviteView {
  const usageLimit = Number.isFinite(link.usageLimit) ? link.usageLimit : null;
  return {
    link: link.link,
    creatorName: link.creator?.displayName ?? null,
    isPrimary: link.isPrimary,
    isRevoked: link.isRevoked,
    usage: link.usage,
    usageLimit,
    approvalNeeded: link.approvalNeeded,
    pendingJoinRequests: link.pendingApprovals,
    expiresAt: link.endDate ? link.endDate.toISOString() : null,
  };
}

function invalid(message: string, details?: Record<string, unknown>): never {
  throw apiError('VALIDATION_ERROR', message, 400, details ? { details } : {});
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Slow mode: one of Telegram's fixed intervals, 0 disables it. */
export function parseSlowMode(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    !(SLOW_MODE_SECONDS as readonly number[]).includes(value)
  ) {
    invalid('slowModeSeconds is not a supported slow-mode interval', {
      allowed: SLOW_MODE_SECONDS,
    });
  }
  return value;
}

export function parseChatTitle(value: unknown): string {
  if (typeof value !== 'string') invalid('title must be a string');
  const title = value.trim();
  if (!title) invalid('title must not be empty');
  if (title.length > MAX_TITLE_LENGTH) {
    invalid(`title must be at most ${MAX_TITLE_LENGTH} characters`);
  }
  return title;
}

export function parseChatDescription(value: unknown): string {
  if (typeof value !== 'string') invalid('about must be a string');
  const about = value.trim();
  if (about.length > MAX_DESCRIPTION_LENGTH) {
    invalid(`about must be at most ${MAX_DESCRIPTION_LENGTH} characters`);
  }
  return about;
}

/** Custom admin rank: `null`/empty clears it, Telegram caps it at 16 chars. */
export function parseRank(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') invalid('rank must be a string or null');
  const rank = value.trim();
  if (!rank) return null;
  if (rank.length > MAX_RANK_LENGTH) {
    invalid(`rank must be at most ${MAX_RANK_LENGTH} characters`);
  }
  return rank;
}

/**
 * Rights body → `chatAdminRights`. Unknown keys and `false` values are
 * dropped; when nothing is selected `other: true` keeps the user an admin
 * without granting additional powers (Telegram otherwise demotes them).
 */
export function toAdminRights(value: unknown): Omit<tl.RawChatAdminRights, '_'> {
  const input = isRecord(value) ? value : {};
  const rights: Omit<tl.RawChatAdminRights, '_'> = {};
  let any = false;
  for (const key of ADMIN_RIGHT_KEYS) {
    if (input[key] === true) {
      rights[key] = true;
      any = true;
    }
  }
  if (!any) rights.other = true;
  return rights;
}

export function parseMemberFilter(value: unknown): ChatMemberFilter {
  if (value === undefined || value === null || value === '') return 'all';
  if (
    typeof value === 'string' &&
    (MEMBER_FILTERS as string[]).includes(value)
  ) {
    return value as ChatMemberFilter;
  }
  invalid('type must be one of all, admins, banned, recent, bots', {
    allowed: MEMBER_FILTERS,
  });
}

export function parseMemberQuery(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') invalid('query must be a string');
  const query = value.trim();
  if (query.length > MAX_MEMBER_QUERY_LENGTH) {
    invalid(`query must be at most ${MAX_MEMBER_QUERY_LENGTH} characters`);
  }
  return query;
}

function parseNonNegativeInteger(
  value: unknown,
  field: string,
  fallback: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return invalid(`${field} must be a non-negative integer`);
}

/** Optional epoch timestamp in milliseconds (as sent by the dashboard). */
export function parseExpiresAt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid('timestamp must be a positive unix time in milliseconds');
  }
  return value;
}

export function parseInviteUsageLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > MAX_USAGE_LIMIT
  ) {
    invalid(`usageLimit must be an integer from 1 to ${MAX_USAGE_LIMIT}`);
  }
  return value;
}

export function parseInviteName(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid('name must be a string');
  const name = value.trim();
  if (!name) return undefined;
  if (name.length > MAX_INVITE_NAME_LENGTH) {
    invalid(`name must be at most ${MAX_INVITE_NAME_LENGTH} characters`);
  }
  return name;
}

/** Optional privacy flag shared by `createInviteLink`/`editInviteLink`. */
export function parseOptionalFlag(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`);
  return value;
}

export function parseInviteLink(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    invalid('link is required');
  }
  const link = value.trim();
  if (link.length > 512 || !/^https?:\/\//i.test(link)) {
    invalid('link must be a Telegram invite URL');
  }
  return link;
}

function parseUserId(value: unknown): number {
  const id = parseChatId(value, 'userId');
  if (id < 0) invalid('userId must be a positive integer');
  return id;
}

function isPrivatePeer(peer: Peer): boolean {
  const type: string = peer.type;
  return type === 'user' || type === 'bot';
}

/** Bounded dialog scan used when a peer is not in the local cache yet. */
const PEER_DIALOG_SCAN_LIMIT = 500;

async function resolvePeerForChat(
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
      for (const archived of ['exclude', 'only'] as const) {
        try {
          let scanned = 0;
          for await (const dialog of client.iterDialogs({
            limit: PEER_DIALOG_SCAN_LIMIT,
            archived,
          })) {
            if (dialog.peer.id === chatId) return dialog.peer;
            scanned += 1;
            if (scanned >= PEER_DIALOG_SCAN_LIMIT) break;
          }
        } catch {
          // Folders fail independently; try the next one.
        }
      }
    }
    raiseTelegramError(error);
  }
}

type FullChat = Awaited<ReturnType<TelegramClient['getFullChat']>>;

interface OpenChat {
  client: TelegramClient;
  chatId: number;
  full: FullChat;
}

/**
 * Group/channel administration on top of an attached session.
 *
 * Every public method resolves the account through `AccountsService`, rejects
 * private peers with 400 `NOT_A_GROUP` and requires `isAdmin || isCreator` on
 * the full chat (403 `CHAT_ADMIN_REQUIRED`). Returned DTOs never contain
 * mtcute objects.
 */
@Injectable()
export class ChatAdminService {
  constructor(private readonly accounts: AccountsService) {}

  private async openChat(
    userId: string,
    accountId: string,
    rawChatId: string,
    sessionIdParam: unknown,
  ): Promise<OpenChat> {
    const chatId = parseChatId(rawChatId);
    const sessionId = parseOptionalSessionId(sessionIdParam);
    const { client } = await this.accounts.resolveSession(
      userId,
      accountId,
      sessionId,
    );

    let peer: Peer;
    try {
      peer = await resolvePeerForChat(client, chatId);
    } catch (error) {
      raiseTelegramError(error);
    }
    if (isPrivatePeer(peer)) {
      assertGroupOrChannel(undefined);
    }

    let full: FullChat;
    try {
      full = await client.getFullChat(chatId);
    } catch (error) {
      raiseTelegramError(error);
    }
    assertGroupOrChannel(full.chatType);
    assertChatAdmin(full);
    return { client, chatId, full };
  }

  async listMembers(
    userId: string,
    accountId: string,
    rawChatId: string,
    query: {
      query?: unknown;
      type?: unknown;
      limit?: unknown;
      offset?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatMembersView> {
    // Validation runs before any network call, so a bad `type` is a 400 even
    // when the chat itself would be inaccessible.
    const search = parseMemberQuery(query.query);
    const filter = parseMemberFilter(query.type);
    const limit = Math.min(parseLimit(query.limit, MAX_MEMBERS), MAX_MEMBERS);
    const offset = parseNonNegativeInteger(query.offset, 'offset', 0);
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      query.sessionId,
    );

    try {
      const members = await client.getChatMembers(chatId, {
        query: search,
        type: filter,
        limit,
        offset,
      });
      return {
        items: members.map((member) => toChatMemberView(member)),
        total: typeof members.total === 'number' ? members.total : null,
      };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async banMember(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawUserId: string,
    body: { untilDate?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatMemberView> {
    const targetId = parseUserId(rawUserId);
    const untilDate = parseExpiresAt(body.untilDate);
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      body.sessionId,
    );

    try {
      await client.banChatMember({
        chatId,
        participantId: targetId,
        ...(untilDate !== undefined ? { untilDate } : {}),
      });
      return await this.reloadMember(client, chatId, targetId);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async unbanMember(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawUserId: string,
    sessionIdParam?: unknown,
  ): Promise<ChatMemberView> {
    const targetId = parseUserId(rawUserId);
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      sessionIdParam,
    );

    try {
      await client.unbanChatMember({ chatId, participantId: targetId });
      return await this.reloadMember(client, chatId, targetId);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async kickMember(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawUserId: string,
    sessionIdParam?: unknown,
  ): Promise<ChatMemberView> {
    const targetId = parseUserId(rawUserId);
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      sessionIdParam,
    );

    try {
      await client.kickChatMember({ chatId, userId: targetId });
      return await this.reloadMember(client, chatId, targetId);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async setMemberRank(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawUserId: string,
    body: { rank?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatMemberView> {
    const targetId = parseUserId(rawUserId);
    const rank = parseRank(body.rank);
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      body.sessionId,
    );

    try {
      await client.editChatMemberRank({
        chatId,
        participantId: targetId,
        rank,
      });
      return await this.reloadMember(client, chatId, targetId);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async promoteMember(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawUserId: string,
    body: { rank?: unknown; rights?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatMemberView> {
    const targetId = parseUserId(rawUserId);
    const rank = parseRank(body.rank);
    const rights = toAdminRights(body.rights);
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      body.sessionId,
    );

    try {
      await client.editAdminRights({
        chatId,
        userId: targetId,
        rights,
        ...(rank !== null ? { rank } : {}),
      });
      return await this.reloadMember(client, chatId, targetId);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /** Demotes an admin: `chatAdminRights` with every flag unset. */
  async demoteMember(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawUserId: string,
    sessionIdParam?: unknown,
  ): Promise<ChatMemberView> {
    const targetId = parseUserId(rawUserId);
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      sessionIdParam,
    );

    try {
      await client.editAdminRights({
        chatId,
        userId: targetId,
        rights: {},
      });
      return await this.reloadMember(client, chatId, targetId);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /**
   * Updates title/description/slow mode in one request. Fields that are not
   * present are left untouched; at least one is required.
   */
  async updateSettings(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: {
      title?: unknown;
      about?: unknown;
      slowModeSeconds?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatAdminSettingsView> {
    const hasTitle = body.title !== undefined && body.title !== null;
    const hasAbout = body.about !== undefined && body.about !== null;
    const hasSlowMode =
      body.slowModeSeconds !== undefined && body.slowModeSeconds !== null;
    if (!hasTitle && !hasAbout && !hasSlowMode) {
      invalid('At least one of title, about or slowModeSeconds is required');
    }
    const title = hasTitle ? parseChatTitle(body.title) : undefined;
    const about = hasAbout ? parseChatDescription(body.about) : undefined;
    const slowModeSeconds = hasSlowMode
      ? parseSlowMode(body.slowModeSeconds)
      : undefined;

    const { client, chatId, full } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      body.sessionId,
    );

    try {
      if (title !== undefined) await client.setChatTitle(chatId, title);
      if (about !== undefined) await client.setChatDescription(chatId, about);
      if (slowModeSeconds !== undefined) {
        await client.setSlowMode(chatId, slowModeSeconds);
      }
      return {
        title: title ?? full.displayName,
        about: about ?? full.bio,
        slowModeSeconds: slowModeSeconds ?? full.slowmodeSeconds ?? 0,
      };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async listInvites(
    userId: string,
    accountId: string,
    rawChatId: string,
    sessionIdParam?: unknown,
  ): Promise<ChatInviteLinksView> {
    const { client, chatId, full } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      sessionIdParam,
    );

    try {
      const links = await client.getInviteLinks(chatId, { limit: 100 });
      const items = links.map((link) => toChatInviteView(link));
      // The primary link is not part of `getExportedChatInvites`; channels
      // expose it separately. A failure only hides that one row.
      if (full.chatType === 'channel') {
        try {
          const primary = await client.getPrimaryInviteLink(chatId);
          if (!items.some((item) => item.link === primary.link)) {
            items.unshift(toChatInviteView(primary));
          }
        } catch {
          // Not enough rights or no primary link: keep the other rows.
        }
      }
      return { items };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async createInvite(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: {
      expiresAt?: unknown;
      usageLimit?: unknown;
      withApproval?: unknown;
      name?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatInviteView> {
    const expiresAt = parseExpiresAt(body.expiresAt);
    const usageLimit = parseInviteUsageLimit(body.usageLimit);
    const withApproval = parseOptionalFlag(body.withApproval, 'withApproval');
    const name = parseInviteName(body.name);
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      body.sessionId,
    );

    try {
      // mtcute 0.32's `createInviteLink` has no `title` parameter; a named
      // link uses the same TL call directly so the admin label is not lost.
      if (name !== undefined) {
        const peer = await client.resolvePeer(chatId);
        const raw = await client.call({
          _: 'messages.exportChatInvite',
          peer,
          expireDate: expiresAt ? Math.floor(expiresAt / 1000) : undefined,
          usageLimit,
          requestNeeded: withApproval,
          title: name,
        });
        if (raw._ !== 'chatInviteExported') {
          raiseTelegramError(
            new Error('Telegram did not return an exported invite link'),
          );
        }
        return {
          link: raw.link,
          creatorName: null,
          isPrimary: raw.permanent === true,
          isRevoked: raw.revoked === true,
          usage: raw.usage ?? 0,
          usageLimit: raw.usageLimit ?? null,
          approvalNeeded: raw.requestNeeded === true,
          pendingJoinRequests: raw.requested ?? 0,
          expiresAt: raw.expireDate
            ? new Date(raw.expireDate * 1000).toISOString()
            : null,
        };
      }

      const link = await client.createInviteLink(chatId, {
        ...(expiresAt !== undefined ? { expires: expiresAt } : {}),
        ...(usageLimit !== undefined ? { usageLimit } : {}),
        ...(withApproval !== undefined ? { withApproval } : {}),
      });
      return toChatInviteView(link);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /** Exports (and thereby rotates) the account's primary invite link. */
  async exportPrimaryInvite(
    userId: string,
    accountId: string,
    rawChatId: string,
  ): Promise<ChatInviteView> {
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      undefined,
    );

    try {
      const link = await client.exportInviteLink(chatId);
      return toChatInviteView(link);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async revokeInvite(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: { link?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatInviteView> {
    const link = parseInviteLink(body.link);
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      body.sessionId,
    );

    try {
      const result = await client.revokeInviteLink(chatId, link);
      return toChatInviteView(result);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async editInvite(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: {
      link?: unknown;
      expiresAt?: unknown;
      usageLimit?: unknown;
      withApproval?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatInviteView> {
    const link = parseInviteLink(body.link);
    const expiresAt = parseExpiresAt(body.expiresAt);
    const usageLimit = parseInviteUsageLimit(body.usageLimit);
    const withApproval = parseOptionalFlag(body.withApproval, 'withApproval');
    if (expiresAt === undefined && usageLimit === undefined && withApproval === undefined) {
      invalid('At least one of expiresAt, usageLimit or withApproval is required');
    }
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      body.sessionId,
    );

    try {
      const result = await client.editInviteLink({
        chatId,
        link,
        ...(expiresAt !== undefined ? { expires: expiresAt } : {}),
        ...(usageLimit !== undefined ? { usageLimit } : {}),
        ...(withApproval !== undefined ? { withApproval } : {}),
      });
      return toChatInviteView(result);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /**
   * Pending join requests. mtcute 0.32 has no high-level listing helper, so
   * this reads `messages.getChatInviteImporters` with `requested: true`.
   */
  async listJoinRequests(
    userId: string,
    accountId: string,
    rawChatId: string,
    sessionIdParam?: unknown,
  ): Promise<ChatJoinRequestsView> {
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      sessionIdParam,
    );

    try {
      const peer = await client.resolvePeer(chatId);
      const result = await client.call({
        _: 'messages.getChatInviteImporters',
        requested: true,
        peer,
        offsetDate: 0,
        offsetUser: { _: 'inputUserEmpty' },
        limit: 100,
      });

      const names = new Map<number, { name: string; username: string | null }>();
      for (const user of result.users) {
        if (user._ !== 'user') continue;
        names.set(user.id, {
          name: [user.firstName, user.lastName].filter(Boolean).join(' ') ||
            `Пользователь ${user.id}`,
          username: user.username ?? null,
        });
      }

      const items = result.importers
        .filter((importer) => importer.requested === true)
        .map((importer) => {
          const meta = names.get(importer.userId);
          return {
            userId: importer.userId,
            name: meta?.name ?? `Пользователь ${importer.userId}`,
            username: meta?.username ?? null,
            about: importer.about ?? null,
            date: new Date(importer.date * 1000).toISOString(),
          };
        });
      return { items };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async decideJoinRequests(
    userId: string,
    accountId: string,
    rawChatId: string,
    body: { userIds?: unknown; approve?: unknown; sessionId?: unknown } = {},
  ): Promise<JoinRequestsDecisionView> {
    if (!Array.isArray(body.userIds) || body.userIds.length === 0) {
      invalid('userIds must be a non-empty array');
    }
    if (body.userIds.length > 100) invalid('userIds must contain at most 100 ids');
    const userIds = body.userIds.map((value) => parseUserId(value));
    if (typeof body.approve !== 'boolean') invalid('approve must be a boolean');
    const approve = body.approve;
    const { client, chatId } = await this.openChat(
      userId,
      accountId,
      rawChatId,
      body.sessionId,
    );

    let approved = 0;
    let declined = 0;
    try {
      for (const target of userIds) {
        await client.hideJoinRequest({
          chatId,
          user: target,
          action: approve ? 'approve' : 'decline',
        });
        if (approve) approved += 1;
        else declined += 1;
      }
      return { approved, declined };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  /** Re-read one participant after a mutation; `null` if they are gone. */
  private async reloadMember(
    client: TelegramClient,
    chatId: number,
    userId: number,
  ): Promise<ChatMemberView> {
    try {
      const member = await client.getChatMember({ chatId, userId });
      if (member) return toChatMemberView(member);
    } catch {
      // Banned/kicked users may disappear from the participant list.
    }
    // Report the known id with an honest empty profile instead of failing
    // the mutation that already succeeded.
    return {
      id: userId,
      name: `Пользователь ${userId}`,
      username: null,
      status: 'left',
      rank: null,
      isAdmin: false,
      isCreator: false,
      joinedAt: null,
    };
  }
}
