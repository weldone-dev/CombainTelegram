# Workflows: приложение ⇄ n8n

Как настроить связку «входящее сообщение в Telegram → workflow в n8n → ответ
души» с нуля, что происходит внутри и где смотреть, когда не работает.

Готовый шаблон: `infra/n8n/templates/combain-events.workflow.json`.
Обвязка n8n (compose, версии, бэкапы): `infra/n8n/README.md`.

Состояние связки — это **три независимые вещи**, и работают они только вместе:

| Что | Где включается | Признак, что включено |
| --- | --- | --- |
| `N8N_ACTION_TOKEN` в API | `apps/api/.env` + перезапуск API | `GET /integrations/n8n/events` отвечает `200`, а не `503` |
| Workflow в n8n | кнопка Active/Publish в n8n | в n8n запуски идут каждые несколько секунд |
| Workflow привязан к аккаунту | `/workflows` в дашборде | `GET /integrations/n8n/accounts` показывает `workflowId` |

Пока нет привязки к аккаунту, лента событий **пустая** — это не баг, а гейт:
приложение отдаёт n8n только трафик аккаунтов, у которых есть workflow.

---

## 1. Что где работает

| Компонент | Где | Адрес | Кто обращается |
| --- | --- | --- | --- |
| Приложение (NestJS API) | процесс на хосте | `0.0.0.0:3001`, Swagger `/docs` | дашборд, n8n-контейнер, curl |
| Дашборд (Next.js) | процесс на хосте | `http://localhost:3000` | браузер |
| n8n | контейнер `n8n-n8n-1` | `http://192.168.1.88:5678` (`N8N_HOST`), внутри сети — `http://n8n:5678` | браузер, приложение |
| Postgres n8n | контейнер, наружу не публикуется | `postgres:5432` | только n8n |
| llm-proxy (OpenCode Go) | контейнер | `:4100` на хосте, `http://llm-proxy:4000` в сети | n8n Assistant |
| sandbox-api | контейнер `n8n-sandbox` | `127.0.0.1:3200`, в сети `http://sandbox-api:8080` | n8n Assistant |
| SearXNG | контейнер | `127.0.0.1:8081`, в сети `http://searxng:8080` | n8n Assistant |

Ключевой момент про адреса: **внутри контейнера `127.0.0.1` — это сам контейнер**.
Поэтому n8n не может ходить в приложение ни по `127.0.0.1:3001`, ни по
`192.168.1.88:3001` (этот адрес может быть недоступен из bridge-сети).
Для этого в `infra/n8n/docker-compose.yml` у сервисов `n8n` и `llm-proxy` есть:

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

и приложение доступно из контейнера как `http://host.docker.internal:3001`.
Из браузера это имя **не** работает — оно только для контейнеров.

Проверка (приложение должно быть запущено):

```bash
cd infra/n8n
docker compose exec n8n wget -qO- http://host.docker.internal:3001/ai/settings
# ожидаем JSON: {"provider":"openai-compatible",...}
```

Направления запросов:

```
n8n workflow ──HTTP (x-combain-token)──▶ приложение :3001 /integrations/n8n/*
n8n workflow ──HTTP────────────────────▶ llm-proxy :4100 / sandbox / searxng
приложение   ──HTTP (X-N8N-API-KEY)────▶ n8n :5678 /api/v1/*   (только список
                                          workflow и executions для дашборда)
```

---

## 2. Токен и credential

Action API (`/integrations/n8n/*`) закрыт общим секретом в заголовке
**`x-combain-token`**. Без него API отвечает `503 N8N_DISABLED` — это защита от
случайно открытого наружу эндпоинта, который умеет отправлять сообщения.

1. Сгенерировать значение (один раз, 32 байта):

   ```bash
   openssl rand -hex 32
   ```

