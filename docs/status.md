# TDLib migration — live status

Updated: 2026-11-23. This file is the single place to check progress.

## Decisions (fixed)
- Working session: native TDLib, official `api_id` (user's decision).
- Old mtcute/desktop session is **never logged out**; it stays as a fallback.
- 2FA cloud password is stored encrypted (AES-256-GCM), never logged.
- Login method for tdata/migration: TDLib generates a QR, the existing session
  approves it. Phone code is kept as an alternative for new accounts.
- The phone-code path through `777000` does not work in practice: Telegram sends
  that code by SMS, so QR is the primary flow.

## Done
- [x] Live proof: TDLib QR + `auth.acceptLoginToken` from the existing session,
      2FA password accepted, `authorizationStateReady`, old session untouched.
- [x] Prebuilt native TDLib (linux-x64) loads under this machine.
- [x] DB: `TelegramSession.engine` / `tdlibPath` / encrypted DB key,
      `TelegramAccount.cloudPassword*`; migrations applied.
- [x] `TdClientManagerService`: one native client per session, per-session
      folders, encrypted `database_encryption_key`, proxy support, official
      Android profile, `TELEGRAM_ENGINE` / `TDLIB_DATA_DIR` settings.
- [x] `attachTdlibSession` (account + TDLib session persistence), `engine` in
      session views.
- [x] TDLib login/migration HTTP API (`tdlib-auth` worker, merged).
- [x] **Live migration of the real account**: migration endpoint -> QR approved
      by the existing session -> 2FA password -> `ready`. Result: one `tdlib`
      session + the untouched mtcute session, cloud password stored encrypted.
- [x] TDLib session reopens from its encrypted database after a process
      restart (`getMe` confirms the same user).

## In progress (Orca workers)
- [x] `tdlib-ui` — no device picker, QR/code/password flow, migration card,
      engine badge. Merged.
- [ ] `tdlib-messaging` — TDLib chats/history/send/media/files behind a switch,
      automatic fallback to mtcute.

## Next
- [ ] Merge workers, wire modules, restart dev servers.
- [ ] Attach the already-authorized TDLib session to the account (keeps mtcute).
- [ ] Realtime from TDLib (new/edited/deleted/read/typing) with dedupe.
- [ ] Live end-to-end check (chats, ordering, media/CDN, send to `@username_dev`).
- [ ] Update `docs/architecture.md` and `docs/auth.md`.

## Safety rules
- No `auth.logOut` on the user's Telegram Desktop session.
- No live Telegram login from workers; live checks are run by the coordinator.
- Every TDLib path has an mtcute fallback, so the app keeps working.
