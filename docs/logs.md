# Логи и доступ для агентов

Структурный журнал приложения: HTTP-действия, ответы Telegram, шаги авторизации,
состояние клиентов/прокси и необработанные ошибки. Всё, что видно на странице
`/logs` в дашборде, доступно и по REST — его может читать ИИ-агент.

## Что логируется

| source      | Что попадает                                                                 |
| ----------- | ---------------------------------------------------------------------------- |
| `http`      | Запрос к контроллеру, которого нет в списке ниже                             |
| `accounts`  | `/accounts/*`: список, активация, удаление, сессии, назначение прокси        |
| `auth`      | `/auth/*`: старт и шаги входа по телефону, QR, импорт tdata                  |
| `messaging` | `/accounts/:id/chats/*`: список чатов, история, отправка/правка/удаление      |
| `proxy`     | `/proxies/*` и построение транспорта прокси для сессии                       |
| `telegram`  | Ошибки MTProto с сырым ответом Telegram и открытие/импорт клиента            |
| `realtime`  | Подписка на updates и запуск цикла обновлений                                |
| `app`       | Необработанные исключения (с полным стеком) и прочие системные события       |

Если запрос шёл через прокси, в записи есть `proxyId`, человекочитаемая
`proxyLabel` и `proxySnapshot` (имя, тип, хост, порт, логин, флаг `enabled`).
Снимок хранится в самой записи, поэтому удаление или переименование прокси не
стирает историю.

Один HTTP-запрос даёт запись `info`/`warn`/`error` с `action` вида
`MessagingController.sendMessage`, длительностью, `requestId`, безопасными
`params/query/body` и кодом ошибки. Ошибка Telegram пишется отдельной записью
`source=telegram` с `telegramError` (например `FLOOD_WAIT_42`) и
`telegramResponse` (`{ code, text, stack }`) — по ней видно, что именно ответил
Telegram.

Чувствительные поля (`password`, `secret`, `code`, `phone`, `token`, ключи
сессий) заменяются на `[redacted]`, длинные строки и глубокие объекты
обрезаются. Текст сообщений не сохраняется: поля `text` и `caption` в теле
запроса заменяются на `[redacted, N chars]` (остаётся только длина), а
поисковый запрос `q` хранится обрезанным до 64 символов.

Записи старше лимита удаляются автоматически; лимит задаётся
`LOG_MAX_ENTRIES` (по умолчанию 10 000). Журнал также дублируется в stdout API
через Nest `Logger`.

## REST API

Все ответы — JSON. Даты — ISO 8601.

### `GET /logs`

| Параметр    | Описание                                                        |
| ----------- | --------------------------------------------------------------- |
| `domain`    | `telegram` (источники `telegram`, `messaging`, `auth`) или `system` (всё остальное); без параметра — все |
| `level`     | `debug`, `info`, `warn`, `error`                                |
| `source`    | `http`, `accounts`, `auth`, `messaging`, `proxy`, `telegram`, `realtime`, `app` |
| `q`         | Подстрока в `action`, `message`, `telegramError`, `errorCode`   |
| `accountId` | Фильтр по аккаунту                                              |
| `sessionId` | Фильтр по сессии                                                |
| `requestId` | Все записи одного запроса (HTTP + Telegram-ошибка)              |
| `chatId`    | Фильтр по чату                                                  |
| `proxy`     | Точная метка прокси (`Эстония/США · http://host:3128`)          |
| `since`     | ISO-дата, включительно                                          |
| `until`     | ISO-дата, включительно                                          |
| `before`    | ISO-дата, строго старше (пагинация по времени)                  |
| `sort`      | `newest` (по умолчанию), `oldest`, `slowest`                    |
| `offset`    | Пропустить N записей (пагинация для любой сортировки)           |
| `limit`     | 1–1000, по умолчанию 100                                        |

Ответ: `{ "entries": [...], "nextBefore": "<ISO>" | null, "nextOffset": <число> | null }`.

Каждая запись:

```json
{
  "id": "cm...",
  "level": "error",
  "source": "telegram",
  "action": "telegram.rpc",
  "message": "Telegram RPC error: FLOOD_WAIT_42",
  "status": "failed",
  "requestId": "9f1c...",
  "userId": "local",
  "accountId": "cm...",
  "sessionId": "cm...",
  "chatId": 123456,
  "attemptId": null,
  "durationMs": 180,
  "errorCode": "FLOOD_WAIT",
  "telegramMethod": null,
  "telegramError": "FLOOD_WAIT_42",
  "telegramResponse": { "code": 420, "text": "FLOOD_WAIT_42", "stack": "..." },
  "proxyId": "cm...",
  "proxyLabel": "Эстония/США · http://192.168.31.216:3128",
  "proxySnapshot": {
    "id": "cm...",
    "name": "Эстония/США",
    "kind": "http",
    "host": "192.168.31.216",
    "port": 3128,
    "username": null,
    "enabled": true
  },
  "details": { "mapped": { "code": "FLOOD_WAIT", "retryAfter": 42 } },
  "createdAt": "2026-11-22T14:50:21.797Z"
}
```