2. Вписать в `apps/api/.env`:

   ```env
   N8N_ACTION_TOKEN=<64 hex-символа>
   ```

   `.env` читается **при старте** процесса, поэтому после правки API нужно
   перезапустить (`bun run dev` в корне репозитория).

3. Проверить, что токен подхватился:

   ```bash
   TOKEN=$(grep '^N8N_ACTION_TOKEN=' apps/api/.env | cut -d= -f2)
   curl -s -H "x-combain-token: $TOKEN" \
     'http://127.0.0.1:3001/integrations/n8n/events?limit=1'
   # {"events":[],"nextCursor":null}   ← 200 и пустая лента = всё хорошо
   curl -s -o /dev/null -w '%{http_code}\n' \
     'http://127.0.0.1:3001/integrations/n8n/events?limit=1'
   # 401 — токен не передан; 503 — токен не задан в API
   ```

4. Создать credential в n8n: **Credentials → Create credential → Header Auth**

   | Поле | Значение |
   | --- | --- |
   | Name | `Combain Action API` |
   | Header Name | `x-combain-token` |
   | Header Value | значение `N8N_ACTION_TOKEN` |

   Имя credential важно: шаблон ссылается именно на `Combain Action API`.
   Значение хранится в зашифрованном виде (ключ `N8N_ENCRYPTION_KEY`), в JSON
   workflow его нет.

Ротация: меняете значение в `apps/api/.env`, перезапускаете API, обновляете
credential в n8n. Старое значение сразу даёт `401 UNAUTHORIZED`. Пустое
значение в `.env` возвращает `503` — сервис «выключен», а не «открыт».

---

## 3. Импорт шаблона

Файл: `infra/n8n/templates/combain-events.workflow.json` (полный экспорт n8n
2.49.6: `nodes`, `connections`, `settings`, `staticData`).

1. n8n → **Workflows** → **⋯ → Import from File…** → выбрать файл
   (или скопировать JSON и вставить через **Import from Clipboard**).
2. Открыть импортированный workflow. Две ноды будут с красной пометкой
   credential:
   - **Combain: события** (GET, long-poll),
   - **Combain: soul-reply** (POST).
   В каждой: поле **Credential for Header Auth** → выбрать `Combain Action API`.
   Третья HTTP-нода («Пример: send-text») выключена и ни к чему не подключена.
3. Нажать **Active** (в 2.x — **Publish**). Без этого Schedule Trigger не
   стреляет, а `Executions` остаётся пустым.

Что делает шаблон:

```
Schedule Trigger (каждые 5 с)
  └─ Poll guard (Code)               один опрос за раз, «замок» в staticData
      └─ IF skip == false
          └─ GET /integrations/n8n/events?limit=25&wait=25&cursor=<staticData>
              └─ Разобрать события (Code)   cursor → staticData, фильтр
                  └─ IF count > 0
                      └─ Item Lists (splitOutItems: events)
                          └─ POST /integrations/n8n/actions/soul-reply
```

Детали, которые важно понимать:

- **Long-poll.** `wait=25` — запрос висит до 25 секунд и возвращается либо с
  событиями, либо пустым. Поэтому «опрос каждые 5 секунд» на самом деле
  превращается в непрерывный поток, а не в 12 запросов/мин.
- **Poll guard.** Пока один запуск держит запрос, следующие тики выходят сразу:
  без этого два параллельных запуска могли получить одно и то же событие и
  ответить дважды. Замок живёт в `$getWorkflowStaticData('global').pollUntil`
  (26 с — чуть больше окна long-poll).
- **Курсор.** `nextCursor` из ответа сохраняется в
  `$getWorkflowStaticData('global').cursor` **до** фильтрации: отфильтрованные
  события не должны приходить снова. Static data хранится в Postgres n8n, в
  экспорт JSON не попадает и переживает рестарт контейнера.
- **Фильтр.** Остаётся только `kind === 'message.new'` и `payload.outgoing !== true`.
  Правки, удаления, прочтения и свои сообщения отбрасываются.
