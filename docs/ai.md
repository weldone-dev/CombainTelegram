# AI, souls, memory and MCP

Status: implemented 2026-11-24 (`897e420`; second batch in the working tree).
Code: `apps/api/src/ai`, `apps/api/src/ai-access`, `apps/api/src/ai-account`,
`apps/api/src/ai-chat`, `apps/api/src/ai-providers`, `apps/api/src/mcp`,
`apps/api/src/bots`, `apps/api/src/automations`; UI: `/ai`, AI settings at
`/settings/ai` (the only settings page), per-account AI dialog on `/accounts`.

## 1. What this layer is

A local AI layer on top of the multi-account Telegram app:

- **Agent** — an OpenAI-compatible LLM with tool calling. It can read accounts,
  chats and messages, send replies, and edit the app's own configuration
  (souls, memory, skills, automations, bots, permissions).
- **Soul (душа)** — one persona per Telegram account: who it is, tone, goals,
  boundaries, language, optional model override and autopilot settings.
- **Memory** — two levels per personal chat: a short-term buffer of recent
  turns and a long-term rolling summary plus extracted facts.
- **Skills** — reusable markdown instruction packs attached to souls, bots and
  single chats/topics.
- **Automations** — schedule or incoming-message triggers with an agent,
  message or memory action; can be bound to one chat/topic and paused for it.
- **Bots** — one shared soul-creator bot and one assistant bot per account over
  the Telegram Bot API (long polling, no webhooks). REST/MCP only: the
  dashboard has no bot UI.
- **MCP** — a Streamable HTTP MCP endpoint (`POST /mcp`) that exposes the same
  tools to external clients (Claude Desktop, Codex, Orca, custom agents).
- **Providers** — a list of OpenAI-compatible LLM endpoints created from a
  preset (`opencode-go`, `custom`), each with an encrypted key (or the local
  OpenCode token), a live model list and its own limits.
- **Speech-to-text** — Parakeet TDT 0.6B v3 only: the remote LAN service or the
  local `sherpa-onnx` model.
- **Per-chat access and state** — an allow/mute row, a blacklist and a warning
  counter, a skill override, a read-only memory view and an audit trail per
  chat or forum topic, independent of the soul's own chat allowlist.
- **Per-account capabilities** — a delta on top of the global permission policy,
  so one account can lose (or gain) a capability without touching the rest.

There is exactly **one tool registry** (`AgentToolsService`) and **one policy
entry point** (`AiAccountPolicyService`, which layers the account overrides on
`AiPolicyService`). The dashboard agent, MCP clients, bots and automations all
call the same registry and the same policy code, so a tool cannot be disabled for
one surface and forgotten in another; only the capability verdict (global, then
the account delta) differs.
Every agent invocation is stored in `AgentRun` with its `source` (`ui`, `mcp`,
`dm`, `bot`, `automation`, `soul-creator`, `test`) and a tool-call trace.

The default posture is conservative: `dryRun` is on, writes to Telegram are
simulated, `sendUnknown` is off, and unknown chats are refused.

## 2. Provider configuration

Any endpoint that implements `POST /chat/completions` works (OpenAI, DeepSeek,
OpenRouter, OpenCode Zen, Ollama, a local gateway):

```dotenv
# apps/api/.env (gitignored)
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
AI_FAST_MODEL=deepseek-chat
AI_API_KEY=sk-...
MCP_TOKEN=optional-fixed-token
# optional: point bot long polling at a local Bot API server
TELEGRAM_BOT_API_BASE=https://api.telegram.org
```

Resolution order:

| Setting | Database (`AiSetting`) | Environment | Default |
| --- | --- | --- | --- |
| `baseUrl` | value if non-empty | `AI_BASE_URL` | – |
| `model` | value if non-empty | `AI_MODEL` | – |
| `fastModel` | value if non-empty | `AI_FAST_MODEL`, else `model` | `model` |
| `apiKey` | encrypted value if present | `AI_API_KEY` | – |
| `provider` | value | – | `openai-compatible` |
| `reasoningEffort` | value | `AI_REASONING_EFFORT` | `low` |
| `temperature`, `maxSteps`, `dryRun`, permissions, allowlists | value | – | see §9 |
| MCP token | encrypted value | `MCP_TOKEN` | random 32 bytes, generated and stored |

The table describes the legacy single-provider fields. A configured default
`AiProvider` is resolved first (see "Providers" below); `AiSetting` is the
fallback, the environment the last resort.

`AI_BASE_URL`, `AI_MODEL`, `AI_FAST_MODEL` and `AI_API_KEY` are read at runtime;
a value saved in the UI wins over the environment. The legacy card on
Настройки → AI (shown only while the provider list is empty) is read-only: it
prints the URL, both models, temperature, the step budget, the reasoning effort
and where the key came from. The key itself is stored as an AES-256-GCM envelope
(`SessionCryptoService`, AAD `ai:api-key`) and is never returned in full — the
settings show `…1234` and `env`/`db`. A stored key is edited or cleared through
`PUT /ai/settings`; with an effective default provider these legacy fields only
apply once that provider is disabled or has no URL/model.

The MCP token is generated once (64 hex chars) and stored encrypted with AAD
`ai:mcp-token`. With `MCP_TOKEN` set and nothing stored yet, the env value is
used; after `POST /ai/mcp/rotate` the database value always wins.

### Providers

`AiProvider` is the provider list behind `/settings/ai`: `name`, `kind`,
`preset`, `baseUrl`, JSON `models`, `defaultModel`, `reasoningEffort`,
`isDefault`, `enabled`, `apiKey` and JSON `limits`. The key is encrypted with
`SessionCryptoService` (AAD `ai-provider:<id>`) and stored in the row as
`enc:v1:<base64 envelope>`; responses only carry `hasKey` and `keySource`,
never the value. Rows written by hand with a plain key still work.

Presets (`GET /ai/providers/presets`):

| Preset | Base URL | Key | Default model |
| --- | --- | --- | --- |
| `opencode-go` | `https://opencode.ai/inference/go/openai/v1` | OpenCode token, `keySource: "opencode"` (nothing is stored on the row) | `deepseek-v4.1-flash` |
| `custom` | empty, filled by hand | stored key, `keySource: "stored"` | – |

A preset only supplies defaults: name, base URL, kind and the model stay
editable, exactly like a hand-created provider. An unknown `preset` on create is
`400 INVALID_PRESET`; the update route does not change the stored preset.
`keySource` is derived from the stored preset, so an `opencode-go` row never
carries a key and still works (§ "OpenCode Go via Orca").

Rules:

- the first provider is created as the default when it is enabled, so a fresh
  install never has a row the resolver ignores;
- setting `isDefault` (or `POST /ai/providers/:id/default`) demotes the previous
  default in one transaction; deleting the default promotes the oldest enabled
  provider (`promotedId` in the answer);
- `POST /ai/providers/:id/test` sends one minimal `chat/completions`
  (`max_tokens: 1`, `temperature: 0`, 8 s budget) and returns
  `{ ok, status, latencyMs, error? }`; a provider without a URL or a model
  answers `ok: false` with the reason, and the key is never echoed;
- `POST /ai/providers/import-settings` copies the current `AiSetting`
  (URL, model, key, effort) into a first provider. It runs once at boot and is
  idempotent: nothing happens when a provider already exists.

#### Models

`GET /ai/providers/:id/models` asks the provider itself
(`<baseUrl>/models`, 10 s budget) so the dashboard never asks for a model id by
hand:

- `{ data: [...] }`, `{ models: [...] }` and a bare array are accepted; ids are
  deduplicated, and an entry may carry `label` and `type`;
- the answer is cached in memory per provider for **5 min** (dropped only when
  the base URL changes or the row is deleted); a cache hit adds
  `cached: true` and `fetchedAt`;
- `source: "provider"` means a live list; on any failure the list stored on the
  row comes back as `source: "stored"` together with `error`, so the UI always
  has something to offer;
- `PUT /ai/providers/:id/models { models, defaultModel? }` saves the chosen
  list; if the current `defaultModel` is no longer listed, the first model
  becomes the default.

#### Limits and usage

`GET /ai/providers/:id/limits` returns
`{ source, limits, observed?, usage?, error?, checkedAt }`:

- `limits` — the stored JSON `{ maxPerHour?, maxPerDay? }`; absent or `0` means
  unlimited. `PATCH /ai/providers/:id/limits` merges a patch: `undefined` keeps
  a value, `null` removes it, anything that is not a non-negative integer is
  `400 INVALID_LIMIT`;
- `observed` — local `AgentRun` counters for the last hour and the last day
  (`{ lastHour, lastDay }`). These are app-wide, not per provider;
- `usage` — real provider quota meters, `rolling` (OpenCode Go's 5-hour
  window), `weekly` and `monthly`, each `{ status, percent 0–100, resetsAt }`.
  Only OpenCode Go exposes them, at
  `https://opencode.ai/inference/go/v1/usage`; the URL is rebuilt from the
  origin whenever `baseUrl` points at `opencode.ai/inference/go…`, because the
  chat path (`/inference/go/openai/v1`) is not the usage path;
- `source: "provider"` only when that usage call really answered; every other
  provider — and any failure — reports `source: "manual"` with the stored
  limits and counters plus `error`.

