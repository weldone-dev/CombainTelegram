# Eve local channel

`apps/eve` is the girl-agent style persona loop. It does **not** open Telegram
and does **not** touch SQLite directly:

- inbound events come from NestJS (`POST /eve/v1/nest/events`, or the
  `/internal/eve` WS namespace);
- outbound actions go to NestJS (`/internal/eve/messages/*`, typing, read,
  presence);
- persona documents, relationship state and memory are read/written through
  NestJS (`/internal/eve/*`, `x-eve-token: $EVE_TOKEN`).

## Environment

Copy `.env.example` to `.env.local` and set:

| Variable | Meaning |
|---|---|
| `EVE_NEST_URL` | NestJS API origin, default `http://127.0.0.1:4001` |
| `EVE_TOKEN` | same value as `apps/api/.env` `EVE_TOKEN`; sent as `x-eve-token` |
| `EVE_MODEL` | fallback model id, `deepseek-v4.1-flash` |
| `AI_GATEWAY_API_KEY` | credential used only when `EVE_LLM_*` is unset |

The only supported persona model is **`deepseek-v4.1-flash`**, reached through
the OpenAI-compatible provider (`EVE_LLM_BASE_URL`, `EVE_LLM_API_KEY`,
`EVE_LLM_MODEL`). Those three take precedence over `EVE_MODEL`.
`EVE_MODEL` is read when the agent module is built/loaded, so restart `eve dev`
or rebuild after changing it.

Nest must point back at Eve:

```dotenv
# apps/api/.env
EVE_ENABLED=true
EVE_TOKEN=<same value as apps/eve/.env.local>
EVE_WEBHOOK_URL=http://127.0.0.1:4020/eve/v1/nest/events
```

### Dry run (no Telegram delivery)

Dry-run is per turn: a test/manual turn carries `dryRun: true` and every
outbound call of that turn forwards the flag to Nest (`apps/api`), which owns
Telegram and suppresses `messages/*`, `typing`, `read`, `presence` and delayed
`send`/`react`/…, logging `[eve][dry-run] <kind> chat=… account=… …`. A real
Telegram `message.new` never sets it, so live traffic is delivered. Eve runs
the complete turn (behavior, model, bubbles, delays, memory, `turn/apply`), so
the next context is realistic. `EVE_DRY_RUN=true` in `apps/api/.env` remains a
global kill-switch.
See `docs/eve/README.md` for the full behaviour and the API endpoints that
return real model-context snapshots (`/internal/eve/context/*`).

## Run (exact commands)

Eve listens on **port 4020** (`eve dev --port 4020 --no-ui`). From the repo
root:

```bash
# all apps (api :4001, dashboard :4000, eve :4020)
bun run dev

# Eve only
bun run --cwd apps/eve dev

# production-style local server
bun run --cwd apps/eve build
bun run --cwd apps/eve start
```

Health check: `curl http://127.0.0.1:4020/eve/v1/health`.

Bun loads `apps/eve/.env.local` for these scripts. Do not commit it.

## Build

```bash
bun run --cwd apps/eve build
```

`eve build` does not call the model, but it needs a model id and provider
credential in scope. For a local smoke build without a real key:

```bash
AI_GATEWAY_API_KEY=dummy EVE_MODEL=deepseek-v4.1-flash \
  bun run --cwd apps/eve build
```

Build output goes to `apps/eve/.output` (and `.eve/`); both are gitignored.

Type-check and engine tests:

```bash
bunx tsc -p apps/eve/tsconfig.json --noEmit
bun test apps/eve/agent/lib/persona
```

## Contract

The channel address is `personaId:accountId:chatId`. Nest sends only events
whose persona/account is bound and whose chat is explicitly allowed.

Inbound `POST /eve/v1/nest/events`:

- ignores `allowed: false`, empty text, and non-`message.new` events;
- uses `EveEvent.id` (then `dedupeKey`, then
  `message.new:accountId:chatId:threadId:messageId`) as the Eve
  `idempotencyKey`, so a replay does not create a second turn;
- seeds durable channel state with `personaId`, `accountId`, `chatId`,
  `threadId`, available as `ctx.channel.state` in `deliver`/events.

Outbound replies are sent by the `content.completed` (`phase: "reply"`)
handler to `POST $EVE_NEST_URL/internal/eve/messages/send` with
`x-eve-token: $EVE_TOKEN` and the persona/account/chat/thread address.
Typing and read receipts are best-effort in `turn.started`.

## Persona and tools

- `agent/instructions/persona.ts` fetches
  `GET /internal/eve/personas/:id` and `GET /internal/eve/context` once per
  session (`ctx.memo`) and renders persona/speech/boundaries/communication
  docs plus relationship and chat notes. A Nest failure returns a short
  fallback instruction instead of failing the turn.
- `agent/instructions/memory.ts` renders the ranked memory snapshot
  (`/internal/eve/memory/retrieve`) as a system block: facts, promises, open
  loops, timeline, attachment, episodes and palace drawers, capped at 3k chars.
- `agent/lib/model/hygiene.ts` wraps the provider model. It drops
  `reasoning_content` before Eve records an assistant turn, strips old
  `[internal: …]`/memory messages from the outgoing prompt, and sets the
  persona temperature (0.95) and output ceiling (3500).
- `agent/tools/persona-tool.ts` attaches the deterministic persona engine
  (T3, `agent/lib/persona/**`) as the `persona-tool` model tool.
- `agent/tools/nest.ts` exposes two read-only tools: `eve_context` and
  `eve_relationship`. There are deliberately no write/transport tools.
- `agent/memory/nest.ts` keeps the memory slot's capture
  (`/internal/eve/memory/capture`). Its recall deliberately returns no user
  messages: recall is a system block now, so service data never enters the user
  history.
