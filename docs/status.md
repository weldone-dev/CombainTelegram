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
- [x] Settings section: the area is AI-only now — `/settings` redirects to
      `/settings/ai`, and `/settings/accounts`, `/settings/proxy`,
      `/settings/logs` redirect there too; accounts, proxies and logs moved to
      the top-level `/accounts`, `/proxies`, `/logs` pages.

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
- API: 801 tests in 60 files, `tsc`, `oxlint`, `nest build` green.
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

### AI layer
Reference: `docs/ai.md`. Code: `apps/api/src/ai`, `ai-access`, `ai-account`,
`ai-chat`, `ai-providers`, `mcp`, `bots`, `automations`; UI: `/ai`, settings at
`/settings/ai`, per-account AI dialog on `/accounts`.

- [x] DB: `Soul`, `SoulSkill`, `Skill`, `SoulTurn`, `SoulSummary`,
      `SoulMemory`, `TelegramBot`, `BotSkill`, `BotTurn`, `Automation`,
      `AutomationRun`, `AiSetting`, `AiProvider`, `AiChatAccess`,
      `AiChatBlock`, `AiChatSkill`, `AiChatEvent`, `AiAccountSetting`,
      `AgentRun`; migrations `ai_souls`, `ai_secrets`,
      `ai_api_key_envelope`, `reasoning_effort`, `ai_chat_controls`,
      `ai_account_controls`.
- [x] Souls: one persona per account, `off/draft/auto`, allowlist/limits,
      lazy creation; DM autopilot replies only in allowlisted private chats
      (draft emits `ai.draft`, auto sends and emits `ai.reply`).
- [x] Memory: short-term `SoulTurn` buffer + rolling `SoulSummary` and
      `SoulMemory` facts, keyword/importance/recency retrieval, manual and
      automatic compaction (≥30 turns, oldest ≤60, keep newest 12); read-only
      per-chat view at `GET /accounts/:id/chats/:chatId/memory`.
- [x] Skills: six seeded built-ins (`soul-creator`, `dm-assistant`,
      `human-style`, `memory-curator`, `automation-builder`,
      `telegram-assistant`), tool allowlists, UI/agent authoring, soul/bot
      attachment, plus a per-chat/topic override (`AiChatSkill`,
      `GET/PUT/DELETE .../ai-skills`, empty override = no skills).
- [x] Automations: `every`/`daily`/`incoming_message`/`manual` triggers,
      `agent`/`send_message`/`summarize` actions, 15 s in-process scheduler,
      run history, immediate HTTP Run.
- [x] Bots: shared soul-creator bot (`accountId = null`) and one assistant bot
      per account, BotFather token (validated with `getMe`, encrypted with
      AAD `bot:<id>`), long polling every 10 s, owner-only access,
      `/start /help /id /reset`; no dashboard UI (REST/MCP only).
- [x] Agent: OpenAI-compatible chat completions, 45 tools in one registry,
      `AgentRun` with trace, token counts and `source`
      (`ui/mcp/dm/bot/automation/soul-creator/test`).
- [x] MCP: stateless Streamable HTTP `POST /mcp`, Bearer token, `initialize`,
      `ping`, `tools/list`, `tools/call`, `prompts/*`, `resources/*`;
      same tool registry and policy as the agent.
- [x] Dashboard `/ai`: three tabs — Агент (one global agent, no account/chat
      selector), Скиллы, Автоматизации; souls moved to the «Настройки ИИ»
      dialog on `/accounts`; bot panel removed.
- [x] Settings: `/settings` and the old `/settings/{accounts,proxy,logs}` routes
      redirect to the AI-only `/settings/ai` (providers, legacy card, STT,
      permissions, MCP + tools).
- [x] Providers: presets (`opencode-go` with the OpenCode token and the Go base
      URL, `custom`), encrypted keys (`enc:v1:…`, AAD `ai-provider:<id>`,
      responses only carry `hasKey`/`keySource`), one default,
      `resolve()` provider → `AiSetting` → env, `import-settings`,
      `POST /ai/providers/:id/test` (8 s, key never echoed).
- [x] Dynamic models: `GET /ai/providers/:id/models` (`<baseUrl>/models`, 10 s,
      5 min cache, `source: provider|stored`), `PUT .../models` saves the chosen
      list and repairs a stale default.
- [x] Provider limits: `AiProvider.limits` (`maxPerHour`/`maxPerDay`),
      `GET/PATCH /ai/providers/:id/limits`, real OpenCode Go usage meters
      (`rolling`/`weekly`/`monthly` from `/inference/go/v1/usage`) plus local
      `AgentRun` counters (`observed`); `source: provider|manual`. Stored limits
      are not enforced in the LLM path.