- **Промпт.** `payload.text`, иначе `payload.transcript` (расшифровка
  голосового), иначе `[вложение]`. `chatId`/`threadId`/`accountId` берутся из
  самого события, `replyToMessageId` — из `payload.messageId`.
- **Таймауты.** GET — 60 с, soul-reply — 120 с (генерация ответа + отправка
  нескольких пузырей).

Импорт через API (необязательно). Публичный API требует ключ со scope на
создание workflow; ключ «только чтение» вернёт `403 Forbidden`:

```bash
cd infra/n8n
# ключ: n8n → Settings → n8n API
curl -s -X POST http://127.0.0.1:5678/api/v1/workflows \
  -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' \
  -d "$(jq '{name: .name, nodes, connections, settings}' \
        templates/combain-events.workflow.json)" | jq '.id'
```

---

## 4. Привязать workflow к аккаунту

### 4.1. Подключение n8n в дашборде

Страница **`/workflows`** → карточка «Подключение n8n»:

- адрес: `http://127.0.0.1:5678` (API и n8n на одном хосте),
- ключ: n8n → **Settings → n8n API → Create an API key**.

Кнопка «Проверить» делает `POST /workflows/n8n/test`. Ключ нужен только
приложению, чтобы показать список workflow и последние executions; n8n ходит в
приложение по своему токену.

### 4.2. Добавить workflow в локальный список

В блоке «Workflow в n8n» нажать **«Использовать»** у нужного workflow — это
`POST /workflows`:

```json
{ "name": "Combain: входящие → soul-reply",
  "n8nWorkflowId": "<id из адреса n8n>",
  "n8nWorkflowName": "Combain: входящие сообщения → soul-reply" }
```

`n8nWorkflowId` — id из адреса n8n (`/workflow/<id>`). Если n8n недоступен,
есть «Добавить по ID» вручную.

### 4.3. Повесить на аккаунты

Карточка workflow → **Аккаунты** → выбрать один или несколько → сохранить
(`PUT /workflows/:id/accounts`):

```bash
curl -s -X PUT http://127.0.0.1:3001/workflows/<wfId>/accounts \
  -H 'Content-Type: application/json' \
  -d '{"accountIds":["<accountId>"]}'
```

То же самое доступно из карточки аккаунта: **Настройки аккаунта → вкладка
Workflow → «Workflow»** (значение «Без workflow» отвязывает аккаунт).

### 4.4. `aiMode`: кто отвечает за аккаунт

`GET /accounts/:accountId/workflow` возвращает `{ workflow, aiMode }`, где
`aiMode`:

| `aiMode` | Когда | Кто отвечает в личке |
| --- | --- | --- |
| `workflow` | у аккаунта есть привязанный workflow | **только n8n** |
| `legacy` | привязки нет, `AI_WORKFLOW_STRICT` выключен (по умолчанию) | встроенный автопилот души |
| `disabled` | привязки нет, `AI_WORKFLOW_STRICT=1` | никто, ИИ молчит |

Что меняет `workflow`:

- встроенный автопилот **не отвечает сам** — он только пишет событие в outbox
  (`message.new`) и логирует `dm.autopilot.workflow`;
- **индикатор «печатает…» и read receipt не отправляются** — это часть
  legacy-пути;
- **allowlist души не проверяется** для ленты: n8n видит все входящие этого
  аккаунта, включая группы и каналы. Фильтровать должен workflow (например,
  `IF chatId > 0`);
- `soul-reply` из n8n **тоже игнорирует allowlist** — решение «этому отвечаем»
  принимает workflow. Блокировка чата (`/block`) по-прежнему сильнее: `403
  CHAT_BLOCKED`.

`AI_WORKFLOW_STRICT=1` в `apps/api/.env` полностью выключает legacy-автопилот
для аккаунтов без workflow (полезно, когда n8n — единственный движок).

