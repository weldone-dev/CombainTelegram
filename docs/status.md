# TDLib migration — live status

Updated: 2026-11-23. This file is the single place to check progress.

## Decisions (fixed)
- Working session: native TDLib, official `api_id` (user's decision).
- Old mtcute/desktop session is **never logged out**; it stays as a fallback.
- 2FA cloud password is stored encrypted (AES-256-GCM), never logged.
- Login method for tdata/migration: TDLib generates a QR, the existing session
  approves it. Phone code stays available for new accounts.
- The phone-code path through `777000` does not work in practice: Telegram sends
  that code by SMS, so QR is the primary flow.
- One TDLib session per account (`deviceId = "tdlib"`); re-migration replaces it.
- `TELEGRAM_ENGINE=auto` (default): TDLib for accounts that have a TDLib
  session, mtcute otherwise, with per-call fallback to mtcute.

## Done

### Engine and storage
- [x] Live proof: TDLib QR + `auth.acceptLoginToken` from the existing session,
      2FA password accepted, `authorizationStateReady`, old session untouched.
- [x] Prebuilt native TDLib (linux-x64) loads on this machine.
- [x] DB: `TelegramSession.engine` / `tdlibPath` / encrypted DB key,
      `TelegramAccount.cloudPassword*`; migrations applied.
- [x] `TdClientManagerService`: native client per session, per-session folders,
      encrypted `database_encryption_key`, proxy support, Android profile,
      `TELEGRAM_ENGINE` / `TDLIB_DATA_DIR`.
- [x] Session ops are engine-aware (revoke/detach only touch the right engine).

### Login and migration
- [x] Login/migration API (`tdlib-auth`): migrate, QR/phone flows, code,
      password, cloud-password get/put/delete.
- [x] **Live migration of the real account**: QR approved automatically, 2FA
      password, `ready`; one `tdlib` session + untouched mtcute session.
- [x] TDLib session reopens from its encrypted database after a restart.
- [x] Dashboard: no device picker, QR/code/password onboarding, migration card,
      cloud-password management, engine badges.

### Messaging (TDLib, with mtcute fallback)
- [x] Chats/folders, chat info, history, search, avatars.
- [x] Send text/media, reactions, edit, delete, read, typing, forward, poll vote.
- [x] Files and media through TDLib — CDN redirects handled natively.
- [x] Sends return the final server message id (edit/delete work afterwards).
- [x] Realtime from TDLib: new/edited/deleted/read/typing; mtcute events are
      skipped for accounts that have a TDLib session (no duplicate ids).

### Live checks
- Chats list with last messages, pinned/folder order.
- History, newest at the bottom; avatars; photo upload + download round-trip.
- Send, edit, reaction, delete — all through TDLib.
- Every TDLib failure falls back to mtcute and is logged (`tdlib.messaging.*`).

### Quality
- API: 270 tests, `tsc`, `oxlint`, `nest build` green.
- Dashboard: `tsc`, `biome`, `next build` green.
- Worker worktrees and branches removed; only `main` remains.

## Still on mtcute (works only while the old session exists)
`getChatInfoMedia`, `getChatInfoSimilar`, message threads/comments, translation,
transcription, `resolveChat`, chat settings/delete, and the admin tools
(members, bans, rights, invite links). These are the next porting batch; the old
session is intentionally kept, so nothing is broken meanwhile.

## Next
- Port the remaining endpoints above to TDLib.
- Optional: idle TDLib client eviction (memory), TDLib connection-state event.
- Optional: clear the service-worker transcript cache after a migration (old
  message ids become stale).
- Update `docs/architecture.md` / `docs/auth.md`  (done) and keep this file in
  sync.

## Safety rules
- No `auth.logOut` on the user's Telegram Desktop session.
- No live Telegram login from workers; live checks are run by the coordinator.
- Every TDLib path has an mtcute fallback, so the app keeps working.
