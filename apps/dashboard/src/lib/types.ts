/** Transport that actually talks to Telegram for a session. */
export type SessionEngine = "mtcute" | "tdlib";

export interface SessionView {
  id: string;
  deviceId: string;
  label: string | null;
  platform: string;
  profile: string;
  /** `mtcute` string session or a native `tdlib` database. */
  engine: SessionEngine;
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
  /** Live session that chat, history and realtime currently use. */
  activeSessionId: string | null;
  sessions: SessionView[];
}

/** `PATCH /accounts/:accountId/sessions/:sessionId`. */
export interface SessionPatch {
  proxyId?: string | null;
  label?: string | null;
}

/** `DELETE /accounts/:accountId/sessions/:sessionId`. */
export interface SessionRemovalView {
  removed: boolean;
  revoked: boolean;
  accountRemoved: boolean;
}

export interface MessageMediaView {
  kind: "photo" | "document" | "voice" | "other";
  mimeType: string | null;
  fileName: string | null;
  size: number | null;
  downloadable: boolean;
}

export interface MessageReactionView {
  emoji: string;
  count: number;
  chosen: boolean;
}

export interface MessagePollAnswerView {
  index: number;
  text: string;
  voters: number;
  chosen: boolean;
  correct: boolean;
}

export interface MessagePollView {
  id: string;
  question: string;
  closed: boolean;
  quiz: boolean;
  multiple: boolean;
  voters: number;
  hideResultsUntilClose: boolean;
  answers: MessagePollAnswerView[];
  solution: string | null;
}

export interface MessageTranslationView {
  text: string;
  to: string;
}

export interface MessageTranscriptionView {
  text: string;
  pending: boolean;
}

export interface MessageThreadInfo {
  comments: number;
  hasComments: boolean;
  discussionChatId: number | null;
}

/** `GET .../messages/:messageId/thread` — comments newest first. */
export interface MessageThreadView {
  chatId: number;
  messageId: number;
  discussionChatId: number | null;
  comments: MessageView[];
  nextOffsetId: number | null;
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
  media?: MessageMediaView | null;
  reactions?: MessageReactionView[] | null;
  poll?: MessagePollView | null;
  isVoice?: boolean;
  /** Telegram service message; the transcript hides these empty bubbles. */
  service?: boolean;
  thread?: MessageThreadInfo | null;
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
  /** False for channels/groups the account may only read. */
  canSendMessages: boolean;
}

/** `GET /accounts/:accountId/chats/:chatId/info`. */
export interface ChatInfoView {
  id: number;
  type: string;
  title: string;
  username: string | null;
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

export type ChatInfoMediaKind = "media" | "links" | "polls";

export interface ChatInfoPollView {
  question: string;
  options: string[];
  totalVoters: number;
}

export interface ChatInfoMediaItemView {
  messageId: number;
  date: string;
  text: string;
  media: MessageMediaView | null;
  url: string | null;
  poll: ChatInfoPollView | null;
}

/** `GET /accounts/:accountId/chats/:chatId/info/media`. */
export interface ChatInfoMediaView {
  items: ChatInfoMediaItemView[];
  nextOffsetId: number | null;
}

export interface ChatInfoSimilarChatView {
  id: number;
  title: string;
  username: string | null;
  memberCount: number | null;
}

/** `GET /accounts/:accountId/chats/:chatId/info/similar`. */
export interface ChatInfoSimilarView {
  chats: ChatInfoSimilarChatView[];
}

export interface MessageHistoryView {
  messages: MessageView[];
  nextOffsetId: number | null;
}

export interface FolderView {
  id: number;
  title: string;
  emoticon: string | null;
}

export interface FoldersView {
  folders: FolderView[];
}

export interface SearchUserView {
  id: number;
  title: string;
  username: string | null;
}

export interface GlobalSearchView {
  chats: ChatView[];
  users: SearchUserView[];
}

export interface ChatSearchView {
  messages: MessageView[];
  nextOffsetId: number | null;
}

export interface ChatRemovedView {
  removed: boolean;
  /** Message count from `clearHistory` when the backend reports it. */
  cleared?: number | null;
}

export interface ReadAllView {
  read: number;
}

/** Body of `PATCH /accounts/:accountId/chats/:chatId`. */
export interface ChatPatch {
  pinned?: boolean;
  muted?: boolean;
  archived?: boolean;
  unread?: boolean;
  sessionId?: string;
}

/** Which slice of the dialog list the chat list is showing. */
export type ChatFolderSelection =
  | { kind: "all" }
  | { kind: "archive" }
  | { kind: "folder"; id: number };

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

/** Lifecycle of a TDLib auth or migration attempt. */
export type AttemptStatus =
  | "starting"
  | "qr_pending"
  | "awaiting_code"
  | "awaiting_password"
  | "ready"
  | "failed"
  | "expired";

/** `POST /tdlib/auth/start` and `POST /accounts/:accountId/tdlib/migrate`. */
export interface AttemptView {
  attemptId: string;
  status: AttemptStatus;
  /** `tg://login?token=...`, present while a QR code is pending. */
  qrLink?: string;
  error?: string;
  needsPassword?: boolean;
  account?: AccountView;
}

export type TdlibAuthMethod = "qr" | "phone";

/** `GET /accounts/:accountId/cloud-password`. */
export interface CloudPasswordView {
  stored: boolean;
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

/** Admin rights exposed by the chat administration panel. */
export interface ChatAdminRights {
  changeInfo?: boolean;
  deleteMessages?: boolean;
  banUsers?: boolean;
  inviteUsers?: boolean;
  pinMessages?: boolean;
  manageCall?: boolean;
  postMessages?: boolean;
  editMessages?: boolean;
  addAdmins?: boolean;
  anonymous?: boolean;
  manageTopics?: boolean;
}

export type ChatAdminRightKey = keyof ChatAdminRights;

export type ChatAdminMemberFilter =
  | "all"
  | "admins"
  | "banned"
  | "recent"
  | "bots";

/** `GET /accounts/:accountId/chats/:chatId/admin/members`. */
export interface ChatAdminMemberView {
  id: number;
  name: string;
  username: string | null;
  status: string;
  rank: string | null;
  isAdmin: boolean;
  isCreator: boolean;
  joinedAt: string | null;
}

export interface ChatAdminMembersView {
  items: ChatAdminMemberView[];
  total: number | null;
}

/** `PATCH /accounts/:accountId/chats/:chatId/admin`. */
export interface ChatAdminSettingsView {
  title: string;
  about: string;
  slowModeSeconds: number;
}

export interface ChatAdminSettingsPatch {
  title?: string;
  about?: string;
  slowModeSeconds?: number;
}

/** `GET /accounts/:accountId/chats/:chatId/admin/invites`. */
export interface ChatAdminInviteView {
  link: string;
  creatorName: string | null;
  isPrimary: boolean;
  isRevoked: boolean;
  usage: number;
  /** `null` means no usage limit. */
  usageLimit: number | null;
  approvalNeeded: boolean;
  pendingJoinRequests: number;
  expiresAt: string | null;
}

export interface ChatAdminInvitesView {
  items: ChatAdminInviteView[];
}

export interface ChatAdminInviteCreate {
  expiresAt?: number;
  usageLimit?: number;
  withApproval?: boolean;
  name?: string;
}

/** `GET /accounts/:accountId/chats/:chatId/admin/join-requests`. */
export interface ChatAdminJoinRequestView {
  userId: number;
  name: string;
  username: string | null;
  about: string | null;
  date: string;
}

export interface ChatAdminJoinRequestsView {
  items: ChatAdminJoinRequestView[];
}