The stored limits are **informational**: nothing in the LLM path throttles on
them yet (§15). The limits that are enforced are the soul's own
`maxPerHour`/`maxPerChatPerDay` (§4).

#### Key candidates

`models()`, `limits()` and `test()` share one chain, most specific first:
OpenCode token (only for an `opencode` preset) → stored provider key → legacy
`AiSetting` key → `AI_API_KEY`. Candidates are deduplicated and the chain ends
with a single unauthenticated attempt when nothing is configured, which is how
a local Ollama-style endpoint works. A `401`/`403` moves on to the next
candidate (an expired OpenCode token must not hide a working `AI_API_KEY`);
transport errors are not retried because every candidate would hit the same
network. One implementation, so the three calls cannot drift.

`AiConfigService.resolved()` asks `AiProvidersService.resolve()` first: the
default enabled provider with a non-empty `baseUrl` and a model (`defaultModel`,
else the first of `models`) supplies URL, model, key and reasoning effort. If no
provider is effective, the legacy `AiSetting` row is used, then
`AI_BASE_URL`/`AI_MODEL`/`AI_API_KEY`/`AI_REASONING_EFFORT`. The key order is
`AI_API_KEY_SOURCE=opencode` → provider key → encrypted `AiSetting` key →
`AI_API_KEY`. `AI_EXTRA_HEADERS` is forwarded in all branches.

`LlmService` sends one request per agent step: 90 s timeout, up to 3 attempts
with a 400 ms × attempt pause. Every failure goes through that loop (a bad key is
attempted three times), then the run fails with the provider's message. Each step
asks for at most 1 800 completion tokens. The fallback summary (when the model
spends its whole step budget on tools) asks for 800. `temperature` is clamped to
0…2 and `maxSteps` to 1…12 (default 6). `reasoningEffort` (`off`/`low`/`medium`/
`high`, default `low`, env `AI_REASONING_EFFORT`) is sent as `reasoning_effort`;
image understanding needs a model that accepts `image_url` content parts
(`deepseek-v4.1-flash` on OpenCode Go does);
when the provider returns `reasoning_content` it is stored in
`AgentRun.reasoning` and shown as a collapsible «Размышления» block in the
dashboard chat. Reasoning is silent in Telegram: no `typing…` is sent while the
model thinks, the indicator starts only when there is text to type. For DM
replies the run also records the ids of the bubbles it produced
(`AgentRun.messageIds`, a JSON array), and the `ai.reply`/`ai.draft` payload
carries `reasoning`; only the reply text is passed to `sendMessage`, reasoning
is never sent to Telegram. While the model works, the autopilot also streams the
reasoning to the dashboard as `ai.thinking` events (§13).

### OpenCode Go via Orca

Orca's OpenCode Go subscription works too. The Go endpoint needs an OAuth access
token (the `st_` value, not the expired `sk-` API key from the console) and a
session header:

```dotenv
AI_BASE_URL=https://opencode.ai/inference/go/openai/v1
AI_MODEL=deepseek-v4.1-flash
AI_FAST_MODEL=deepseek-v4.1-flash
# off | low | medium | high (default low)
AI_REASONING_EFFORT=low
AI_EXTRA_HEADERS={"x-opencode-session":"ses_combaintelegram"}
# Read the live token from Orca's OpenCode database and follow its refreshes.
AI_API_KEY_SOURCE=opencode
# Optional fallback if the database cannot be read.
AI_API_KEY=st_...
```

Any stable `ses_*` value is accepted. `AI_API_KEY_SOURCE=opencode` reads the
active OAuth credential from `~/.local/share/opencode/opencode.db`; Orca refreshes
it. `OPENCODE_DB` overrides the path. Without the database source, copy `access`
from `opencode auth export` into `AI_API_KEY` and refresh it manually before it
expires.

The same token backs the `opencode-go` provider preset: that row stores no key
and `models`, `limits` and `test` read `AI_API_KEY_SOURCE=opencode` as the first
candidate. With the variable unset the preset has no key at all (chat falls back
to the stored/`AiSetting`/`AI_API_KEY` chain), so set it once before creating the
provider.

DeepSeek `deepseek-chat` is the model used for the live checks below; other
OpenAI-compatible providers are drop-in replacements.

## 3. Data model

| Model | Key fields | Purpose |
| --- | --- | --- |
| `Soul` | unique `accountId`, `name`, `essence`, `tone`, `goals`, `boundaries`, `language`, `systemPrompt`, `mode`, JSON `settings`, `model`, `temperature` | one persona per account |
| `SoulSkill` | `soulId` + `skillId` | many-to-many soul↔skill |
| `SoulTurn` | `accountId`, `chatId`, `role` (`user`/`assistant`/`system`/`tool`/`draft`), `content`, `messageId`, `runId` | short-term dialogue buffer |
| `SoulSummary` | unique `accountId + chatId`, `summary`, JSON `facts`, `turnsThrough` | rolling long-term summary |
| `SoulMemory` | `accountId`, optional `chatId`, `kind`, `content`, `importance` 1–5, `source` | durable facts (account-wide or per chat) |
| `Skill` | unique `slug`, `name`, `instructions`, JSON `tools`, `origin`, `enabled` | reusable instruction pack |
| `TelegramBot` | unique `accountId` (null for the shared bot), `mode`, encrypted token columns, JSON `allowedUserIds`, `lastUpdateId`, `lastError` | Bot API control surface |
| `BotSkill` | `botId` + `skillId` | bot↔skill |
| `BotTurn` | `botId`, `chatId`, `role`, `content` | bot conversation buffer (trimmed to 40) |
| `Automation` | optional `accountId`, `chatId`, `threadId` (`0` = whole chat), `soulId`, `createdBy` (`user`/`soul`/`assistant`), IANA `timezone`, `enabled`, `triggerType`, JSON `trigger`, `actionType`, JSON `action`, `selfPausedAt`, `selfPauseReason`, `lastRunAt`, `nextRunAt`, `runCount` | trigger → action rule, optionally bound to one chat/topic |
| `AutomationRun` | `automationId`, `status`, JSON `input`, `output`, `error`, timestamps | run history |
| `AiSetting` | singleton `default`: provider, endpoints, models, encrypted keys, `reasoningEffort`, STT columns, `dryRun`, JSON capabilities/allowlists | provider fallback + permission policy |
| `AiProvider` | `name`, `kind`, `preset` (null = custom), `baseUrl`, `apiKey` (`enc:v1:…`), JSON `models`, `defaultModel`, `reasoningEffort`, JSON `limits`, `isDefault`, `enabled` | configurable LLM endpoints, one default |
| `AiChatAccess` | `userId`, `accountId`, `chatId`, `threadId` (`0` = whole chat), optional `soulId`, `enabled`, `note`; unique per account+chat+thread | per-chat/topic allow-mute for the soul |
| `AiChatBlock` | `accountId`, `chatId`, `threadId`, `reason`, `warnings`, `blockedBy` (`user`/`soul`/`warning`); unique per account+chat+thread | blacklist; a `warning` row is only a counter |
| `AiChatSkill` | `accountId`, `chatId`, `threadId` (`0` = whole chat), JSON `skillSlugs`; unique per account+chat+thread | skill override for one chat/topic |
| `AiChatEvent` | `accountId`, `chatId`, `threadId`, `kind` (`warning`/`block`/`unblock`/`clear`/`access`), `reason`, `warnings`, `actor` (`user`/`soul`/`system`) | append-only audit trail of AI decisions about a chat |
| `AiAccountSetting` | unique `accountId`, JSON `permissions` (`{}` = inherit the global policy) | per-account capability overrides |
| `AgentRun` | optional `accountId`/`soulId`/`chatId`, `source`, `prompt`, `output`, `reasoning`, JSON `messageIds`, `model`, `steps`, JSON `trace`, token counts, `status` | every agent invocation |

Migrations: `20261123230239_ai_souls`, `20261123230327_ai_secrets`,
`20261123231007_ai_api_key_envelope`, `20261124122851_reasoning_effort`
(`reasoning`, `reasoningEffort`), `20261124152734_ai_chat_controls`
(`AiChatAccess`, `AiChatBlock`, `AiProvider`, `AgentRun.messageIds`, automation
chat binding, STT columns), `20261124174416_ai_account_controls`
(`AiChatSkill`, `AiChatEvent`, `AiAccountSetting`, `AiProvider.preset`/`limits`).
The tables have no user foreign key — the app is
single-user; `Soul.accountId` and `TelegramBot.accountId` are unique,
`Automation.accountId` is optional (null = global rule). Access, block, skill,
event and account-setting rows cascade with the account (access and block also
with the soul), `Automation.soulId` becomes null when the soul is deleted.

## 4. Souls and autopilot

`GET/PUT /accounts/:accountId/soul` reads/updates a soul. Rows are created
lazily with `name = firstName || username || "Аккаунт"` and `mode = "off"`;
`GET /ai/souls` therefore materialises a soul for every attached account.

Fields: `name`, `essence`, `tone`, `goals`, `boundaries`, `language` (default
`ru`), `systemPrompt`, `mode`, `settings`, `model`, `temperature`, `skills`.
`promptFor()` renders these into the system prompt after the base agent rules.

Modes:

- `off` — manual use only (UI chat, MCP, automations). No autopilot.
- `draft` — the agent writes a suggested reply to `SoulTurn` and emits a WS
  event `ai.draft`; nothing is sent to Telegram.
