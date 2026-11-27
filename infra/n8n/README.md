# n8n (self-hosted, Docker Compose)

Локальный n8n с собственной базой Postgres. Всё состояние лежит **на диске хоста**
рядом с `docker-compose.yml`, а не в named volumes: скопировали папку + `.env` —
получили тот же инстанс на другой машине.

```
infra/n8n/
├── docker-compose.yml
├── .env.example        # шаблон, коммитится
├── .env                # реальные секреты, в git не попадает
├── .gitignore
├── README.md
├── templates/          # экспорты workflow для импорта в UI/API
│   ├── combain-v2.workflow.json      # вебхук → read → typing → generate → send (актуальный)
│   ├── combain-webhook.workflow.json # v1: вебхук → soul-reply (устарел)
│   └── combain-events.workflow.json  # УСТАРЕЛ: long-poll по расписанию, не использовать
├── llm-proxy/          # OpenAI-совместимый шим для OpenCode Go (Assistant)
│   ├── proxy.mjs
│   └── Dockerfile
├── searxng/            # метапоиск для веб-поиска Assistant
│   ├── settings.yml    # конфиг (JSON-формат, limiter off), коммитится
│   └── cache/          # кеш результатов, одноразовый, в git не попадает
├── sandbox/            # отдельный compose-проект: sandbox-сервис для Assistant
│   ├── docker-compose.yml
│   ├── .env.example    # шаблон, коммитится
│   ├── .env            # реальные секреты, в git не попадает
│   └── tls/            # mTLS-сертификаты и ключи, генерируются, в git не попадают
└── data/               # рантайм-состояние, в git не попадает
    ├── n8n/            -> /home/node/.n8n            (config, nodes, storage, логи)
    └── postgres/       -> /var/lib/postgresql/data   (pgdata: воркфлоу, executions, credentials, users)
```

## Версии и порты

| Компонент | Образ | Порты |
| --- | --- | --- |
| n8n | `docker.n8n.io/n8nio/n8n:2.49.6` | `5678:5678` (опубликован на все интерфейсы) |
| Postgres 16 | `postgres:16.16-alpine` | наружу **не** публикуется, доступен n8n по `postgres:5432` |
| llm-proxy | собирается из `./llm-proxy` (`node:22-alpine`) | `4100:4000` (только для отладки/браузера; Assistant ходит по `http://llm-proxy:4000`) |
| searxng | `searxng/searxng:2026.11.23-a7163d091` | `127.0.0.1:8081->8080` (только для `curl`/UI с хоста; Assistant ходит по `http://searxng:8080`) |
| sandbox-api | `ghcr.io/n8n-io/n8n-sandbox-service-api:1.16.0` | `127.0.0.1:3200->8080` (только для `curl` с хоста; n8n ходит по `http://sandbox-api:8080`) |
| sandbox-runner-1 | `ghcr.io/n8n-io/n8n-sandbox-service-runner-dind:1.16.0` | наружу **не** публикуется |

Тег `2.49.6` — текущий стабильный (`stable`/`latest` в реестре указывают на него;
`2.50.x` на момент написания ещё помечен как pre-release). Не используйте `latest`:
обновление должно быть осознанным действием, см. раздел «Обновление».

SearXNG закреплён тегом `2026.11.23-a7163d091` — это текущий релиз в Docker Hub
на 2026-11-25 (`latest` указывает на тот же образ). У SearXNG нет «стабильной»
ветки: теги — дата плюс коммит, обновляйте так же осознанно, см. раздел
«n8n Assistant: веб-поиск (SearXNG)».

Образы sandbox-сервиса (API, runner и sandbox) выпускаются одним релизом и
поддерживаются только вместе: у всех трёх тег `1.16.0` (`stable` в ghcr.io
указывает на тот же digest). Обновлять их нужно одной версией, см. раздел
«n8n Assistant: sandbox».

Лимиты: n8n — 2 CPU / 2 GB, Postgres — 1 CPU / 1 GB, llm-proxy — 0.5 CPU /
512 MB, SearXNG — 0.5 CPU / 256 MB (`deploy.resources.limits`, compose
учитывает их и без swarm).

## Первый запуск

```bash
cd /home/roman/Desktop/www/project/CombainTelegram/infra/n8n

cp .env.example .env
# 1) пароль Postgres
#    openssl rand -base64 24
# 2) ключ шифрования n8n — генерируется ОДИН раз:
openssl rand -hex 32          # вставьте результат в N8N_ENCRYPTION_KEY
# 3) N8N_HOST / WEBHOOK_URL — адрес, по которому n8n открывается из браузера
# 4) SEARXNG_SECRET (веб-поиск Assistant) — тоже `openssl rand -hex 32`

# каталоги под bind-mount'ы должен создать ваш пользователь (uid 1000),
# иначе Docker создаст их от root и n8n (uid 1000 в контейнере) не сможет писать
mkdir -p data/n8n data/postgres searxng/cache

# внешняя сеть, общая с sandbox/ (Assistant-песочница). Нужна до `up`,
# иначе compose скажет "network n8n-sandbox declared as external".
# Команда идемпотентна; без песочницы сеть просто пустует.
docker network create n8n-sandbox 2>/dev/null || true

docker compose up -d
docker compose ps                 # postgres, n8n, llm-proxy, searxng -> (healthy)
curl -s http://127.0.0.1:5678/healthz   # {"status":"ok"}
curl -s http://127.0.0.1:8081/healthz   # OK
```

Первый старт занимает ~20–40 секунд: Postgres инициализирует кластер, n8n прогоняет
миграции. Логи: `docker compose logs -f n8n`.

### Вход и создание owner-аккаунта

1. Откройте `http://<host>:5678` (на этой машине — `http://192.168.1.88:5678`,
   с самой машины — `http://127.0.0.1:5678`).
