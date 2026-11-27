# T9 — Proactive wiring handoff

Status: Nest proactive engine + Eve schedules are written; the shared module
has **not** been edited (T8 owns it). Until the two lines below are added, the
`EveProactiveService` timer is not started and the two HTTP routes are not
mounted. Eve's schedules can be built and run already.

## Files

| File | Purpose |
| --- | --- |
| `apps/api/src/eve/eve-proactive.service.ts` | 60 s tick, due-item selection, allowlist/cooldown checks, push to Eve, autonomous agenda, deterministic daily life |
| `apps/api/src/eve/eve-proactive.controller.ts` | `POST /internal/eve/proactive/tick`, `POST /internal/eve/daily-life/ensure` behind `EveTokenGuard` |
| `apps/api/src/eve/eve-proactive.service.spec.ts` | 21 specs: due selection, binding/allowlist, cooldown, push failure, limits/marker, daily-life determinism |
| `apps/eve/agent/lib/proactive.ts` | Nest tick client (never throws; missing route = no-op) |
| `apps/eve/agent/schedules/proactive.ts` | every minute → `POST /internal/eve/proactive/tick` |
| `apps/eve/agent/schedules/presence.ts` | every minute → `POST /internal/eve/presence/tick` (no-op until that endpoint exists) |

## Exact module wiring (integrator, one edit)

`apps/api/src/eve/eve.module.ts`:

```ts
import { EveProactiveController } from './eve-proactive.controller.js';
import { EveProactiveService } from './eve-proactive.service.js';

@Module({
  imports: [MessagingModule, RealtimeModule],
  controllers: [EveController, EveProactiveController],
  providers: [
    EveTokenGuard,
    EveGateway,
    EveEventsService,
    EveMediaService,
    EveService,
    EveProactiveService,
  ],
  exports: [EveEventsService, EveService, EveMediaService, EveProactiveService],
})
```

No other change is required. `EveProactiveService` deliberately depends only on
`PrismaService`, so it does not enlarge the module graph.

Do **not** also add a second timer: this service is the single proactive
scheduler once registered (`onModuleInit` + `setInterval(60 s).unref()`), and
`EveEventsService` only subscribes to the realtime bus.

## EveChannel proactive route requirement

`POST /eve/v1/nest/proactive` must start a synthetic turn that writes the first
message. The canonical Nest payload is:

```json
{
  "personaId": "persona-1",
  "accountId": "account-1",
  "chatId": "1830539716",
  "threadId": 0,
  "item": {
    "id": "cuid",
    "about": "спросить, как прошёл день",
    "reason": "самой захватило",
    "kind": "proactive-life",
    "importance": 2,
    "pingAt": "2026-11-27T10:00:00.000Z"
  }
}
```

Requirements:

1. Create the turn with the literal `[internal: proactive]` prefix on the
   synthetic user message (same convention as the behavior gate), so the model
   understands no human asked anything.
2. Use `item.about` / `item.reason` as the prompt material, not a user message.
3. Pass `item.id` as `idempotencyKey`: a retried Nest push must not create a
   second proactive turn.
4. Return `2xx` only once the turn was accepted; Nest leaves the agenda item
   `pending` otherwise and retries on the next minute.
5. Respect `allowed` semantics already enforced by Nest: the item is only
   pushed after both the persona/account binding and
   `EveChatBinding.allowed` were verified, so the route does not need to
   re-check the allowlist, but it must reject a malformed address.

Current state in `apps/eve/agent/channels/nest.ts` (T2): the route exists and
adds the `[internal: proactive]` prefix, but reads `about`/`reason`/`id` at the
top level. Nest therefore also sends those three flattened aliases alongside
`item`. When T8 touches the channel, switch it to read `item.*` (keeping the
flattened fallback for old rows) and pass `item.id` as the idempotency key.
The channel was not edited by T9.

## Presence

`POST /internal/eve/presence/tick` does not exist yet. `presence.ts` ships now
and treats `404/405/501` as `skipped`, so it is a silent no-op. Whoever adds the
endpoint should return `{ ok: true }` and keep it inside the `EveTokenGuard`.

## Configuration

- `EVE_WEBHOOK_URL` — one env var configures both directions: Nest pushes
  events to `.../eve/v1/nest/events` and proactive turns to its sibling
  `.../eve/v1/nest/proactive`.
- `EVE_PROACTIVE_URL` — optional explicit override. An empty value disables the
  proactive tick (`tick()` returns `reason: "disabled"`).
- `EVE_ENABLED` / `EVE_TOKEN` — with no webhook override, an enabled Eve falls
  back to `http://127.0.0.1:4020/eve/v1/nest/proactive`.
- `EVE_NEST_URL` is used only by Eve (to reach Nest). It is intentionally not
  used to build the Eve URL: it points at the API on port 4001, not Eve on 4020.

## Known limitations / next slices

- `EveAgendaItem` has no `threadId` column, so autonomous items are generated
  only for whole-chat bindings (`threadId = 0`); tick always checks/sends with
  `threadId: 0`. Topic-scoped pings need a schema change (T0).
- Conflict (`EveConflict.level >= 2`) is not consulted when generating the
  autonomous set. It is still enforced by the Eve-side `planAgendaTick` when
  the proactive turn runs; the Nest generator only caps by stage limit.
- Presence state (online/asleep/busy) is not stored in Nest; the tick does not
  delay a due item for presence. That is the future `/presence/tick`.
- `eve dev` never fires schedules. Use
  `POST /eve/v1/dev/schedules/proactive` while iterating; `eve start` runs the
  cron.

## Verification

```
bun run --cwd apps/api check-types        # pass
cd apps/api && bunx vitest run src/eve    # 10 files, 127 tests pass
bunx vitest run src/eve/eve-proactive.service.spec.ts  # 21 pass
```

(An earlier run hit one failure in `eve-turn.service.spec.ts`; it was written
concurrently by another slice and passes now.)

