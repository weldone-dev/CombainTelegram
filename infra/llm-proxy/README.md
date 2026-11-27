# llm-proxy

Маленький OpenAI-совместимый прокси перед **OpenCode Go**. Единственная задача:
добавить стабильный заголовок `x-opencode-session` (и настоящий токен), которых
не умеют отправлять обычные OpenAI-клиенты, и прозрачно пробросить запрос.

```
клиент (girl-agent, curl) ──OpenAI API──▶ llm-proxy :4100 ──+headers──▶ OpenCode Go
```

Сервис без состояния: ни базы, ни кеша. Единственные файлы на диске — опциональные
трассы в `./data/llm-traces`.

## Запуск

```bash
cd infra/llm-proxy
cp .env.example .env       # опционально: все значения имеют дефолты
docker compose up -d --build
docker compose ps
curl -s http://127.0.0.1:4100/healthz          # {"ok":true}
```

Порт `4100` публикуется на всех интерфейсах хоста: из другого контейнера прокси
доступен как `http://host.docker.internal:4100`, с хоста — как
`http://127.0.0.1:4100`. Наружу порт не открывать: прокси пробрасывает живой
платный токен.

Остановка / обновление:

```bash
docker compose down            # остановить (трассы остаются)
docker compose up -d --build   # пересобрать после правки proxy.mjs
docker compose logs -f llm-proxy
```

## Настройки

| Переменная | По умолчанию | Зачем |
| --- | --- | --- |
| `PORT` | `4000` | порт внутри контейнера (хост слушает `4100`) |
| `OPENCODE_BASE_URL` | `https://opencode.ai/inference/go/openai/v1` | апстрим |
| `OPENCODE_API_KEY` | пусто | **fallback**, если `opencode.db` не смонтирована |
| `OPENCODE_SESSION` | `combain-n8n` | значение `x-opencode-session`; стабильный opaque id |
| `OPENCODE_DB_PATH` | `/data/opencode/opencode.db` | путь к базе CLI внутри контейнера |
| `OPENCODE_DB_DIR` | `/home/roman/.local/share/opencode` | host-путь, монтируется ro в `/data/opencode` |
| `LLM_TRACE_DIR` | `/data/llm-traces` | каталог трасс; пустая строка выключает трассировку |
| `LLM_TRACE_KEEP_DAYS` | `7` | retention, минимум 1 день |

Токен берётся **живьём** из `opencode.db` (таблица `credential`,
`integration_id = 'opencode'`, JSON-поле `access`) и перечитывается раз в 60 секунд.
Перелогинились в `opencode` CLI — прокси подхватит новый токен без перезапуска.
Каталог монтируется целиком (а не только `.db`), потому что SQLite нужны соседние
`-shm`/`-wal`. Если база недоступна, используется `OPENCODE_API_KEY`; без обоих
токенов прокси не стартует и пишет об этом в лог.

Значение токена и сессии никогда не попадает в логи: там только
`метод / путь -> статус, мс` и источник токена (`opencode.db` / `env`).

## Проверка

```bash
# health
curl -s http://127.0.0.1:4100/healthz

# короткий запрос (8 токенов достаточно для проверки)
curl -s http://127.0.0.1:4100/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"Reply with the single word: ok"}],"max_tokens":8}'

# из другого контейнера — ровно тот путь, которым ходит girl-agent
docker run --rm --add-host host.docker.internal:host-gateway curlimages/curl:latest \
  -s http://host.docker.internal:4100/healthz
```

Пути принимаются и как `/models`, и как `/v1/models`: если base URL оканчивается
на `/v1`, префикс `/v1` из запроса отбрасывается.

## Трассы

По умолчанию включены. Каждый POST с телом дописывается одной JSON-строкой в
`data/llm-traces/YYYY-MM-DD.jsonl` (дата — UTC):

- `messages` — весь контекст запроса (system/персона, история, tool-результаты),
  с капами: одно поле ≤ 200 КБ, весь `messages` ≤ 2 МБ (сохраняются ведущий
  system-блок и самые новые сообщения), `response.text` ≤ 64 КБ;
- `response.text` — ответ модели (для SSE — склеенные `delta.content`);
- `usage`, `finishReason`, `status`, `durationMs`;
- `headers` — только безопасный allowlist; `authorization`, `api-key`, `cookie`,
  `x-opencode-session` записываются как `[redacted]`.

Смотреть:

```bash
ls infra/llm-proxy/data/llm-traces/
tail -n1 infra/llm-proxy/data/llm-traces/$(date -u +%F).jsonl |
  jq '{ts,model,messageCount,roles:[.messages[].role],text:.response.text[0:200]}'
tail -f infra/llm-proxy/data/llm-traces/$(date -u +%F).jsonl |
  jq -c '{ts,path,model,messageCount}'
```

**Приватность.** В трассах лежит реальная переписка (включая персону и контекст
из памяти клиента). Каталог в git не попадает, наружу не публикуется; не
выкладывайте его и не открывайте порт `4100` в интернет. Удалить историю можно в
любой момент: `rm -rf data/llm-traces/*.jsonl`.

**Retention.** Файлы старше `LLM_TRACE_KEEP_DAYS` удаляются при старте и раз в
сутки. Полностью выключить трассировку: `LLM_TRACE_DIR=` в `.env` (пустая строка,
не удаление переменной) и `docker compose up -d`.

## Кто использует

- **girl-agent** — оба профиля (`алиса`, `светлана`) ходят на
  `http://host.docker.internal:4100`; конфиги менять не нужно.
- Ранее — встроенный Assistant n8n (инфраструктура n8n удалена, прокси остался
  самостоятельным сервисом).