2. n8n сам перекинет на `/setup`. **Первый, кто заполнит форму, становится владельцем
   инстанса** — email, имя, пароль. Сделайте это сразу после первого запуска, пока
   порт открыт только в доверенной сети.
3. Дальше вход — через `/signin`. Восстановления пароля «по почте» здесь нет
   (SMTP не настроен): если пароль владельца утерян, его сбрасывают через CLI
   внутри контейнера или из бэкапа. Не теряйте доступ.

## Сеть: откуда что доступно

| Кто обращается | URL |
| --- | --- |
| браузер в LAN | `http://192.168.1.88:5678` (поставьте реальный IP/имя хоста в `N8N_HOST` и `WEBHOOK_URL`) |
| само приложение (API на этом же хосте) | `http://127.0.0.1:5678` |
| приложение, если n8n на другом хосте | `http://<ip-n8n-хоста>:5678` |
| n8n (из контейнера) → API приложения на хосте | `http://host.docker.internal:4001` |

Важно про прокси: приложение ходит в LAN-сервисы **напрямую, минуя** прокси
`192.168.31.216:3128`. Для интеграции с n8n прокси не нужен — в HTTP-клиенте
приложения этот адрес должен попадать в `NO_PROXY` / исключения диспетчера,
иначе запрос уйдёт в Эстонию/США и до `127.0.0.1` или `192.168.1.88` не дойдёт.

Если n8n ставится за уже существующий reverse proxy (один хоп), в `.env`:
`N8N_PROXY_HOPS=1`, `N8N_PROTOCOL=https`, `WEBHOOK_URL=https://<домен>/`,
`N8N_SECURE_COOKIE=true`. Каталог `data/` при этом остаётся тем же.

Обратное направление — **n8n → приложение** — идёт не по LAN-адресу, а через
алиас хоста: у сервисов `n8n` и `llm-proxy` в `docker-compose.yml` стоит

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

поэтому workflows обращаются к API как `http://host.docker.internal:4001`.
Внутри контейнера `127.0.0.1` — это сам контейнер, и `192.168.1.88` может быть
недоступен из bridge-сети, так что этот алиас обязателен. Проверка:

```bash
docker compose exec n8n wget -qO- http://host.docker.internal:4001/ai/settings
```

Как собрать «входящее сообщение → ответ души» в n8n (credential, шаблон,
привязка к аккаунту, разбор ошибок): раздел «Workflow: вебхук на каждое
сообщение» ниже и `docs/workflows.md` в корне репозитория.

## Workflow: ответ на каждое сообщение (v2)

Актуальная схема — **приложение пушит событие в n8n**, а n8n отдельно
генерирует и отдельно отправляет ответ:

```
Telegram → API (UpdatesService) → POST /webhook/<path>
  → IF (message.new, входящее, есть текст)
  → POST /actions/read
  → POST /actions/typing {status:'typing', durationMs:60000}
  → POST /actions/generate {maxParts:3}          ← только текст, без отправки
  → IF (parts.length>0 && !duplicate && !superseded && !blocked && !dryRun)
       true  → POST /actions/send-text {parts, replyToId, typing:'off'}
       false → (dry-run / дубль / блок / отмена — сообщение не уходит)
  → POST /actions/typing {status:'cancel'}
```

Одно входящее сообщение = один вызов вебхука = **ровно один execution**
(и ровно один ответ). Schedule/Cron-нод и long-poll
`GET /integrations/n8n/events` в схеме нет: нет тика — нет лишних запусков,
нет повторных вызовов LLM и дублей ответов.

Приложение пушит в тот же webhook и остальные события (`message.read`,
`message.edit`, смену доступа) — такие запуски заканчиваются на первом же IF
и ни одного HTTP-вызова не делают. То есть «лишние» executions в списке — это
не ответы, а отфильтрованные события; ответ на сообщение всегда один.

### Workflow в инстансе

| Поле | Значение |
| --- | --- |
| Имя | `Combain: ответ на сообщение (v2: generate → send)` |
| id | `dayYJBs5WlG22pDR` |
| Шаблон | `templates/combain-v2.workflow.json` |
| Webhook path | `combain-07c3eaec-e8aa-4cc3-a2a4-f1bd460b9ca9` |
| Production URL | `http://127.0.0.1:5678/webhook/combain-07c3eaec-e8aa-4cc3-a2a4-f1bd460b9ca9` |
| Метод | `POST`, `responseMode: onReceived` → 200 уходит сразу, работа идёт после |
| Авторизация | Header Auth credential **`Combain Action API`** (`x-combain-token`) |
| Состояние | Active (Publish) |

Путь — длинный случайный сегмент: он и есть секрет URL, плюс обязательный
заголовок. Тестовый адрес `/webhook-test/<path>` работает только пока в
редакторе нажата *Listen*; приложение всегда должно звать production-URL.

Прежние workflow выключены и остаются только как история:

| id | Имя | Почему выключен |
| --- | --- | --- |
| `TKkIEU972Ho3opXY` | `Combain: webhook сообщений → soul-reply` | v1: один вызов `soul-reply` генерировал **и** отправлял внутри себя, а его ответ ждал подтверждения Telegram ~100 с; не было ни dry-run по флагу, ни явного typing |
| `sDjqHBEjdKZFs2hW` | `Combain: входящие сообщения → soul-reply` | ещё более ранний шаблон `templates/combain-events.workflow.json` на Schedule Trigger + long-poll |

### Тело запроса от приложения

```json
{
  "kind": "message.new",
  "accountId": "cmwrzlyl7000ceq0g1yyvi29t",
  "chatId": 1830539716,
  "threadId": 0,
  "payload": {
    "messageId": 1,
    "text": "тест",
    "outgoing": false,
    "transcript": null,
    "senderName": "Роман"
  }
}
```

IF-нода пропускает дальше только `kind === 'message.new'`,
`payload.outgoing !== true` и непустой `payload.text || payload.transcript`.
Остальное (правки, прочтения, собственные сообщения, вложения без текста)
завершает запуск, не доходя ни до одного HTTP-вызова.

