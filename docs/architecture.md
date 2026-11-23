# Architecture

Status: **design fixed 2026-11-16**. Phase 1 and Phase 2 backends are
implemented in `apps/api` (accounts, sessions, crypto, phone/QR/tdata login,
chats/messages REST, Socket.IO fan-out, Swagger, `.tar.gz` tdata). The app runs
in **single-user mode**: there is no local registration or login — every request
runs as `DEFAULT_USER_ID` (default `local`). The database is still SQLite (the
Postgres move is deferred); Redis is not implemented yet — WS fan-out is
in-process, so it assumes a single API node.

## 1. Product requirements (hard)

1. **Multi-account is a first-class feature, not an add-on.**
   - One local user can attach an arbitrary number of Telegram accounts. No
     hard-coded 3/4 UI cap; the limit is a config value (`MAX_ACCOUNTS_PER_USER`,
     default 25) so it can be raised.
   - Accounts are independent: own session/auth key, own DC, own device profile,
     own caches, own unread counters.
   - Switching accounts must not require re-login or a full reload.
   - Concurrent updates for all attached accounts, not just the active one.
   - tdata import can add several accounts in one upload (a tdata folder holds up
     to 6).
   - Account removal offers two choices: detach locally or terminate the Telegram
     session (`auth.logOut`).
2. **Three login methods, all producing the same kind of account slot:**
   - phone number + code (SMS/app/call) + optional 2FA;
   - QR code (`tg://login?token=...`);
   - tdata upload (Telegram Desktop folder, optional local passcode).
3. **Behaviour and feature set follow the official clients**, not Android mods.
   The reference implementation is **64Gram** (`inspiration/repos/64Gram`), a
   direct fork of official Telegram Desktop: 100 account slots
   (`Main::Domain::kMaxAccounts`), one encrypted account store, one active
   account, per-account session and storage. Secondary reference: **Nagram**
   (`MAX_ACCOUNT_COUNT = 128`) for unlimited-account UX and feature scope.
4. **Telegram API ToS compliance.** No ghost mode, no anti-delete, no local
   "premium", own `api_id`/`api_hash`. See `docs/auth.md` for consequences.

## 2. Why the backend owns MTProto

The browser cannot speak MTProto over raw TCP and must never hold auth keys.
NestJS owns Telegram clients, sessions and updates; the Next.js app only talks
HTTP/WebSocket to us.

```
Next.js (dashboard) ── REST + WS ──▶ NestJS
                                     ├── UserContextModule (single local user, guard)
                                     ├── AuthModule      (phone / QR / tdata)
                                     ├── AccountsModule  (slots, switching)
                                     ├── MessagingModule (chats, messages)
                                     ├── TelegramModule  (client manager, crypto)
                                     └── RealtimeModule  (updates, WS fan-out)
                                            │
                                            ▼
                                     mtcute ── MTProto ──▶ Telegram DCs
                                            ▲
                                     opentele2 (tdata → session, device profiles)
```

## 3. Stack decisions

