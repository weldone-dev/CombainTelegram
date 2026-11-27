# Eve engine: локальный запуск

`apps/eve` — отдельный Node-процесс (Eve 1.5.0), который реализует
girl-agent-поведение. Telegram, SQLite, allowlist и фактическая отправка
остаются в NestJS.

Eve — единственный LLM-стек: старые Soul/autopilot, реестр провайдеров, скиллы,
боты, автоматизации, MCP-эндпоинт и n8n удалены вместе с таблицами. Голос
расшифровывает `SpeechService` в messaging-слое по env `STT_*`.

## Запуск

```bash
bun install
bun run dev
```

Turbo поднимает:

| Процесс | Адрес |
|---|---|
| API | http://127.0.0.1:4001 |
| Dashboard | http://127.0.0.1:4000 |
| Eve | http://127.0.0.1:4020 (`/eve/v1/health`) |

Eve не контейнер и не отдельный ручной процесс: его запускает `bun run dev`.

## Env

`apps/api/.env`:

```env
EVE_TOKEN=<random 32 bytes hex>
EVE_WEBHOOK_URL=http://127.0.0.1:4020/eve/v1/nest/events
EVE_PROACTIVE_URL=
EVE_TURN_URL=   # optional; derived from EVE_WEBHOOK_URL when empty
```

`apps/eve/.env.local`:

```env
EVE_NEST_URL=http://127.0.0.1:4001
EVE_TOKEN=<same as api>
EVE_LLM_BASE_URL=<OpenAI-compatible>
EVE_LLM_API_KEY=<key>
EVE_LLM_MODEL=<model>
EVE_LLM_HEADERS={"x-opencode-session":"..."}   # optional
```

`apps/dashboard/.env.local` (server-only proxy):

```env
EVE_NEST_URL=http://127.0.0.1:4001
EVE_TOKEN=<same as api>
```

## UI

`/eve`:

- создание/редактирование персоны;
- привязка Telegram-аккаунтов (`shared` / `isolated`);
- allowlist чатов (по умолчанию blocked);
- docs: persona/speech/boundaries/communication;
- read-only relationship/conflict, memory daily/facts/palace/sessions/agenda.

## Промпт и стиль

- `apps/eve/agent/instructions.md` — статический системный промпт: роль, регистр, anti-AI правила, ритм и длина, пузыри, скучные вопросы, память, маркеры действий.
- `apps/eve/agent/instructions/persona.ts` — динамика на каждый turn: доки персоны, локальное время и часовой пояс, стадия, счёт score, конфликт.
- `apps/api/src/eve/eve-text.ts` — разбиение на пузыри и дедуп: `---` канонический разделитель, короткие строки становятся пузырями, если behavior попросил больше одного, точные повторы и перефразы выкидываются.
- `apps/eve/agent/lib/realism/typos.ts` — редкие опечатки по соседним клавишам, максимум одна на реплику, ссылки и упоминания не трогаются.
- `EvePersonaGenService` генерирует четыре дока с семью секциями: бэкграунд, характер, триггеры, интересы, тёмные стороны, кринж, отношение к айтишнику; речь, границы и манера общения — отдельными документами.

## Контракт

- Eve → Nest: `/internal/eve/*`, заголовок `x-eve-token`.
- Nest → Eve: `POST /eve/v1/nest/events` (durable push),
  `POST /eve/v1/nest/turn` (отложенный turn) и `POST /eve/v1/nest/proactive`.

## Контекст модели (снапшоты)

Дашборд показывает не реконструкцию промпта, а фактический вход модели.
`agent/instrumentation/context.ts` получает финальные `instructions` и
`messages` прямо перед вызовом провайдера, `agent/hooks/context-snapshot.ts`
после `turn.settled` отправляет первый вызов turn'а в Nest:

| Метод | Что делает |
|---|---|
| `POST /internal/eve/context/snapshot` | приём снапшота, `chars` считает Nest, идемпотентно по `turnId` |
| `GET /internal/eve/context/snapshots?personaId=&accountId=&chatId=&limit=` | новые первыми |
| `GET /internal/eve/context/snapshots/:id` | один снапшот |

- `kind`: `inbound` / `proactive` / `deletion` / `reaction` / `other`; канал
  кладёт origin в auth-атрибут `kind`, поэтому hook не угадывает по тексту.