Переключатель «включён/выключен» на карточке workflow — это флаг
`Workflow.enabled`: он показывается в дашборде и в
`GET /integrations/n8n/accounts`, но **не** останавливает ни ленту событий, ни
гейт автопилота. Чтобы аккаунт вернулся к legacy, отвяжите его («Без
workflow»); чтобы остановить движок — деактивируйте workflow в n8n.

---

## 5. Как проверить, что работает

### 5.1. Лента событий

```bash
TOKEN=$(grep '^N8N_ACTION_TOKEN=' apps/api/.env | cut -d= -f2)
curl -s -H "x-combain-token: $TOKEN" \
  'http://127.0.0.1:3001/integrations/n8n/accounts' \
  | jq '.[] | {id,title,workflowId,workflowName,soulMode}'
```

`workflowId` должен быть не `null`. `soulMode` — это режим души
(`off`/`draft`/`auto`), а не `aiMode`: эффективный движок аккаунта смотрите в
`GET /accounts/:id/workflow` (§4.4). Дальше — отправить сообщение с другого
Telegram-аккаунта в личку этому аккаунту и посмотреть ленту:

```bash
curl -s -H "x-combain-token: $TOKEN" \
  'http://127.0.0.1:3001/integrations/n8n/events?limit=5&wait=5' | jq
```

Ответ: `{ "events": [ { "id", "kind", "accountId", "chatId", "threadId",
"payload": { "messageId", "text", "mediaType", "transcript", "outgoing",
"senderName", ... }, "createdAt" } ], "nextCursor": "<id>" }`.
Внимание: чтение помечает события доставленными, но это **не** удаляет их —
повторный запрос с тем же `cursor` их снова покажет (ретенция 7 дней).

### 5.2. Исполнение в n8n

n8n → **Executions** → последний запуск. Ожидаемая картина:

- `Combain: события` — `200`, в output `events`;
- `Разобрать события` — `count ≥ 1`;
- `Combain: soul-reply` — `200` и тело вида
  `{ "sent": true, "superseded": false, "text": "…", "messageIds": [123] }`.

Ответ в Telegram приходит через приложение (n8n не знает MTProto), поэтому
сообщение появляется от вашего аккаунта.

### 5.3. Логи и запуски в приложении

```bash
# debug-записи гейта: «Autopilot skipped in <chatId>: the account is assigned…»
curl -s 'http://127.0.0.1:3001/logs?q=dm.autopilot&limit=20' \
  | jq '.entries[] | {level,action,message}'
# запуски агента, в том числе созданные soul-reply
curl -s 'http://127.0.0.1:3001/ai/runs?source=dm&limit=5' \
  | jq '.runs[] | {id,status,steps,model,error}'
# события, которые приложение записало в outbox
curl -s 'http://127.0.0.1:3001/logs?q=n8n.event&limit=20' \
  | jq '.entries[] | {action,message}'
```

`AgentRun` (таблица + `GET /ai/runs?source=dm`) — это и есть «что делала душа»:
prompt, output, steps, trace, токены, ошибка.

### 5.4. Если лента пустая

