# CombainTelegram dashboard

Next.js 16 (App Router, React 19, Tailwind 4, Biome) messenger UI for the
CombainTelegram API.

## Run

From the repository root:

```bash
bun install
bun run db:generate
bun run db:migrate
bun run dev
```

- Dashboard: http://localhost:4000 (fixed port, no auto-increment)
- API: http://localhost:4001
- Swagger UI: http://localhost:4001/docs (OpenAPI JSON: `/docs-json`)

To run only the dashboard:

```bash
bunx turbo run dev --filter=dashboard
```

## Configuration

`NEXT_PUBLIC_API_URL` (default `http://localhost:4001`) is read by the browser.
See `.env.example`; `.env.local` is gitignored and overrides it for local dev.

## Using the UI

1. Open http://localhost:4000. The app is single-user — there is no login or
   registration; it runs as `DEFAULT_USER_ID` (default `local`).
2. Add Telegram accounts from the sidebar:
   - **Phone** — `+number`, then the Telegram code; handles 2FA password and
     sign-up.
   - **QR** — scan `tg://login?token=...` from Telegram → Devices → Link Desktop
     Device; handles 2FA password.
   - **tdata** — upload a `.zip`, `.tar.gz` or `.tgz` Telegram Desktop archive,
     choose one of the discovered accounts and import it as a new session or
     (advanced) reuse the desktop session.
3. Select an account, then a chat. The composer sends messages; outgoing
   messages can be edited or deleted. Opening a chat marks it read, and typing
   is sent debounced.

Realtime events arrive on the Socket.IO `/events` namespace. If the socket is
unavailable, the open chat is polled every 5 seconds instead.

## Production build

```bash
bunx turbo run build --filter=dashboard
bun start
```
