# TDLib migration — live status

Updated: 2026-11-24. This file is the single place to check progress.

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

### Sessions
- [x] Per-account active session (`TelegramAccount.activeSessionId`): engine,
      routing, messaging and realtime follow the selected session.
- [x] `POST /accounts/:id/sessions/:sessionId/activate`.
- [x] Add a session to an existing account (`/tdlib/auth/start` with
      `accountId`), own label/proxy, stored 2FA password reused.
- [x] Delete a session (local detach or server revoke) without touching other
      sessions; clearing an active session falls back safely.
- [x] Sessions UI: no bulk proxy, per-session proxy, activate/add/delete with
      confirmation.

### UI and notifications
- [x] Account card shows the full phone (`AccountView.phone`), no mask.
- [x] Proxy chip with hover/focus/tap popover: name, kind, `host:port`,
      exit node IP + latency from `POST /proxies/:id/check` (5 min cache;
      MTProto reports "exit node unknown").
- [x] One notification menu (bell): notifications, sound, Web Push and a
      `Проверить` test; Web Audio chime on incoming messages, no audio files.
- [x] Settings section: `/settings` now redirects to `/eve` (old bookmarks
      keep working); accounts, proxies and logs live on the top-level
      `/accounts`, `/proxies`, `/logs` pages.

### Live checks
- Chats list with last messages, pinned/folder order.
- History, newest at the bottom; avatars; photo upload + download round-trip.
- Send, edit, reaction, delete — all through TDLib.
- Every TDLib failure falls back to mtcute and is logged (`tdlib.messaging.*`).
- Switching the active session: mtcute ids (453/452/450) vs TDLib ids
  (475004928/…) — routing follows the selection.
- Adding a session live is pending: Telegram is throttling QR token exports
  right now (a bare TDLib client gets no answer). The attempt now fails with a
  clear status instead of hanging; retest when the throttle clears.
- Proxy exit node check: `Эстония/США` (http://192.168.31.216:3128) → exit
  `48.102.209.54`, 400 ms.
- Notification test button plays the chime ("Звук отправлен"); the embedded
  browser denies Notification/push permission, so that part is environment-bound.

### Quality
- API: 766 tests in 61 files, `tsc`, `oxlint`, `nest build` green.
- Eve agent: 248 tests in 21 files (`bun test apps/eve/agent`), three green runs.
- Dashboard: `tsc`, `biome check`, `next build` green (12 routes).
- Worker worktrees and branches removed; only `main` remains.

### Threads
- [x] Channel comment threads on TDLib (`getMessageThread` /
      `getMessageThreadHistory`), root filtered, paging, `sendComment`.
      Live-verified on a real channel post (5 comments mapped).

### Info panel, translation, transcription
- [x] `info/media` (photos, links, polls) on TDLib — ids match media downloads.
- [x] `translate` on TDLib (`translateMessageText`), live-verified.
- [x] `transcribe` on TDLib (`recognizeSpeech` + `updateMessageContent` wait).
- [x] `info/similar` on TDLib (`getChatSimilarChats`).

### Eve (the only LLM stack)
Reference: `docs/eve/README.md`, `docs/eve/PLAN.md`. Code: `apps/eve` (agent
process on `:4020`) and `apps/api/src/eve` (Telegram-facing API). The old
Soul/autopilot/provider/MCP/bot/automation layer and its tables are removed.

- [x] Personas: CRUD, docs, account bindings (`shared`/`isolated`), chat
      allowlist (blocked by default), context snapshots.
- [x] Turn loop in `apps/eve` (Eve 1.5.0) over an OpenAI-compatible endpoint
      (`AI_BASE_URL`/`AI_MODEL`/`AI_FAST_MODEL`/`AI_API_KEY`); outward actions
      go through Nest (`/internal/eve/*`, `EVE_TOKEN`).
- [x] Dry run (per-turn `dryRun`, global `EVE_DRY_RUN` kill-switch): a full turn with no Telegram delivery.
- [x] Durable events (`EveEvent`), delayed turns (`EveDelayedAction`), dedupe.
- [x] Dashboard `/eve`: personas, bindings, allowlists, memory tab.
- [x] Speech-to-text: `SpeechService` (messaging layer), env-only `STT_*` —
      Parakeet TDT 0.6B v3, `remote|local|disabled`, no automatic local
      failover unless `STT_LOCAL_FALLBACK=on`, whisper only via
      `STT_ENGINE=whisper`. Voices and `audio/*` documents are transcribed;
      the transcribe endpoint falls back on `PREMIUM_REQUIRED`
      (`messaging.transcribe.local`) and degrades to `null` when no engine is
      configured.

## Still on mtcute (works only while the old session exists)
`resolveChat`, chat settings/delete, and the admin tools (members, bans, rights,
invite links). None of these take a message id.

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