- `auto` — replies in the allowed personal chats.

`Soul.settings`:

| Key | Default | Meaning |
| --- | --- | --- |
| `allowAllChats` | `false` | reply in any private chat except `excludeChatIds` |
| `chatIds` | `[]` | explicit allowlist of private chat ids (Telegram user ids) |
| `excludeChatIds` | `[]` | deny list, checked first |
| `replyDelayMs` | `1200` | human-like pause before replying, 0…120 000 ms |
| `maxPerHour` | `12` | assistant replies per account per hour; `0` disables |
| `maxPerChatPerDay` | `40` | assistant replies per chat per day; `0` disables |
| `typing` | `true` | send `typing` while generating/sending |
| `typingSpeed` | `300` | characters per minute for the typing indicator, clamped to 40…600 (600 = human upper bound) |
| `peerProfile` | `true` | pass the peer's Telegram name, username and profile bio to the agent (cached 10 min, best-effort) |
| `presenceIdleMinutes` | `5` | minutes without activity before the account looks offline; `0` never goes offline |
| `presenceOnlineDelaySeconds` | `5` | delay before the account shows online again after a message that arrived while offline, 0…600 s |
| `presenceReadDelaySeconds` | `0` | extra delay between coming online and the read receipt, 0…300 s |
| `presenceTypingDelaySeconds` | `3` | pause between the read receipt and the first `typing…`, 0…120 s |

`PUT` validates the mode and merges the parsed `settings` into the stored
object: omitted keys keep their current values, and the dashboard sends the full
object anyway.

`DmAutopilotService` subscribes to `message.new` at boot (updates start even with
no dashboard open) and:

1. accepts only private chats (`chatId > 0`), skips outgoing/service messages,
   Saved Messages and messages older than 2 minutes;
2. requires an existing soul with `mode != off` and a chat allowed by the
   per-chat gate (see "Per-chat access and blacklist": block > access row >
   soul settings > deny; the soul's own rule is `excludeChatIds` first, then
   `allowAllChats`, then `chatIds`);
3. debounces per account+chat (`min(1.5 s, max(200 ms, replyDelayMs))`), dedupes
   message ids and accumulates up to 5 consecutive messages, so a burst gets one
   reply covering all of them; every new message bumps a per-chat token and
   cancels the reply that is still generating or typing — its result is dropped,
   `typing…` is hidden and the run restarts with the new context; before
   generating anything it marks the chat read up to the incoming message on the
   active engine — immediately while the account is online, or after the
   presence delays (§4 "Presence") when it was offline — and postpones the reply
   by the same amount, so the sender never sees "online", "read" and "typing…"
   all at once (best-effort: a failed receipt never blocks the reply);
4. enforces `maxPerHour` / `maxPerChatPerDay` by counting assistant `SoulTurn`
   rows;
5. runs the agent with `source = "dm"`, the persona and memory, no tools
   (`tools: []`) and the last 10 turns as history, then appends the incoming
   message to memory; the skill set is resolved per chat/topic first — an
   `AiChatSkill` row for this conversation replaces the soul's skills (§6) — and
   is passed as authoritative (`replaceSoulSkills`), so an override that drops a
   skill is honoured; when `peerProfile` is on, the system prompt also carries
   the peer's username and profile bio (`getChatInfo`), so the soul knows who it
   is talking to; photos and image documents up to 5 MB are downloaded and sent
   to the model as `image_url` content parts (max 2 images, 5 MB total), so a
   vision model can answer about the picture itself (the text placeholder is
   `[изображение]`); voice notes and `audio/*` documents are transcribed and
   passed as `[голосовое] «…»` (see "Voice notes" below); the last photo stays
   attached for follow-up text questions
   like «что тут?» for 3 minutes, because such a question arrives as a separate
   message with no media of its own; when the text asks about a picture but no
   image was attached (or cached), the prompt carries an explicit note not to
   invent the content and to ask for the picture instead, so the soul never
   reports a "blurry" picture it never received;
6. `draft` stores a `draft` turn and emits `ai.draft`; `auto` keeps the thinking
   phase silent (no `typing…` while the model works), then for each reply
   bubble starts a `typing…` heartbeat every 4 s, holds it until
   `typingDurationMs = length / typingSpeed` (0.6…60 s) has elapsed, sends the
   bubble as a Telegram reply, appends the assistant turn and emits `ai.reply`.
   A cancelled run clears the heartbeat and sends `chatActionCancel`, so the
   indicator disappears until the next run.

### Several bubbles and quotes

One incoming burst may need several answers. The prompt gives the model the
numbered burst and this output format:

- split bubbles with a line that is exactly `---` (1–3 recommended, max 5);
- start a bubble with `[#N]` to answer the N-th incoming message;
- add a line `цитата: «…»` to quote a short excerpt of that message
  (TDLib `inputTextQuote`, max 200 chars);
- no Markdown, one thought per bubble.

`parseReply()` (`dm-reply.ts`) turns that into parts. Each part is sent with its
own typing hold, `replyToId` pointing at the chosen incoming message and the
quote, with a 200–400 ms pause between bubbles so they arrive separately. A new
incoming message cancels the remaining bubbles (`dm.autopilot.cancel`,
`phase: "parts"`). Draft mode joins the parts back into one editable draft.

It never starts a conversation: only replies to an incoming message. Autopilot
writes are exempt from `dryRun` because `auto`/`draft` is an explicit opt-in
(§9); the UI says so next to the flag.

### Send confirmation

TDLib answers a send with a temporary message id; the real one arrives with
`updateMessageSendSucceeded`. The API waits for it for `SEND_WAIT_TIMEOUT_MS`
(default **20 s**, clamped 5 s…10 min) and then returns the temporary id with
the message still queued — a stalled proxy is not a failed send, and waiting
two minutes only made the answer look ignored (the second bubble sat behind the
first). A confirmation that arrives later is still recorded as `tdlib.send.late`
(up to 5 min of watching); a slow but in-time one logs `tdlib.send.slow`.

### Presence (online/offline)

`PresenceService` makes the account behave like a person who is not glued to
the phone:

- any outgoing activity (a sent reply or an outgoing message) marks the account
  online and re-arms an idle timer;
- after `presenceIdleMinutes` without activity it calls `setOnline(false)`
  (TDLib option `online`, mtcute `setOnline`), so the peer sees the last-seen
  status instead of "online";
- the first DM after that follows a fixed order, so the sender does not see
  "online", the read receipt and `typing…` in the same instant:

  1. the message arrives while the account is offline: it stays offline and the
     read receipt is postponed;
  2. after `presenceOnlineDelaySeconds` (default 5 s) the account goes online;
  3. `presenceReadDelaySeconds` later (default 0) the chat is marked read — with
     the default the receipt lands as the account appears online;
  4. `presenceTypingDelaySeconds` after the read receipt (default 3 s) the
     autopilot shows `typing…` and starts the reply.

  The reply debounce is shifted by the same total, so the answer never overtakes
  the read receipt or the typing indicator. While the account is already online
  the gate is zero: the chat is marked read immediately and the normal
  `replyDelayMs` debounce applies.

Logs: `presence.offline` (the idle timer fired), `presence.pending` (a DM arrived
while offline; carries the online/read/typing deadlines), `presence.online`
(back online), `presence.option_ignored` (TDLib did not apply the option), plus
the usual `dm.autopilot.read`, `dm.autopilot.peer` (peer profile resolved or
not), `dm.autopilot.image` (a picture was forwarded to the model, or skipped as
too big) and `dm.autopilot.cancel` (a newer message invalidated the in-flight
reply).

### Per-chat access and blacklist

`AiAccessService` (`apps/api/src/ai-access`) answers "may the AI work in this
chat/topic". `AiAccessModule` is `@Global()`: it is registered once in
`AppModule`, and the autopilot and the tool registry (tools used by bots, MCP
and the dashboard agent) inject the service without importing the module, which
would add a second graph edge between `AiModule` and `AiAccessModule`.

Scoping:

- `threadId = 0` means the whole chat; a positive id is a forum topic or a
  channel-comment thread (the root post id). The sentinel exists because SQLite
  treats NULLs as distinct in unique keys and would allow duplicate whole-chat
  rows.
- A positive thread uses its own row and falls back to the whole-chat row; a
  whole-chat block closes every topic of that chat.

Decision for one chat: **block > `AiChatAccess` row > soul settings
(`excludeChatIds`/`allowAllChats`/`chatIds`) > deny**. An `enabled: false` row
shadows the soul allowlist; only a missing row lets the soul decide.

Autopilot gate:

- the decision is taken before anything visible happens: a blocked chat gets no
  agent call, no `typing…` and no read receipt, and the message is logged as
  `dm.autopilot.blocked` with `{chatId, threadId, warnings, reason}`;
- decisions are cached per `accountId:chatId:threadId` for 10 s (max 2 000
  entries, oldest evicted), so a new block applies within 10 s without a restart;
- at boot the soul `chatIds` are copied into whole-chat access rows once
  (`ai.access.seed`, details `{created, selected}`). Existing rows — including
  a human's `enabled: false` — are never overwritten. Because the row now
  exists, later soul `chatIds` edits no longer open or close that chat; edit the
  row instead.

Blacklist and warnings:

- `POST .../chats/:chatId/ai-block` blocks immediately (`blockedBy` `user` or
  `soul`, the client may choose); `DELETE .../chats/:chatId/ai-block` lifts it
  and resets the counter;
- `POST .../chats/:chatId/ai-warning` adds one warning. The counter lives in the
  `AiChatBlock` row with `blockedBy = "warning"`; at `AI_BLOCK_AFTER_WARNINGS`
  (default 3) the same row turns into a real block attributed to `user` or
  `soul`. An already blocked chat is not counted further, and warning-only rows
  are hidden from the block list;
- `DELETE .../chats/:chatId/ai-warnings` zeroes the counter **without**
  unblocking: a row blocked by `user`/`soul` keeps denying access, only its
  `warnings` becomes 0 (`{ removed, warnings, blocked }`);
- every state change appends an `AiChatEvent` (`warning`, `block`, `unblock`,
  `clear`, `access`) with the reason, the resulting counter and the actor
  (`user`/`soul`/`system`). The write is best-effort — a failed audit row is
  logged (`ai.chat.event.record`) and never fails the block itself.
  `GET .../chats/:chatId/ai-events?threadId=&limit=` returns newest first
  (default 50, max 200), exact thread: a topic's history does not include the
  whole-chat rows.

### Voice notes

Voice notes and `audio/*` documents are transcribed by `SpeechService`
(`apps/api/src/ai/speech.service.ts`). It lives in its own `SpeechModule`
because `AiModule` (autopilot) and `MessagingModule` (transcription endpoint)
need the same instance and importing `AiModule` back would close a cycle.

The engine is Parakeet TDT 0.6B v3 in one of two places, chosen by
`AiSetting.sttEngine` (`STT_ENGINE` wins when set):

| `sttEngine` | What runs | Fallback |
| --- | --- | --- |
| `remote` (default) | the LAN Parakeet HTTP service only | none, unless `STT_LOCAL_FALLBACK=on` |
| `local` | the local Parakeet TDT model via `sherpa-onnx-node` | none |
| `disabled` | nothing; `transcribe()` returns `null` | – |

Legacy stored values are mapped on read: `parakeet` → `local`, `auto`, an
unknown value or a legacy `whisper` row → `remote` when a remote endpoint is
configured and `local` otherwise. `whisper.cpp` is an
**internal** last resort: it is reachable only through `STT_ENGINE=whisper` or
the opt-in `STT_LOCAL_FALLBACK=on` chain, never through the settings row, and
`sttEngine: "whisper"` is rejected with `400 INVALID_STT_ENGINE`. The model id is
fixed: `sttModel` must be empty (→ `parakeet-tdt-0.6b-v3`) or start with
`parakeet`, otherwise `400 INVALID_STT_MODEL`.

`transcribe()` never throws: a missing binary, a dead model, a timeout or empty
text returns `null` and the caller answers anyway.

Remote engine:

- base URL `http://192.168.31.108:5092` (Proxmox CT 116 `parakeet-lxc`);
  `POST <base>/v1/audio/transcriptions` (a base already ending in `/v1` or
  `/audio/transcriptions` is used as is) with multipart `file`, `model` and
  `response_format=json`; a `Bearer` header is sent only when a key is stored
  (the LXC needs none, there is no auth);
- `GET <origin>/health` is probed first (5 s timeout); the result is cached
  60 s, so a dead LXC costs one probe per minute. With `sttEngine = "remote"`
  the note then simply fails (`null`) unless `STT_LOCAL_FALLBACK=on`, which
  re-enables the local chain remote → Parakeet → whisper for this case;
- 300 s budget. The returned language is ignored (the LXC hardcodes
  `english`), so `language` is always null;
- configuration is re-read at most every 30 s: `STT_BASE_URL`/`STT_MODEL`
  override the `AiSetting.sttBaseUrl/sttModel` columns, which override the
  defaults; a stored model that does not start with `parakeet` is replaced by
  `parakeet-tdt-0.6b-v3`. `STT_REMOTE=off` or `sttEngine = "disabled"` disables
  the network engine. `AiSetting.sttApiKey` is read from the row; `sttLanguage`
  is stored but the engine does not use it yet.
- **LAN proxy bypass:** the workstation exports `HTTP(S)_PROXY` and that proxy
  answers 503 for private addresses. Requests to a private host (`localhost`,
  `*.localhost`, `10/8`, `127/8`, `192.168/16`, `172.16–31`, `169.254/16`) go
  through an explicit `undici` `Agent` without a proxy; public endpoints keep
  the default dispatcher. Without the bypass the remote engine never works on
  this machine.

Local engines (CPU):

- ffmpeg converts the note to 16 kHz mono WAV (`FFMPEG_BIN`, default `ffmpeg`);
  without ffmpeg there is no local engine;
- Parakeet TDT 0.6B v3 via `sherpa-onnx-node`
  (`encoder/decoder/joiner.int8.onnx` + `tokens.txt`, 4 threads, `cpu`); model
  directory `PARAKEET_MODEL_DIR`, default
  `~/.local/share/combain/parakeet-tdt-0.6b-v3`. The recognizer is loaded once
  per process (~1.1–1.2 GB RSS) and a 4-second note takes ~0.3 s;
- notes longer than 20 s are cut at silences (`silencedetect -45dB/0.25s`) into
  windows of at most 15 s, max 40 chunks; a failed silence scan falls back to
  fixed windows;
- whisper.cpp CLI (`WHISPER_BIN`, default `whisper-cli`; `WHISPER_MODEL`,
  default `~/.local/share/combain/whisper/ggml-small.bin`; `WHISPER_LANG`,
  default `auto`) runs with `-oj` and its JSON is parsed defensively; it is an
  internal env-only path (`STT_ENGINE=whisper`), never selected by the settings
  row;
- the local Parakeet engine reports no language: `language` is null, there is no
  detection;
- `STT_ENGINE` accepts `remote|local|disabled` and wins over the stored row;
  legacy `parakeet` maps to `local`, `auto` maps to `remote` (or `local` when
  `STT_REMOTE=off`), and `whisper` forces the internal CLI;
- at most 2 jobs run at once, input is capped at 25 MB, and the local chain
  shares one deadline (`WHISPER_TIMEOUT_MS`, default 120 s).

In the DM autopilot the transcript replaces the audio in the prompt
(`[голосовое] «…»`, cut at 1 500 chars). A failed note becomes
`[голосовое сообщение, расшифровать не удалось]` with a note telling the model
not to invent content and to ask for text. Every note logs `dm.autopilot.voice`
(`ok`, or `failed` with reason `unavailable`/`empty`/the error), and the engine
logs `speech.transcribe` with `{engine, bytes, ms, chars}`.

The transcription endpoint (`POST .../messages/:messageId/transcribe`) falls
back to the same engine when Telegram answers `PREMIUM_REQUIRED` and logs
`messaging.transcribe.local`; without an engine the original
`403 PREMIUM_REQUIRED` is returned.

## 5. Memory

Two levels, both per `accountId + chatId`:

- **Short-term** — `SoulTurn` rows: raw user/assistant (and `draft`) turns,
  capped at 8 000 chars each.
- **Long-term** — one `SoulSummary` (3–6 sentence rolling summary, plus the
  facts already folded into it, `turnsThrough`) and `SoulMemory` facts with
  `kind` (`fact`, `preference`, `event`, `profile`), `importance` 1–5 and
  `source` (`agent`, `user`, `mcp`, `summary`).

Compaction (`MemoryService.maybeCompact` → `summarize`):

- runs when the buffer has at least 30 turns (`COMPACT_AFTER`), or manually with
  `POST .../memory/summarize` / `memory_summarize` (force works with fewer than
  4 turns);
- loads the **oldest up to 60** turns (`MAX_SUMMARY_TURNS`), sends them to the
  fast model (temperature 0.2, ≤900 tokens) with the current summary and asks
  for `{summary, facts[]}` JSON;
- stores the summary (≤4 000 chars) and up to 20 extracted facts — facts are
  normalised, capped at 600 chars, deduplicated by exact text in the same scope,
  and clamped to importance 1–5;
- prunes the summarised rows, keeping the newest 12 of that batch
  (`KEEP_TURNS`). A buffer larger than 60 therefore shrinks in steps rather
  than to exactly 12.
- requires a configured LLM; without one the automatic attempt logs
  `memory.compact` and gives up, and the manual endpoint returns an error.

Automatic compaction is invoked only after a successful **auto** autopilot reply.
`draft` turns, UI chats and manual sends do not trigger it; use the memory tab or
the manual endpoint instead. The `memory-curator` skill describes the same
compaction task for manual/agent use.

Retrieval (`MemoryService.context`) is keyword + importance + recency ranked, no
embeddings:

- score = word overlap × 3 + importance + recency (0…1 over 30 days), with word
  overlap over tokens of 4+ characters; the top 8 facts for the prompt are
  selected from at most 200 candidates;
- the latest summary and those 8 facts are injected into the system prompt;
- up to 20 recent turns are loaded, and the agent sends the last 14 as
  conversation history (DM autopilot uses the last 10, bots the last 12).

Views and edits:

- `GET /accounts/:accountId/soul/memory?chatId=` returns summary, facts, up to
  50 turns and counts. Without `chatId` only account-wide facts are shown.