| Симптом | Причина | Что делать |
| --- | --- | --- |
| `503 N8N_DISABLED` | `N8N_ACTION_TOKEN` не в `.env` или API не перезапущен | вписать токен, перезапустить API |
| `401 UNAUTHORIZED` | не тот заголовок/значение | credential `Combain Action API`, имя `x-combain-token` |
| `200`, `events: []` | у аккаунта нет workflow | `PUT /workflows/:id/accounts` |
| `200`, `events: []`, но workflow привязан | сообщение пришло до привязки/до старта приложения; либо это группа и её отфильтровали | написать новое сообщение, проверить `chatId > 0` |
| `200`, `events: []`, `nextCursor` не меняется | курсор уже указывает на последнее событие | это норма: ждём новых |
| курсор «застрял» на удалённой записи | ретенция вычистила строку | лента сама переиграет с самой старой сохранённой; если нет — очистить `staticData.global.cursor` в n8n (Workflow → ⋯ → Settings → Static Data) |
| n8n: `ECONNREFUSED`/`ENOTFOUND host.docker.internal` | нет `extra_hosts` или контейнер не пересоздан | `docker compose up -d` в `infra/n8n`, затем `docker compose exec n8n wget -qO- http://host.docker.internal:3001/ai/settings` |
| n8n: `connect ETIMEDOUT` | приложение слушает только loopback или другой порт | `PORT=3001` и `0.0.0.0` в `apps/api` |
| n8n: `socket hang up` на soul-reply | ответ дольше 120 с | увеличить `options.timeout`; смотреть `GET /logs?level=error` |
| `404 SOUL_NOT_FOUND` | у аккаунта не настроена душа | Настройки аккаунта → Душа |
| `403 CHAT_BLOCKED` | чат/топик заблокирован | `POST /integrations/n8n/actions/unblock` |
| `400 VALIDATION_ERROR` | не хватает `accountId`/`chatId`/`prompt` | смотреть `message` в ответе |
| ответ есть, но `superseded: true` | пришло новое сообщение, пока генерировался ответ | норма; см. §7 |

---

## 6. MCP в workflow: два направления

В проекте есть **свой** MCP-сервер приложения, и это не то же самое, что
интеграция n8n. Не смешивайте:

### 6.1. Workflow → инструменты приложения (используется сейчас)

Внутри n8n-воркфлоу нет MCP-клиента, и он не нужен: все инструменты доступны
обычным HTTP-вызовом

```http
POST http://host.docker.internal:3001/integrations/n8n/actions/tool/<name>
x-combain-token: <N8N_ACTION_TOKEN>
content-type: application/json

{ "accountId": "...", "chatId": 123456, "args": { ... } }
```

Ответ: `{ "ok": true, "result": …, "dryRun": false }`.

Имена (`<name>`) — из реестра `apps/api/src/ai/agent-tools.service.ts`:

| Группа | Инструменты |
| --- | --- |
| Сообщения | `messages_send`, `messages_history`, `messages_search`, `messages_edit`, `messages_react`, `messages_read`, `messages_delete` |
| Чаты | `chats_list`, `chats_get`, `chats_search` |
| Память | `memory_add`, `memory_view`, `memory_summarize`, `memory_clear` |
| Души и навыки | `souls_list`, `soul_get`, `soul_update`, `skills_list`, `skill_get`, `skill_create`, `skill_update`, `skill_delete` |
| Автоматизации | `automation_create`, `automation_update`, `automation_delete`, `automation_run`, `automation_pause_chat`, `automation_resume_chat`, `automations_list` |
| Доступ | `chat_warn`, `chat_block`, `chat_unblock`, `ai_access_get`, `ai_access_set` |
| Прочее | `logs_search`, `policy_get`, `policy_update`, `accounts_list`, `accounts_get`, `system_status`, `settings_get`, `settings_update` |

Аргументы — те же, что у инструмента в диалоге с агентом; `accountId`/`chatId`
можно указать на верхнем уровне (они подставятся в контекст вызова).

**Политика применяется как обычно, и это главное отличие от «просто curl»:**

- capability инструмента должна быть включена (`read`, `send`, `edit`,
  `delete`, `react`, `admin`, `policy`; см. Настройки → AI и оверрайды
  аккаунта) — иначе `403 CAPABILITY_DISABLED`;
- `accountId` проверяется на принадлежность пользователю — иначе
  `404 ACCOUNT_NOT_FOUND`;
- заблокированный чат — `403 CHAT_BLOCKED`;
- `dryRun=1` в настройках делает вызов «примерочным»: `dryRun: true` в ответе,
  ничего не отправляется;
- каждый вызов попадает в лог как `ai.tool.<name>` (source `automation`).

