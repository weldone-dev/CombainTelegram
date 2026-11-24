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
- [x] Settings section: `/settings` (general) plus `/settings/ai`, `/accounts`,
      `/proxy`, `/logs`; provider, permission, MCP and tool-list cards moved off
      `/ai` to `/settings/ai`.

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
- API: 697 tests in 54 files, `tsc`, `oxlint`, `nest build` green.
- Dashboard: `tsc`, `biome`, `next build` green.
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

### AI layer
Reference: `docs/ai.md`. Code: `apps/api/src/ai`, `ai-access`, `ai-providers`,
`mcp`, `bots`, `automations`; UI: `/ai`, settings at `/settings/ai`.

- [x] DB: `Soul`, `SoulSkill`, `Skill`, `SoulTurn`, `SoulSummary`,
      `SoulMemory`, `TelegramBot`, `BotSkill`, `BotTurn`, `Automation`,
      `AutomationRun`, `AiSetting`, `AiProvider`, `AiChatAccess`,
      `AiChatBlock`, `AgentRun`; migrations `ai_souls`, `ai_secrets`,
      `ai_api_key_envelope`, `reasoning_effort`, `ai_chat_controls`.
- [x] Souls: one persona per account, `off/draft/auto`, allowlist/limits,
      lazy creation; DM autopilot replies only in allowlisted private chats
      (draft emits `ai.draft`, auto sends and emits `ai.reply`).
- [x] Memory: short-term `SoulTurn` buffer + rolling `SoulSummary` and
      `SoulMemory` facts, keyword/importance/recency retrieval, manual and
      automatic compaction (≥30 turns, oldest ≤60, keep newest 12).
- [x] Skills: six seeded built-ins (`soul-creator`, `dm-assistant`,
      `human-style`, `memory-curator`, `automation-builder`,
      `telegram-assistant`), tool allowlists, UI/agent authoring, soul/bot
      attachment.
- [x] Automations: `every`/`daily`/`incoming_message`/`manual` triggers,
      `agent`/`send_message`/`summarize` actions, 15 s in-process scheduler,
      run history, immediate HTTP Run.
- [x] Bots: shared soul-creator bot (`accountId = null`) and one assistant bot
      per account, BotFather token (validated with `getMe`, encrypted with
      AAD `bot:<id>`), long polling every 10 s, owner-only access,
      `/start /help /id /reset`.
- [x] Agent: OpenAI-compatible chat completions, 45 tools in one registry,
      `AgentRun` with trace, token counts and `source`
      (`ui/mcp/dm/bot/automation/soul-creator/test`).
- [x] MCP: stateless Streamable HTTP `POST /mcp`, Bearer token, `initialize`,
      `ping`, `tools/list`, `tools/call`, `prompts/*`, `resources/*`;
      same tool registry and policy as the agent.
- [x] Dashboard `/ai`: Агент, Души с памятью, Скиллы, Автоматизации, Боты;
      provider/model, dryRun, capabilities, allowlists, MCP and the tool list
      moved to «Настройки → AI» (`/settings/ai`).
- [x] Providers: `AiProvider` list with encrypted keys (`enc:v1:…`, AAD
      `ai-provider:<id>`, responses only carry `hasKey`), one default,
      `resolve()` provider → `AiSetting` → env, `import-settings`,
      `POST /ai/providers/:id/test` (8 s, key never echoed).
- [x] Per-chat access and blacklist: `AiChatAccess` + `AiChatBlock`, whole-chat
      `threadId = 0` vs forum topic/comment thread, block > row > soul > deny,
      10 s decision cache, one-time `ai.access.seed` from soul `chatIds`,
      `ai-access`/`ai-block`/`ai-warning` endpoints, `AI_BLOCK_AFTER_WARNINGS`
      (default 3, internal `blockedBy = "warning"` rows).
- [x] Speech-to-text: remote LAN LXC (OpenAI-compatible, `/health` probe cached
      60 s, 300 s budget) → local Parakeet TDT 0.6B v3 (`sherpa-onnx-node`) →
      whisper.cpp → `null`; explicit `undici` agent bypasses `HTTP(S)_PROXY`
      for private hosts; voice notes and `audio/*` documents are transcribed in
      the DM autopilot (`dm.autopilot.voice`, `speech.transcribe`), and the
      transcription endpoint falls back on `PREMIUM_REQUIRED`
      (`messaging.transcribe.local`).
- [x] Automations per chat: `chatId`/`threadId` binding, `createdBy`
      (`user`/`soul`/`assistant`), IANA `timezone` for `daily`,
      `selfPausedAt`/`selfPauseReason`, chat card endpoint, pause/resume by chat
      or by id, scheduler and incoming matching skip paused rows.
- [x] Reasoning stays local: `AgentRun.reasoning` and `messageIds`,
      `ai.reply`/`ai.draft` carry `reasoning` for the dashboard; only reply text
      is sent to Telegram.
- [x] Tools: 45 in the registry (39 with default capabilities), including
      `ai_access_get/set`, `chat_warn/block/unblock`,
      `automation_pause_chat/resume_chat`; muting via `ai_access_set` and the
      blacklist sit behind `admin`.
- [x] Messenger UI: AI chip in the chat header (allow/mute, block, unblock),
      full access editor in the info panel and comment-thread drawer, own voice
      bubble with transcription.

Live checks:
- [x] Agent answered through `POST /ai/chat` after calling `accounts_list`
      (2 steps: the tool call + the answer).
- [x] MCP: `initialize`, `tools/list` (39 tools with default capabilities,
      because `delete`/`policy`/`admin` are off) and `tools/call accounts_list`
      over `POST /mcp` with the Bearer token.
- [x] dry-run send: `messages_send` returned
      `{ "dryRun": true, "wouldCall": "messages_send", ... }`; nothing was sent.
- [x] dry-run automation: a manual `send_message` automation ran and returned
      `dryRun: would send to 777: …`; the run row was written.
- [x] «Настройки → AI» renders (`/settings/ai` answers 200; providers, model,
      permissions, MCP and tool list load); the MCP endpoint uses the API
      origin, not :3000.
- [x] MCP capability gate: with `mcp=false` every method answers `-32001`;
      restored to true afterwards.
- [x] Soul settings are merged: `PUT {settings:{maxPerHour:7}}` kept the
      existing `chatIds` and other values.
- [x] Attached-but-disabled skills stay attached in `SoulView.skills`.
- [x] API suite: 54 files, 697 tests passed (config, memory, agent, MCP,
      autopilot, bots, automations, providers, per-chat access, speech).

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