- `GET /accounts/:accountId/chats/:chatId/memory?limit=` is the read-only view of
  one chat for the info panel: `{ shortTerm: [{ role, content, createdAt }],
  longTerm: { summary, facts: [{ kind, content, importance, createdAt }] } }`.
  `limit` is capped at 200 (default 50); it never writes, compaction stays in
  `MemoryService`.
- Facts can be added in the UI / `POST .../memory/facts` / `memory_add`.
  Deleting one fact is UI/REST only (`DELETE .../memory/facts/:factId`); there
  is no `memory_delete` tool.
- `DELETE .../memory/chats/:chatId` and `memory_clear` wipe turns, summary and
  facts of one chat; `memory_clear` is gated by the `delete` capability.

## 6. Skills

Built-in packs are seeded once in `SkillsService.onModuleInit()`. Existing rows
are never overwritten, so edits survive restarts:

| Slug | Purpose |
| --- | --- |
| `soul-creator` | interview and edit a soul; the shared bot's default |
| `dm-assistant` | short, human replies in a personal chat |
| `human-style` | strip AI writing habits: no lists, clichés or officialese; messenger-length Russian |
| `memory-curator` | produce the `{summary, facts}` compaction JSON |
| `automation-builder` | turn a request into trigger/action JSON |
| `telegram-assistant` | read chats, draft answers, manage the account; per-account bot's default |

A skill has `slug`, `name`, `description`, `instructions` (markdown prompt),
`tools` (JSON array of tool names) and `enabled`. `origin` is `system` for the
seeds and `user` for everything created from the UI or the agent (the schema
also reserves `agent`, currently unused).

Tool allowlists: when any attached skill has a non-empty `tools` array, the
agent is restricted to the **union** of those arrays (`AgentService` +
`SkillsService.toolsFor`). A skill with an empty array contributes nothing; if
all attached skills are empty, no tool filter is applied and every tool allowed
by the policy is visible. The rule applies to the effective set, so a per-chat
override changes the tool allowlist for that conversation as well.

Slugs must match `[a-z0-9][a-z0-9_-]{1,63}` and are unique. System skills cannot
be deleted (`SYSTEM_SKILL`), but they can be edited and disabled. `enabled:
false` removes a skill from prompts and from soul/bot attachment lists. Attach to
a soul via `PUT /accounts/:id/soul { skillSlugs }` (replaces the set) and to a
bot via `PUT /ai/bots/:id/skills { skillSlugs }`.

### Skills per chat

`AiChatSkill` stores one set per `accountId + chatId + threadId`
(`0` = whole chat). It **replaces** the soul's set for that conversation:

- `GET /accounts/:id/chats/:chatId/ai-skills?threadId=` → `{ effective,
  source: "chat"|"soul", defaults, skills }`, where `defaults` is the soul's own
  set (used by the "reset" button in the UI) and `skills` is the catalogue rows
  for `effective` in order;
- `PUT ... { skillSlugs, threadId? }` replaces the override. Slugs are trimmed,
  deduplicated, capped at 100, and every one must exist (otherwise
  `400 SKILL_NOT_FOUND` with the missing list);
- `DELETE ...` drops the row so the soul's skills apply again.

Resolution (`AiChatSkillsService.resolve`): a stored row wins **even when its
array is empty** — "no skills in this chat" is a deliberate state, not a fallback
— and without a row the soul decides. The DM autopilot is the only consumer
today: it passes the resolved list with `replaceSoulSkills: true`, so the
override is authoritative. The dashboard agent, bots and automations still union
their `skillSlugs` with the soul's skills.

## 7. Bots

Two kinds, both long polling over the Bot API:

| Kind | `accountId` | `mode` | Default skill | Scope |
| --- | --- | --- | --- | --- |
| Shared soul-creator | `null` | `soul-creator` | `soul-creator` | any account; edits souls, skills, automations |
| Per-account assistant | set | `assistant` | `telegram-assistant` | its own account for account-scoped tools (`ACCOUNT_SCOPE` otherwise) |

BotFather setup:

1. Open `@BotFather` in Telegram, send `/newbot`, choose a name and a username
   ending in `bot`.
2. Copy the token (format `123456789:AA…`).
3. Configure it through the API or an MCP client:
   `PUT /ai/bots/shared` for the shared bot or
   `PUT /ai/bots/accounts/:accountId` for an account. Saving validates the token
   with `getMe` and fills in the username/title; `POST /ai/bots/:id/check`
   repeats `getMe` and re-enables the bot. There is no bot panel in the
   dashboard any more.
4. The token is encrypted with AAD `bot:<id>` and never returned by the API or
   tools — only `hasToken: true`. Pasting a new token replaces it.

`BotRunnerService` supervises the loops: every 10 s it diffs
`enabled && token` rows against running loops, calls `deleteWebhook` once, then
long-polls `getUpdates` (25 s). A `409` (another poller/webhook) backs off 30 s,
other errors 5 s and are recorded in `lastError`. Only **text messages in
private chats** are handled; bots and non-private chats are ignored. Commands
are exact matches: `/start`, `/help` (HELP text), `/id` (your user id, chat id,
bot username) and `/reset` (clears `BotTurn` for that chat). Everything else is
sent to the agent with `source = bot|soul-creator`, the bot's skills (or its
default skill) and the last 12 bot turns; replies are chunked at 3 900 chars and
conversation rows are trimmed to 40.

Access control: `allowedUserIds` per bot (Telegram user ids). When it is empty,
`AiConfigService.ownerTgUserIds()` is used — the explicit `ownerTgUserIds`
policy list, otherwise every attached account's `tgUserId`. Unauthorised users
get one refusal message containing their id and the attempt is logged
(`bot.deny`). If the app has no accounts *and* no owner list, the allowlist is
empty and every request is refused — attach an account (or set owner ids) before
enabling a bot.

Bot limits worth knowing: a Telegram bot cannot message a user who never started
it, and a bot chat is not an account DM. Personal conversations are handled by
the account itself through TDLib/mtcute and the soul (§4), not by a bot. The
per-account bot runs with that `accountId` but `chatId = null`, so it must name a
chat id when it uses messaging tools. A few read-only list tools
(`accounts_list`, `souls_list`, `automations_list`, `bots_list`) are global and
still return every account's data to a per-account bot.

## 8. Automations

`Automation.trigger` JSON:

| Trigger | Shape | Notes |
| --- | --- | --- |
| interval | `{"kind":"every","minutes":30}` | 1…10 080 minutes (7 days) |
| daily | `{"kind":"daily","at":"09:00"}` | wall-clock `HH:MM` in the automation's `timezone`, else server-local; next occurrence, tomorrow if already past |
| incoming | `{"kind":"incoming_message","keywords":["invoice"],"chatIds":[123]}` | empty list = any; keywords are case-insensitive substrings |
| manual | `{"kind":"manual"}` | only via Run |

An invalid schedule (missing/invalid `minutes` or `at`) yields `nextRunAt: null`
and never fires.

`Automation.action` JSON:

| Action | Shape | Notes |
| --- | --- | --- |
| agent | `{"type":"agent","prompt":"...","chatId":123,"skillSlugs":["..."],"sendOutput":true}` | `chatId` optional; `sendOutput` defaults to `true`, so the answer is posted to `chatId` when set |
| send | `{"type":"send_message","chatId":123,"text":"..."}` | both fields required |
| memory | `{"type":"summarize","chatId":123}` | needs the automation's `accountId`; forces compaction |

The scheduler (`AutomationSchedulerService`) is an in-process 15 s ticker that
also runs once at boot. One tick runs at most 20 due automations; a per-automation
lock prevents overlaps. `complete()` sets `lastRunAt`, increments `runCount` on
success **and** failure, and recomputes `nextRunAt` (null for manual/incoming
triggers). Every run is written to `AutomationRun` with `status`, `input`,
`output` (≤8 000 chars) and `error` (≤2 000), and shown in the UI's run history.

Incoming triggers listen to `message.new`, accept only private chats, skip
outgoing/service messages, dedupe by `accountId:chatId:messageId`, and match
enabled automations for that account plus global ones (`accountId = null`).
Keywords are OR-ed; `chatIds` narrows the chats. A global incoming automation
matches every account, but its actions run without an account context, so set
`accountId` on automations that must read or send as a specific account.

Sending: `send_message` and the agent action's `sendOutput` call the policy
(`evaluate("send")`) and the messaging service directly. They respect `dryRun`
and the chat/account allowlists; in dry-run the run output says
`dryRun: would send …` (or appends `(dryRun: сообщение не отправлено)` for the
agent action).

Running by hand: `POST /ai/automations/:id/run` executes immediately and returns
the run result; the `automation_run` tool only sets `nextRunAt = now`, so the
work happens on the next scheduler tick. The UI button uses the HTTP endpoint.
`enabled` defaults to `false` on create.

### Chat binding and self-pause

`Automation.chatId` + `threadId` bind a rule to one chat/topic (`threadId = 0`
means the whole chat). `soulId` and `createdBy` (`user`/`soul`/`assistant`)
record who owns it; a soul may only be paired with its own account
(`SOUL_ACCOUNT_MISMATCH`).

- a chat-bound action without its own `chatId` falls back to the bound chat
  (agent `sendOutput`, `send_message`, `summarize`);
- `timezone` (IANA, e.g. `Europe/Moscow`) makes `daily` follow that wall clock;
  an unknown zone is `400 INVALID_TIMEZONE`. `every` is absolute and
  timezone-independent; without a zone the server clock is used;
