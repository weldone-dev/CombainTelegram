export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogSource =
  | "app"
  | "http"
  | "auth"
  | "accounts"
  | "messaging"
  | "proxy"
  | "telegram"
  | "realtime"
  | "ai"
  | "mcp"
  | "bot"
  | "automation";

/** Everything a caller can attach to one log line. */
export interface LogInput {
  level: LogLevel;
  source: LogSource;
  action: string;
  message: string;
  status?: "ok" | "failed";
  requestId?: string;
  userId?: string;
  accountId?: string;
  sessionId?: string;
  chatId?: number;
  attemptId?: string;
  durationMs?: number;
  errorCode?: string;
  telegramMethod?: string;
  telegramError?: string;
  telegramResponse?: unknown;
  /** Proxy in effect; a snapshot is resolved when the entry is persisted. */
  proxyId?: string | null;
  proxyLabel?: string | null;
  proxySnapshot?: unknown;
  details?: unknown;
  createdAt?: Date;
}

type LogSink = (entry: LogInput) => void;

let sink: LogSink | null = null;

/**
 * Wires the persistence layer. Kept as a module-level sink so pure helpers
 * such as `raiseTelegramError` (no DI) can log without importing Nest.
 */
export function setLogSink(next: LogSink | null): void {
  sink = next;
}

/** Fire-and-forget. Logging must never break the code path it observes. */
export function emitLog(entry: LogInput): void {
  if (!sink) return;
  try {
    sink(entry);
  } catch {
    // Swallowed on purpose.
  }
}
