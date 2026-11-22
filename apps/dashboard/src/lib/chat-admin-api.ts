import { apiFetch } from "./api";
import type {
  ChatAdminInviteCreate,
  ChatAdminInvitesView,
  ChatAdminInviteView,
  ChatAdminJoinRequestsView,
  ChatAdminMemberFilter,
  ChatAdminMembersView,
  ChatAdminMemberView,
  ChatAdminRights,
  ChatAdminSettingsPatch,
  ChatAdminSettingsView,
} from "./types";

/** Shared prefix of the chat administration endpoints. */
function adminPath(accountId: string, chatId: number): string {
  return `/accounts/${encodeURIComponent(accountId)}/chats/${chatId}/admin`;
}

function withQuery(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function sessionParams(sessionId?: string | null): URLSearchParams {
  const params = new URLSearchParams();
  if (sessionId) params.set("sessionId", sessionId);
  return params;
}

export interface ChatAdminMembersOptions {
  query?: string;
  type?: ChatAdminMemberFilter;
  limit?: number;
  offset?: number;
  sessionId?: string | null;
}

/** One page of chat members; `offset` is a sequential index, not a user id. */
export function getChatAdminMembers(
  accountId: string,
  chatId: number,
  options: ChatAdminMembersOptions = {},
): Promise<ChatAdminMembersView> {
  const params = new URLSearchParams();
  params.set("type", options.type ?? "all");
  params.set("limit", String(options.limit ?? 50));
  params.set("offset", String(options.offset ?? 0));
  if (options.query) params.set("query", options.query);
  if (options.sessionId) params.set("sessionId", options.sessionId);
  return apiFetch<ChatAdminMembersView>(
    withQuery(`${adminPath(accountId, chatId)}/members`, params),
    { method: "GET" },
  );
}

export function banChatAdminMember(
  accountId: string,
  chatId: number,
  userId: number,
  untilDate?: number | null,
): Promise<ChatAdminMemberView> {
  return apiFetch<ChatAdminMemberView>(
    `${adminPath(accountId, chatId)}/members/${userId}/ban`,
    {
      method: "POST",
      body: untilDate ? { untilDate } : {},
    },
  );
}

export function unbanChatAdminMember(
  accountId: string,
  chatId: number,
  userId: number,
): Promise<ChatAdminMemberView> {
  return apiFetch<ChatAdminMemberView>(
    `${adminPath(accountId, chatId)}/members/${userId}/unban`,
    { method: "POST", body: {} },
  );
}

export function kickChatAdminMember(
  accountId: string,
  chatId: number,
  userId: number,
): Promise<ChatAdminMemberView> {
  return apiFetch<ChatAdminMemberView>(
    `${adminPath(accountId, chatId)}/members/${userId}/kick`,
    { method: "POST", body: {} },
  );
}

export function setChatAdminMemberRank(
  accountId: string,
  chatId: number,
  userId: number,
  rank: string | null,
): Promise<ChatAdminMemberView> {
  return apiFetch<ChatAdminMemberView>(
    `${adminPath(accountId, chatId)}/members/${userId}/rank`,
    { method: "POST", body: { rank } },
  );
}

export function promoteChatAdminMember(
  accountId: string,
  chatId: number,
  userId: number,
  input: { rank?: string | null; rights: ChatAdminRights },
): Promise<ChatAdminMemberView> {
  return apiFetch<ChatAdminMemberView>(
    `${adminPath(accountId, chatId)}/members/${userId}/admin`,
    {
      method: "POST",
      body: { rank: input.rank ?? null, rights: input.rights },
    },
  );
}

export function demoteChatAdminMember(
  accountId: string,
  chatId: number,
  userId: number,
): Promise<ChatAdminMemberView> {
  return apiFetch<ChatAdminMemberView>(
    `${adminPath(accountId, chatId)}/members/${userId}/admin`,
    { method: "DELETE" },
  );
}

export function updateChatAdminSettings(
  accountId: string,
  chatId: number,
  patch: ChatAdminSettingsPatch,
): Promise<ChatAdminSettingsView> {
  return apiFetch<ChatAdminSettingsView>(adminPath(accountId, chatId), {
    method: "PATCH",
    body: patch,
  });
}

export function getChatAdminInvites(
  accountId: string,
  chatId: number,
): Promise<ChatAdminInvitesView> {
  return apiFetch<ChatAdminInvitesView>(
    `${adminPath(accountId, chatId)}/invites`,
    { method: "GET" },
  );
}

export function createChatAdminInvite(
  accountId: string,
  chatId: number,
  input: ChatAdminInviteCreate = {},
): Promise<ChatAdminInviteView> {
  return apiFetch<ChatAdminInviteView>(
    `${adminPath(accountId, chatId)}/invites`,
    { method: "POST", body: input },
  );
}

/** Exports the primary link; the previous primary link stops working. */
export function exportChatAdminPrimaryInvite(
  accountId: string,
  chatId: number,
): Promise<ChatAdminInviteView> {
  return apiFetch<ChatAdminInviteView>(
    `${adminPath(accountId, chatId)}/invites/primary`,
    { method: "POST", body: {} },
  );
}

export function revokeChatAdminInvite(
  accountId: string,
  chatId: number,
  link: string,
): Promise<ChatAdminInviteView> {
  return apiFetch<ChatAdminInviteView>(
    `${adminPath(accountId, chatId)}/invites/revoke`,
    { method: "POST", body: { link } },
  );
}

export function editChatAdminInvite(
  accountId: string,
  chatId: number,
  link: string,
  patch: { expiresAt?: number; usageLimit?: number; withApproval?: boolean },
): Promise<ChatAdminInviteView> {
  return apiFetch<ChatAdminInviteView>(
    `${adminPath(accountId, chatId)}/invites/edit`,
    { method: "POST", body: { link, ...patch } },
  );
}

export function getChatAdminJoinRequests(
  accountId: string,
  chatId: number,
  sessionId?: string | null,
): Promise<ChatAdminJoinRequestsView> {
  return apiFetch<ChatAdminJoinRequestsView>(
    withQuery(
      `${adminPath(accountId, chatId)}/join-requests`,
      sessionParams(sessionId),
    ),
    { method: "GET" },
  );
}

export function decideChatAdminJoinRequests(
  accountId: string,
  chatId: number,
  userIds: number[],
  approve: boolean,
): Promise<{ approved: number; declined: number }> {
  return apiFetch<{ approved: number; declined: number }>(
    `${adminPath(accountId, chatId)}/join-requests`,
    { method: "POST", body: { userIds, approve } },
  );
}