`prompt` для `generate` = `payload.text`, иначе `payload.transcript`
(голосовое).

### Action API: кто что делает

| Нода | Вызов | Тело | Ответ |
| --- | --- | --- | --- |
| Прочитать сообщение | `POST /actions/read` | `{accountId, chatId, messageId}` | `{read, maxId, state}` |
| Печатает… (start) | `POST /actions/typing` | `{accountId, chatId, threadId, status:'typing', durationMs:60000}` | `{ok, until}` |
| Сгенерировать ответ | `POST /actions/generate` | `{accountId, chatId, threadId, messageId, prompt, maxParts:3}` | `{runId, parts:[{text, replyToMessageId, quote}], reasoning, state, superseded, duplicate, blocked}` |
| Отправить ответ | `POST /actions/send-text` | `{accountId, chatId, threadId, parts:[text], replyToId, quote, typing:'off'}` | `{sent, messageIds, state, typingMs}` |
| Печатает… (stop) | `POST /actions/typing` | `{accountId, chatId, threadId, status:'cancel'}` | `{ok}` |

`generate` **ничего не отправляет и не печатает** — это чистая генерация.
Поэтому «печатает…» включает сам workflow, а `send-text` получает
`typing: 'off'`: задержку уже отыграл индикатор, второй раз она не нужна.

`read`/`typing` терпимы к недоступности: у нод `neverError` +
`onError: continueRegularOutput`, так что 404/сбой этих действий не ломает
генерацию ответа.

### Сколько пузырей: `maxParts`

В ноде **Сгенерировать ответ** в JSON-теле `maxParts: 3` (API принимает 1–3,
дефолт — настройка души). `1` — всегда один пузырь; `2`/`3` — душа может
разбить ответ на несколько. `parts` приходят готовыми, `send-text` получает
`parts.map(p => p.text)` и один `replyToId` (сообщение, на которое отвечаем).

### Dry-run: тест без отправки в Telegram

Добавьте в тело вебхука `"dryRun": true` — IF **«Есть что отправить?»**
уводит запуск в ветку `false`:

- `read` + `typing` + `generate` выполняются, текст виден в Executions;
- `send-text` **не вызывается**, в Telegram не уходит ни одного сообщения;
- вторая ветка IF только гасит «печатает…».

Та же ветка срабатывает для `duplicate`/`superseded`/`blocked` и пустых
`parts`. Флаг читается из тела вебхука, а не из ответа `generate`.

Боевой режим — то же тело **без** `dryRun`.

### Проверка

```bash
set -a; . ./apps/api/.env; set +a   # N8N_ACTION_TOKEN

# сколько запусков было до
curl -s -b /tmp/n8n.cookies --get \
  --data-urlencode 'filter={"workflowId":"dayYJBs5WlG22pDR"}' \
  http://127.0.0.1:5678/rest/executions | jq '.data.count'

# dry-run: 200 сразу, один execution, send-text пропущен
curl -s -X POST \
  http://127.0.0.1:5678/webhook/combain-07c3eaec-e8aa-4cc3-a2a4-f1bd460b9ca9 \
  -H "x-combain-token: $N8N_ACTION_TOKEN" -H 'content-type: application/json' \
  -d '{"dryRun":true,"kind":"message.new","accountId":"cmwrzlyl7000ceq0g1yyvi29t","chatId":1830539716,"threadId":0,"payload":{"messageId":999100,"text":"привет, коротко ответь","outgoing":false}}'
# → {"message":"Workflow was started"} за десятки миллисекунд
```

В Executions ровно **одна** новая запись: `read` → `Печатает… (start)` →
`Сгенерировать ответ` → `Есть что отправить?` → `Печатает… (stop)`; ноды
`Отправить ответ` в запуске нет. В `GET /logs` видно один
`N8nActionsController.generate` и ни одного `sendText`/`telegram.send`.

Боевой режим (реальная отправка) — тот же curl **без** `"dryRun":true`.

Без заголовка `x-combain-token` вебхук отвечает `403` ещё до запуска workflow.

### Таймауты (почему щедрые)

Подтверждение Telegram на этой машине иногда приходит медленно, поэтому:

- `generate` — 120 с (сам LLM-вызов);
- `send-text` — 120 с (ждёт подтверждения отправки);
- `typing cancel` — 60 с: ответ уже отправлен, но `cancel` может ждать тот же
  медленный ack (наблюдалось ~30 с); сбой отмены не красит запуск в error;
- `read` / `typing start` — 15 с, ошибки не фатальны.

### Идемпотентность

Дедупликация живёт в API, не в n8n: `generate` запоминает пару
`accountId:chatId:messageId` и на повторную доставку отвечает
`{duplicate: true, parts: []}` без вызова LLM — workflow тогда тихо
заканчивается. `superseded: true` приходит, если пришло более новое сообщение
и ответ отменён до отправки. Оба флага + `blocked` проверяет IF перед
`send-text`, поэтому повторная доставка не даёт второго сообщения.
Память дедупликации — in-process (сбрасывается при рестарте API).

### Привязка к аккаунту

Аккаунт `cmwrzlyl7000ceq0g1yyvi29t` привязан к этому workflow через строку
`Workflow` в API (`cmwwi7xu5000k0d0ge0urgmg5`) — там `n8nWorkflowId` =
`dayYJBs5WlG22pDR`, и `GET /accounts/<id>/workflow` отвечает
`aiMode: workflow`. Менять привязку в UI (`/workflows` → «Использовать»),
либо:

```bash
# переназначить строку workflow на другой n8n-workflow
curl -s -X PATCH http://127.0.0.1:4001/workflows/<workflowId> \
  -H 'content-type: application/json' \
  -d '{"n8nWorkflowId":"dayYJBs5WlG22pDR","n8nWorkflowName":"Combain: ответ на сообщение (v2: generate → send)"}'
```

