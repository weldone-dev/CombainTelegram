import { apiFetch } from "./api";
import type {
  ChatFolderSelection,
  ChatPatch,
  ChatRemovedView,
  ChatSearchView,
  ChatView,
  FoldersView,
  FolderView,
  GlobalSearchView,
  MessagePollView,
  MessageTranscriptionView,
  MessageTranslationView,
  MessageView,
  ReadAllView,
} from "./types";

/** Page sizes offered by the "Показать ещё" button. */
export const CHAT_PAGE_SIZES = [50, 100, 200] as const;
export const MAX_CHAT_LIMIT = 200;
export const INITIAL_CHAT_LIMIT = 50;

/** Upload limit enforced by the API (`PAYLOAD_TOO_LARGE` beyond this size). */
export const MAX_MEDIA_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Next page size above `limit`, or null when the maximum is reached. */
export function nextChatLimit(limit: number): number | null {
  return CHAT_PAGE_SIZES.find((size) => size > limit) ?? null;
}

export interface ChatListOptions {
  limit?: number;
  folder?: ChatFolderSelection;
  archived?: boolean;
}

export function listChats(
  accountId: string,
  options: ChatListOptions = {},
): Promise<ChatView[]> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? INITIAL_CHAT_LIMIT),
  });
  if (options.folder?.kind === "folder") {
    params.set("folderId", String(options.folder.id));
  } else if (options.folder?.kind === "archive" || options.archived) {
    params.set("archived", "true");
  } else if (options.archived === false) {
    params.set("archived", "false");
  }
  return apiFetch<ChatView[]>(
    `/accounts/${accountId}/chats?${params.toString()}`,
    {},
  );
}

export async function listFolders(accountId: string): Promise<FolderView[]> {
  const result = await apiFetch<FoldersView>(
    `/accounts/${accountId}/folders`,
    {},
  );
  return result.folders;
}

export function updateChat(
  accountId: string,
  chatId: number,
  patch: ChatPatch,
): Promise<ChatView> {
  return apiFetch<ChatView>(`/accounts/${accountId}/chats/${chatId}`, {
    method: "PATCH",
    body: patch,
  });
}

/** `clearHistory` wipes messages and keeps the dialog; otherwise the chat is left. */
export function removeChat(
  accountId: string,
  chatId: number,
  options: { clearHistory?: boolean; revoke?: boolean } = {},
): Promise<ChatRemovedView> {
  const params = new URLSearchParams();
  if (options.clearHistory) params.set("clearHistory", "true");
  if (options.revoke !== undefined)
    params.set("revoke", String(options.revoke));
  const query = params.toString();
  return apiFetch<ChatRemovedView>(
    `/accounts/${accountId}/chats/${chatId}${query ? `?${query}` : ""}`,
    { method: "DELETE" },
  );
}

export function markAllRead(accountId: string): Promise<ReadAllView> {
  return apiFetch<ReadAllView>(`/accounts/${accountId}/chats/read-all`, {
    method: "POST",
    body: {},
  });
}

export function resolveChat(
  accountId: string,
  username: string,
): Promise<ChatView> {
  const params = new URLSearchParams({ username });
  return apiFetch<ChatView>(
    `/accounts/${accountId}/chats/resolve?${params.toString()}`,
    {},
  );
}

export function searchGlobal(
  accountId: string,
  query: string,
  limit = 20,
): Promise<GlobalSearchView> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  return apiFetch<GlobalSearchView>(
    `/accounts/${accountId}/search?${params.toString()}`,
    {},
  );
}

export function searchChatMessages(
  accountId: string,
  chatId: number,
  query: string,
  limit = 30,
  offsetId?: number,
): Promise<ChatSearchView> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  if (offsetId !== undefined) params.set("offsetId", String(offsetId));
  return apiFetch<ChatSearchView>(
    `/accounts/${accountId}/chats/${chatId}/search?${params.toString()}`,
    {},
  );
}

/** Send or remove (`null`) the current account's reaction on a message. */
export async function sendMessageReaction(
  accountId: string,
  chatId: number,
  messageId: number,
  emoji: string | null,
): Promise<MessageView | null> {
  const message = await apiFetch<MessageView | undefined>(
    `/accounts/${accountId}/chats/${chatId}/messages/${messageId}/reaction`,
    { method: "POST", body: { emoji } },
  );
  return message ?? null;
}

/** Vote in a poll (`[index]`), or retract with `null`. */
export function sendPollVote(
  accountId: string,
  chatId: number,
  messageId: number,
  options: number[] | null,
): Promise<MessagePollView> {
  return apiFetch<MessagePollView>(
    `/accounts/${accountId}/chats/${chatId}/messages/${messageId}/vote`,
    { method: "POST", body: { options } },
  );
}

/** Translate the message text (captions included) into a two-letter code. */
export function translateMessage(
  accountId: string,
  chatId: number,
  messageId: number,
  to: string,
): Promise<MessageTranslationView> {
  return apiFetch<MessageTranslationView>(
    `/accounts/${accountId}/chats/${chatId}/messages/${messageId}/translate`,
    { method: "POST", body: { to } },
  );
}

/** Transcribe a voice note; `pending` means Telegram is still working. */
export function transcribeMessage(
  accountId: string,
  chatId: number,
  messageId: number,
): Promise<MessageTranscriptionView> {
  return apiFetch<MessageTranscriptionView>(
    `/accounts/${accountId}/chats/${chatId}/messages/${messageId}/transcribe`,
    { method: "POST", body: {} },
  );
}

/**
 * Delete one message. `revoke` defaults to `false`: the message disappears
 * only for this account. `revoke: true` deletes it for everyone.
 */
export function deleteMessage(
  accountId: string,
  chatId: number,
  messageId: number,
  options: { revoke?: boolean } = {},
): Promise<{ deleted: boolean; messageId: number }> {
  const params = new URLSearchParams();
  if (options.revoke) params.set("revoke", "true");
  const query = params.toString();
  return apiFetch<{ deleted: boolean; messageId: number }>(
    `/accounts/${accountId}/chats/${chatId}/messages/${messageId}${query ? `?${query}` : ""}`,
    { method: "DELETE" },
  );
}
