# AI, souls, memory and MCP

Status: implemented 2026-11-24 (`897e420`). Code: `apps/api/src/ai`,
`apps/api/src/mcp`, `apps/api/src/bots`, `apps/api/src/automations`; UI: `/ai`
in the dashboard.

## 1. What this layer is

A local AI layer on top of the multi-account Telegram app:

- **Agent** — an OpenAI-compatible LLM with tool calling. It can read accounts,
  chats and messages, send replies, and edit the app's own configuration
  (souls, memory, skills, automations, bots, permissions).
- **Soul (душа)** — one persona per Telegram account: who it is, tone, goals,
  boundaries, language, optional model override and autopilot settings.
- **Memory** — two levels per personal chat: a short-term buffer of recent
  turns and a long-term rolling summary plus extracted facts.
- **Skills** — reusable markdown instruction packs attached to souls and bots.
- **Automations** — schedule or incoming-message triggers with an agent,
  message or memory action.
- **Bots** — one shared soul-creator bot and one assistant bot per account over
  the Telegram Bot API (long polling, no webhooks).
- **MCP** — a Streamable HTTP MCP endpoint (`POST /mcp`) that exposes the same
  tools to external clients (Claude Desktop, Codex, Orca, custom agents).

There is exactly **one tool registry** (`AgentToolsService`) and **one policy**
(`AiPolicyService`). The dashboard agent, MCP clients, bots and automations all
call the same registry, so a tool is either allowed for everyone or for nobody.
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
| `temperature`, `maxSteps`, `dryRun`, permissions, allowlists | value | – | see §9 |
| MCP token | encrypted value | `MCP_TOKEN` | random 32 bytes, generated and stored |

`AI_BASE_URL`, `AI_MODEL`, `AI_FAST_MODEL` and `AI_API_KEY` are read at runtime;
a value saved in the UI wins over the environment. The dashboard
(AI → Настройки → Модель) can edit the URL, both models, temperature, the step
budget and the key. The key is stored as an AES-256-GCM envelope
(`SessionCryptoService`, AAD `ai:api-key`) and is never returned in full — the
settings show `…1234` and where the key came from (`env`/`db`). An empty API key
field clears the stored key; the environment key, if any, is used again.

The MCP token is generated once (64 hex chars) and stored encrypted with AAD
`ai:mcp-token`. With `MCP_TOKEN` set and nothing stored yet, the env value is
used; after `POST /ai/mcp/rotate` the database value always wins.

`LlmService` sends one request per agent step: 90 s timeout, up to 3 attempts
with a 400 ms × attempt pause. Every failure goes through that loop (a bad key is
attempted three times), then the run fails with the provider's message. Each step
asks for at most 1 800 completion tokens. The fallback summary (when the model
spends its whole step budget on tools) asks for 800. `temperature` is clamped to
0…2 and `maxSteps` to 1…12 (default 6).

### OpenCode Go via Orca

Orca's OpenCode Go subscription works too. The Go endpoint needs an OAuth access
token (the `st_` value, not the expired `sk-` API key from the console) and a
session header:

```dotenv
AI_BASE_URL=https://opencode.ai/inference/go/openai/v1
AI_MODEL=deepseek-v4.1-flash
AI_FAST_MODEL=deepseek-v4.1-flash
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
| `Automation` | optional `accountId`, `enabled`, `triggerType`, JSON `trigger`, `actionType`, JSON `action`, `lastRunAt`, `nextRunAt`, `runCount` | trigger → action rule |
| `AutomationRun` | `automationId`, `status`, JSON `input`, `output`, `error`, timestamps | run history |
| `AiSetting` | singleton `default`: provider, endpoints, models, encrypted keys, `dryRun`, JSON capabilities/allowlists | provider + permission policy |
| `AgentRun` | optional `accountId`/`soulId`/`chatId`, `source`, `prompt`, `output`, `model`, `steps`, JSON `trace`, token counts, `status` | every agent invocation |

Migrations: `20261123230239_ai_souls`, `20261123230327_ai_secrets`,
`20261123231007_ai_api_key_envelope`. The tables have no user foreign key — the
app is single-user; `Soul.accountId` and `TelegramBot.accountId` are unique,
`Automation.accountId` is optional (null = global rule).

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

`PUT` validates the mode and replaces `settings` with the parsed object; because
parsing fills defaults first, omitted keys fall back to the defaults above — send
the full object (the dashboard does).

`DmAutopilotService` subscribes to `message.new` at boot (updates start even with
no dashboard open) and:

1. accepts only private chats (`chatId > 0`), skips outgoing/service messages,
   Saved Messages and messages older than 2 minutes;
2. requires an existing soul with `mode != off` and a chat allowed by
   `allowsChat()` (`excludeChatIds` wins, then `allowAllChats`, then `chatIds`);
3. debounces per account+chat (`min(1.5 s, max(200 ms, replyDelayMs))`), keeps a
   per-chat lock, and dedupes message ids;
4. enforces `maxPerHour` / `maxPerChatPerDay` by counting assistant `SoulTurn`
   rows;
5. runs the agent with `source = "dm"`, the persona and memory, no tools
   (`tools: []`) and the last 10 turns as history, then appends the incoming
   message to memory;
6. `draft` stores a `draft` turn and emits `ai.draft`; `auto` optionally sends
   typing (`typingDurationMs = length / typingSpeed`, 0.6…60 s, refreshed every
   4 s, so longer replies keep the indicator longer), sends the reply as a
   Telegram reply, appends
   the assistant turn, emits `ai.reply` and triggers memory compaction.

It never starts a conversation: only replies to an incoming message. Autopilot
writes are exempt from `dryRun` because `auto`/`draft` is an explicit opt-in
(§9); the UI says so next to the flag.

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
by the policy is visible.

Slugs must match `[a-z0-9][a-z0-9_-]{1,63}` and are unique. System skills cannot
be deleted (`SYSTEM_SKILL`), but they can be edited and disabled. `enabled:
false` removes a skill from prompts and from soul/bot attachment lists. Attach to
a soul via `PUT /accounts/:id/soul { skillSlugs }` (replaces the set) and to a
bot via `PUT /ai/bots/:id/skills { skillSlugs }`.

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
3. In the dashboard open AI → Боты and paste it into the shared card or into an
   account card. Saving validates the token with `getMe` and fills in the
   username/title; `/check` repeats `getMe` and re-enables the bot.
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
| daily | `{"kind":"daily","at":"09:00"}` | server-local `HH:MM`; next occurrence, tomorrow if already past |
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
| `admin` | **off** | reserved; no tool uses it yet |
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

`AgentToolsService.execute()` additionally enforces per-tool `sources`
restrictions, rejects a call that targets another account from a scoped surface
(`ACCOUNT_SCOPE`), and audits every result as `ai.tool.<name>` (source `mcp` for
MCP calls). Denials are logged as `ai.policy.deny` with the code and capability.

When `dryRun` is on, write tools return
`{ "dryRun": true, "wouldCall": "...", "args": {...}, "note": "..." }` and never
touch Telegram. `messages_send` also refuses unknown chats unless
`sendUnknown` is on: it probes the peer with `getChat` first. `messages_read`
is not a `telegramWrite`, so marking read is not simulated.

Soul autopilot (`source = "dm"`) is the one write path exempt from `dryRun`; it
is enabled only by choosing `auto`/`draft` on a soul and allowing the chat
(`chatIds` or `allowAllChats`).

For the agent and MCP, changing permissions or provider settings requires the
`policy` capability. The local dashboard can always save them — the API has no
authentication in single-user mode (`PUT /ai/policy`, `PUT /ai/settings`).

## 10. MCP

- Endpoint: `POST http://127.0.0.1:3001/mcp` (Streamable HTTP, JSON responses,
  stateless, no SSE stream). `GET` → `405`, `DELETE` → `204`.
- Auth: `Authorization: Bearer <token>`; comparison is constant-time. A missing or
  wrong token returns HTTP 401 with JSON-RPC error `-32001` and `id: null`.
- The token is the only credential (single-user app). It is shown at
  AI → Настройки → MCP-сервер, copied with a button and rotated with
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
| `tools/list` | tools whose capability is enabled (38 registered; 34 with defaults) |
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

38 tools are registered; `GET /ai/tools` lists them regardless of policy, while
`tools/list` (MCP) and the LLM schema hide tools whose capability is off.

| Group | Tools | Capability |
| --- | --- | --- |
| Status | `system_status`, `settings_get`, `policy_get` | `read` |
| Accounts | `accounts_list`, `accounts_get` | `read` |
| Chats | `chats_list`, `chats_get`, `chats_search` | `read` |
| Messages read | `messages_history`, `messages_search`, `messages_read`, `logs_search` | `read` |
| Messages write | `messages_send`, `messages_edit`, `messages_delete`, `messages_react` | `send` / `edit` / `delete` / `react` |
| Souls + memory | `souls_list`, `soul_get`, `soul_update`, `memory_view`, `memory_add`, `memory_summarize` | `souls` |
| Memory wipe | `memory_clear` | `delete` |
| Skills | `skills_list`, `skill_get`, `skill_create`, `skill_update`, `skill_delete` | `skills` |
| Automations | `automations_list`, `automation_create`, `automation_update`, `automation_delete`, `automation_run` | `automations` |
| Bots | `bots_list`, `bot_set_token`, `bot_update` | `bots` |
| Settings | `policy_update`, `settings_update` | `policy` |