RPC-вызовы пишутся отдельными записями `source=telegram, action=telegram.call`
с `telegramMethod` (`messages.sendMessage`, `auth.exportLoginToken`, ...) и
длительностью — это и есть «лог взаимодействия с Telegram». Источники `http`,
`accounts`, `proxy`, `realtime`, `app` — системные логи приложения.

`proxyId`, `proxyLabel` и `proxySnapshot` заполняются, если запрос шёл через
прокси. Снимок профиля (`proxySnapshot`) сохраняется в самой записи, поэтому
после переименования или удаления прокси история продолжает показывать, через
что именно шёл запрос; `proxyId` при этом остаётся для связи.

### `GET /logs/stats`

`{ total, byLevel, bySource, oldest, newest }` — для заголовка страницы и
быстрой оценки.

### `GET /logs/:id`

Одна запись; `404 { code: "LOG_NOT_FOUND" }`, если её уже нет.

### `GET /logs/export`

NDJSON (одна запись на строку), те же фильтры, до 1000 строк. Удобно скачать и
скормить агенту файлом.

### `DELETE /logs`

`{ "cleared": <число> }`. Полная очистка журнала.

## Примеры для агента

```bash
# Последние ошибки с ответом Telegram
curl -s 'http://localhost:3001/logs?level=error&limit=50' | jq '.entries[] | {createdAt, action, message, telegramError}'

# Что происходило с конкретным аккаунтом
curl -s 'http://localhost:3001/logs?accountId=<accountId>&limit=200' | jq -r '.entries[] | [.createdAt,.level,.action,.message] | @tsv'

# Разбор одного HTTP-запроса целиком (HTTP + RPC + фильтр)
curl -s 'http://localhost:3001/logs?requestId=<requestId>' | jq

# Все отказы Telegram в журнале
curl -s 'http://localhost:3001/logs?source=telegram&q=FLOOD' | jq -r '.entries[] | [.createdAt,.telegramError] | @tsv'

# Запросы через конкретный прокси (метку берите из /logs/stats → byProxy)
curl -s 'http://localhost:3001/logs?proxy=Эстония/США · http://192.168.31.216:3128' | jq

# Самые медленные запросы и пагинация
curl -s 'http://localhost:3001/logs?sort=slowest&limit=20' | jq -r '.entries[] | [.durationMs,.action,.message] | @tsv'
curl -s 'http://localhost:3001/logs?sort=slowest&limit=20&offset=20' | jq

# Выгрузка NDJSON
curl -s 'http://localhost:3001/logs/export?level=warn' -o logs.ndjson
```

Поле `requestId` также возвращается в заголовке `x-request-id` каждого ответа
API, поэтому запись в журнале можно сопоставить с конкретным вызовом.

## Добавление новых логов

- В сервисах с DI — `LogsService.write({ level, source, action, message, ... })`
  или инжектировать его и писать напрямую.
- В чистых функциях без DI (например `raiseTelegramError`) — `emitLog(...)` из
  `src/logs/log-sink.ts`.
- `action` — стабильное машинное имя (`domain.verb`), `message` — короткое
  человекочитаемое описание, всё остальное — в `details`.

## Live-хвост по WebSocket

Каждая запись, попавшая в БД, сразу публикуется через Socket.IO (namespace
`/events`, комната `user:<id>`) событием `log.new` с тем же JSON, что отдаёт
`GET /logs/:id`. Поэтому страница `/logs` не опрашивает сервер: галочка
«Live по WebSocket» подписывается на поток и вставляет новые строки сверху.
Живой поток работает только для сортировки «сначала новые»; для остальных
сортировок используйте кнопку «Обновить».

Агент может подключиться так же:

```js
import { io } from "socket.io-client";
const socket = io("http://localhost:3001/events", {
  transports: ["websocket", "polling"],
});
socket.on("log.new", (entry) => {
  if (entry.source === "telegram" && entry.status === "failed") {
    console.log(entry.telegramMethod, entry.telegramError, entry.proxyLabel);
  }
});
```
