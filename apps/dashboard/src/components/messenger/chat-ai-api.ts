import type { AiCapabilities, AiCapability, SkillView } from "../../lib/ai-api";
import { apiFetch } from "../../lib/api";
import type { LogLevel, LogsPageView } from "../../lib/types";

/** Mirrors `AiChatEventView` of the API audit trail. */
export type AiChatEventKind =
  | "warning"
  | "block"
  | "unblock"
  | "clear"
  | "access";

/** Who caused the event: the local user or the soul itself. */
export type AiChatEventActor = "user" | "soul" | "system";

export interface AiChatEventView {
  id: string;
  accountId: string;
  chatId: number;
  threadId: number;
  kind: AiChatEventKind;
  reason: string | null;
  /** Resulting warning counter at the time of the event. */
  warnings: number;
  actor: AiChatEventActor;
  createdAt: string;
}

export interface AiWarningsCleared {
  removed: boolean;
  warnings: number;
  blocked: boolean;
}

export interface ChatMemoryTurnView {
  role: string;
  content: string;
  createdAt: string;
}

export interface ChatMemoryFactView {
  kind: string;
  content: string;
  importance: number;
  createdAt: string;
}

export interface ChatMemoryView {
  accountId: string;
  chatId: number;
  shortTerm: ChatMemoryTurnView[];
  longTerm: {
    summary: string;
    facts: ChatMemoryFactView[];
  };
}

export interface ChatSkillsView {
  effective: string[];
  source: "chat" | "soul";
  defaults: string[];
  skills: SkillView[];
}

export interface AccountAiSettingsView {
  accountId: string;
  /** Stored deltas only: absent key = inherits the global policy. */
  permissions: Partial<Record<AiCapability, boolean>>;
  effective: AiCapabilities;
  defaults: AiCapabilities;
}

const EVENT_LIMIT = 50;
const MEMORY_LIMIT = 50;
const LOG_LIMIT = 50;

function accountPath(accountId: string): string {
  return `/accounts/${encodeURIComponent(accountId)}`;
}

function threadQuery(threadId: number): string {
  return threadId > 0 ? `?threadId=${threadId}` : "";
}

/** Newest-first warning/block/access history of one chat or topic. */
export function getAiChatEvents(
  accountId: string,
  chatId: number,
  threadId = 0,
  limit = EVENT_LIMIT,
): Promise<AiChatEventView[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (threadId > 0) params.set("threadId", String(threadId));
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/ai-events?${params.toString()}`,
  );
}

/** Zeroes the warning counter; an existing block stays in place. */
export function clearAiChatWarnings(
  accountId: string,
  chatId: number,
  threadId = 0,
): Promise<AiWarningsCleared> {
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/ai-warnings${threadQuery(threadId)}`,
    { method: "DELETE" },
  );
}

/** Recent turns plus the long-term summary/facts of one chat. */
export function getChatMemory(
  accountId: string,
  chatId: number,
  limit = MEMORY_LIMIT,
): Promise<ChatMemoryView> {
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/memory?limit=${limit}`,
  );
}

/** Drops turns, summary and facts of one chat; the Telegram history stays. */
export function clearChatMemory(
  accountId: string,
  chatId: number,
): Promise<{ cleared: true; chatId: number }> {
  return apiFetch(`${accountPath(accountId)}/chats/${chatId}/memory`, {
    method: "DELETE",
  });
}

/**
 * Queues a synthetic incoming message; the workflow answers with a real
 * Telegram message. The synthetic bubble is local and vanishes on refetch.
 */
export function simulateIncoming(
  accountId: string,
  chatId: number,
  text?: string,
): Promise<{ queued: true; messageId: number }> {
  return apiFetch("/ai/simulate-incoming", {
    method: "POST",
    body: { accountId, chatId, text },
  });
}

/** Effective skills, their source, the soul set and the matching catalog rows. */
export function getChatSkills(
  accountId: string,
  chatId: number,
  threadId = 0,
): Promise<ChatSkillsView> {
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/ai-skills${threadQuery(threadId)}`,
  );
}

/** Replaces the chat/topic override with exactly `skillSlugs`. */
export function setChatSkills(
  accountId: string,
  chatId: number,
  skillSlugs: string[],
  threadId = 0,
): Promise<ChatSkillsView> {
  return apiFetch(`${accountPath(accountId)}/chats/${chatId}/ai-skills`, {
    method: "PUT",
    body: { skillSlugs, threadId },
  });
}

/** Drops the override so the soul's skill set applies again. */
export function removeChatSkills(
  accountId: string,
  chatId: number,
  threadId = 0,
): Promise<{ removed: boolean }> {
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/ai-skills${threadQuery(threadId)}`,
    { method: "DELETE" },
  );
}

/** Per-account permission deltas against the global policy. */
export function getAccountAiSettings(
  accountId: string,
): Promise<AccountAiSettingsView> {
  return apiFetch(`${accountPath(accountId)}/ai-settings`);
}

export interface ChatAiSettingsView {
  /** Stored overrides only; `{}` = the chat inherits everything. */
  settings: Record<string, unknown>;
}

/** Raw per-chat/topic AI overrides (`typingMode`, `maxParts`, ...). */
export function getChatAiSettings(
  accountId: string,
  chatId: number,
  threadId = 0,
): Promise<ChatAiSettingsView> {
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/ai-chat-settings${threadQuery(threadId)}`,
  );
}

/** Replaces the whole override object of one chat/topic. */
export function setChatAiSettings(
  accountId: string,
  chatId: number,
  settings: Record<string, unknown>,
  threadId = 0,
): Promise<ChatAiSettingsView> {
  return apiFetch(
    `${accountPath(accountId)}/chats/${chatId}/ai-chat-settings`,
    { method: "PATCH", body: { settings, threadId } },
  );
}

/** Structured log entries scoped to one account and chat. */
export function getChatLogs(
  accountId: string,
  chatId: number,
  options: { level?: "" | LogLevel; limit?: number } = {},
): Promise<LogsPageView> {
  const params = new URLSearchParams({
    accountId,
    chatId: String(chatId),
    limit: String(options.limit ?? LOG_LIMIT),
  });
  if (options.level) params.set("level", options.level);
  return apiFetch(`/logs?${params.toString()}`);
}