| Concern | Choice | Why |
| --- | --- | --- |
| MTProto | [`@mtcute/node`](https://mtcute.dev) 0.32.x (MIT) | TypeScript, phone + QR + 2FA flows built in, manual auth methods, updates loop |
| tdata | [`opentele2`](https://opentele2.github.io/) 2.0 (MIT) | Reads/writes tdesktop 7.3.x tdata, passcode support, mtcute session conversion, official device profiles, Rust core with prebuilt Node addons |
| API | NestJS 12 (already in repo) | ESM, DI, fits the existing app |
| DB | PostgreSQL via Prisma (planned; Phase 1 currently runs on SQLite) | Multi-user, concurrent updates, JSONB for device profiles |
| Ephemeral state | Redis | pending auth attempts, QR state, rate limits, WS pub/sub across nodes |
| File uploads | temp volume now, S3 + worker later | tdata can be hundreds of MB and must be shredded after parsing |

## 4. Multi-account data model

```prisma
model User {
  id                String   @id @default(cuid())
  email             String?  @unique   // lowercase, unique
  name              String?
  passwordHash      String?            // scrypt(password, salt), base64
  passwordSalt      String?            // 16 random bytes, base64
  passwordUpdatedAt DateTime?
  accounts          TelegramAccount[]
}

model TelegramAccount {
  id               String   @id @default(cuid())
  userId           String
  tgUserId         BigInt
  phoneEncrypted   Bytes?   // packed AES-256-GCM envelope, AAD phone:<accountId>
  phoneNonce       Bytes?
  phoneTag         Bytes?
  firstName        String
  lastName         String?
  username         String?
  deviceProfile    String   @default("{}") // JSON snapshot of the last profile
  isActive         Boolean  @default(false)
  lastUsedAt       DateTime?
  createdAt        DateTime @default(now())
  sessions         TelegramSession[]       // PC + phone + ... can coexist
  @@unique([userId, tgUserId])
}

// One auth key = one device. Unique per (accountId, deviceId): a new deviceId
// adds a session, the same deviceId replaces that session's key.
model TelegramSession {
  id          String   @id @default(cuid())
  accountId   String
  deviceId    String
  label       String?
  platform    String   @default("desktop")
  profile     String   @default("TelegramDesktop")
  dcId        Int
  apiId       Int
  keyVersion  Int      @default(1)
  cipher      Bytes    // payload encrypted with a per-record DEK
  nonce       Bytes
  tag         Bytes
  dekWrapped  Bytes    // DEK encrypted with the master key
  dekNonce    Bytes
  dekTag      Bytes
  revokedAt   DateTime?
  lastUsedAt  DateTime?
  proxyId     String?              // optional, from the user's Proxy list
  @@unique([accountId, deviceId])
}

// Named proxy: reusable across sessions of one local user.
model Proxy {
  id              String   @id @default(cuid())
  userId          String
  name            String              // unique per user
  kind            String   @default("socks5") // socks5|socks4|http|https|mtproto
  host            String
  port            Int
  username        String?
  secretEncrypted Bytes?              // password / MTProto secret, encrypted
  enabled         Boolean  @default(true)
  @@unique([userId, name])
}

model AuthAttempt {
  id        String   @id @default(cuid())
  userId    String?
  method    AuthMethod            // PHONE | QR | TDATA
  status    AuthStatus            // PENDING | CODE_SENT | PASSWORD_REQUIRED | DONE | EXPIRED | FAILED
  payload   Json?                 // no codes, no passwords, no keys
  expiresAt DateTime
}

model TdataUpload {
  id        String   @id @default(cuid())
  userId    String
  status    UploadStatus
  accounts  Json?                 // discovered accounts metadata only
  expiresAt DateTime
}
```

Rules:
- `TelegramSession.cipher` is the only place an auth key lives. Kill it and that
  session is detached.
- Unique `(userId, tgUserId)` prevents the same Telegram account being added twice
  to one local user; login from a second device upserts the same account.
- `(accountId, deviceId)` is unique: PC and phone are two rows/clients.
- Each session may have its own `proxyId`; a proxied session never falls back to
  a direct connection (a disabled/missing proxy is an error, not a leak).
- Deleting the last session deletes the account slot (`DELETE /accounts/:id/sessions/:sessionId`).

## 5. Session encryption

- Master key from `TELEGRAM_SESSION_MASTER_KEY` (32 bytes, base64) or KMS.
  Development falls back to a deterministic key with a warning; production
  throws if the variable is missing.
- Envelope per record: random 32-byte DEK, payload AES-256-GCM under the DEK,
  DEK wrapped AES-256-GCM under the master key. Stored columns: `cipher`,
  `nonce`, `tag`, `dekWrapped`, `dekNonce`, `dekTag`, `keyVersion`.
- AAD binds the record to its owner: `session:<accountId>` for auth keys,
  `phone:<accountId>` for the phone number, `proxy:<proxyId>` for proxy
  secrets. A blob moved to another record fails authentication.
- The phone number has no DEK columns, so the whole envelope is packed as JSON
  (base64 fields) into `TelegramAccount.phoneEncrypted`; `phoneNonce`/`phoneTag`
  mirror the payload values.
- Decrypt only inside `TelegramModule`, only when opening a client; never return
  keys to controllers, logs or the frontend.
- Rotation: `keyVersion` is stored; re-wrapping DEKs is future work.
- 2FA passwords and phone codes live only in memory for the duration of a
  request/attempt. `AuthAttempt.payload` never contains codes, `phone_code_hash`
  or auth keys.

## 6. Client manager and scale

- `ClientManagerService` keeps `Map<sessionId, TelegramClient>` (one client per
  session/device, so PC and phone are independent).
- Lazy connect on first use; LRU eviction when `MAX_LIVE_CLIENTS` is reached;
  reconnect on demand.
- Start `startUpdatesLoop()` for every attached account, including inactive ones
  (bounded by `MAX_LIVE_CLIENTS`).
- Auth attempts hold a live client in memory. They must be **sticky** to the node
  that created them: route by `auth:attempt:<id>:node` in Redis, or run auth on a
  dedicated worker. A QR token cannot be serialized between nodes.
- Multi-tenant deployments: per-user concurrency limits and per-account flood
  handling (`FLOOD_WAIT_X` is per account, not global).

## 7. HTTP/WS surface (v1)

Every auth flow takes `deviceId` (8..128 chars) and optional `profile`
(`desktop` default, `mobile`, `android-x`, `ios`, `macos`, `web-a`, `web-k`,
`webogram`), and optional `label`. Errors are `{ code, message, retryAfter? }`.

Auth:
```
POST   /auth/phone/start        { phone, deviceId, profile?, label? }
                                → { attemptId, codeType, timeout, nextType? }
POST   /auth/phone/resend       { attemptId }
POST   /auth/phone/verify       { attemptId, code }          → ok | password_required | signup_required
POST   /auth/phone/password     { attemptId, password }
POST   /auth/phone/signup       { attemptId, firstName, lastName }
POST   /auth/phone/cancel       { attemptId }

POST   /auth/qr/start           { deviceId, profile?, label? }
                                → { attemptId, url, expiresAt }
GET    /auth/qr/:attemptId                                   → { status, url?, expiresAt?, error?, account? }
POST   /auth/qr/:attemptId/password { password }
POST   /auth/qr/:attemptId/cancel

POST   /auth/tdata              multipart(file, passcode?)   → { uploadId, accounts: [{ index, userId }] }
POST   /auth/tdata/:id/import   { indexes?, mode, deviceId, profile?, label?, password? }
DELETE /auth/tdata/:id
```

`mode` is `new_session` (default; fresh auth key via `qrLoginToNewClient`) or
`reuse` (imports the desktop auth key and returns a `SHARED_DESKTOP_SESSION`
warning). The `tdata` archive is deleted right after extraction; the extracted
folder lives at most 15 minutes.

Accounts:
```
GET    /accounts                                   → slots + sessions + masked phone + isActive
POST   /accounts/:id/activate                      → one active account per user
DELETE /accounts/:id?revokeSession=true|false      → local detach by default
GET    /accounts/:id/sessions                      → Telegram authorizations
GET    /accounts/:id/avatar                        → JPEG profile photo (404 if none)
DELETE /accounts/:id/sessions/:sessionId?revoke=true
PATCH  /accounts/:id/sessions/:sessionId           { proxyId?: string|null, label? }
```

Proxies (per local user; reusable, name is unique):
```
GET    /proxies                                    → list (secrets never returned)
POST   /proxies                                    { name, kind, host, port, username?, secret?, enabled? }
PATCH  /proxies/:id                                partial update; secret:"" clears it
DELETE /proxies/:id                                sessions fall back to no proxy (proxyId = null)
POST   /proxies/:id/test                           TCP reachability probe (does not auth)
```

Assigning a proxy to an existing session closes its live client and reconnects
it through the new transport, including the realtime updates loop.
```
No registration or login. DefaultUserService upserts `DEFAULT_USER_ID`
(default `local`) and DefaultUserGuard attaches it to every HTTP request; the
`@CurrentUser()` decorator returns it. WS sockets join `user:<id>` without a
token. This must be replaced by real auth before a shared deployment.
```
```
GET    /accounts/:accountId/chats?limit=50&folderId=&archived=&sessionId=
GET    /accounts/:accountId/folders?sessionId=                  chat folders
GET    /accounts/:accountId/search?q=&limit=&sessionId=         global chat/user search
GET    /accounts/:accountId/chats/resolve?username=&sessionId=   @name / t.me link → chat
GET    /accounts/:accountId/chats/:chatId                       chat peer (id/type/title/username)
GET    /accounts/:accountId/chats/:chatId/info                  full chat info panel (about, members, permissions, invite link)
GET    /accounts/:accountId/chats/:chatId/info/media?kind=&limit=&offsetId=  media|links|polls tab
GET    /accounts/:accountId/chats/:chatId/info/similar          similar channels
GET    /accounts/:accountId/chats/:chatId/avatar                JPEG chat photo (404 if none)
GET    /accounts/:accountId/chats/:chatId/messages?limit=50&offsetId=&newerThanId=&sessionId=
GET    /accounts/:accountId/chats/:chatId/messages/:messageId/media?filename=&thumb=&sessionId=  download attachment (`thumb=1`: inline preview)
GET    /accounts/:accountId/chats/:chatId/search?q=&limit=&offsetId=&sessionId=
POST   /accounts/:accountId/chats/:chatId/messages             { text, replyToId?, sessionId? }
POST   /accounts/:accountId/chats/:chatId/media                multipart `file` (≤ 50 MB) + caption?, replyToId?  → 413 PAYLOAD_TOO_LARGE
POST   /accounts/:accountId/chats/:chatId/forward              { fromChatId, messageIds[1..100], sessionId? }
POST   /accounts/:accountId/chats/:chatId/messages/:messageId/reaction    { emoji } → MessageView | 204
POST   /accounts/:accountId/chats/:chatId/messages/:messageId/vote        { options: number[] | null } → poll
POST   /accounts/:accountId/chats/:chatId/messages/:messageId/translate   { to? } → { text, to }
POST   /accounts/:accountId/chats/:chatId/messages/:messageId/transcribe  → { text, pending }
PATCH  /accounts/:accountId/chats/:chatId                      { pinned?, muted?, archived?, unread?, sessionId? }
DELETE /accounts/:accountId/chats/:chatId?revoke=&clearHistory=&sessionId=
POST   /accounts/:accountId/chats/read-all                     { sessionId? } → { read, failed }
PATCH  /accounts/:accountId/chats/:chatId/messages/:messageId  { text, sessionId? }
DELETE /accounts/:accountId/chats/:chatId/messages/:messageId?revoke=&sessionId=
POST   /accounts/:accountId/chats/:chatId/read                 { maxId?, sessionId? }
POST   /accounts/:accountId/chats/:chatId/typing               { status?, sessionId? }
```

`GET /chats` with no params returns main *and* archived dialogs: mtcute maps
`archived: 'keep'` to `folderId = undefined`, i.e. only folder 0, so the
service fetches folder 0 and folder 1 separately and merges them by peer id
(pinned duplicates are dropped, order is preserved). That "all" list and
`POST /chats/read-all` therefore cover the archive too.
Chats are mapped to `{ id, type, title, username, lastMessage, unreadCount,
pinned, muted, archived, readInboxMaxId, canSendMessages }`;
`readInboxMaxId` is the dialog's read boundary (used as `newerThanId`).
`canSendMessages` follows the peer's
`permissions.canSendMessages` when present; broadcast channels additionally
need `isAdmin`/`isCreator`, while legacy groups without permission info stay
writable. The info panel (`/chats/:chatId/info`) adds `about`, `memberCount`,
`onlineCount`, `isChannel`, `isGroup`, `isAdmin`, `isCreator` and `inviteLink`
from `getFullChat`, falling back to the plain peer for private chats. Its tabs
come from in-chat `searchMessages` with `inputMessagesFilterPhotoVideo`,
`inputMessagesFilterUrl` or `inputMessagesFilterPoll` (`limit` capped at 50,
paged by `offsetId`); similar channels use raw
`channels.getChannelRecommendations` and return an empty list when Telegram
does not support it for the peer.
`folderId` selects one folder; `archived=true|false` lists only archived or
only non-archived dialogs (with no params both folders are returned).
Folders come from `getFolders()` as `{ id, title, emoticon }`. Global search
folds `searchGlobal` hits into `{ chats: ChatView[], users: { id, title,
username }[] }`; in-chat search returns `{ messages, nextOffsetId }`. Message
actions: reply via `replyTo`, forward via `forwardMessagesById`, pin and mute
via the raw `messages.toggleDialogPin` / `account.updateNotifySettings` calls
(mtcute 0.32 has no high-level helpers for those two), archive/unread via
`archiveChats`/`unarchiveChats`/`markChatUnread`/`readHistory`. Deleting a chat
uses `deleteHistory` for private chats and legacy groups and `leaveChat` for
channels/supergroups; `clearHistory=true` only clears messages. Both flags
default to `false`, so a bare `DELETE` removes the chat only for this account —
`revoke=true` is the explicit "delete for everyone". The response is
`{ removed }` (`clearHistory` keeps the dialog, so `removed: false`).
`POST /chats/read-all` marks both folders in batches of 10 with
`Promise.allSettled`, returning `{ read, failed }` (capped at 200 dialogs).
`newerThanId` (usually the dialog's `readInboxMaxId`) returns the oldest unread
batch plus a little read context, so opening a chat with many unread messages
does not mark everything read at once. Messages come from `getHistory`, newest
first, with `nextOffsetId` for paging:
`{ id, chatId, text, date, outgoing, edited, senderId, senderName, replyToId,
mediaType, media, reactions, poll, isVoice }`, where `media` is
`{ kind: photo|document|voice|other, mimeType, fileName, size, downloadable }`
(voice notes default to `audio/ogg`), `reactions` is
`[{ emoji, count, chosen }]` (`custom:<id>` for custom emoji, zero counts
dropped), and `poll` is
`{ id, question, closed, quiz, multiple, voters, hideResultsUntilClose, answers:
[{ index, text, voters, chosen, correct }], solution }` for poll media.
The new message actions map to `sendReaction` (re-fetch → `MessageView`, `204`
when Telegram returns none), `sendVote` (`null` retracts; answer indexes are
positions in `poll.answers`), `translateText` (`to` is a 2-letter code,
default `ru`, `message.text` includes captions) and a raw
`messages.transcribeAudio` call (`pending` while Telegram still works;
`MSG_VOICE_MISSING` → 400 `TRANSCRIPTION_UNAVAILABLE`,
`PREMIUM_ACCOUNT_REQUIRED` → 403 `PREMIUM_REQUIRED`).
Uploads (`POST /chats/:chatId/media`) accept one multipart `file` up to 50 MB
(`MAX_MEDIA_BYTES`, `413 PAYLOAD_TOO_LARGE`), with an optional caption; images
are sent as photos, everything else as documents. If Telegram rejects a photo
with `IMAGE_PROCESS_FAILED` (e.g. very small PNGs), the upload is retried once
as a document; a second failure returns `400 MEDIA_PROCESS_FAILED`. Deletes
(`DELETE .../messages/:messageId`) are revoked for everyone by default
(`revoke=true`); `revoke=false` keeps the account-local delete for
compatibility. The dashboard loop used for selection-mode batch deletes calls
the same single-message endpoint, so it always revokes too. Downloads
(`GET .../messages/:messageId/media`) reject descriptors above the same 50 MB
limit (`413 MEDIA_TOO_LARGE`) before fetching bytes, cache at most 200 MB total
(entries over 10 MB are not cached, TTL 5 min), and validate the sender's MIME
type: invalid values become `application/octet-stream`, only raster images
(`image/jpeg`, `image/png`, `image/webp`, `image/gif`) are served `inline`,
every other type is forced to `attachment`. Media/avatar responses also send
`X-Content-Type-Options: nosniff` and `Cache-Control: private, max-age=600`.
`?thumb=1|true` serves the best preview (the `m` 320 px box, else the largest
size ≤ 320 px, else the largest available) cached under `<key>:thumb` for
30 minutes (`MAX_MEDIA_THUMB_BYTES` 2 MB cap); when no thumbnail exists or it
fails, the full file is returned instead of a 404. Voice notes are served
`audio/ogg` inline so the chat window can play them with `<audio controls>`.
Sending trims text (non-empty, max 4096); typing accepts
`typing`, `record_video`, `record_voice`, `upload_photo`, `upload_document`,
`cancel`. The session must belong to the account and the account to the user;
Telegram errors are mapped to `{ code, message, retryAfter? }` (FLOOD_WAIT
included).

### Group and channel administration

A dedicated `ChatAdminController` (`/accounts/:accountId/chats/:chatId/admin`)
adds the "Управление" tab of the info drawer for groups, supergroups and
channels the account administers. Every route resolves the session through
`AccountsService`, rejects private peers with `400 NOT_A_GROUP`, and requires
`isAdmin || isCreator` from `getFullChat`, otherwise `403 CHAT_ADMIN_REQUIRED`.
DTOs contain no mtcute objects and validation runs before network calls.

```
GET    .../admin/members?query=&type=all|admins|banned|recent|bots&limit=&offset=
         → { items: [{ id, name, username, status, rank, isAdmin, isCreator, joinedAt }], total }
POST   .../admin/members/:userId/ban      { untilDate? (ms) }   banChatMember
POST   .../admin/members/:userId/unban                         unbanChatMember
POST   .../admin/members/:userId/kick                          kickChatMember
POST   .../admin/members/:userId/rank     { rank: string|null } editChatMemberRank
POST   .../admin/members/:userId/admin    { rank?, rights }     editAdminRights
DELETE .../admin/members/:userId/admin                          editAdminRights (empty)
PATCH  .../admin                           { title?, about?, slowModeSeconds? }
GET    .../admin/invites                   → { items: [{ link, creatorName, isPrimary, ... }] }
POST   .../admin/invites                   { expiresAt?, usageLimit?, withApproval?, name? }
POST   .../admin/invites/primary           export primary link (rotates the old one)
POST   .../admin/invites/revoke            { link }
POST   .../admin/invites/edit              { link, expiresAt?, usageLimit?, withApproval? }
GET    .../admin/join-requests             messages.getChatInviteImporters (requested)
POST   .../admin/join-requests             { userIds: number[], approve: boolean }
```

`limit` is capped at 200 (Telegram's own cap; `total` comes from
`ArrayWithTotal`). Slow mode accepts only Telegram's intervals
(`0,10,30,60,300,900,3600,10800,21600,43200,86400`); `0` disables it. Admin
rights are an allow-list (`changeInfo`, `deleteMessages`, `banUsers`,
`inviteUsers`, `pinMessages`, `manageCall`, `postMessages`, `editMessages`,
`addAdmins`, `anonymous`, `manageTopics`); an empty selection becomes
`other: true` (admin without extra powers) instead of silently demoting.
Invite `usageLimit: null` and `expiresAt: null` mean unlimited/no expiry;
`pendingJoinRequests` counts approval-based join requests. mtcute 0.32 has no
`title` on `createInviteLink`, so a named link uses the underlying
`messages.exportChatInvite` call; join requests use the raw importer call and
`hideJoinRequest` for approve/decline.

Accounts:
```
GET    /accounts                                   → slots + sessions + masked phone + isActive
POST   /accounts/:id/activate                      → one active account per user
DELETE /accounts/:id?revokeSession=true|false      → local detach by default
GET    /accounts/:id/sessions                      → Telegram authorizations
DELETE /accounts/:id/sessions/:sessionId?revoke=true
```

Swagger UI is public at `/docs`, the OpenAPI JSON at `/docs-json`; there is no
Bearer scheme because the API is single-user.

### Logs

Structured journal (HTTP actions, Telegram RPC answers, auth steps, client and
proxy failures, unhandled exceptions) stored in `LogEntry` and exposed for both
the dashboard page `/logs` and AI agents. Full field reference:
`docs/logs.md`.
```
GET    /logs?domain=telegram|system&level=&source=&q=&accountId=&sessionId=&requestId=&chatId=&proxy=&since=&until=&before=&sort=&offset=&limit=
GET    /logs/stats?domain=
GET    /logs/:id
GET    /logs/export?level=...                      NDJSON, one entry per line
DELETE /logs
```
Every RPC call to Telegram is logged with its method name and raw error text
(`source=telegram, action=telegram.call`); `domain=telegram` groups those with
`messaging`/`auth`, `domain=system` covers application logs. New entries are
pushed over Socket.IO as `log.new` in the `user:<id>` room.

Every API response carries `x-request-id`; the same value is stored on all log
rows produced by that request, so an HTTP action and the Telegram error it
caused can be joined. Secrets, passwords, codes, phone numbers and session keys
are redacted before writing; retention is `LOG_MAX_ENTRIES` (default 10 000).

### Web Push

Browser notifications work without an open dashboard tab: the dashboard
registers `public/sw.js`, and the API sends a Web Push notification for every
incoming `message.new`. Subscriptions are stored in `PushSubscription` (one row
per browser endpoint, cascaded with the user). Outgoing messages, edits and
read receipts never push; a chat muted in Telegram is skipped when the dialog
state can be read cheaply. Each chat is limited to one push per 10 s and each
user to 20 per minute. Delivery uses `TTL: 3600`; endpoints answering 404/410
are removed.

```
GET    /push/key                                   → { publicKey }
PUT    /push/subscribe   { endpoint, keys: { p256dh, auth } }   → 204
DELETE /push/subscribe   { endpoint }                           → 204
POST   /push/test                                  → { sent, failed }
```

VAPID keys are not committed. Generate them once and put them into
`apps/api/.env`:

```bash
bunx web-push generate-vapid-keys
```

Set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and (optionally) `VAPID_SUBJECT`
(`mailto:you@example.com`, defaults to `mailto:admin@localhost`). Without both
keys the API still boots, logs one warning, and the push routes answer
`503 PUSH_DISABLED`; the dashboard shows a readable Russian message.

The dashboard also keeps an offline snapshot (last 50 messages per chat, the
chat list, a minimal account list and the last selected account/chat, versioned
`tg-offline-v1`/`tg-offline-selection`, ~2 MB with LRU eviction). It contains
only account ids/names, chat titles and messages — never logs, proxies,
sessions, phone numbers or tokens.

## 7.1 Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `TELEGRAM_API_MODE` | `official` | `official` (opentele2 profiles, ToS 2.1 violation warning) or `custom` |
| `TELEGRAM_API_ID` / `TELEGRAM_API_HASH` | – | required in `custom` mode |
| `TELEGRAM_DEVICE_MODEL`, `TELEGRAM_SYSTEM_VERSION`, `TELEGRAM_APP_VERSION`, `TELEGRAM_LANG_CODE`, `TELEGRAM_LANG_PACK` | Desktop / Linux / 1.0.0 / en / – | device fields in `custom` mode |
| `TELEGRAM_DEFAULT_PROFILE` | `desktop` | profile used when a flow omits `profile` |
| `TELEGRAM_SESSION_MASTER_KEY` | dev key | 32-byte base64 AES key; required in production |
| `TELEGRAM_TMP_DIR` | `<os tmp>/combain-telegram` | tdata upload/extraction |
| `MAX_ACCOUNTS_PER_USER` | `25` | account limit per local user |
| `MAX_SESSIONS_PER_ACCOUNT` | `10` | device/session limit per Telegram account |
| `DEFAULT_USER_ID` | `local` | the single local user every request runs as |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | – | Web Push keys from `bunx web-push generate-vapid-keys`; missing = `503 PUSH_DISABLED` |
| `VAPID_SUBJECT` | `mailto:admin@localhost` | contact address sent with each push |
| `PORT` | `3001` | HTTP port |

`apps/api/.env.example` lists all of them. With `TELEGRAM_API_MODE=custom` and no
credentials the app still boots; auth endpoints answer `503 NOT_CONFIGURED`.

WS namespace `/events` needs no token; sockets join `user:<id>`. Events:
```
auth.qr.updated | auth.qr.scanned | auth.password_required | auth.done | auth.failed
message.new | message.edited | message.deleted | message.read | chat.typing
```

Payloads: `message.new` / `message.edited` = `{ accountId, sessionId, chatId,
message }`; `message.deleted` = `{ accountId, sessionId, chatId, messageIds }`
(`chatId` is the channel id or `null`, as the update only exposes that);
`message.read` = `{ accountId, chatId, maxId, outbox, unread }`; `chat.typing` =
`{ accountId, chatId, userId, status, chatType }`. UpdatesService subscribes
once per session to `onNewMessage`, `onEditMessage`, `onDeleteMessage`,
`onUserTyping`, `onHistoryRead`, starts `startUpdatesLoop()`, and dedupes the
same event seen through two sessions of one account for 10 s. Fan-out is
in-process (rxjs Subject), so a multi-node deployment needs Redis pub/sub.

Never send session keys, auth keys, phone codes or passwords over WS.

## 8. TDLib engine (native)

The working session is native TDLib (`tdlib-native` + prebuilt `libtdjson`),
while mtcute remains available as the fallback engine. `TELEGRAM_ENGINE`
(`auto` by default) decides: an account with a live `engine = "tdlib"` session
is served by TDLib, everything else by mtcute. Every TDLib call is wrapped:
on error the request is logged (`tdlib.messaging.*`) and retried with mtcute,
so a TDLib problem degrades instead of breaking the UI.

### Storage
- One folder per session: `$TDLIB_DATA_DIR/sessions/<deviceId>/{db,files}`.
- `TelegramSession.engine` chooses the engine; `tdlibPath` points at the folder
  and `tdlibKeyEncrypted` holds the TDLib `database_encryption_key`, sealed by
  `SessionCryptoService` (AAD `tdlib:<accountId>`, AES-256-GCM).
- `TelegramAccount.cloudPassword*` stores the 2FA cloud password (AAD
  `cloud:<accountId>`); it is only used to answer `authorizationStateWaitPassword`
  automatically. It never appears in logs.
- `TdClientManagerService` opens a client lazily per session, applies the
  session proxy through `addProxy` and reuses it until logout/removal.

### Login and migration
TDLib cannot import an MTProto auth key from `tdata`, so an existing session
authorizes the new TDLib client through QR:

1. TDLib calls `requestQrCodeAuthentication` and exposes
   `tg://login?token=...`.
2. The existing mtcute session (the imported `tdata` one) calls raw
   `auth.acceptLoginToken` with that token — no code, no SMS.
3. TDLib may ask for the cloud password; the stored one is submitted, or the UI
   asks and stores it.
4. On `authorizationStateReady` the attempt folder is renamed to its permanent
   session folder and an `engine = "tdlib"` row is attached.

The old mtcute session is **never logged out**: it stays as a fallback and the
user can remove it in Telegram at any time. The phone-code path
(`setAuthenticationPhoneNumber`) exists for brand-new accounts; the
`777000` bridge is unreliable because Telegram often sends that code by SMS.

`POST /accounts/:id/tdlib/migrate` runs the flow for an existing account
(the QR is approved automatically). `POST /tdlib/auth/start` handles new
accounts (`qr` or `phone`), with `/code` and `/password` steps. Attempts live
in memory for 10 minutes.

### Messaging and realtime
- `TdChatRegistry` maps TDLib `chat_id` ↔ marked peer ids (user, `-group`,
  `-100…channel`) and keeps chat snapshots fresh from `updateChat*`.
- `td-message-view.ts` maps TDLib messages/content to the existing
  `MessageView`/`ChatView` DTOs, so the dashboard is engine-agnostic.
- Sends wait for `updateMessageSendSucceeded` so the API returns the final
  server message id (the temporary id cannot be edited or deleted later).
- `TdFilesService` downloads through TDLib, which follows CDN redirects itself
  (the reason for the migration: mtcute cannot open CDN DCs ≥ 200).
- `TdUpdatesService` republishes TDLib updates as the same `message.new` /
  `message.edited` / `message.deleted` / `message.read` / `chat.typing` events.
  For an account with a TDLib session, `UpdatesService` skips its mtcute
  sessions entirely: a message may not be announced twice with different ids.

The same bridge backs both onboarding and migration, so no separate proof
scripts are kept: `POST /accounts/:id/tdlib/migrate` is the diagnostic path and
is covered by the auth tests.

## 9. Phases

0. **Spike** (1–2 days): a NestJS script proving phone login, QR login and
   tdata→session import against a test account, with `getMe()` after each.
1. **Multi-account core**: schema, session crypto, account slots, switching API,
   phone auth, multi-session per account. **Implemented on SQLite**; the Postgres
   move, Redis-backed attempt routing and WS fan-out remain.
2. **QR auth**: `signInQr` + polling, 2FA. **Implemented** (HTTP polling and WS
   events).
3. **tdata import**: upload, parse, account picker, fresh-session strategy.
   **Implemented** (`.zip`, `.tar.gz` and `.tgz`, max 512 MB).
4. **Updates + messaging**: chats, messages, read/typing, media upload/download,
   avatars, realtime fan-out. **Implemented** (bounded in-memory cache).
5. **Admin panel** workflows on top of the same API.

## 10. Open decisions

- ~~Local users: e-mail/password vs external IdP~~ → the app is single-user now
  (`DEFAULT_USER_ID`); add real auth before any shared deployment.
- Whether to allow the same Telegram account in two local users (default: no).
- Storage of message cache: server-side vs IndexedDB on the client (affects
  offline mode and search).
- Public deployment regions vs Telegram DC latency; proxy support per account.