- `selfPausedAt`/`selfPauseReason` let the soul pause its own follow-ups in one
  chat (`automation_pause_chat` / `POST /ai/automations/chats/:accountId/:chatId/pause`);
  pausing clears `nextRunAt`, so the scheduler skips the row;
- `resume` (`automation_resume_chat`, `POST /ai/automations/:id/resume` or
  `POST .../chats/:accountId/:chatId/resume`) clears the pause and recomputes
  `nextRunAt`; a manual `enabled: true` also clears it. The `automation_run`
  tool answers `409 AUTOMATION_PAUSED` for a paused row;
- `GET /ai/automations/chats/:accountId/:chatId` returns the chat card: every
  automation of that chat/topic with `lastRunStatus`/`lastRunError` and a
  summary (`total`, `active`, `paused`, `nextDueAt`, `lastRunAt`);
- `nextDueAt` in every view is a zone-aware alias of `nextRunAt`;
- `due()` takes at most 20 rows per tick and skips `selfPausedAt` rows, so a
  paused chat never fires.

## 9. Permissions and dry-run

`AiSetting.capabilities` (defaults):

| Capability | Default | Gates |
| --- | --- | --- |
| `read` | on | accounts, chats, messages, logs, memory and run reads; `messages_read` (marks read) |
| `send` | on | `messages_send`, automation sends |
| `sendUnknown` | **off** | sending to a chat the account has never talked to |
| `edit` | on | `messages_edit` |
| `delete` | **off** | `messages_delete`, `memory_clear` |
| `react` | on | `messages_react` |
| `admin` | **off** | `chat_warn`, `chat_block`, `chat_unblock`, and `ai_access_set` with `enabled: false` |
| `souls` | on | souls and memory |
| `skills` | on | skills |
| `automations` | on | automations |
| `bots` | on | bots |
| `policy` | **off** | `policy_update`, `settings_update` (provider/model/dryRun/all allowlists) |
| `mcp` | on | stored for the UI; not enforced by the MCP controller yet (§15) |

`AiPolicyService.evaluate()` is the single gate:

1. the capability must be enabled;
2. if the call names an account and `allowAccountIds` is non-empty, the account
   must be listed (`ACCOUNT_DENIED`);
3. if the call names a chat, `blockChatIds` always denies it (`CHAT_DENIED`);
   `allowChatIds`, when non-empty, restricts only write capabilities
   (`send`/`edit`/`delete`/`react`) — reads are not limited by it;
4. `dryRun = policy.dryRun && isWriteCapability && source !== "dm"`.

### Per-account capabilities

`AiAccountPolicyService` wraps that gate with a per-account delta and is what
`AgentToolsService` actually injects:

- `AiAccountSetting.permissions` holds only the overrides; `{}` (the default for
  an account without a row) means "inherit everything";
- `GET /accounts/:id/ai-settings` returns `{ permissions, effective, defaults }`
  (stored deltas, defaults merged with them, and the global policy they inherit
  from), `PATCH /accounts/:id/ai-settings` merges a patch where `null` removes a
  key. A non-boolean value is `400 VALIDATION_ERROR`, so a dashboard typo cannot
  silently leave an account unrestricted;
- per key, an override wins; every other capability keeps the global value
  (`mergeCapabilities`). The UI shows three states per capability: inherit,
  allow, deny;
- when the effective value equals the global one, the call is delegated
  unchanged to `AiPolicyService`, so there is still one implementation of the
  allowlists, dry-run and logging;
- a denied override answers `CAPABILITY_DISABLED` and logs `ai.policy.deny` with
  `details.scope = "account"`;
- a granting override (turning on something the global policy denies) still goes
  through `allowAccountIds`, the chat block/allow lists and `dryRun`
  (`evaluateGranted`), so it cannot bypass them;
- the tool registry asks `capabilities(ctx.accountId)`, so the LLM schema and
  MCP `tools/list` hide tools the account denies (and expose ones it grants).

`AgentToolsService.execute()` additionally enforces per-tool `sources`
restrictions, rejects a call that targets another account from a scoped surface
(`ACCOUNT_SCOPE`), and audits every result as `ai.tool.<name>` (source `mcp` for
MCP calls). Denials are logged as `ai.policy.deny` with the code and capability.

Two tools need a second gate: `ai_access_set` may allow a chat with `souls` but
only `enabled: false` (muting) additionally requires `admin`, checked by
`requireDestructive()`, which reuses the policy flags instead of a new
confirmation switch. The destructive-by-purpose tools (`chat_block`,
`chat_warn`, `chat_unblock`, `automation_pause_chat`) carry that capability
themselves, so they are already filtered and asserted by the policy.

When `dryRun` is on, write tools return
`{ "dryRun": true, "wouldCall": "...", "args": {...}, "note": "..." }` and never
touch Telegram. `messages_send` also refuses unknown chats unless
`sendUnknown` is on: it probes the peer with `getChat` first. `messages_read`
is not a `telegramWrite`, so marking read is not simulated.

Soul autopilot (`source = "dm"`) is the one write path exempt from `dryRun`; it
is enabled only by choosing `auto`/`draft` on a soul and allowing the chat
(`chatIds`/`allowAllChats`, or an explicit `AiChatAccess` row).

For the agent and MCP, changing permissions or provider settings requires the
`policy` capability. The local dashboard can always save them — the API has no
authentication in single-user mode (`PUT /ai/policy`, `PUT /ai/settings`).

## 10. MCP

- Endpoint: `POST http://127.0.0.1:3001/mcp` (Streamable HTTP, JSON responses,
  stateless, no SSE stream). `GET` → `405`, `DELETE` → `204`.
- Auth: `Authorization: Bearer <token>`; comparison is constant-time. A missing or
  wrong token returns HTTP 401 with JSON-RPC error `-32001` and `id: null`.
- The token is the only credential (single-user app). It is shown at
  Настройки → AI → MCP-сервер, copied with a button and rotated with
  `POST /ai/mcp/rotate` (old clients lose access immediately). See §2 for the
  env/DB precedence.
- Requests may be a single JSON-RPC object or a batch array. Notifications
  (no `id`, method `notifications/*`) are accepted and answered with `202`.
- `initialize` echoes the client's `protocolVersion` (else `2025-06-18`), reports
  `tools`, `prompts` and `resources` capabilities (no list change, no
  subscribe), `serverInfo { name: "combain-telegram", title: "CombainTelegram",
  version: "1.0.0" }`, and Russian instructions that list the enabled
  capabilities and whether `dryRun` is on.

Implemented methods:

| Method | Result |
| --- | --- |
| `initialize` | protocol version, capabilities, server info, instructions |
| `ping` | `{}` |
| `tools/list` | tools whose capability is enabled (45 registered; 38 with the defaults, because `delete`/`policy`/`admin` are off) |
| `tools/call` | `{ content: [{ type: "text", text: <JSON> }] }`; `isError` on failure |
| `prompts/list` | every skill as a prompt (name = slug, no arguments) |
| `prompts/get` | the skill's `instructions` as one user message |
| `resources/list` | `telegram://accounts`, `telegram://souls` |
| `resources/read` | accounts (id, name, username, masked phone) or souls |
| `notifications/*` | accepted, no body |

Anything else, including `completion`, `logging` or `sampling`, returns
`-32601 Method not found`. `resources/templates/list` is supported and returns
an empty template list.

MCP calls run as the single local user with `source = "mcp"`,
`accountId = null`, `chatId = null`; the tool arguments decide the account/chat,
and the policy is evaluated per call. `tools/call` therefore goes through the same
registry, audit log and `dryRun` as the UI agent. Bots and automations use the
same registry; only automations' direct `send_message` path (and the agent
action's output post) call the policy/messaging services directly.

Client config (Claude Desktop-style; any Streamable HTTP client works):