- `turnId` = `<eveSessionId>:<turnId>`: ретрай turn'а не создаёт дубль, и
  сброс Eve-сессии (turn id снова `turn_0`) не сталкивается со старой строкой.
- `tokens` — usage провайдера; если провайдер его не вернул, оценка
  `chars/4` и `meta.estimated: true`.
- Retention: `EVE_CONTEXT_SNAPSHOT_KEEP` (по умолчанию 50) последних
  снапшотов на чат; старые удаляются после записи, не блокируя ответ.
- Захват best-effort: ошибка/таймаут отправки снапшота не ломает turn.

## Dry-run (ответы не уходят в Telegram)

`apps/api/.env`:

```env
EVE_DRY_RUN=false
# необязательно: ограничить конкретными чатами / аккаунтами
EVE_DRY_RUN_CHATS=1830539716,-1001234567890
EVE_DRY_RUN_ACCOUNTS=
```

- Включается только явным `true/1/yes/on`; опечатка оставляет реальную
  отправку. При старте API печатает
  `[eve][dry-run] WARNING: EVE DRY RUN enabled — outbound suppressed for …`.
- Персона проходит весь путь: behavior, LLM, пузыри, задержки, память,
  `turn/apply`, запись в `EveSessionLog` (строка `-> она (dry-run): …`).
- Подавляются все исходящие действия: текст, медиа, стикер, войс, реакция,
  правка/удаление, typing, read, presence, block/unblock, а также `send`/
  `react`/`edit`/`delete`/`read` из `EveDelayedAction`. Вместо Telegram —
  строка `[eve][dry-run] <kind> chat=… account=… …` и синтетический
  отрицательный `messageId`, чтобы turn завершился без ретрая.
- Подавленные действия попадают в `meta.suppressedOutbound` следующего
  снапшота, а `EveContextSnapshot.dryRun` помечает сам turn для дашборда.


## Отложенные действия

Eve не держит таймеров. Канал, увидев `delaySec > 0`, кладёт строку в
`EveDelayedAction` (`POST /internal/eve/actions`) и отвечает 202. Nest тикает
раз в 60 с (`EveDelayedService`):

| kind | что делает тик |
|---|---|
| `turn` | `POST /eve/v1/nest/turn` → модель отвечает в той же сессии |
| `send` | `MessagingService.sendMessage` без модели |
| `edit` | `MessagingService.editMessage` |
| `delete` | `MessagingService.deleteMessage` |
| `react` | `MessagingService.sendReaction` |
| `read` | `MessagingService.markRead` |

- `dueAt` считается из `delaySec`; кап — 1 ч для `turn`, 24 ч для остальных.
- `dueAt = null` (`reason: sleep|busy|offline`) ждёт не часов, а presence-тика:
  когда она просыпается, строка становится due. Строка, которая прождала
  больше 24 ч, дропается с `expired`.
- `key` (id события) уникален на персону, поэтому реплей события не создаёт
  второй turn.
- Если чат убрали из allowlist или отвязали аккаунт, строка получает
  `state = dropped` и в Telegram не уходит.
- Ошибки: до 5 попыток, потом `state = failed`; последняя ошибка в `lastError`.
- Отложенный turn передаёт сохранённое поведенческое решение, поэтому
  `decideBehavior` и счётчики стадии не применяются второй раз.
- Адрес сессии: `personaId:accountId:chatId`.
- Eve не импортирует Prisma и не открывает Telegram.

## Что реализовано

