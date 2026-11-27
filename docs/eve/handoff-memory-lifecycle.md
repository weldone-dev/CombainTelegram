# Handoff: memory lifecycle (T10)

Статус: реализовано и покрыто тестами, **не подключено** к контроллеру и
модулю. Ниже — точные правки, которые нужно внести интегратору. Файлы
`eve.controller.ts`, `eve.module.ts`, `eve.service.ts` намеренно не менялись.

## Что уже есть

| Файл | Роль |
|---|---|
| `apps/api/src/eve/eve-memory-lifecycle.service.ts` | Nest-сервис: `closeDay`, `retrieve`, `reflect`, `amnesia`, `reset` + экспортированные чистые функции (`classifyHall`, `minePalace`, `analyzeLog`, `scoreText`, …) |
| `apps/api/src/eve/eve-memory-lifecycle.service.spec.ts` | 19 тестов: закрытие дня, дедуп, холлы, ранжирование, амнезия, reset |
| `apps/eve/agent/lib/memory/lifecycle.ts` | Те же детерминированные алгоритмы для локального fallback агента: `summarizeDay`, `minePalace`, `rankByKeywords`, `selectReflectionFacts`, `toMemoryContext` |
| `apps/eve/agent/lib/memory/lifecycle.test.ts` | 10 тестов на bun:test, общий фикстур с Nest-спекой (паритет) |

Схема Prisma не менялась. Внешних LLM-вызовов нет.

## 1. Провайдер в модуле

`apps/api/src/eve/eve.module.ts`:

```ts
import { EveMemoryLifecycleService } from './eve-memory-lifecycle.service.js';

@Module({
  imports: [MessagingModule, RealtimeModule],
  controllers: [EveController],
  providers: [
    EveTokenGuard,
    EveGateway,
    EveEventsService,
    EveMediaService,
    EveService,
    EveMemoryLifecycleService,
  ],
  exports: [
    EveEventsService,
    EveService,
    EveMediaService,
    EveMemoryLifecycleService,
  ],
})
export class EveModule {}
```

Сервис зависит только от `PrismaService`, новых модулей не требует.

## 2. Роуты в `EveController`

Все они автоматически закрыты `EveTokenGuard` (`x-eve-token`), потому что
guard висит на классе. Добавить в `apps/api/src/eve/eve.controller.ts`:

```ts
import { EveMemoryLifecycleService } from './eve-memory-lifecycle.service.js';

constructor(
  private readonly eve: EveService,
  private readonly events: EveEventsService,
  private readonly lifecycle: EveMemoryLifecycleService,
) {}
```

### `POST /internal/eve/memory/close-day`

```ts
@Post('memory/close-day')
closeDay(@Body() body: Record<string, unknown>) {
  return this.lifecycle.closeDay(
    field(body, 'personaId'),
    field(body, 'accountId'),
    body.chatId as string | number, // BigInt не сериализуется, см. ниже
    typeof body.day === 'string' ? body.day : undefined,
  );
}
```

Тело: `{ "personaId": "...", "accountId": "...", "chatId": 1830539716, "day": "2026-11-26" }`.
`day` опционален (по умолчанию — сегодня UTC). Ответ:

```json
{
  "personaId": "p1", "day": "2026-11-26", "skipped": false,
  "chars": 812, "feeling": "тепло и живо", "topics": ["плавание", "зал"],
  "facts": 2, "drawers": 5, "episodes": 1, "timeItems": 1, "complete": true
}
```

`skipped: true` + `reason: "no-log" | "too-short" | "already-closed"`.
Повторный вызов с тем же логом ничего не дублирует; если лог дорос (вечерние
сообщения), день перезакрывается — ловушка «сводка навсегда зафиксирована»
из TEXTBOOK §9.3 решена.

### `POST /internal/eve/memory/retrieve`

```ts
@Post('memory/retrieve')
retrieve(@Body() body: Record<string, unknown>) {
  return this.lifecycle.retrieve(
    field(body, 'personaId'),
    field(body, 'scopeKey'),
    typeof body.query === 'string' ? body.query : '',
    {
      facts: Number(body.facts) || undefined,
      daily: Number(body.daily) || undefined,
      palace: Number(body.palace) || undefined,
      episodes: Number(body.episodes) || undefined,
      crossChat: Number(body.crossChat) || undefined,
    },
  );
}
```

`limits` можно передать и объектом: `{ "limits": { "palace": 10 } }` — тогда
`this.lifecycle.retrieve(..., body.limits)`. Ответ:
`{ summary, relationship, facts[], daily[], palace[], episodes[], crossChat[] }`,
где `relationship` — отдельный объект со `stage`, счётчиками и `notes`.

### `POST /internal/eve/memory/reflect`

```ts
@Post('memory/reflect')
reflect(@Body() body: Record<string, unknown>) {
  return this.lifecycle.reflect(
    field(body, 'personaId'),
    field(body, 'accountId'),
    body.chatId as string | number,
  );
}
```

Ответ: `{ reflected: boolean, turns, factsAdded, feeling, scopeKey? }`.
Рефлексия срабатывает только когда общее число строк `EveSessionLog` для
`(persona, account, chat)` кратно 6.

### `POST /internal/eve/memory/amnesia`

```ts
@Post('memory/amnesia')
amnesia(@Body() body: Record<string, unknown>) {
  return this.lifecycle.amnesia(field(body, 'personaId'), Number(body.minutes));
}
```

Тело: `{ "personaId": "p1", "minutes": 120 }`. Удаляет записи за окно и
сбрасывает конфликт; строка `EveRelationship` остаётся. Ответ — счётчики:
`{ minutes, since, logs, facts, conflicts, conflictEvents, relationshipEvents, notes, agenda }`.

### `POST /internal/eve/memory/reset`

```ts
@Post('memory/reset')
reset(@Body() body: Record<string, unknown>) {
  return this.lifecycle.reset(field(body, 'personaId'));
}
```

Полная очистка памяти персоны (14 таблиц в одной транзакции). Персоны,
привязки аккаунтов, allowlist и `EveSessionState` не затрагиваются.

## 3. Канал Eve

`apps/eve/agent/memory/nest.ts` сейчас читает `/memory/recall`. После
подключения роутов:

- `turn.started` → `POST /memory/retrieve` с `{ personaId, scopeKey: ctx.memory.scope.key, query }`,
  затем `toMemoryContext(snapshot)` из `agent/lib/memory/lifecycle.ts` →
  `buildSystemPrompt({ memory })`.
- `turn.completed` → оставить `/memory/capture`; дополнительно
  `POST /memory/reflect` (сервис сам решит, шестой ли это ход).
- закрытие дня вызывает планировщик T9 (`POST /memory/close-day` для каждого
  дня, кроме текущего, раз в 30 минут). В этом сервисе нет таймера.

## 4. Известные ограничения

- Эвристики без модели: «факт» — предложение с «я/мне/меня» или именем;
  вопросы-болтовня («как прошёл день?») отбрасываются. Это осознанный
  fallback, не финальное качество.
- `EveMemoryFact.relationshipId` при дневной добыче остаётся `null`
  (персональная память персоны), поэтому `retrieve` всегда добавляет
  `relationshipId: null` к выборке скоупа.
- `apps/api` и `apps/eve` не могут импортировать друг друга, поэтому
  алгоритмы продублированы. Общий фикстур в двух спеках — единственная защита
  от расхождения; при правке маркеров меняйте оба файла.