Notes: `messages_*` and `chats_*` take `accountId` (defaults to the surface's
account) and `chatId`; `logs_search` reads the structured journal from
`docs/logs.md`; `bot_set_token` never echoes the token; `settings_update` also
changes `dryRun`, so it sits behind `policy`.

## 12. REST surface

```text
GET/PUT /ai/settings                    provider, models, key hint, dryRun, MCP endpoint+token
PUT     /ai/policy                      capabilities, allowlists, dryRun
POST    /ai/test                        one-shot LLM check without tools
GET     /ai/tools                       registry (name, capability, write)
POST    /ai/chat                        { prompt, accountId?, chatId?, messages?, skillSlugs? }
GET     /ai/runs?accountId=&source=&limit=   agent runs with traces (limit ≤ 100)
GET     /ai/mcp                         { endpoint, token, tools }
POST    /ai/mcp/rotate                  new bearer token
GET     /ai/souls                       every account's soul (creates missing rows)

GET/PUT /accounts/:accountId/soul
GET     /accounts/:accountId/soul/memory?chatId=
POST    /accounts/:accountId/soul/memory/summarize  { chatId }
POST    /accounts/:accountId/soul/memory/facts      { chatId?, content, kind?, importance? }
DELETE  /accounts/:accountId/soul/memory/facts/:factId
DELETE  /accounts/:accountId/soul/memory/chats/:chatId

GET/POST /ai/skills
PATCH/DELETE /ai/skills/:id

GET/POST /ai/automations?accountId=
PATCH/DELETE /ai/automations/:id
POST    /ai/automations/:id/run          run now, returns { runId, status, output?, error? }
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
`user`/`assistant`). Errors are `{ code, message }`; LLM failures are
`502 AI_FAILED`, invalid input `400`. There is no route to delete a soul. The
dashboard endpoints themselves have no auth (single-user mode); MCP is the only
token-protected surface.

## 13. Dashboard `/ai`

The sidebar entry is “AI” (page title “AI и души”). The page has six tabs:

| Tab | What it does |
| --- | --- |
| Агент | chat with the agent, account selector (all/one), trace badges per tool call (`dry` for simulated), “Новый диалог” |
| Души | per-account persona editor, autopilot mode (off/draft/auto), allowlist and limits, temperature, memory panel (chat id, summary, facts, turns, manual compaction) |
| Скиллы | create/edit/disable/delete skills, edit instructions and tool list |
| Автоматизации | editor for trigger/action, enable toggle, “Run”, last 30 runs |
| Боты | shared bot card, per-account cards, token, username, allowlist, skills, “Проверить” |
| Настройки | model/URL/key (write-only), temperature, max steps, dryRun, all capability toggles, account/chat allowlists, owner ids, MCP endpoint + token + rotate, tool list grouped by capability |

## 14. Safety rules

- `dryRun` is on by default: the agent and MCP simulate send/edit/delete/react.
  Soul autopilot is the only write path outside it, and it is off by default.
- `sendUnknown`, `delete`, `admin` and `policy` are off by default.
- Soul autopilot starts with `mode = off`, an empty allowlist and
  `allowAllChats = false`.
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
- `nextRunAt` for `daily` uses the server's local timezone; the scheduler has a
  15 s granularity.
- Bots: long polling needs outbound `api.telegram.org`, one poller per token
  (`409` otherwise), text and private chats only, and a bot cannot start a DM.
- MCP is HTTP-only (no stdio binary), stateless, with no server-initiated SSE.
  When the `mcp` capability is off, every method except `initialize`, `ping`
  and notifications answers `-32001`; access also needs the bearer token.
  The `admin` capability has no tools yet (reserved).
- Message ids belong to the engine that served the call; TDLib and mtcute ids are
  never mixed.
- A per-account bot is scoped: `accounts_list`, `souls_list`,
  `automations_list` and `bots_list` only show its own account, and a tool call
  naming another account is refused (`ACCOUNT_SCOPE`).
- `Soul.settings` is merged on `PUT`; omitted keys keep their current values.
- Agent output is buffered (no streaming); each tool result is truncated to
  6 000 chars in the model context and each step to 1 800 completion tokens.
