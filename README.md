# CombainTelegram

Monorepo (Bun workspaces + Turborepo):

| Path | What |
| --- | --- |
| `apps/dashboard` | Next.js 16 messenger UI (App Router, Tailwind 4, Biome) |
| `apps/api` | NestJS 12 API, ESM, Vitest — http://localhost:4001 |
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

`bun run dev` starts both apps. There is **no local registration or login**: the
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

## AI, souls and MCP

The app has a local AI layer: an agent with 38 Telegram/app tools, one "soul"
(persona + autopilot) per account, two-level memory, skills, automations, a
shared soul-creator bot and one assistant bot per account, plus an MCP server for
external clients. Everything shares one tool registry and one permission policy;
`dryRun` is on by default, so writes are simulated.

Configure an OpenAI-compatible provider in `apps/api/.env` or in
AI → Настройки (the UI value wins; the key is encrypted at rest):

```dotenv
AI_BASE_URL=https://api.deepseek.com/v1
AI_MODEL=deepseek-chat
AI_FAST_MODEL=deepseek-chat
AI_API_KEY=sk-...
# optional: generated on first boot when empty
MCP_TOKEN=
```

Open <http://localhost:4000/ai>: Агент, Души, Скиллы, Автоматизации, Боты and
Настройки. The Настройки tab has the provider test button, permission toggles,
chat/account allowlists and the MCP endpoint + token (copy/rotate).

To connect an MCP client (Claude Desktop, Codex, Orca, a custom agent), use the
Streamable HTTP URL and the Bearer token from AI → Настройки:

```json
{
  "mcpServers": {
    "combain-telegram": {
      "type": "http",
      "url": "http://127.0.0.1:4001/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Safety defaults: `dryRun` on, `sendUnknown`/`delete`/`admin`/`policy` off, soul
autopilot `off` with an empty allowlist, bots answer only the app's account
owners (set an owner id when no account is attached), and API keys/bot tokens are
encrypted and masked. The API is single-user and has no auth (only `/mcp` checks
the Bearer token) — keep it on loopback. Details: [`docs/ai.md`](docs/ai.md).

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
  data model, API/WS surface, AI/MCP layer, phases.
- [`docs/auth.md`](docs/auth.md) — phone, QR and tdata login flows, error map,
  session security.
- [`docs/ai.md`](docs/ai.md) — souls, memory, skills, automations, bots, the
  agent, MCP and its permission policy.
- [`inspiration/README.md`](inspiration/README.md) — reference clients and the
  functional backlog.

See `AGENTS.md` for agent-facing notes and gotchas.