Push-адрес приложения — `N8N_WEBHOOK_URL` в `apps/api/.env`; он должен
указывать на **тот же** path, что в активном workflow. После правки `.env`
API нужно перезапустить (переменная читается из `process.env`).

### Управление через REST (если нет UI под рукой)

```bash
# логин (cookie jar)
curl -s -c /tmp/n8n.cookies -X POST http://127.0.0.1:5678/rest/login \
  -H 'content-type: application/json' \
  -d '{"emailOrLdapLoginId":"admin@combain.local","password":"<N8N_OWNER_PASSWORD>"}'

# создать / обновить
curl -s -b /tmp/n8n.cookies -X POST  http://127.0.0.1:5678/rest/workflows -H 'content-type: application/json' -d @workflow.json
curl -s -b /tmp/n8n.cookies -X PATCH http://127.0.0.1:5678/rest/workflows/<id> -H 'content-type: application/json' -d @workflow.json
# включить / выключить
curl -s -b /tmp/n8n.cookies -X POST http://127.0.0.1:5678/rest/workflows/<id>/activate -H 'content-type: application/json' -d '{"versionId":"<versionId>"}'
curl -s -b /tmp/n8n.cookies -X POST http://127.0.0.1:5678/rest/workflows/<id>/deactivate
```

`PATCH` создаёт новую версию: включённый workflow нужно активировать ещё раз
с новым `versionId`, иначе останется работать прежняя версия.

`N8N_OWNER_PASSWORD` — из `infra/n8n/.env`.


## Использовать OpenCode Go в n8n Assistant

OpenCode Go (`https://opencode.ai/inference/go/openai/v1`) отклоняет запросы без
заголовка `x-opencode-session` («в запросе отсутствует x-opencode-session»), а в
диалоге модели у встроенного Assistant в n8n есть только Base URL / API key /
Model — добавить свой заголовок негде. Поэтому в стеке есть маленький сервис
`llm-proxy` (`./llm-proxy`): он принимает обычные OpenAI-запросы, сам подставляет
ключ и `x-opencode-session` и **стримит** ответ обратно (SSE, без буферизации).

**Что вводить в n8n** (Assistant → настройки модели → OpenAI-compatible):

| Поле | Значение |
| --- | --- |
| Base URL | `http://llm-proxy:4000/v1` |
| API key | `local` — любой плейсхолдер, прокси его игнорирует |
| Model | `deepseek-v4.1-flash` |

**Важно про адрес.** Проверка модели и сам чат Assistant выполняются **внутри
контейнера n8n**, поэтому:

- `http://127.0.0.1:4100` из n8n — это сам контейнер n8n → `ECONNREFUSED`;
- `http://192.168.1.88:4100` из контейнера недоступен (ограничение сети хоста);
- работает только имя сервиса compose: `http://llm-proxy:4000/v1`.

Порт `4100` публикуется наружу лишь для отладки с этой машины или из браузера:
`curl http://127.0.0.1:4100/...`. Assistant им не пользуется. Снаружи порт
`4100` открывать не нужно — он даёт доступ к вашему токену OpenCode.

Реальный токен в интерфейс n8n, воркфлоу и его базу не попадает.
`OPENCODE_SESSION` (`combain-n8n` по умолчанию) — это и есть тот стабильный
идентификатор клиента, которого требует Go.

### Токен читается из базы opencode «на лету»

`credential.access` — короткоживущий OAuth access token (текущий — до
2026-11-28), и `opencode` CLI сам обновляет его в
`~/.local/share/opencode/opencode.db`. Поэтому каталог CLI смонтирован в
`llm-proxy` **только для чтения**:

```yaml
volumes:
  - ${OPENCODE_DB_DIR:-/home/roman/.local/share/opencode}:/data/opencode:ro
```

Прокси раз в 60 секунд выполняет запрос

```sql
select value from credential
where integration_id = 'opencode' and active = 1
order by time_updated desc limit 1
```

и берёт из JSON поле `access`. Значит: перелогинились в CLI — n8n продолжает
работать **без перезапуска прокси**. Если база не смонтирована (путь не тот,
другой пользователь, другой сервер), прокси один раз пишет в лог
`opencode.db not mounted` и использует `OPENCODE_API_KEY` из `.env` как
резерв — то есть без монтирования всё тоже работает, просто токен придётся
обновлять вручную. Монтировать нужно **каталог**, а не только файл `.db`:
SQLite нужны соседние `-shm`/`-wal`, иначе чтение падает с
`attempt to write a readonly database`.

Проверка без n8n (с хоста):

```bash
curl -s http://127.0.0.1:4100/healthz                       # {"ok":true}
curl -s http://127.0.0.1:4100/models -H 'authorization: Bearer local' | head -c 300
curl -s http://127.0.0.1:4100/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Reply with the single word: ok"}],"max_tokens":60}'
curl -N -s http://127.0.0.1:4100/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","stream":true,"messages":[{"role":"user","content":"Count to five"}]}'
```

Так же, но **изнутри контейнера n8n** — ровно тот путь, которым ходит Assistant:

```bash
docker compose exec n8n wget -qO- http://llm-proxy:4000/models | head -c 200
docker compose exec n8n wget -qO- --header='Content-Type: application/json' \
  --post-data='{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Reply with the single word: ok"}],"max_tokens":60}' \
  http://llm-proxy:4000/v1/chat/completions
```

Пути принимаются и как `/models`, и как `/v1/models`: если Base URL оканчивается
на `/v1`, префикс `/v1` из запроса отбрасывается. Логи — только
`метод / путь -> статус, мс` и источник токена (`opencode.db` / `env`); ни тел,
ни ключей, ни значения сессии в них нет (`docker compose logs llm-proxy`).

### Трассы: какой контекст реально уходит в модель

По умолчанию тела **не** пишутся. Включено в `docker-compose.yml` парой env:

