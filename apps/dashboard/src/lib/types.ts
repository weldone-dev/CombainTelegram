export interface SessionView {
  id: string;
  deviceId: string;
  label: string | null;
  platform: string;
  profile: string;
  proxyId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ProxyView {
  id: string;
  name: string;
  kind: string;
  host: string;
  port: number;
  username: string | null;
  hasSecret: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyTestResult {
  ok: boolean;
  latencyMs: number;
}

export interface AccountView {
  id: string;
  tgUserId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  phoneMasked: string | null;
  isActive: boolean;
  createdAt: string;
  lastUsedAt: string | null;
  deviceProfile: Record<string, unknown> | null;
  sessions: SessionView[];
}

export interface MessageView {
  id: number;
  chatId: number;
  text: string;
  date: string;
  outgoing: boolean;
  edited: boolean;
  senderId: number;
  senderName: string;
  replyToId: number | null;
  mediaType: string | null;
}

export interface ChatView {
  id: number;
  type: string;
  title: string;
  username: string | null;
  lastMessage: MessageView | null;
  unreadCount: number;
  pinned: boolean;
  muted: boolean;
  archived: boolean;
  /** Highest incoming message id already read by this account. */
  readInboxMaxId: number;
}

export interface MessageHistoryView {
  messages: MessageView[];
  nextOffsetId: number | null;
}

export interface ForwardResult {
  forwarded: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  retryAfter?: number;
  details?: Record<string, unknown>;
}

export interface PhoneStartView {
  attemptId: string;
  codeType: string;
  timeout: number;
  nextType?: string;
}

export type PhoneVerifyView =
  | { status: "ok"; account: AccountView }
  | { status: "password_required" }
  | { status: "signup_required" };

export interface PhoneCompletedView {
  status: "ok";
  account: AccountView;
}

export interface QrStartView {
  attemptId: string;
  url: string;
  expiresAt: string;
}

export interface QrStatusView {
  status: string;
  url?: string;
  expiresAt?: string;
  error?: string;
  account?: AccountView;
}

export interface TdataAccountEntry {
  index: number;
  userId: string;
}

export interface TdataUploadView {
  uploadId: string;
  accounts: TdataAccountEntry[];
}

export interface TdataImportAccountView {
  account: AccountView;
  mode: "new_session" | "reuse";
  warning?: { code: string; message: string };
}

export interface TdataImportView {
  accounts: TdataImportAccountView[];
}

export interface RealtimeMessageEvent {
  accountId: string;
  sessionId: string;
  chatId: number;
  message: MessageView;
}

export interface RealtimeDeletedEvent {
  accountId: string;
  sessionId: string;
  chatId: number | null;
  messageIds: number[];
}

export interface RealtimeReadEvent {
  accountId: string;
  chatId: number;
  maxId: number;
  outbox: boolean;
  unread: number;
}

export interface RealtimeTypingEvent {
  accountId: string;
  chatId: number;
  userId: number;
  status: string;
  chatType: string;
}

export interface RealtimeAuthDoneEvent {
  attemptId: string;
  account: AccountView;
}

export interface RealtimeAuthFailedEvent {
  attemptId: string;
  error: string;
}

export interface RealtimeQrUpdatedEvent {
  attemptId: string;
  url: string;
  expiresAt: string;
}

export interface TypingEntry {
  userId: number;
  status: string;
  until: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogSource =
  | "app"
  | "http"
  | "auth"
  | "accounts"
  | "messaging"
  | "proxy"
  | "telegram"
  | "realtime";

export interface LogEntryView {
  id: string;
  level: LogLevel;
  source: LogSource;
  action: string;
  message: string;
  status: "ok" | "failed" | null;
  requestId: string | null;
  userId: string | null;
  accountId: string | null;
  sessionId: string | null;
  chatId: number | null;
  attemptId: string | null;
  durationMs: number | null;
  errorCode: string | null;
  telegramMethod: string | null;
  telegramError: string | null;
  telegramResponse: unknown;
  proxyId: string | null;
  proxyLabel: string | null;
  proxySnapshot: unknown;
  details: unknown;
  createdAt: string;
}

export interface LogsPageView {
  entries: LogEntryView[];
  nextBefore: string | null;
  nextOffset: number | null;
}

export interface LogsStatsView {
  total: number;
  byLevel: Record<string, number>;
  bySource: Record<string, number>;
  byProxy: Record<string, number>;
  oldest: string | null;
  newest: string | null;
}