Пример: узнать историю чата тем же путём, которым это делает агент:

```bash
curl -s -X POST http://127.0.0.1:3001/integrations/n8n/actions/tool/messages_history \
  -H "x-combain-token: $TOKEN" -H 'Content-Type: application/json' \
  -d '{"accountId":"<id>","args":{"chatId":123456789,"limit":10}}'
```

Теги — не инструмент агента, а отдельный Action API: тег ставится через
`POST /integrations/n8n/actions/tags/set` с `{ accountId, chatId, tag }`.

### 6.2. n8n как MCP-сервер (следующий шаг, пока не подключено)

В n8n есть нода **MCP Server Trigger**
(`@n8n/n8n-nodes-langchain.mcpTrigger`): она публикует workflow как
MCP-инструмент. Поле **Path** — это полный путь, а не суффикс: если вписать
`mcp/combain`, сервер будет доступен по `http://<n8n>/mcp/combain`
(за `WEBHOOK_URL`); актуальный адрес копируется кнопкой в самой ноде. Каждая
подключённая к триггеру нода-**инструмент** становится MCP-tool с описанием,
а `Authentication` по умолчанию `None` — то есть эндпоинт открыт всем, кто до
него дотянется, и его стоит закрыть хотя бы `Header Auth`.

Чтобы душа могла вызывать такой инструмент, **приложению нужен MCP-клиент**:
запись вида «endpoint + авторизация + политика» в реестре инструментов, чтобы
`AgentToolsService` показывал эти tools модели. Сейчас такой записи нет:
приложение умеет быть только MCP-**сервером** (`POST /mcp`, Streamable HTTP,
`Authorization: Bearer <токен из GET /ai/mcp>`), а не клиентом. Так что
направление

```
душа ──MCP──▶ n8n MCP Server Trigger   ← пока НЕ реализовано
```

— это следующая задача. Что для неё понадобится: адрес
`http://host.docker.internal:5678/mcp/<path>` (из контейнера n8n) или
`http://127.0.0.1:5678/mcp/<path>` (если клиент живёт в API), заголовок,
который требует `Authentication` ноды, отдельная capability в политике,
таймаут и префикс имён, чтобы инструменты n8n не конфликтовали с 45
встроенными.

Обратное направление — **приложение как MCP-сервер для n8n** — работает уже
сейчас и является альтернативой `actions/tool/<name>`: в n8n можно поставить
ноду **MCP Client Tool** и указать

```
URL:    http://host.docker.internal:3001/mcp
Header: Authorization: Bearer <токен из GET /ai/mcp>
```

Плюс — модель в n8n видит те же схемы инструментов, что и душа; минус — политика
оценивается без привязки к аккаунту (`accountId`/`chatId` передаются
аргументами), и в логах это `source=mcp`. Для «ответить в чат» проще и
предсказуемее `actions/soul-reply`/`actions/send-text`.

---

## 7. Ограничения и подводные камни

- **Склейка бурста.** Legacy-автопилот ждёт паузу и склеивает несколько
  подряд идущих сообщений в один ответ (до `MAX_BURST`). Workflow получает
  **по событию на сообщение**, поэтому шаблон отвечает на каждое — и если
  человек написал три строки подряд, вы получите три ответа (второй и третий
  могут отменить первый, см. ниже). Если нужен один ответ на бурст: поставьте
  после `Item Lists` ноду **Wait** (5–10 с), затем **Aggregate** по `chatId`,
  и только потом один `soul-reply` с текстом последнего сообщения.
- **`superseded`.** `soul-reply` идёт через тот же пайплайн, что и автопилот:
  новое входящее в тот же чат увеличивает run-token, и текущая генерация
  возвращает `{ sent: false, superseded: true, messageIds: [] }` вместо
  устаревшего ответа. В n8n это `200`, а не ошибка — смотрите поле `sent`.