```yaml
LLM_TRACE_DIR: /data/llm-traces        # пустая строка = трассировка выключена
LLM_TRACE_KEEP_DAYS: ${LLM_TRACE_KEEP_DAYS:-7}
```

и volume `./data/llm-traces:/data/llm-traces`. Файлы появляются на хосте:
`infra/n8n/data/llm-traces/YYYY-MM-DD.jsonl` (дата — UTC), **одна строка JSON на
каждый POST с телом**. Каждая строка — это реальный запрос вместе с ответом:

| Поле | Что внутри |
| --- | --- |
| `ts`, `id`, `durationMs` | время, UUID запроса, длительность |
| `method`, `path`, `upstreamPath` | путь у прокси и путь у OpenCode Go |
| `model`, `stream`, `messageCount` | параметры запроса |
| `messages` | **весь контекст как есть**: system/персона, история, tool-результаты |
| `tools`, `max_tokens`, `temperature` | остальные параметры, если были |
| `headers` | только безопасный allowlist (`content-type`, `accept`, `user-agent`, `openai-*`); `authorization`/`api-key`/`cookie`/`x-opencode-session` пишутся как `[redacted]` |
| `response.status` | HTTP-статус апстрима |
| `response.text` | `choices[0].message.content` для JSON или склеенные `delta.content` для SSE |
| `response.usage`, `response.finishReason` | usage/finish_reason, если апстрим их прислал |
| `response.textTruncated` / `responseTruncated` | сработал кап |

Ограничения, чтобы диск не кончился: одно строковое поле ≤ 200 КБ, весь
`messages` ≤ 2 МБ (сохраняются ведущий system-блок и самые новые сообщения,
середина длинной истории отбрасывается с маркером `__truncated`),
`response.text` ≤ 64 КБ. SSE не буферизуется:
контент копится по мере стриминга, клиент получает байты без задержки.
Запись асинхронная, после ответа; ошибка записи только один раз пишет warning
в лог и никогда не ломает прокси. Файлы старше `LLM_TRACE_KEEP_DAYS` удаляются
при старте и раз в сутки. Токен OpenCode в трассы не попадает ни в каком виде.

Смотреть:

```bash
ls infra/n8n/data/llm-traces/
# последняя трасса: модель, число сообщений, первые 400 символов ответа
tail -n1 infra/n8n/data/llm-traces/$(date -u +%F).jsonl |
  jq '{ts,model,messageCount,roles:[.messages[].role],text:.response.text[0:400]}'
# только system-контекст (персона) последнего запроса
tail -n1 infra/n8n/data/llm-traces/$(date -u +%F).jsonl |
  jq -r '.messages[] | select(.role=="system") | .content' | head -50
# поток запросов в реальном времени
tail -f infra/n8n/data/llm-traces/$(date -u +%F).jsonl | jq -c '{ts,path,model,messageCount}'
```

**В трассах лежит переписка.** Каталог `data/` в git не попадает; не выкладывайте
его и не открывайте порт `4100` наружу.

## n8n Assistant: sandbox

Встроенный Assistant умеет выполнять код, который пишет модель. Делает он это не
сам, а через внешний **sandbox-сервис**: в мастере настройки Assistant нужно указать
Service URL и API key. Платный Daytona не используем — рядом с n8n поднят
self-hosted sandbox-сервис n8n (`sandbox/`), это **вариант для разработки**, не для
продакшена.

```
infra/n8n/                 собственный compose-проект "n8n"     (n8n, postgres, llm-proxy)
infra/n8n/sandbox/         собственный compose-проект "n8n-sandbox"
                           tls-init / sandbox-api / sandbox-runner-1
docker network n8n-sandbox  внешняя сеть, единственная связь между проектами
```

| Контейнер | Что делает |
| --- | --- |
| `tls-init` | одноразовый: генерирует mTLS-сертификаты в `sandbox/tls/`, выходит |
| `sandbox-api` | control plane, с ним общается n8n по HTTP `:8080` + Bearer-ключ |
| `sandbox-runner-1` | privileged Docker-in-Docker: на каждое выполнение поднимает одноразовый контейнер из образа `...-sandbox:1.16.0` |

### Что вводить в мастере Assistant

| Поле | Значение |
| --- | --- |
| Service URL | `http://sandbox-api:8080` |
| API key | значение `SANDBOX_API_KEYS` из `sandbox/.env` (строка 6) |

- Именно `sandbox-api`, а не `127.0.0.1` и не LAN-IP: запрос идёт **из контейнера
  n8n**, где `127.0.0.1` — это сам n8n, а хост в этой сети недоступен. Имя
  резолвится через общую docker-сеть `n8n-sandbox`.
- Ключ целиком (64 hex-символа) копируется из `sandbox/.env`, строка
  `SANDBOX_API_KEYS=...`. В README и в git его нет; `sandbox/.env` в git не попадает.
- Порт `3200` опубликован только на `127.0.0.1` и нужен лишь для проверок с хоста —
  в мастере его указывать не нужно.

### Запуск и проверка

```bash
cd /home/roman/Desktop/www/project/CombainTelegram/infra/n8n

docker network create n8n-sandbox            # один раз; повторно - "already exists"

cd sandbox
cp .env.example .env                         # затем вписать 3 секрета: openssl rand -hex 32
docker compose up -d
cd ..

docker compose up -d                         # n8n пересоздастся и подключится к сети
```

Проверки:

```bash
# 1) API жив (с хоста)
curl -s http://127.0.0.1:3200/healthz                      # {"status":"ok"}

# 2) API виден из контейнера n8n - это и есть адрес из мастера
docker compose exec n8n wget -qO- http://sandbox-api:8080/healthz   # {"status":"ok"}

# 3) runner зарегистрировался
docker compose -f sandbox/docker-compose.yml logs sandbox-api | grep -i runner
#   ... "msg":"runner registered","runner_id":"runner-1" ...

# 4) статусы
docker compose -f sandbox/docker-compose.yml ps            # api и runner: (healthy)
docker compose ps                                          # n8n: (healthy)
```

