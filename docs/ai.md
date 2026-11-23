# AI, souls, memory and MCP

Status: implemented 2026-11-24. Code: `apps/api/src/ai`, `apps/api/src/mcp`,
`apps/api/src/bots`, `apps/api/src/automations`; UI: `/ai` in the dashboard.

## 1. What this layer is

A local AI layer on top of the multi-account Telegram app:

- **Agent** — an OpenAI-compatible LLM with tool calling. It can read accounts,
  chats and messages, send replies, and edit the app's own configuration
  (souls, memory, skills, automations, bots, permissions).
- **Soul (душа)** — one persona per Telegram account: who it is, tone, goals,
  boundaries, language, optional model override.
- **Memory** — two levels per personal chat: a short-term buffer of recent
  turns and a long-term rolling summary plus extracted facts.
- **Skills** — reusable markdown instruction packs attached to souls and bots.
- **Automations** — schedule or incoming-message triggers with an agent,
  message or memory action.
- **Bots** — one shared soul-creator bot and one assistant bot per account over
  the Telegram Bot API (long polling, no webhooks).
- **MCP** — a Streamable HTTP MCP endpoint (`POST /mcp`) that exposes the same
  tools to external clients (Claude Desktop, Codex, Orca, custom agents).

Everything is behind one permission policy. The default is conservative:
`dryRun` is on, writes to Telegram are simulated, and unknown chats are
refused.

## 2. Provider configuration

Any OpenAI-compatible endpoint works:

```dotenv
# apps/api/.env (gitignored)
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
AI_FAST_MODEL=deepseek-chat
AI_API_KEY=sk-...
MCP_TOKEN=optional-fixed-token
```

`AI_BASE_URL`, `AI_MODEL`, `AI_FAST_MODEL` and `AI_API_KEY` are read at runtime.
The dashboard (AI → Настройки) can override the URL/model and store a key
encrypted (AES-256-GCM envelope, `SessionCryptoService`); the key is never
returned in full. `MCP_TOKEN` is optional — without it the app generates a
random token on first boot and stores it encrypted. The token is shown in the
UI so it can be copied into a client config.

DeepSeek V4.1 Flash (`deepseek-chat`) is the working default on this machine;
OpenCode Zen/OrcaRouter/OpenRouter/Ollama are drop-in alternatives.

## 3. Data model

| Model | Purpose |
| --- | --- |
| `Soul` | persona per account (unique `accountId`), `mode: off/draft/auto`, JSON `settings` |
| `SoulSkill` | many-to-many soul↔skill |
| `SoulTurn` | short-term dialogue buffer per `accountId + chatId` |
| `SoulSummary` | rolling long-term summary per chat (`summary`, `facts`) |
| `SoulMemory` | durable facts (`kind`, `importance`, optional `chatId`) |
| `Skill` | slug, instructions, tool allowlist, origin (system/user/agent) |
| `TelegramBot` | token (encrypted), mode `soul-creator/assistant`, optional `accountId` |
| `BotTurn` | short-term bot conversation |
| `Automation` / `AutomationRun` | trigger/action config and history |
| `AiSetting` | provider config, MCP token, `dryRun`, capability flags, allowlists |
| `AgentRun` | every agent invocation with prompt, output, steps, trace, tokens |

Migrations: `20261123230239_ai_souls`, `20261123230327_ai_secrets`,
`20261123231007_ai_api_key_envelope`.

## 4. Souls and autopilot

`GET/PUT /accounts/:accountId/soul` returns/updates a soul. A soul is created
lazily with the account's first name. Modes:

- `off` — only manual use (UI chat, MCP, automations).
- `draft` — the agent writes a suggested reply to `SoulTurn` and emits
  `ai.draft`; nothing is sent.
- `auto` — replies in allowed personal chats.

Autopilot (`DmAutopilotService`) listens to `message.new`, requires a private
chat (`chatId > 0`), skips outgoing/service/old messages and Saved Messages,
checks `allowAllChats`/`chatIds`/`excludeChatIds`, rate limits (`maxPerHour`,
`maxPerChatPerDay`), typing and delay. It never initiates a conversation:
only replies to an incoming message. A per-chat lock plus a 1.5 s debounce
prevents reply storms. Updates start at boot, so autopilot works with no browser
open.

## 5. Memory

- `SoulTurn` keeps the last ~36 turns per chat.
- When the buffer exceeds 30 turns, `MemoryService` sends the oldest 24 to the
  fast model, upserts `SoulSummary`, extracts facts into `SoulMemory`, and
  deletes the summarised rows. Manual compaction: `POST .../memory/summarize`.
- Retrieval is keyword + importance + recency ranked (no embeddings): the
  latest summary and up to 8 relevant facts are injected into the system prompt;
  the last 20 turns are sent as history.
- Facts can be added/deleted in the UI or through `memory_add`/`memory_*` tools.
- `GET .../soul/memory?chatId=` shows summary, facts and turns; `DELETE
  .../memory/chats/:chatId` clears one chat.

## 6. Skills

Built-ins are seeded once and never overwritten: `soul-creator`, `dm-assistant`,
`memory-curator`, `automation-builder`, `telegram-assistant`. A skill can
restrict the tool set (`tools` JSON array; empty = any tool the policy allows).
The agent can create/update skills when the `skills` capability is on.

`POST /ai/skills`, `PATCH/DELETE /ai/skills/:id`, `GET /ai/skills`.