- **Лимиты души.** `maxPerHour` (по умолчанию 12 на аккаунт) и
  `maxPerChatPerDay` (40 на чат). При достижении `soul-reply` возвращает
  `sent: false` и пишет `dm.autopilot.rate_limit`; `0` — без лимита. Workflow
  эти лимиты **не обходит** — они часть генерации.
- **Read receipt и «печатает…»** в режиме workflow не отправляются: сообщение
  остаётся непрочитанным в интерфейсе Telegram, пока вы не откроете его сами.
  Если это важно — после `soul-reply` вызовите
  `POST /integrations/n8n/actions/tool/messages_read` с `{ accountId, chatId }`.
- **Приватные чаты.** В ленту попадают все чаты, включая группы и каналы
  (`chatId < 0`). В шаблоне нет фильтра по типу чата — добавьте `IF chatId > 0`,
  если не хотите отвечать в группах.
- **Медиа.** Байты в событие не попадают: только `mediaType`, `media.kind`,
  имя/размер файла и `transcript` (если включена расшифровка голосовых). Для
  фото/стикера `prompt` станет `[вложение]`.
- **Ретенция событий.** Доставленные строки живут 7 дней
  (`N8N_EVENT_RETENTION_DAYS`), затем удаляются. Всё, что n8n не забрал, тоже
  чистится по этому окну, так что «догнать» недельную давность не получится.
- **Только живой поток.** Outbox пишется из realtime-шины: сообщения, пришедшие
  пока API лежал, могут не попасть в ленту (Telegram не всегда отдаёт их как
  update после реконнекта). На этот случай лучше держать n8n и API на autostart.
- **Один опрос за раз.** `Poll guard` держит замок 26 с. Если у вас десятки
  событий в минуту, поднимайте `limit` (до 100) и уменьшайте интервал
  расписания до 30–60 с: важна не частота тика, а длинный `wait`.
- **`N8N_EVENTS_ALL=1`** отключает фильтр «только аккаунты с workflow» — удобно
  для отладки, но тогда лента поедет по всем аккаунтам, а гейт автопилота
  останется как был.
- **Текст ответа** режется на пузыри по строкам `---` и по 4096 символов
  (не больше 20 частей за вызов).
- **Дубли при перекрытии.** Если ответ генерируется дольше 26 с, следующий
  опрос может начаться до сохранения курсора — теоретически одно событие
  обработается дважды. Лечится увеличением `pollUntil` в ноде `Poll guard`.

---

## 8. Бэкапы и где лежат секреты

| Что | Где | В git |
| --- | --- | --- |
| Workflows, executions, credentials n8n | Postgres в `infra/n8n/data/postgres` | нет |
| Ключ шифрования credential'ов n8n | `infra/n8n/.env` → `N8N_ENCRYPTION_KEY` | нет |
| Настройки n8n (config, binary data) | `infra/n8n/data/n8n` | нет |
| Токен Action API | `apps/api/.env` → `N8N_ACTION_TOKEN` | нет |
| База приложения (аккаунты, души, память, события) | `packages/database/prisma/dev.db` (SQLite) | нет |
| Шаблон workflow | `infra/n8n/templates/combain-events.workflow.json` | да |

Что важно: `N8N_ENCRYPTION_KEY` **нельзя** менять/терять — иначе все
credential'ы (включая `Combain Action API`) станут нерасшифровываемыми, и их
придётся вводить заново. Ключ и `data/` бэкапятся вместе.

```bash
# n8n: дамп базы (без остановки контейнера)
cd infra/n8n
docker compose exec -T postgres pg_dump -U "$(grep '^POSTGRES_USER=' .env | cut -d= -f2)" \
  "$(grep '^POSTGRES_DB=' .env | cut -d= -f2)" | gzip > "backup-$(date +%F).sql.gz"

# n8n: экспорт одного workflow в файл (в git — только шаблон)
curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
  http://127.0.0.1:5678/api/v1/workflows/<id> | jq > my-workflow.json

# приложение: SQLite
sqlite3 packages/database/prisma/dev.db ".backup '/path/to/dev-$(date +%F).db'"
```