`401`/`403` от API при верном URL означают неверный ключ: сверьте `SANDBOX_API_KEYS`
в `sandbox/.env` с тем, что вставлено в мастер.

При первом выполнении кода runner **скачивает образ песочницы**
(`ghcr.io/n8n-io/n8n-sandbox-service-sandbox:1.16.0`) во внутренний dockerd — это
десятки-сотни МБ и несколько минут. В логах это видно как `sandbox image ready`,
до этого момента первое выполнение просто ждёт. Образ кешируется в anonymous
volume внутреннего dockerd (`/var/lib/docker`): переживает рестарт контейнера, но
не `docker compose up -d --force-recreate`.

### Рестарт и обновление

```bash
cd /home/roman/Desktop/www/project/CombainTelegram/infra/n8n

# перезапуск только sandbox-стека (n8n продолжает работать)
docker compose -f sandbox/docker-compose.yml restart
# полный перезапуск обоих стеков (порядок не важен, связь - сеть)
docker compose -f sandbox/docker-compose.yml up -d
docker compose up -d

# обновление: API, runner и sandbox-образ меняются ОДНОЙ версией
# новый стабильный тег смотреть на https://github.com/n8n-io/n8n-sandbox-service/releases
sed -i 's/1\.16\.0/1.17.0/g' sandbox/docker-compose.yml      # все три вхождения
docker compose -f sandbox/docker-compose.yml pull
docker compose -f sandbox/docker-compose.yml up -d
docker compose -f sandbox/docker-compose.yml logs -f sandbox-api
```

- Сертификаты в `sandbox/tls/` живут 825 дней (CA — 10 лет) и **сами не
  обновляются**. Перегенерировать: удалить `sandbox/tls/` (или
  `SANDBOX_TLS_REGEN=1 docker compose -f sandbox/docker-compose.yml run --rm tls-init`)
  и перезапустить оба контейнера sandbox-стека.
- Состояние API (sqlite) лежит в named volume `n8n-sandbox_sandbox-api-data`, а не
  в `data/`: там только учёт песочниц, терять нечего. Полный сброс:
  `docker compose -f sandbox/docker-compose.yml down -v` (уберёт и volume).
- `docker compose down` в `sandbox/` **не** удаляет внешнюю сеть `n8n-sandbox`;
  она общая с n8n.

### Безопасность (важно)

- `sandbox-runner-1` запущен с `privileged: true` и собственным dockerd: это
  **эквивалент root на хосте**. Код в песочнице пишет модель, поэтому считайте,
  что у модели есть доступ к хосту через runner.
- Порт `8080` API и `9090` (gRPC регистрации) наружу **не публикуются**; `3200`
  слушает только `127.0.0.1`. Не публикуйте их на LAN/интернет.
- Держите этот стек в доверенной сети и только для разработки. Для продакшена —
  Sysbox/Firecracker runner или Daytona, см. документацию n8n «Set up n8n Assistant».
- `sandbox/.env` содержит ключ доступа к API песочниц, `sandbox/tls/` — приватные
  ключи mTLS (включая ключ CA). Оба пути в git не попадают, но в бэкап их кладите
  вместе с остальным `infra/n8n`.
- Ротировать ключи можно без простоя: добавьте новый ключ через запятую в
  `SANDBOX_API_KEYS`, перезапустите `sandbox-api`, обновите ключ в мастере, затем
  уберите старый.

## n8n Assistant: веб-поиск (SearXNG)

