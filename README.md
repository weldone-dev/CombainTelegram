# CombainTelegram

Monorepo (Bun workspaces + Turborepo):

| Path | What |
| --- | --- |
| `apps/dashboard` | Next.js 16 messenger UI (App Router, Tailwind 4, Biome) |
| `apps/api` | NestJS 12 API, ESM, Vitest — http://localhost:4001 |
| `apps/eve` | Eve 1.5.0 agent process (personas, LLM turns, memory) — http://localhost:4020 |
| `packages/database` | Prisma 7 + SQLite (`@repo/database`) |

## Getting started

```bash
bun install
bun run db:generate
bun run db:migrate
bun run dev
```

- Dashboard: http://localhost:4000 (fixed port — it will not auto-pick another one)
- API: http://localhost:4001 (`GET /health` checks the database)
- Swagger UI: http://localhost:4001/docs (OpenAPI JSON: `/docs-json`)
- Eve: http://localhost:4020 (`GET /eve/v1/health`)

`bun run dev` starts all three processes. There is **no local registration or login**: the
app is single-user, and every request runs as `DEFAULT_USER_ID` (default
`local`). Telegram accounts are added from the sidebar with phone code, QR login
or a tdata archive. See [`apps/dashboard/README.md`](apps/dashboard/README.md)
for the UI guide.

Both ports are pinned. If :4000 is already in use by another project, dashboard
fails with a clear error instead of silently taking the API's port.

## API and realtime

The API has no tokens: all endpoints run as the single local user.

```bash
curl -s http://localhost:4001/accounts          # []
curl -s http://localhost:4001/health            # {"status":"ok","users":...}
```

Telegram accounts are attached with `POST /auth/phone/start`,
`POST /auth/qr/start` or `POST /auth/tdata` (`.zip`, `.tar.gz`, `.tgz`). Messaging
then lives under one account:

```
GET    /accounts/:accountId/chats
GET    /accounts/:accountId/chats/:chatId/messages?limit=50&offsetId=
POST   /accounts/:accountId/chats/:chatId/messages      { text }
PATCH  /accounts/:accountId/chats/:chatId/messages/:messageId { text }
DELETE /accounts/:accountId/chats/:chatId/messages/:messageId
POST   /accounts/:accountId/chats/:chatId/read          { maxId? }
POST   /accounts/:accountId/chats/:chatId/typing        { status? }
```

Every messaging endpoint accepts `?sessionId=` / `"sessionId"` to choose one of
the account's sessions (PC vs phone); the default is the most recent session.

Realtime: Socket.IO namespace `/events`, no token.

```js
const socket = io('http://localhost:4001/events');
socket.on('message.new', (e) => console.log(e.accountId, e.chatId, e.message));
socket.on('message.edited', ...); socket.on('message.deleted', ...);
socket.on('message.read', ...);  socket.on('chat.typing', ...);
socket.on('auth.qr.updated', ...); socket.on('auth.done', ...);
```

`DEFAULT_USER_ID` selects the local user row (default `local`); it is created on
demand. See `apps/api/.env.example`.

## Eve (the only LLM stack)

All model-driven behaviour belongs to **Eve**, a local girl-agent style persona
engine: `apps/eve` runs the turn loop on `:4020`, and `apps/api/src/eve` is its
Telegram-facing half (personas, account bindings, chat allowlist, context
snapshots, durable events, dry run).

Configure any OpenAI-compatible endpoint in `apps/api/.env`:

```dotenv
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
AI_FAST_MODEL=deepseek-chat
AI_API_KEY=sk-...
# optional embedding model for memory ranking
AI_EMBED_MODEL=
# shared secret for /internal/eve/*
EVE_TOKEN=
```

Open <http://localhost:4000/eve> to create a persona, bind Telegram accounts and
allow chats. `EVE_DRY_RUN=true` runs a full turn without any Telegram delivery.
Details: [`docs/eve/README.md`](docs/eve/README.md).

Speech-to-text for voice notes is env-only (`STT_BASE_URL`, `STT_MODEL`,
`STT_API_KEY`, `STT_ENGINE`, ...); with no engine configured the transcribe
endpoint answers "not configured" instead of failing.

The old Soul/autopilot/provider/MCP/bot/automation layer and the `n8n` proxy were
removed. The API is single-user and has no auth (only `/internal/eve/*` checks
`EVE_TOKEN`) — keep it on loopback.

## Scripts

```bash
bun run build         # all packages/apps
bun run test
bun run lint
bun run check-types
bun run db:generate   # regenerate Prisma Client after schema changes
bun run db:migrate    # create + apply a migration
bun run db:studio     # Prisma Studio
```

Scope to one app with `bunx turbo run dev --filter=api`.

## Database

SQLite lives in `packages/database/prisma/dev.db` (gitignored). `DATABASE_URL` is
optional; see `packages/database/.env.example`. Prisma 7 pins `prisma` and
`@prisma/client` to 7.10.1 on purpose — do not upgrade to `@latest` without
upgrading both.

## Design

- [`docs/architecture.md`](docs/architecture.md) — multi-account model, stack,
  data model, API/WS surface, Eve and speech, phases.
- [`docs/auth.md`](docs/auth.md) — phone, QR and tdata login flows, error map,
  session security.
- [`docs/eve/`](docs/eve/README.md) — the Eve engine, its API and memory.
- [`inspiration/README.md`](inspiration/README.md) — reference clients and the
  functional backlog.

See `AGENTS.md` for agent-facing notes and gotchas.