При переносе на другую машину: `infra/n8n` (папка + `.env` + `data/`),
`apps/api/.env` (токен и ключ сессий) и файл SQLite. Адрес приложения внутри
compose (`host.docker.internal`) менять не нужно, пока API на том же хосте.

---

## Приложение: справочник Action API

Все запросы — с заголовком `x-combain-token`. Ошибки в формате
`{ "code": "...", "message": "..." }`.

### Чтение

| Метод | Путь | Параметры |
| --- | --- | --- |
| GET | `/integrations/n8n/accounts` | — |
| GET | `/integrations/n8n/accounts/:accountId/chats` | `limit` (≤200) |
| GET | `/integrations/n8n/events` | `cursor`, `limit` (≤100, по умолчанию 25), `wait` (секунды, ≤25) |
| GET | `/integrations/n8n/actions/memory` | `accountId`, `chatId`, `limit` |
| GET | `/integrations/n8n/actions/tags` | `accountId`, `chatId` |

### Действия (`POST`, JSON-тело)

| Путь | Тело | Ответ |
| --- | --- | --- |
| `/actions/send-text` | `accountId`, `chatId`, `text`, `threadId?`, `replyToId?`, `quote?` | `{ sent, messageIds }` |
| `/actions/soul-reply` | `accountId`, `chatId`, `prompt?`, `threadId?`, `replyToMessageId?`, `returnText?` | `{ sent, superseded, text, messageIds }` |
| `/actions/memory/add` | `accountId`, `chatId`, `content`, `kind?`, `importance?` | `{ fact }` |
| `/actions/memory/clear` | `accountId`, `chatId` | `{ accountId, chatId, cleared }` — сбрасывает реплики, сводку и факты чата |
| `/actions/tags/set` | `accountId`, `chatId`, `tag` | `{ accountId, chatId, tags, available }` |
| `/actions/tags/remove` | `accountId`, `chatId`, `tag` | `{ …, removed }` |
| `/actions/warn` | `accountId`, `chatId`, `threadId?`, `reason?` | предупреждение/блок по порогу |
| `/actions/block` | `accountId`, `chatId`, `threadId?`, `reason` (3+ символа) | `AiAccessView` |
| `/actions/unblock` | `accountId`, `chatId`, `threadId?` | `AiUnblockResult` |
| `/actions/automations/pause` | `accountId`, `chatId`, `threadId?`, `reason?` | `{ count, automationIds }` |
| `/actions/automations/resume` | `accountId`, `chatId`, `threadId?` | `{ count, automationIds }` |
| `/actions/tool/:name` | `accountId?`, `chatId?`, `args: {}` | `{ ok, result, dryRun }` |

`threadId` — топик форума/ветка комментариев, по умолчанию `0` (весь чат).

### Событие `message.new`

```json
{
  "id": "clx…",
  "kind": "message.new",
  "accountId": "clx…",
  "chatId": 123456789,
  "threadId": 0,
  "payload": {
    "messageId": 98765,
    "chatId": 123456789,
    "threadId": 0,
    "text": "привет",
    "mediaType": null,
    "media": null,
    "transcript": null,
    "outgoing": false,
    "senderId": 123456789,
    "senderName": "Вася",
    "replyToId": null,
    "date": "2026-11-25T18:00:00.000Z",
    "edited": false,
    "isVoice": false,
    "service": false
  },
  "createdAt": "2026-11-25T18:00:00.100Z"
}
```

Другие `kind`: `message.edited`, `message.deleted`, `message.read`,
`access.changed`, `block.changed` — шаблон их не использует, но по ним можно
строить свои сценарии (например, эскалацию после `block.changed`).