Чтобы Assistant мог искать в интернете, ему нужен поисковый API. Здесь это
self-hosted [SearXNG](https://docs.searxng.org/) — маленький сервис `searxng`
в основном compose-стеке (`./searxng/settings.yml`). Публичный SearXNG или
платный Search API не нужны, ключей нет.

**Что вводить в мастере Assistant** (Custom / SearXNG):

| Поле | Значение |
| --- | --- |
| SearXNG URL | `http://searxng:8080` |

- Именно имя сервиса, без `/search` и без `/`: запрос делает **контейнер n8n**,
  а `127.0.0.1` там — сам n8n. Имя резолвится по default-сети compose-проекта
  `n8n` (в сеть `n8n-sandbox` сервис не добавлен, ему она не нужна).
- `N8N_INSTANCE_AI_SEARXNG_URL` в `.env` — только документированное значение
  «чтобы не забыть»: n8n эту переменную не читает, URL сохраняет сам мастер
  (таблица `settings` в Postgres, ключ `instanceAi.settings`). Сменили URL в
  мастере — `.env` можно не трогать.
- Порт `8081` опубликован **только на `127.0.0.1`** и нужен лишь для проверок
  и локального UI (`http://127.0.0.1:8081`). В мастер его указывать не нужно.

### Почему в `settings.yml` именно это

`./searxng/settings.yml` монтируется read-only в `/etc/searxng/settings.yml`,
`use_default_settings` оставляет все штатные настройки и движки — меняется
только перечисленное ниже:

- `search.formats: [html, json]` — **обязательно**. n8n просит
  `?format=json`; без `json` в списке SearXNG отвечает 403, и поиск в Assistant
  падает, хотя сам сервис жив. `html` оставлен для локального UI.
- `server.limiter: false` — n8n ходит из одного IP контейнера, и штатный
  limiter SearXNG принимает это за флуд и отдаёт `429`. Для loopback-only
  инстанса limiter не нужен.
- `server.image_proxy: true` — превью грузятся через SearXNG, браузер не
  обращается к Google/Bing напрямую.
- `general.contact_url` — без него не грузятся движки `wikipedia`, `wikidata`,
  `openstreetmap` (требование User-Agent политики Wikipedia). Стоит локальный
  URL, публичного адреса у инстанса нет.
- `engines`: включён `bing` (в upstream он выключен), из `use_default_settings`
  убраны `ahmia` и `torch` — это onion-движки, без Tor они всё равно не
  загружаются. Из этого хоста проверено: `google`/`qwant` — `access denied`,
  `brave` — 405 (нужен ключ), `startpage`/`mojeek` — `inactive` в upstream,
  `duckduckgo` периодически отдаёт CAPTCHA. Рабочие движки по умолчанию:
  `google cse` (обычно 20 результатов) и `bing` (обычно 10) — этого Assistant хватает.
  Если движок «сломался», он виден в `unresponsive_engines` в JSON-ответе и в
  логах; чинится обновлением тега или добавлением движка в `engines`.

`SEARXNG_SECRET` из `.env` перекрывает `server.secret_key` из файла (образ
читает эту переменную сам). Ротация секрета ломает только cookie-сессии самого
SearXNG — ничего не теряется, `docker compose up -d searxng` достаточно.

### Запуск и проверка

```bash
cd /home/roman/Desktop/www/project/CombainTelegram/infra/n8n

docker compose up -d searxng        # добавьте SEARXNG_SECRET в .env заранее
docker compose ps searxng           # Up (healthy)
```

```bash
# 1) жив с хоста
curl -s http://127.0.0.1:8081/healthz                 # OK

# 2) JSON с результатами (это тот ответ, который читает n8n)
curl -s "http://127.0.0.1:8081/search?q=n8n&format=json" | head -c 400
#   {"query": "n8n", "results": [{"url": "https://n8n.io/", ...

# 3) ровно тот путь, которым ходит Assistant - из контейнера n8n
docker compose exec n8n wget -qO- "http://searxng:8080/search?q=n8n&format=json" | head -c 300
```

Первый запрос после старта бывает медленнее (2–4 с): движки «прогреваются»,
часть отвечает таймаутом (`wikidata`) или CAPTCHA (`duckduckgo`) — это штатно,
результаты от остальных движков приходят. Пустой `results` при `200` —
смотрите `docker compose logs searxng`: скорее всего, все движки заблокировали
IP (тогда помогает другой upstream/прокси или новый тег SearXNG).

Если правили `settings.yml` — нужен **restart**, простой `up -d` ничего не
пересоздаст (файл примонтирован, а не запечён в образ):

```bash
docker compose restart searxng
docker compose logs --tail=20 searxng
```

`docker compose up -d` в этом каталоге поднимает и searxng, и остальной стек;
`docker compose up -d searxng` трогает только его, n8n не перезапускается
(данные всё равно на bind-mount'ах).

### Обновление

```bash
# новый тег: https://hub.docker.com/r/searxng/searxng/tags
sed -i 's|searxng/searxng:2026.11.23-a7163d091|searxng/searxng:2026.12.01-xxxxxxxxx|' docker-compose.yml
docker compose pull searxng
docker compose up -d searxng
docker compose logs -f searxng          # ждём "Started worker-1", без ERROR про движки
```

Состояния у SearXNG нет (только кеш в `./searxng/cache`, его можно удалить) —
откат на прежний тег безопасен в любой момент.

## Бэкап и восстановление

Состояние = `data/` (кластер Postgres + каталог n8n) плюс `.env`
(там `N8N_ENCRYPTION_KEY`). Бэкапить нужно **всё вместе**: без ключа credentials
в базе не расшифруются. Если поднят sandbox-стек, добавьте в архив
`sandbox/.env` и `sandbox/tls/` (ключи API и mTLS; сами песочницы не нужны).
SearXNG состояния не имеет: `searxng/settings.yml` коммитится в git, а
`searxng/cache/` — одноразовый кеш, в архив не нужен.

### Бэкап

```bash
cd /home/roman/Desktop/www/project/CombainTelegram/infra/n8n

docker compose down                      # остановить оба контейнера; данные на диске остаются
TS=$(date +%Y%m%d-%H%M)
sudo tar -czf "/var/backups/n8n-$TS.tar.gz" data .env sandbox/.env sandbox/tls

docker compose up -d                     # вернуть сервис
docker compose ps
```

`sudo` нужен потому, что файлы кластера Postgres внутри контейнера принадлежат
uid 999 с правами `0700`; на обычном Linux-хосте ваш пользователь их не прочитает.
(На Docker Desktop uid мапится на ваш, но команда с `sudo` работает в обоих случаях.)

Проверка архива: `sudo tar -tzf /var/backups/n8n-*.tar.gz | head`.

Дополнительно (без остановки, логический дамп — удобно для переезда между версиями):

```bash
docker compose exec -T postgres pg_dumpall -U n8n > /var/backups/n8n-db-$(date +%F).sql
```

### Восстановление

```bash
cd /home/roman/Desktop/www/project/CombainTelegram/infra/n8n

docker compose down
sudo rm -rf data                         # старый (сломанный) стейт убираем целиком
sudo tar -xzf /var/backups/n8n-YYYYmmdd-HHMM.tar.gz -C .   # вернёт data/ и .env

# n8n работает от uid 1000 — владелец его каталога должен совпадать
sudo chown -R 1000:1000 data/n8n

docker compose up -d
docker compose ps
curl -s http://127.0.0.1:5678/healthz
```

Если `.env` восстанавливается отдельно — ключ `N8N_ENCRYPTION_KEY` должен быть
**точно тем же**, что был при создании credentials, иначе n8n запустится, но
сохранённые логины/токены в нодах станут нечитаемыми.

## Перенос на другой сервер

1. На старом хосте — бэкап (см. выше) или сразу архив всей папки:

   ```bash
   cd /home/roman/Desktop/www/project/CombainTelegram/infra
   cd n8n && docker compose down && cd ..
   sudo tar -czf /tmp/n8n-move.tar.gz n8n          # вместе с data/ и .env
   ```

2. Скопировать `n8n-move.tar.gz` на новый хост и развернуть в **том же
   относительном виде** (`infra/n8n/...`), т.к. bind-mount'ы относительные:

   ```bash
   sudo mkdir -p /path/to/CombainTelegram/infra
   sudo tar -xzf n8n-move.tar.gz -C /path/to/CombainTelegram/infra
   sudo chown -R 1000:1000 /path/to/CombainTelegram/infra/n8n/data/n8n
   ```

3. Поправить адреса в `.env` под новый хост:

   ```
   N8N_HOST=192.168.1.50
   WEBHOOK_URL=http://192.168.1.50:5678/
   ```

4. Поднять и проверить:

   ```bash
   cd /path/to/CombainTelegram/infra/n8n
   docker compose up -d && docker compose ps
   curl -s http://127.0.0.1:5678/healthz
   ```

   Owner-аккаунт, воркфлоу, credentials и история executions переезжают вместе с
   данными — заново логиниться и заново вводить креды не нужно.

## Обновление

Порядок: бэкап → новый тег → pull → up → проверка.

```bash
cd /home/roman/Desktop/www/project/CombainTelegram/infra/n8n
docker compose down
sudo tar -czf "/var/backups/n8n-before-upgrade-$(date +%F).tar.gz" data .env

# закрепить новый стабильный тег (проверить, что он существует в реестре)
sed -i 's|n8nio/n8n:2.49.6|n8nio/n8n:2.50.0|' docker-compose.yml

docker compose pull
docker compose up -d
docker compose ps                          # ждём (healthy)
docker compose logs -f n8n                 # смотрим, что миграции прошли
```

Важно:

- n8n прогоняет миграции БД автоматически при старте; **откат на старый тег после
  миграций не поддерживается** — поэтому бэкап обязателен.
- `docker compose pull` тянет и `postgres:16.16-alpine`, если тег не менялся —
  это безопасно (тот же минорный релиз). Мажор Postgres (17+) не обновляйте
  заменой тега: нужен `pg_upgrade`.
- Не запускайте одновременно `down -v`: ключ `-v` удалит данные. Здесь это не
  опасно только потому, что используются bind-mount'ы, но привычку лучше не заводить.

## Безопасность

- Порт `5678` слушает `0.0.0.0`. В интернет так выпускать **нельзя**: n8n даёт
  выполнение произвольных HTTP/JS-нод с доступом к вашим credentials.
- Наружу — только через reverse proxy с TLS (`https://`), тогда в `.env`:
  `N8N_PROTOCOL=https`, `N8N_SECURE_COOKIE=true`, `N8N_PROXY_HOPS=1`,
  `WEBHOOK_URL=https://<домен>/`.
- В LAN ограничьте доступ файрволом, например:
  `sudo ufw allow from 192.168.1.0/24 to any port 5678 proto tcp`.
- Owner-аккаунт создайте сразу после первого старта, пароль — уникальный.
  В n8n 2.x basic-auth (`N8N_BASIC_AUTH_*`) больше нет, защита — учётка владельца
  плюс (по желанию) авторизация на прокси.
- `.env` содержит `N8N_ENCRYPTION_KEY`, которым зашифрованы все credentials.
  Файл в git не попадает, но и в бэкапах он лежит рядом с базой — храните архивы
  так же бережно, как пароли.
- Ключ нельзя менять/перегенерировать «для порядка»: credentials станут
  нерасшифровываемыми.
- SearXNG порт `8081` слушает только `127.0.0.1`. Сам SearXNG без аутентификации
  и с выключенным limiter — в LAN/интернет его публиковать нельзя. Запросы
  уходят с этого хоста к внешним поисковикам (Google CSE, Bing, Wikipedia), т.е.
  поисковые фразы Assistant покидают машину.

## Диагностика

```bash
docker compose ps
docker compose logs -f n8n
docker compose logs -f postgres
docker compose logs -f searxng
curl -s http://127.0.0.1:5678/healthz        # {"status":"ok"}
curl -s http://127.0.0.1:8081/healthz        # OK
docker inspect -f '{{.State.Health.Status}}' n8n-n8n-1
docker compose exec postgres psql -U n8n -d n8n -c '\dt' | head
```

Известные безобидные сообщения в логах n8n 2.49:

- `DeprecationWarning: Calling client.query() ...` — внутреннее дело драйвера `pg`.
- `N8N_RUNNERS_MODE -> Internal task runner mode is deprecated` — для одного
  небольшого инстанса internal-режим штатный; внешний runner нужен для изоляции
  кода и горизонтального масштабирования.
- `Permissions ... are too open` не появляется: в compose включён
  `N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=true`.

В логах SearXNG безобидны: `missing config file: /etc/searxng/limiter.toml` и
`X-Forwarded-For nor X-Real-IP header is set!` (limiter выключен, это одноразовая
запись на старте), а также `CAPTCHA`/`timeout` по отдельным движкам —
результаты остальных приходят.

## Что нужно знать приложению (app-side)

- Base URL: `http://127.0.0.1:5678`, если API и n8n на одном хосте,
  иначе `http://<ip-n8n-хоста>:5678`.
- REST API n8n: `GET/POST http://127.0.0.1:5678/api/v1/...`, заголовок
  `X-N8N-API-KEY: <ключ из Settings → n8n API>`.
- Вебхуки воркфлоу: `http://127.0.0.1:5678/webhook/<path>`
  (production) и `/webhook-test/<path>` (при активном тестовом режиме).
  Приложение пушит сюда `message.new` (см. «Workflow: вебхук на каждое
  сообщение») и **не** опрашивает `/integrations/n8n/events`.
- Прокси `192.168.31.216:3128` для этих запросов **не использовать** — адрес
  должен быть в исключениях (`NO_PROXY`/диспетчер), иначе локальный n8n недостижим.
- Проверка живости: `GET /healthz` → `{"status":"ok"}` (используется и в
  healthcheck контейнера).