## 7. Bots

Two kinds, both long polling:

- **Shared soul-creator** (`accountId = null`, `mode = soul-creator`): the
  owner talks to it to create/edit souls, skills and automations. Default skill
  `soul-creator`.
- **Per-account assistant** (`accountId`, `mode = assistant`): a control
  surface for one account. Default skill `telegram-assistant`.

Create a bot in `@BotFather` (`/newbot`) and paste the token into AI → Боты. The
token is encrypted with AAD `bot:<id>`. Only private bot chats are handled;
unknown Telegram users are refused unless their id is in the bot's allowlist
(empty = owners of the app's accounts, or `ownerTgUserIds`). Commands: `/start`,
`/help`, `/id`, `/reset`.

Important: a Telegram bot cannot message users who never started it. DM
conversations are handled by the account itself through TDLib and the soul, not
by the bot.

## 8. Automations

`trigger` JSON:

- `{"kind":"every","minutes":N}`
- `{"kind":"daily","at":"HH:MM"}`
- `{"kind":"incoming_message","keywords":["..."],"chatIds":[...]}`
- `{"kind":"manual"}`

`action` JSON:

- `{"type":"agent","prompt":"...","chatId":123,"send":true,"skillSlugs":[...]}`
- `{"type":"send_message","chatId":123,"text":"..."}`
- `{"type":"summarize","chatId":123}`

The scheduler ticks every 15 s. Incoming-message triggers are matched against
`message.new` and run once per message id. `complete()` sets `lastRunAt`,
`runCount` and the next `nextRunAt`. Manual "Run" executes immediately. All
runs are written to `AutomationRun` and visible in the UI.

## 9. Permissions and dry-run

`AiSetting.capabilities`:

`read`, `send`, `sendUnknown`, `edit`, `delete`, `react`, `admin`, `souls`,
`skills`, `automations`, `bots`, `policy`, `mcp`.

Defaults: read/send/edit/react/souls/skills/automations/bots/mcp = true;
delete/admin/policy/sendUnknown = false; `dryRun = true`.

`AiPolicyService` enforces capabilities, account allowlist, chat allow/deny
lists, and per-chat write restrictions. Telegram writes return a simulated
result while `dryRun` is on (soul autopilot is exempt because it is an explicit
opt-in), and every allow/deny is logged (`ai.policy.*`, `ai.tool.*`). Unknown
chats are additionally refused by `messages_send` when `sendUnknown=false`.

**Policy changes** are themselves gated by the `policy` capability, off by
default. The owner can enable it in the UI (or ask the soul-creator bot) and
then the agent can adjust permissions.

## 10. MCP

- Endpoint: `POST http://127.0.0.1:3001/mcp` (Streamable HTTP, JSON responses,
  stateless). `GET` → 405, `DELETE` → 204.
- Auth: `Authorization: Bearer <token>`. The token is in `AiSetting`
  (encrypted) and shown at AI → Настройки → MCP; rotate with
  `POST /ai/mcp/rotate`.
- Methods: `initialize`, `ping`, `tools/list`, `tools/call`, `prompts/list`,
  `prompts/get`, `resources/list`, `resources/read`,
  `resources/templates/list`, `notifications/*`.
- Prompts are the app's skills; resources are `telegram://accounts` and
  `telegram://souls`.
- Tools: accounts, chats, message history/search/send/edit/delete/react/read,
  logs search, souls, memory, skills, automations, bots, settings and policy.
  `tools/list` hides tools whose capability is disabled.

Example client config:

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

## 11. REST surface (dashboard)

- `GET/PUT /ai/settings`, `PUT /ai/policy`, `POST /ai/test`
- `GET /ai/tools`, `POST /ai/chat`, `GET /ai/runs`
- `GET /ai/mcp`, `POST /ai/mcp/rotate`
- `GET /ai/souls`
- `GET/PUT /accounts/:accountId/soul`
- `GET .../soul/memory`, `POST .../memory/summarize`,
  `POST .../memory/facts`, `DELETE .../memory/facts/:id`,
  `DELETE .../memory/chats/:chatId`
- `GET/POST/PATCH/DELETE /ai/skills[/:id]`
- `GET/POST/PATCH/DELETE /ai/automations[/:id]`, `POST /:id/run`,
  `GET /:id/runs`
- `GET /ai/bots`, `PUT /ai/bots/shared`, `PUT /ai/bots/accounts/:accountId`,
  `PATCH/DELETE /ai/bots/:id`, `PUT /:id/skills`, `POST /:id/check`

## 12. Safety rules

- `dryRun` on by default; no test sends to unknown people.
- Soul autopilot is off by default and has an empty allowlist.
- Bots refuse users who are not owners.
- No secrets in logs; API keys and bot tokens are encrypted and masked.
- MCP tools go through the same policy as the in-app agent; every call is
  logged with source `ai`/`mcp`/`bot`/`automation`.
- The old mtcute/desktop session is still never logged out; the AI layer only
  sends through the active engine.

## 13. Known limitations

- SQLite, in-process scheduler/polling: single API node only.
- Memory retrieval is keyword-based, not embedding-based.
- `nextRunAt` for `daily` uses the server's local timezone.
- Bot long polling requires outbound access to `api.telegram.org` and a token.
- MCP is HTTP-only (no stdio binary); the token is the only auth.
- An agent can only act on message ids of the active engine; TDLib ids and
  mtcute ids are never mixed.