- [x] Shared key-candidate chain for `models`/`limits`/`test`: OpenCode token →
      stored key → `AiSetting` key → `AI_API_KEY`, deduped, `401/403` moves on.
- [x] Per-account capabilities: `AiAccountSetting` deltas,
      `GET/PATCH /accounts/:id/ai-settings`, `null` removes an override,
      `AiAccountPolicyService` merges per key and still applies allowlists and
      `dryRun`; the registry filters tools by the effective set.
- [x] Per-chat access and blacklist: `AiChatAccess` + `AiChatBlock`, whole-chat
      `threadId = 0` vs forum topic/comment thread, block > row > soul > deny,
      10 s decision cache, one-time `ai.access.seed` from soul `chatIds`,
      `ai-access`/`ai-block`/`ai-warning` endpoints, `AI_BLOCK_AFTER_WARNINGS`
      (default 3, internal `blockedBy = "warning"` rows).
- [x] Per-chat audit: `AiChatEvent` (`warning`/`block`/`unblock`/`clear`/
      `access`), `GET .../ai-events`, warning clear without unblock
      (`DELETE .../ai-warnings`), chat log filters with a deep link to
      `/logs?accountId=&chatId=&level=` (`/logs/stats` takes the same filters).
- [x] Speech-to-text: Parakeet TDT 0.6B v3 only — `sttEngine`
      `remote|local|disabled`, remote LAN LXC (OpenAI-compatible, `/health`
      probe cached 60 s, 300 s budget) or local `sherpa-onnx`; no automatic local
      failover unless `STT_LOCAL_FALLBACK=on`, whisper only via
      `STT_ENGINE=whisper`; fixed model `parakeet-tdt-0.6b-v3`; explicit
      `undici` agent bypasses `HTTP(S)_PROXY` for private hosts; voice notes and
      `audio/*` documents are transcribed in the DM autopilot
      (`dm.autopilot.voice`, `speech.transcribe`), and the transcription
      endpoint falls back on `PREMIUM_REQUIRED` (`messaging.transcribe.local`).
- [x] Automations per chat: `chatId`/`threadId` binding, `createdBy`
      (`user`/`soul`/`assistant`), IANA `timezone` for `daily`,
      `selfPausedAt`/`selfPauseReason`, chat card endpoint, pause/resume by chat
      or by id, scheduler and incoming matching skip paused rows.
- [x] Reasoning stays local: `AgentRun.reasoning` and `messageIds`,
      `ai.reply`/`ai.draft` carry `reasoning` for the dashboard; only reply text
      is sent to Telegram.
- [x] Reasoning stream: `ai.thinking` (`start` → throttled `delta` → `done`
      with the full text) from the autopilot, the strip above the composer, and
      `LlmService.chatStream()` (SSE) with a blocking fallback.
- [x] Messenger merge: live bubbles and history are merged by id and then by a
      ±5 s signature (temporary TDLib id vs the real one), reasoning is remapped
      and kept once per `runId` (`apps/dashboard/src/lib/message-merge.ts`).
- [x] Tools: 45 in the registry (38 with default capabilities, because
      `delete`/`policy`/`admin` are off), including
      `ai_access_get/set`, `chat_warn/block/unblock`,
      `automation_pause_chat/resume_chat`; muting via `ai_access_set` and the
      blacklist sit behind `admin`.
- [x] Messenger UI: AI chip in the chat header (allow/mute, block, unblock),
      tabbed info panel (Обзор · Доступ ИИ · Память · Скиллы · Автоматизации ·
      Медиа · Ссылки · Опросы · Логи, + Похожие/Управление), own voice bubble
      with transcription.

Live checks:
- [x] Agent answered through `POST /ai/chat` after calling `accounts_list`
      (2 steps: the tool call + the answer).
- [x] MCP: `initialize`, `tools/list` (38 tools with default capabilities,
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
- [x] API suite: 60 files, 801 tests passed (config, memory, agent, LLM
      streaming/fallback, MCP, autopilot, presence, bots, automations,
      providers/presets/models/limits, per-chat access/events/skills, memory,
      speech, logs).

Not yet re-checked live after the second batch (unit tests and the builds cover
it): provider presets/models/limits against OpenCode Go, the `ai.thinking` strip
in a real autopilot reply, per-account permission deltas and per-chat skills on a
live Telegram account.

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
