# Eve engine — план и декомпозиция

Статус: Phase 0 (фундамент) начат. Nest остаётся владельцем Telegram, SQLite и
логова; Eve — отдельный локальный процесс, который говорит с Nest по
`/internal/eve/*`.

## Что уже сделано

- Prisma-схема: новые таблицы `EvePersona*`, `EveRelationship*`, `EveMemory*`,
  `EveAgendaItem`, `EveSessionLog`, `EveEvent`, ...
- Миграция `20261126225349_eve_phase0` применена, Prisma Client собран.
- Каркас Nest-модуля `apps/api/src/eve` (guards, events, gateway, actions,
  memory/state endpoints).
- Каркас `apps/eve` (agent, channel, memory provider).
- Legacy AI/n8n (`Soul*`, autopilot, providers, MCP, bots, automations) удалены;
  аккаунтам отвечает только Eve.
- `apps/api` проходит `check-types`.

Ещё не сделано: `bun install` для Eve, `eve build`, dashboard-страница,
полный behavior-engine, медиа/voice, тесты.

## Контракт

- Eve → Nest: `POST /internal/eve/*`, заголовок `x-eve-token: $EVE_TOKEN`.
- Nest → Eve: `POST http://127.0.0.1:4020/eve/v1/nest/events` (custom channel)
  и live WS `/internal/eve` namespace.
- Адрес Eve-сессии: `personaId:accountId:chatId`.
- Durable события: `EveEvent` + `GET /internal/eve/events?cursor=`.
- LLM: Eve — единственный провайдер для персоны; dashboard-агент остаётся на
  Nest-провайдере.

## Задачи и владение файлами

| ID | Задача | Владеет | Зависит от |
|---|---|---|---|
| T0 | Фундамент: схема, миграция, generate, API check-types | интегратор | — |
| T1 | Nest `/internal/eve`: actions, memory, state, events, tests | `apps/api/src/eve/**` | **готово** (49 tests) |
| T2 | Eve app: install, channel, memory provider, build | `apps/eve/agent/{agent.ts,channels,memory}`, `package.json` | **готово** (build + 86 engine tests) |
| T3 | Persona engine: behavior-tick, presence, prompt, conflict, agenda, memory algorithms | `apps/eve/agent/lib/persona/**` | **готово** (86 тестов) |
| T4 | Dashboard: страница персоны, allowlist, привязки, память | `apps/dashboard/src/app/**/eve/**`, `apps/dashboard/src/lib/eve-api.ts` | **готово** (build) |
| T5 | Transport actions: media, voice, sticker, block, rate limit | новые `apps/api/src/eve/eve-transport*.ts` | **готово** (215 тестов) |
| T6 | Contract tests + evals | `apps/api/src/eve/*.spec.ts`, `apps/eve/evals/**` | частично (Nest 54, engine 86) |
| T8 | State writeback: moodDelta, conflict, stage counters, session log | `apps/eve/agent/channels/nest.ts` + Nest state endpoints | **готово** (22 теста) |
| T9 | Proactive: agenda tick, presence schedule, daily-life | `apps/eve/agent/schedules/**`, `apps/api/src/eve/eve-agenda.service.ts` | **готово** (21 тест) |
| T10 | Memory lifecycle: daily summary, palace, retrieval, reflection | `apps/api/src/eve/eve-memory.service.ts`, `apps/eve/agent/lib/memory/**` | **готово** (19+10 тестов) |
| T11 | Multi-account/shared relationships + memory UI | dashboard + `eve.service.ts` | **готово** (build) |
| T12 | Durable delayed actions: `EveDelayedAction` + 5 s tick в Nest (`EVE_DELAYED_TICK_MS`), без `setTimeout` в Eve | `apps/api/src/eve/eve-delayed.service.ts`, `apps/eve/agent/channels/nest.ts` | **готово** (19 тестов) |
| T13 | Стиль girl-agent: полный системный промпт, динамика персоны, пузыри, опечатки | `apps/eve/agent/instructions.md`, `instructions/persona.ts`, `eve-text.ts`, `lib/realism/typos.ts` | **готово** (18 тестов) |
| T14 | Гормоны, ночные пробуждения, входящие реакции/удаления, LLM-доки и daily-life, санитайз, эмбеддинги | `lib/persona/hormones.ts`, `realtime/reactions.ts`, `eve-persona-llm.ts`, `lib/realism/sanitize.ts`, `eve-memory-rank.ts` | **готово** (391 API + 153 Eve) |
| T7 | Ops: turbo, env, docs, feature flags, automations guard | root/turbo/docs | **частично** |

Правила: не удалять существующий код; не менять Prisma-схему без T0; не
открывать MTProto в Eve; Eve не импортирует Prisma; новые таблицы только через
Nest.

## Acceptance для первой рабочей версии

1. `bun run dev` поднимает api, dashboard, eve.
2. На странице персоны создаётся персона, привязывается аккаунт, добавляется
   чат в allowlist.
3. Входящее в разрешённый чат попадает в Eve, ответ уходит через Nest и виден
   в веб-чате.
4. Отвечает только Eve; других AI-путей в API нет.
5. Повторный вебхук не создаёт второй ответ.
6. После рестарта Eve события восстанавливаются по cursor.
