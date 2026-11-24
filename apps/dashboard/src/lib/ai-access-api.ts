import { apiFetch } from "./api";

/** Stored `AiChatAccess` row: the AI may work in a chat or a forum topic. */
export interface AiAccessRow {
  id: string;
  accountId: string;
  chatId: number;
  threadId: number;
  soulId: string | null;
  enabled: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Stored `AiChatBlock` row; warnings-only rows are not returned by the list. */
export interface AiBlockRow {
  id: string;
  accountId: string;
  chatId: number;
  threadId: number;
  reason: string | null;
  warnings: number;
  blockedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiAccessList {
  accesses: AiAccessRow[];
  blocks: AiBlockRow[];
}

/** Derived per-chat/topic decision, the shape every mutation returns. */
export interface AiAccessView {
  allowed: boolean;
  blocked: boolean;
  reason: string | null;
  warnings: number;
  soulId: string | null;
  note: string | null;
  threadId: number;
}

export interface AiWarningResult {
  warnings: number;
  blocked: boolean;
}

export interface AiUnblockResult extends AiWarningResult {
  removed: boolean;
}

export interface AiAccessPatch {
  enabled?: boolean;
  soulId?: string | null;
  note?: string | null;
  threadId?: number;
}

function accountPath(accountId: string): string {
  return `/accounts/${encodeURIComponent(accountId)}`;
}

function threadQuery(threadId: number): string {
  return threadId > 0 ? `?threadId=${threadId}` : "";
}

/** One call decorates the whole chat list of an account. */
export function listAiAccess(accountId: string): Promise<AiAccessList> {
  return apiFetch(`${accountPath(accountId)}/ai-access`);
}

export function getAiAccess(
  accountId: string,
  chatId: number,
  threadId = 0,
): Promise<AiAccessView> {
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/ai-access${threadQuery(threadId)}`,
  );
}

export function setAiAccess(
  accountId: string,
  chatId: number,
  patch: AiAccessPatch,
): Promise<AiAccessView> {
  return apiFetch(`${accountPath(accountId)}/chats/${chatId}/ai-access`, {
    method: "PUT",
    body: patch,
  });
}

export function removeAiAccess(
  accountId: string,
  chatId: number,
  threadId = 0,
): Promise<{ removed: boolean }> {
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/ai-access${threadQuery(threadId)}`,
    { method: "DELETE" },
  );
}

export function blockAi(
  accountId: string,
  chatId: number,
  options: { reason?: string | null; threadId?: number } = {},
): Promise<AiAccessView> {
  return apiFetch(`${accountPath(accountId)}/chats/${chatId}/ai-block`, {
    method: "POST",
    body: options,
  });
}

export function unblockAi(
  accountId: string,
  chatId: number,
  threadId = 0,
): Promise<AiUnblockResult> {
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/ai-block${threadQuery(threadId)}`,
    { method: "DELETE" },
  );
}

export function warnAi(
  accountId: string,
  chatId: number,
  options: { reason?: string | null; threadId?: number } = {},
): Promise<AiWarningResult> {
  return apiFetch(`${accountPath(accountId)}/chats/${chatId}/ai-warning`, {
    method: "POST",
    body: options,
  });
}
