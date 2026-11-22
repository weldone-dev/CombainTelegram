# CombainTelegram

Monorepo (Bun workspaces + Turborepo):

| Path | What |
| --- | --- |
| `apps/dashboard` | Next.js 16 messenger UI (App Router, Tailwind 4, Biome) |
| `apps/api` | NestJS 12 API, ESM, Vitest — http://localhost:3001 |
| `packages/database` | Prisma 7 + SQLite (`@repo/database`) |

## Getting started

```bash
bun install
bun run db:generate
bun run db:migrate
bun run dev
```

- Dashboard: http://localhost:3000 (fixed port — it will not auto-pick another one)
- API: http://localhost:3001 (`GET /health` checks the database)
- Swagger UI: http://localhost:3001/docs (OpenAPI JSON: `/docs-json`)

`bun run dev` starts both apps. There is **no local registration or login**: the
app is single-user, and every request runs as `DEFAULT_USER_ID` (default
`local`). Telegram accounts are added from the sidebar with phone code, QR login
or a tdata archive. See [`apps/dashboard/README.md`](apps/dashboard/README.md)
for the UI guide.

Both ports are pinned. If :3000 is already in use by another project, dashboard
fails with a clear error instead of silently taking the API's port.

## API and realtime

The API has no tokens: all endpoints run as the single local user.

```bash
curl -s http://localhost:3001/accounts          # []
curl -s http://localhost:3001/health            # {"status":"ok","users":...}
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
const socket = io('http://localhost:3001/events');
socket.on('message.new', (e) => console.log(e.accountId, e.chatId, e.message));
socket.on('message.edited', ...); socket.on('message.deleted', ...);
socket.on('message.read', ...);  socket.on('chat.typing', ...);
socket.on('auth.qr.updated', ...); socket.on('auth.done', ...);
```

`DEFAULT_USER_ID` selects the local user row (default `local`); it is created on
demand. See `apps/api/.env.example`.

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
  data model, API/WS surface, phases.
- [`docs/auth.md`](docs/auth.md) — phone, QR and tdata login flows, error map,
  session security.
- [`inspiration/README.md`](inspiration/README.md) — reference clients and the
  functional backlog.

See `AGENTS.md` for agent-facing notes and gotchas.