```json
{
  "mcpServers": {
    "combain-telegram": {
      "type": "http",
      "url": "http://127.0.0.1:3001/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Some clients spell the transport `streamable-http` or take `url` plus a bearer
header in their own format; only the URL and header matter. The UI shows the same
snippet with the current endpoint.

Smoke test without a client:

```bash
TOKEN=$(curl -s http://127.0.0.1:3001/ai/settings | jq -r .mcp.token)
curl -s http://127.0.0.1:3001/mcp \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"accounts_list","arguments":{}}}'
```

## 11. Tools

45 tools are registered; `GET /ai/tools` lists them regardless of policy, while
`tools/list` (MCP) and the LLM schema hide tools whose capability is off. With
an account in scope the effective set is the account's overrides on top of the
global capabilities (§9), so the same tool can be visible for one account and
hidden for another.

| Group | Tools | Capability |
| --- | --- | --- |
| Status | `system_status`, `settings_get`, `policy_get` | `read` |
| Accounts | `accounts_list`, `accounts_get` | `read` |
| Chats | `chats_list`, `chats_get`, `chats_search` | `read` |
| Messages read | `messages_history`, `messages_search`, `messages_read`, `logs_search` | `read` |
| Messages write | `messages_send`, `messages_edit`, `messages_delete`, `messages_react` | `send` / `edit` / `delete` / `react` |
| Souls + memory | `souls_list`, `soul_get`, `soul_update`, `memory_view`, `memory_add`, `memory_summarize` | `souls` |
| Memory wipe | `memory_clear` | `delete` |
| Chat access | `ai_access_get`, `ai_access_set` | `read` / `souls` (mute also needs `admin`) |
| Blacklist | `chat_warn`, `chat_block`, `chat_unblock` | `admin` |
| Skills | `skills_list`, `skill_get`, `skill_create`, `skill_update`, `skill_delete` | `skills` |
| Automations | `automations_list`, `automation_create`, `automation_update`, `automation_delete`, `automation_run`, `automation_pause_chat`, `automation_resume_chat` | `automations` |
| Bots | `bots_list`, `bot_set_token`, `bot_update` | `bots` |
| Settings | `policy_update`, `settings_update` | `policy` |

Notes: `messages_*` and `chats_*` take `accountId` (defaults to the surface's
account) and `chatId`; `logs_search` reads the structured journal from
`docs/logs.md`; `bot_set_token` never echoes the token; `settings_update` also
changes `dryRun`, so it sits behind `policy`. `ai_access_*`, `chat_*` and
`automation_*_chat` take `threadId` (omit or `0` for the whole chat).
`chat_block` and `automation_pause_chat` require a reason of at least 3
characters, because it is shown to the owner in the chat card.

## 12. REST surface

```text
GET/PUT/PATCH /ai/settings              providers fallback, models, key hint, dryRun, STT, MCP endpoint+token
POST    /ai/stt/test                    probe the selected STT engine (`/health` or the local model files)
PUT     /ai/policy                      capabilities, allowlists, dryRun
POST    /ai/test                        one-shot LLM check without tools
GET     /ai/tools                       registry (name, capability, write)
POST    /ai/chat                        { prompt, accountId?, chatId?, messages?, skillSlugs? }
GET     /ai/runs?accountId=&chatId=&source=&limit=   agent runs with traces (limit ≤ 100)
GET     /ai/runs/:id                    one run: reasoning, messageIds, trace

GET/POST /ai/providers                  list (default first) / create
GET     /ai/providers/presets           opencode-go | custom
PATCH/DELETE /ai/providers/:id          update / delete (promotes a new default)
GET     /ai/providers/:id/models        live <baseUrl>/models (5 min cache) or the stored list
PUT     /ai/providers/:id/models        { models, defaultModel? } save the chosen list
GET     /ai/providers/:id/limits        stored limits + local counters + OpenCode Go usage meters
PATCH   /ai/providers/:id/limits        { maxPerHour?, maxPerDay? } (null removes a value)
POST    /ai/providers/:id/default       make the single default
POST    /ai/providers/:id/test          one minimal chat completion (8 s)
POST    /ai/providers/import-settings   copy AiSetting into a provider (idempotent)
GET     /ai/mcp                         { endpoint, token, tools }
POST    /ai/mcp/rotate                  new bearer token
GET     /ai/souls                       every account's soul (creates missing rows)

GET/PUT /accounts/:accountId/soul
GET     /accounts/:accountId/soul/memory?chatId=
POST    /accounts/:accountId/soul/memory/summarize  { chatId }
POST    /accounts/:accountId/soul/memory/facts      { chatId?, content, kind?, importance? }
DELETE  /accounts/:accountId/soul/memory/facts/:factId
DELETE  /accounts/:accountId/soul/memory/chats/:chatId

GET/PATCH /accounts/:accountId/ai-settings                 { permissions, effective, defaults } / patch overrides
GET     /accounts/:accountId/chats/:chatId/memory?limit=   read-only short-term + long-term view

GET     /accounts/:accountId/ai-access                      access rows + active blocks
GET/PUT /accounts/:accountId/chats/:chatId/ai-access?threadId=   decision / allow, mute, re-scope
DELETE  /accounts/:accountId/chats/:chatId/ai-access?threadId=   drop the row (falls back to the soul, then deny)
POST    /accounts/:accountId/chats/:chatId/ai-block         { reason?, blockedBy?, threadId? } block now
DELETE  /accounts/:accountId/chats/:chatId/ai-block?threadId=    unblock, reset warnings
POST    /accounts/:accountId/chats/:chatId/ai-warning       { reason?, threadId? } one warning
DELETE  /accounts/:accountId/chats/:chatId/ai-warnings?threadId= reset the counter, keep the block
GET     /accounts/:accountId/chats/:chatId/ai-events?threadId=&limit=  audit trail, newest first

GET/PUT/DELETE /accounts/:accountId/chats/:chatId/ai-skills?threadId=  skill override of one chat/topic

GET/POST /ai/skills
PATCH/DELETE /ai/skills/:id

GET/POST /ai/automations?accountId=&chatId=&threadId=&soulId=
PATCH/DELETE /ai/automations/:id
GET     /ai/automations/chats/:accountId/:chatId?threadId=&soulId=   chat card with last run + summary
POST    /ai/automations/chats/:accountId/:chatId/pause   { threadId?, soulId?, reason? }
POST    /ai/automations/chats/:accountId/:chatId/resume?threadId=&soulId=
POST    /ai/automations/:id/run          run now, returns { runId, status, output?, error? }
POST    /ai/automations/:id/resume       clear a self-pause
GET     /ai/automations/:id/runs?limit=  history, newest first

GET     /ai/bots                         { bots, shared }
PUT     /ai/bots/shared                  create/update the shared soul-creator bot
PUT     /ai/bots/accounts/:accountId     create/update that account's bot
PATCH/DELETE /ai/bots/:id
PUT     /ai/bots/:id/skills              { skillSlugs }
POST    /ai/bots/:id/check               getMe, refresh username/title, re-enable

POST/GET/DELETE /mcp                     MCP endpoint (Bearer token)
```

`/ai/chat` accepts either `prompt` or a `messages` transcript (roles
`user`/`assistant`), plus optional `accountId`/`chatId`/`skillSlugs`. The
dashboard sends neither scope, so a UI run is global; tools still name the
account they touch. Errors are `{ code, message }`; LLM failures are
`502 AI_FAILED`, invalid input `400`. There is no route to delete a soul. The
dashboard endpoints themselves have no auth (single-user mode); MCP is the only
token-protected surface.

## 13. Dashboard `/ai`

The sidebar entry is “AI” (page title “AI”) and the page has three tabs:

| Tab | What it does |
| --- | --- |
| Агент | one global chat with the agent, trace badges per tool call (`dry` for simulated), the areas the registry actually exposes, “Новый диалог” |
| Скиллы | create/edit/disable/delete skills, edit instructions and tool list |
| Автоматизации | editor for trigger/action, enable toggle, “Run”, last 30 runs |

The agent is **global**: there is no account or chat selector any more. The
header lists the capabilities derived from `GET /ai/tools`, and `POST /ai/chat`
is sent without `accountId`/`chatId` (the API still accepts both for scripts and
MCP-style callers). Souls, per-account permissions and bots are not on this
page: souls and capability overrides live on `/accounts`, bots are API/MCP only.

**Настройки → AI** (`/settings/ai`) is now the only settings page. `/settings`
redirects there, and the old `/settings/accounts`, `/settings/proxy`,
`/settings/logs` bookmarks redirect to it as well; accounts, proxies and logs
have their own top-level pages. The page carries the provider list
(preset picker, model list, test, limits and usage meters), the read-only
legacy `AiSetting` card (only while the provider list is empty), STT, the
capability toggles with account/chat allowlists and owner ids, and the MCP card
with the endpoint, token, rotate button and the grouped tool list.

**Аккаунты** has a «Настройки ИИ» button per account that opens a dialog with two
tabs:

- **Душа** — the soul form: name, essence, tone, goals, boundaries, language,
  extra instructions, model, temperature, autopilot mode (off/draft/auto),
  reply delay, hourly/daily limits, typing speed, presence timings and the
  attached skills. The API upserts, so the same form creates a missing soul;
- **Права ИИ** — per-account capability overrides: every capability can be
  inherited, allowed or denied; only the changed keys are PATCHed (`null`
  removes an override).

In the messenger, the chat header carries an AI chip: neutral when no rule
exists, emerald when the soul answers there, red for a blocked chat. Its menu
allows/mutes the chat (`ИИ: разрешить`/`ИИ: запретить`), blocks it with a
reason, or lifts the block. The info panel is tabbed: **Обзор · Доступ ИИ ·
Память · Скиллы · Автоматизации · Медиа · Ссылки · Опросы · Логи** (+
«Похожие», + «Управление» for groups the account administers, and the same tabs
in the comment-thread drawer scoped to the open thread):

| Tab | What it does |
| --- | --- |
| Доступ ИИ | access row (allow/mute, note, assigned soul), warning counter with «Сбросить предупреждения» (keeps an existing block), block/unblock and the event history |
| Память | short-term turns, the rolling summary and the chat's facts (read-only) |
| Скиллы | the chat/topic override, its source (`chat`/`soul`) and «сбросить» back to the soul's set |
| Автоматизации | the automations bound to this chat/topic with their last run |
| Логи | structured entries of this account/chat with a level filter and a deep link to `/logs?accountId=&chatId=&level=` |

Обзор, Медиа, Ссылки, Опросы, Похожие and Управление are unchanged (chat facts,
media tabs, similar channels, admin tools).

Voice notes render in their own player with a transcription button.

### Reasoning stream

While the autopilot waits for the model, the dashboard shows a strip directly
above the composer («Агент думает…», local-only). It is fed by WS `ai.thinking`
events for the open account/chat:

| Phase | Payload | Meaning |
| --- | --- | --- |
| `start` | `{ accountId, chatId, runId, phase: "start" }` | opens the strip as soon as the `AgentRun` row exists |
| delta | `{ …, runId, delta }` | a throttled chunk of `reasoning_content` (at most one per 100 ms and only once ≥16 chars accumulated) |
| `done` | `{ …, runId, phase: "done", reasoning }` | closes the strip and carries the complete reasoning; the strip fades out |

Only the DM autopilot attaches a reasoning listener (`AgentService` falls back
to the blocking `chat()` when none is given), so bots, automations and UI runs do
not stream. Nothing in this path touches Telegram: the strip is local UI, and
`sendMessage` receives only the reply text. After the run the same reasoning is
persisted in `AgentRun` and shown under the bubble as the collapsible
«Размышления» block (`ai.reply` carries it too, so it appears without a
refetch).

### Duplicate bubbles (client-side merge)

TDLib answers a send with a **temporary** message id; the real id only arrives
with `updateMessageSendSucceeded` (or a later history refetch). The API already
returns the real id when the confirmation arrives inside `SEND_WAIT_TIMEOUT_MS`,
but a slow one leaves the temporary id in the transcript, and the same bubble can
also arrive twice through `message.new` and a page load.

The dashboard therefore merges every incoming bubble with the local list
(`apps/dashboard/src/lib/message-merge.ts`):

1. a numeric id match wins (ids are normalised with `Number`);
2. otherwise `isSameBubble` recognises a temporary/real pair by the same
   `chatId`, direction, exact text, media kind, reply target and a **±5 s**
   window on `date`;
3. the non-temporary id survives, the existing bubble keeps its slot (the list
   is re-sorted newest-first) and local metadata is moved;
4. `remapReasoning` follows id hops (temp → temp → real) and `putReasoning`
   keeps **one reasoning block per `runId`**, so a duplicate `ai.reply` moves the
   block instead of decorating two bubbles.

This is the pitfall to keep in mind for later work: the signature is a
heuristic, not an identity. Two genuinely different bubbles with identical short
text, sent in the same direction within 5 s and with the same reply/media shape,
collapse into one. A new field that changes a bubble's shape (a draft flag, a
different media descriptor, a forward header) must be added to `isSameBubble`,
or temp/real pairs will show up twice again. Reasoning must always go through
`remapReasoning`/`putReasoning`, never be keyed by the id that just arrived.

## 14. Safety rules

- `dryRun` is on by default: the agent and MCP simulate send/edit/delete/react.
  Soul autopilot is the only write path outside it, and it is off by default.
- `sendUnknown`, `delete`, `admin` and `policy` are off by default.
- Soul autopilot starts with `mode = off`, an empty allowlist and
  `allowAllChats = false`.
- A blocked chat/topic is a hard drop: no agent call, no `typing…`, no read
  receipt, only a debug entry (`dm.autopilot.blocked`). A warning (`chat_warn`)
  does not stop the chat by itself; the one at `AI_BLOCK_AFTER_WARNINGS`
  (default 3) turns it into a block. Clearing warnings keeps an existing block.
- Provider keys are sealed per provider (AAD `ai-provider:<id>`) and masked as
  `hasKey`; an `opencode-go` row stores no key at all and uses the local OpenCode
  token. The STT engine, base URL and language are editable at `/settings/ai`
  (`PATCH /ai/settings`, `POST /ai/stt/test`); the model is fixed to Parakeet and
  is shown read-only, and the optional STT key (usually unset, the LAN service
  has no auth) is set through the API and only reported as `hasSttKey`.
- Provider limits and usage meters are display-only: they are stored and
  reported but never throttle a request. Only the soul's `maxPerHour` /
  `maxPerChatPerDay` stop replies.
- Speech audio leaves the machine only when the remote engine is selected (the
  LAN LXC); the local engine keeps it inside the process. Model files and
  ffmpeg are installed outside the app and are not managed by it.
- `ai.thinking`, `ai.reply` and `AgentRun.reasoning` are dashboard-only. The
  model's reasoning never reaches Telegram, and the strip above the composer is
  never part of a sent message.
- Bots refuse users who are not owners (unless the allowlist is empty because no
  account is attached — attach one first).
- API keys and bot tokens are encrypted (AES-256-GCM envelope), masked in
  responses, redacted in tool audit args (`token`/`apiKey` → `***`) and never
  logged.
- Every agent run is persisted with its prompt, output, steps, trace and token
  usage; every tool call is logged with its source.
- The MCP token is compared in constant time and is the only credential; bind the
  API to loopback. The dashboard itself has no auth.
- Prompt rules: fetch data instead of inventing it, never send without an
  explicit request (except the opt-in soul autopilot), never reveal secrets or
  other people's chats, and confirm before policy changes.
- The old mtcute/desktop session is still never logged out; the AI layer sends
  through the account's active engine.

## 15. Known limitations

- SQLite and in-process scheduler / bot polling / WS fan-out: one API node only.
- Memory retrieval is keyword-based; there are no embeddings.
- Automatic compaction only runs after an auto DM reply; draft mode and manual
  sends need the manual button/endpoint.
- `daily` without a `timezone` follows the server clock; the scheduler has a
  15 s granularity.
- Bots: long polling needs outbound `api.telegram.org`, one poller per token
  (`409` otherwise), text and private chats only, and a bot cannot start a DM.
  There is no dashboard UI for bots; tokens are set through REST/MCP only.
- MCP is HTTP-only (no stdio binary), stateless, with no server-initiated SSE.
  When the `mcp` capability is off, every method except `initialize`, `ping`
  and notifications answers `-32001`; access also needs the bearer token.
- Message ids belong to the engine that served the call; TDLib and mtcute ids are
  never mixed.
- A per-account bot is scoped: `accounts_list`, `souls_list`,
  `automations_list` and `bots_list` only show its own account, and a tool call
  naming another account is refused (`ACCOUNT_SCOPE`).
- `Soul.settings` is merged on `PUT`; omitted keys keep their current values.
- The dashboard agent is global: a UI run has no account or chat scope, so it
  relies on the tool arguments (`POST /ai/chat` still accepts `accountId` and
  `chatId` for scripts).
- Agent output text is buffered (no token streaming); only the autopilot's
  reasoning is streamed (`ai.thinking`), and each `delta` carries the chunk
  accumulated since the previous emit, not the whole text — the complete
  reasoning arrives with `done` and `ai.reply`. Each tool result is truncated to
  6 000 chars in the model context and each step to 1 800 completion tokens.
- Provider limits (`maxPerHour`/`maxPerDay`) are not enforced anywhere; they are
  stored, shown with the local `observed` counters and the provider's own usage
  meters, and nothing more. The counters are app-wide, not per provider, and the
  meters exist only for OpenCode Go.
- Per-chat skills replace the soul's set for that chat/topic (an empty override
  means "no skills"), and only the DM autopilot reads them; a chat override does
  not narrow the UI agent, bots or automations.
- A temporary TDLib message id can still reach the dashboard when the send
  confirmation arrives after `SEND_WAIT_TIMEOUT_MS`. The client merge (±5 s
  signature, §13) hides it, but the heuristic can collapse two genuinely
  different bubbles with the same text sent within 5 s — and it must be extended
  whenever a bubble gains a new distinguishing field.
- Speech-to-text detects no language (`language` is always null; the LXC's
  hardcoded `english` is ignored), needs ffmpeg plus the model files on the
  host, and keeps the recognizer in memory for the whole process
  (~1.1–1.2 GB RSS). Notes over 20 s are cut at silences, so unusual audio can
  lose a word at a join; at most 2 transcriptions run at once. A dead remote
  engine is re-probed after 60 s. `AiSetting.sttLanguage` is stored but unused.
- Access decisions are cached for 10 s per chat/topic, so a dashboard change
  takes up to 10 s to apply. Warning counters live in `AiChatBlock` rows
  (`blockedBy = "warning"`) and show up only as `warnings` in the per-chat view,
  not in the block list.
- The one-time `ai.access.seed` turns the soul's `chatIds` into explicit rows;
  after that, editing `chatIds` no longer changes access for those chats.
- Only the default provider is used; per-task provider selection is not
  implemented (a provider row has its own limits, but they are not consulted per
  request). A provider without its own key silently falls back to the
  `AiSetting` key and then to `AI_API_KEY`, and `AI_API_KEY_SOURCE=opencode`
  wins over every stored key.
- The dashboard no longer edits the legacy `temperature`/`maxSteps` or API-key
  fields: the legacy card is read-only and those values are changed through
  `PUT /ai/settings`. A provider row carries its own `reasoningEffort`, but
  temperature stays global (or per soul, which wins for its own replies).
- The model list is cached for 5 min per provider and only invalidated by a base
  URL change or a delete; a model added by the provider shows up after the TTL
  (the UI refresh does not bypass the cache).
- An account override can grant a globally disabled capability; only the
  account/chat allowlists and `dryRun` still apply, so `policy` and `admin`
  remain the capabilities to keep off unless the account really needs them.
- The automation editor edits trigger/action only; chat/thread binding,
  timezone and self-pause are API/tool fields. `POST /ai/automations/:id/run`
  runs immediately even for a self-paused row, while the `automation_run` tool
  answers `409 AUTOMATION_PAUSED`.
