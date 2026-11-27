# AGENTS.md

## Product decisions (fixed)
- **Multi-account is a first-class requirement**, not a later feature: one local user attaches many Telegram accounts, each with its own session, device profile, cache and unread state; switching never re-logs in. No 3/4 cap — `MAX_ACCOUNTS_PER_USER` config (default 25). Reference: **64Gram** (`inspiration/repos/64Gram`, 100 slots), secondary **Nagram** (128 slots).
- **Three login methods**: phone+code (+2FA), QR (`tg://login?token=`), tdata upload. All produce the same `TelegramAccount` slot.
- **MTProto lives in NestJS**, never in the browser: `@mtcute/node` (MIT) + `opentele2` (MIT) for tdata. Sessions encrypted at rest; auth attempts sticky to one node.
- **Follow official clients, not Android mods.** Protocol flows were taken from tdesktop/64Gram sources (`intro/*`, `core/core_cloud_password.cpp`).
- **ToS:** no ghost mode, no anti-delete, no local premium; own `api_id`/`api_hash`.
- **Single LLM stack = Eve.** All model-driven behaviour lives in `apps/eve` (agent process) + `apps/api/src/eve` (Telegram-facing API). The old Soul/autopilot/provider/MCP/bot/automation layer and `n8n` are deleted; do not reintroduce them. Speech-to-text is env-only (`STT_*`) in the messaging layer.
- Design docs: `docs/architecture.md` (modules, data model, API) and `docs/auth.md` (three flows, error map, security). Structured logs (HTTP actions, raw Telegram answers, errors) and their REST API for agents: `docs/logs.md` (`GET /logs`, `/logs/export`).

## Layout
- Bun workspaces + Turborepo. Package manager is **bun 1.3.9** (`devEngines`); `npm install`/`npm view` fail with `EBADDEVENGINES` — always use `bun`.
- `apps/dashboard` — Next.js 16 (App Router, Tailwind 4, Biome). It ships its own `AGENTS.md`: read `node_modules/next/dist/docs/` before writing Next code, this version differs from training data.
- `apps/api` — NestJS 12, **ESM** (`"type": "module"`, relative imports end in `.js`), Vitest (not Jest), oxlint. Its `AGENTS.md` lists first-party Nest packages.
- `packages/database` — the only owner of Prisma: schema, migrations, generated client.
- `inspiration/repos/` — local shallow clones of open-source Telegram Android and desktop clients (gitignored, several GB). Read-only UX/feature references: GPL-2/3 code must not be copied into this repo. Index, functional backlog and feature map in `inspiration/README.md`.

## Commands (from repo root)
- `bun install`
- `bun run dev` — dashboard on **:4000** (`next dev -p 4000`, no auto-increment), api on **:4001**, Eve agent on **:4020**. If 4000 is taken by another project, dashboard fails loudly instead of falling back onto 4001 and killing the API.
- `bun run build` / `bun run test` / `bun run lint` / `bun run check-types`
- Focus one app: `bunx turbo run <task> --filter=api`
- Single test: `cd apps/api && bunx vitest run src/app.controller.spec.ts`
- DB: `bun run db:generate`, `bun run db:migrate`, `bun run db:studio` (all proxy to `@repo/database`)

## Prisma 7 gotchas (cost real time before)
- **Pin `prisma` and `@prisma/client` to the same version (7.10.1).** The registry tags `prisma@latest` as `8.0.0-rc.33` while `@prisma/client@latest` is `7.10.1`; `@latest` on both installs an incompatible pair.
- Prisma 7 requires a **driver adapter**; there is no engine-based `new PrismaClient()` anymore. SQLite uses `@prisma/adapter-better-sqlite3` via `createSqliteAdapter()` in `packages/database/src/adapter.ts`.
- Client is generated into `packages/database/src/generated/prisma` (gitignored) with the `prisma-client` generator. Imports go through `@repo/database` only — never import the generated path from apps.
- `prisma migrate dev` no longer runs `generate` (v7 change); run `bun run db:generate` after schema edits.
- `file:./...` SQLite URLs are resolved against `packages/database`, not the process cwd, so the API works when started from anywhere. `DATABASE_URL` is optional.
- The database package compiles to `dist` (turbo `build`), so `check-types`, `test`, and `dev` depend on `^build`. Editing `packages/database` does not hot-reload the API: rerun `bun run dev` after changing schema/client code.
- Old NestJS+Prisma tutorials assume CommonJS and `PrismaClient` from `@prisma/client`; both are wrong here.

## Conventions
- mtcute is imported from `@mtcute/node` only: `@mtcute/core` is not a direct
  dependency of `apps/api`, and `@mtcute/node` re-exports everything needed
  (`TelegramClient`, `MemoryStorage`, `tl`, `SentCode`).
- opentele2 flow helpers (`getSessions`, `terminateSession`, `qrLoginToNewClient`)
  accept its structural `FlowClient`, which mtcute's generic `call()` does not
  satisfy. Cast with `asFlowClient()` from `apps/api/src/telegram/flow-client.ts`.
- `toStringSession` lives in `opentele2/mtcute`, not the package root.
- **Single-user mode:** no local registration or login. `DefaultUserService`
  (`apps/api/src/user-context`) upserts `DEFAULT_USER_ID` (default `local`) and
  `DefaultUserGuard` attaches it to every HTTP request; `@CurrentUser()` returns
  it. WS sockets join `user:<id>` with no token. Add real auth before a shared
  deployment.
- Messaging lives in `apps/api/src/messaging` on top of
  `AccountsService.resolveSession(userId, accountId, sessionId?)`, which checks
  both ownership links (session→account→user) and opens the client (TDLib or
  mtcute).
- Eve lives in `apps/api/src/eve` (personas, bindings, allowlist, context
  snapshots, events, delayed turns, dry run) and `apps/eve` (the turn loop). It
  never opens a Telegram client itself: outward actions go through
  `MessagingService`. Speech-to-text is `SpeechService` in `messaging`, configured
  only by `STT_*` env.
- Realtime lives in `apps/api/src/realtime`: `UpdatesService` subscribes once per
  session (dedupe 10 s across PC/phone), `RealtimeService` is an in-process rxjs
  bus, and `EventsGateway` fans out to `user:<id>` rooms. No service imports the
  gateway, so the module graph stays acyclic.
- API keeps Nest DI: `PrismaService extends PrismaClient` in `apps/api/src/prisma`, adapter factory imported from `@repo/database`. Add tables by editing `prisma/schema.prisma` + a migration, not with raw SQL.
- Nest 12 compile gotchas (`nest build` fails otherwise):
  - Types used in decorated signatures must be `import type` (TS1272, `isolatedModules` + `emitDecoratorMetadata`).
  - Annotate Prisma return types explicitly (`Promise<UserModel[]>`, `Promise<UserModel>`); inference leaks `PrismaPromise`/`GlobalOmitConfig` from `dist` and breaks declaration emit (TS2883). Model types are exported from `@repo/database`.
- The demo `/users` CRUD was removed; `User` rows are created by
  `DefaultUserService` (or a future real auth module).
- Swagger is mounted at `/docs` (`/docs-json` for the OpenAPI document) in `main.ts`; add `@ApiTags` to new controllers. There is no Bearer scheme.
- Root TypeScript is 7.0.2; `apps/api` pins TS 6.x from the Nest scaffold. Don't assume one compiler version across packages.
- Only `@repo/database` may depend on Prisma runtime packages; apps import it.