- behavior gate до создания сессии (сон/конфликт/dumped/ignore): `activeDialog` = её последний ответ < 5 мин, а не его сообщения; сон приоритетнее, в живом диалоге занятость не глушит ответ;
- `applied` живёт один turn: каждый входящий заново применяет mood/стадии/лог, `memory/reflect` и `agenda/extract`; proactive/reaction/deletion не считаются входящими и не повторяют чужой `messageId`;
- новый inbound снимает отложенный `turn` этого чата, чтобы не отправить два ответа на одну паузу; текст снятого turn'а не теряется — серия неотвеченных сообщений (`burst`, `id` + текст) уходит в следующий turn, модель отвечает на всю серию, а `turn/apply` считает каждый `id` серии один раз (`lastHisMessageId`, mood — один раз на turn), `agenda/extract` получает объединённый текст;
- proactive-, reaction- и deletion-turn'ы отправляются с `turnPolicy: 'queue'`: они не вклиниваются (steering) в уже выполняющийся ответ и не перетирают его per-turn поля;
- reaction-only без второго LLM: на тёплой стадии часть игноров и «телефон недоступен» превращается в исходящую реакцию из палитры стадии;
- reply/forward-контекст: `quoteText` mtcute, `forward`/`forward_info` обоих транспортов и догрузка текста цитируемого сообщения;
- state writeback: mood, conflict, stage, session log;
- proactive agenda tick + daily-life;
- memory lifecycle: daily summary, palace, retrieval, reflection, amnesia/reset;
- transport: text, media, voice, sticker, reaction, edit/delete, block/unblock, typing/read/presence;
- durable delayed actions: `EveDelayedAction` + тик в Nest, без `setTimeout` в Eve;
- гормоны: детерминированный цикл 26–32 дня, фазы, стресс, влияние на reply/ignore/delay/bubbles; `nightWakeChance` работает;
- входящие реакции и удаления: TDLib/mtcute → `EveEvent` → policy в канале, без лишних turn'ов; свои отправки индексируются в `UpdatesService` (`noteOutgoing`), поэтому `targetIsMine` работает и на mtcute (phone/QR); токсичная реакция меняет настроение молча, удаление даёт короткий комментарий по трём веткам (saw-and-read / saw-not-read / missed);
- daily-life и `busySchedule` реально влияют на поведение: занятость/«без телефона» — это задержка или игнор, а не только текст в промпте;
- prompt собирает communication-профиль, ignoreTendency, возраст, день, конфликт с часами; память приходит одним каналом (memory-сообщения), без дубля в системном блоке;
- recall идёт через ранжирующий `memory/retrieve` (эмбеддинги + лексика) с фолбэком на SQL-recall; Nest резолвит `scopeKey` из account/chat, а не из хеша Eve;
- agenda: LLM-извлечение событий из его сообщений, LLM-поводы вместо шаблонов, отмена/перенос при росте конфликта;
- online-heartbeat по паттерну (burst/evening/rare/night), а не «бодрствует = онлайн»;
- `GET /eve/v1/nest/why` — последнее решение по чату (intent, причина игнора, задержка) для диагностики;
- self-edit опечатки (25 %) через durable-очередь `edit`;
- LLM-генерация доков персоны и daily-life с детерминированным фолбэком;
- санитайз ответов (анти-jailbreak, мета-утечки) и паузы между пузырями;
- семантический recall: эмбеддинги поверх лексического скоринга, с фолбэком;
- dashboard persona/docs/memory UI;
- 95 файлов / 1323 Nest-теста (включая Eve/realtime/messaging) и 200
  Eve engine/realism/channel-тестов; живые числа печатают `bun run test` и
  `bun test apps/eve/agent`.

## Ограничения

- Incoming edits never create turns. Incoming deletions produce a short turn only for saw-and-read / saw-not-read; missed deletions stay silent. A sent reaction is not a turn, and a toxic reaction only moves mood (throttled).
- TDLib inbound reactions (`updateMessageInteractionInfo`) are mapped and enriched from the session's recent index; TDLib deletions get text/date/outgoing from the same index. Stickers save `fileId`: mtcute's Bot API id or TDLib's `remote.unique_id`, so the library works on both transports (a foreign id falls back to the other engine or is skipped).
- TTS/voice initiative and photo library are not implemented: the persona can
  send stickers and text, not generated voice or photos.
- Model sampling parameters (temperature) are not exposed by Eve 1.5
  `defineAgent`; only the provider defaults apply.
- `eve dev` never fires static schedules on their cadence, so the Eve-side
  `proactive.ts`/`presence.ts` files are inert in dev; Nest runs its own 60 s
  ticks (`EveProactiveService`, `EveDelayedService`, memory lifecycle).
- Persona docs generation is an LLM call with strict JSON and structural
  validation; a deterministic template remains as the fallback when no
  provider is configured.
- Memory summary/palace/reflection heuristics are deterministic; semantic
  recall is embeddings over lexical scoring when the provider exists.
- `LLM-judge` верификатор ответа не подключён, и второго LLM в поведенческом
  тике нет: канал зовёт `decideBehavior` без decider'а, то есть решение
  полностью детерминированное (`decideWithLlm` существует, но в боевом пути
  не используется). Санитайз остаётся regex-based (осознанно; обоснование — в
  отчёте раунда 2, раздел «сознательно другое»).
- Eve sessions are pinned to the Eve version; upgrade can strand a session.
