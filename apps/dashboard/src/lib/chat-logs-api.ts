import { apiFetch } from "./api";
import type { LogLevel, LogsPageView } from "./types";

const LOG_LIMIT = 50;

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
