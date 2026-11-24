"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { API_URL, apiFetch, errorMessage } from "../../lib/api";
import { subscribeRealtime } from "../../lib/realtime-bus";
import type {
  LogEntryView,
  LogLevel,
  LogsPageView,
  LogsStatsView,
} from "../../lib/types";

const PAGE_SIZE = 100;

const LEVEL_OPTIONS: Array<{ value: "" | LogLevel; label: string }> = [
  { value: "", label: "Все уровни" },
  { value: "error", label: "Ошибки" },
  { value: "warn", label: "Предупреждения" },
  { value: "info", label: "Информация" },
  { value: "debug", label: "Отладка" },
];

const TELEGRAM_SOURCES = ["telegram", "messaging", "auth"];
const SYSTEM_SOURCES = ["http", "accounts", "proxy", "realtime", "app"];

type Domain = "telegram" | "system" | "all";

const DOMAIN_OPTIONS: Array<{ value: Domain; label: string }> = [
  { value: "telegram", label: "Telegram" },
  { value: "system", label: "Системные" },
  { value: "all", label: "Все" },
];

const SOURCE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "Все источники" },
  { value: "http", label: "http" },
  { value: "accounts", label: "accounts" },
  { value: "auth", label: "auth" },
  { value: "messaging", label: "messaging" },
  { value: "proxy", label: "proxy" },
  { value: "telegram", label: "telegram" },
  { value: "realtime", label: "realtime" },
  { value: "app", label: "app" },
];

/** Valid `level` values accepted from the URL; anything else is ignored. */
const LEVEL_VALUES: Array<"" | LogLevel> = [
  "",
  "error",
  "warn",
  "info",
  "debug",
];
const DEFAULT_DOMAIN: Domain = "telegram";
const URL_SYNC_DELAY = 300;

const SORT_OPTIONS = [
  { value: "newest", label: "Сначала новые" },
  { value: "oldest", label: "Сначала старые" },
  { value: "slowest", label: "Самые медленные" },
] as const;

const LEVEL_STYLES: Record<LogLevel, string> = {
  debug: "bg-zinc-700 text-zinc-300",
  info: "bg-sky-500/20 text-sky-300",
  warn: "bg-amber-500/20 text-amber-300",
  error: "bg-red-500/20 text-red-300",
};

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function sinceIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function untilIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T23:59:59.999`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

interface InitialFilters {
  accountId: string;
  /** `""` when absent or malformed. */
  chatId: string;
  level: "" | LogLevel;
  /** Inline note about a malformed deep link; the page still works. */
  error: string | null;
}

/** First-render filters of a `/logs?accountId=&chatId=&level=` deep link. */
function parseInitialFilters(
  params: Readonly<URLSearchParams>,
): InitialFilters {
  const accountId = params.get("accountId")?.trim() ?? "";

  const rawChatId = params.get("chatId")?.trim() ?? "";
  const chatId = /^\d{1,16}$/.test(rawChatId) ? rawChatId : "";
  const rawLevel = params.get("level")?.trim() ?? "";
  const level = LEVEL_VALUES.includes(rawLevel as "" | LogLevel)
    ? (rawLevel as "" | LogLevel)
    : "";

  let error: string | null = null;
  if (rawChatId && !chatId) {
    error = "Некорректный chatId в ссылке — фильтр по чату не применён.";
  } else if (rawLevel && !level) {
    error = "Неизвестный уровень в ссылке — фильтр по уровню не применён.";
  }
  return { accountId, chatId, level, error };
}

/** Stable `a=1&b=2` string of the deep-link filters for the URL bar. */
function scopeQuery(accountId: string, chatId: string, level: string): string {
  const params = new URLSearchParams();
  if (accountId) params.set("accountId", accountId);
  if (chatId) params.set("chatId", chatId);
  if (level) params.set("level", level);
  return params.toString();
}

export function LogsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // The deep link is applied once; later filter changes own the state.
  const [initial] = useState(() => parseInitialFilters(searchParams));
  const [accountId, setAccountId] = useState(initial.accountId);
  const [chatId, setChatId] = useState(initial.chatId);
  const [domain, setDomain] = useState<Domain>(DEFAULT_DOMAIN);
  const [level, setLevel] = useState<"" | LogLevel>(initial.level);
  const [source, setSource] = useState("");
  const [proxy, setProxy] = useState("");
  const [query, setQuery] = useState("");
  const [since, setSince] = useState("");
  const [until, setUntil] = useState("");
  const [sort, setSort] =
    useState<(typeof SORT_OPTIONS)[number]["value"]>("newest");
  const [entries, setEntries] = useState<LogEntryView[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(initial.error);
  const [stats, setStats] = useState<LogsStatsView | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const offsetRef = useRef(0);
  const statsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const queryString = useCallback(
    (offset?: number) => {
      const params = new URLSearchParams();
      if (domain !== "all") params.set("domain", domain);
      if (accountId) params.set("accountId", accountId);
      if (chatId) params.set("chatId", chatId);
      if (level) params.set("level", level);
      if (source) params.set("source", source);
      if (proxy) params.set("proxy", proxy);
      if (query.trim()) params.set("q", query.trim());
      const sinceValue = sinceIso(since);
      if (sinceValue) params.set("since", sinceValue);
      const untilValue = untilIso(until);
      if (untilValue) params.set("until", untilValue);
      if (sort !== "newest") params.set("sort", sort);
      params.set("limit", String(PAGE_SIZE));
      if (offset) params.set("offset", String(offset));
      return params.toString();
    },
    [
      domain,
      level,
      source,
      proxy,
      query,
      since,
      until,
      sort,
      accountId,
      chatId,
    ],
  );

  const loadStats = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (domain !== "all") params.set("domain", domain);
      if (accountId) params.set("accountId", accountId);
      if (chatId) params.set("chatId", chatId);
      const suffix = params.toString() ? `?${params.toString()}` : "";
      setStats(await apiFetch<LogsStatsView>(`/logs/stats${suffix}`, {}));
    } catch {
      // The list already reports connectivity problems.
    }
  }, [domain, accountId, chatId]);

  const load = useCallback(
    async (options: { silent?: boolean; append?: boolean } = {}) => {
      if (!options.silent && !options.append) setLoading(true);
      setError(null);
      try {
        const offset = options.append ? offsetRef.current : 0;
        const page = await apiFetch<LogsPageView>(
          `/logs?${queryString(offset)}`,
          {},
        );
        setEntries((previous) =>
          options.append
            ? [
                ...previous,
                ...page.entries.filter(
                  (entry) =>
                    !previous.some((existing) => existing.id === entry.id),
                ),
              ]
            : page.entries,
        );
        offsetRef.current = offset + page.entries.length;
        setNextOffset(page.nextOffset);
        void loadStats();
      } catch (loadError) {
        setError(errorMessage(loadError));
      } finally {
        setLoading(false);
      }
    },
    [queryString, loadStats],
  );

  // Debounced reload when any filter or the sort order changes.
  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 250);
    return () => clearTimeout(timer);
  }, [load]);

  // Keep the deep-link filters in the URL without adding history entries.
  const scope = scopeQuery(accountId, chatId, level);
  useEffect(() => {
    const timer = setTimeout(() => {
      const next = scope ? `${pathname}?${scope}` : pathname;
      const current = `${window.location.pathname}${window.location.search}`;
      if (current === next) return;
      router.replace(next, { scroll: false });
    }, URL_SYNC_DELAY);
    return () => clearTimeout(timer);
  }, [scope, pathname, router]);

  const statsSoon = useCallback(() => {
    if (statsTimer.current) clearTimeout(statsTimer.current);
    statsTimer.current = setTimeout(() => {
      statsTimer.current = null;
      void loadStats();
    }, 800);
  }, [loadStats]);

  // Live tail over Socket.IO: new entries are pushed by the API as `log.new`.
  useEffect(() => {
    if (!live) return;
    const sinceValue = sinceIso(since);
    const untilValue = untilIso(until);
    return subscribeRealtime(({ event, payload }) => {
      if (event !== "log.new") return;
      const entry = payload as LogEntryView;
      if (domain === "telegram" && !TELEGRAM_SOURCES.includes(entry.source)) {
        return;
      }
      if (domain === "system" && !SYSTEM_SOURCES.includes(entry.source)) {
        return;
      }
      if (accountId && entry.accountId !== accountId) return;
      if (chatId && String(entry.chatId ?? "") !== chatId) return;
      if (level && entry.level !== level) return;
      if (source && entry.source !== source) return;
      if (proxy && entry.proxyLabel !== proxy) return;
      if (sinceValue && entry.createdAt < sinceValue) return;
      if (untilValue && entry.createdAt > untilValue) return;
      const needle = query.trim().toLowerCase();
      if (needle) {
        const haystack = [
          entry.action,
          entry.message,
          entry.errorCode ?? "",
          entry.telegramError ?? "",
          entry.proxyLabel ?? "",
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(needle)) return;
      }

      // A live row only makes sense at the top of the newest-first view.
      if (sort !== "newest") return;
      setEntries((previous) =>
        previous.some((existing) => existing.id === entry.id)
          ? previous
          : [entry, ...previous].slice(0, 500),
      );
      statsSoon();
    });
  }, [
    live,
    domain,
    accountId,
    chatId,
    level,
    source,
    proxy,
    query,
    since,
    until,
    sort,
    statsSoon,
  ]);

  useEffect(() => {
    return () => {
      if (statsTimer.current) clearTimeout(statsTimer.current);
    };
  }, []);

  const clearLogs = async () => {
    if (!window.confirm("Удалить все записи журнала?")) return;
    try {
      await apiFetch<{ cleared: number }>("/logs", { method: "DELETE" });
      setExpandedId(null);
      await load();
    } catch (clearError) {
      setError(errorMessage(clearError));
    }
  };

  const copyEntry = async (entry: LogEntryView) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(entry, null, 2));
      setCopiedId(entry.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Clipboard may be blocked without user gesture permissions.
    }
  };

  const hasScopeFilters = Boolean(accountId || chatId || level);
  const levelLabel =
    LEVEL_OPTIONS.find((option) => option.value === level)?.label ?? level;
  const clearScopeFilters = () => {
    setAccountId("");
    setChatId("");
    setLevel("");
    setUrlError(null);
  };

  const errorCount = stats?.byLevel.error ?? 0;
  const warnCount = stats?.byLevel.warn ?? 0;
  const proxyOptions = Object.entries(stats?.byProxy ?? {}).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-zinc-800 bg-zinc-900 p-0.5">
            {DOMAIN_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setDomain(option.value);
                  setSource("");
                }}
                className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
                  domain === option.value
                    ? "bg-sky-500 text-white"
                    : "text-zinc-400 hover:text-zinc-100"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по действию, сообщению, коду, ошибке Telegram или прокси"
            autoComplete="off"
            className="min-w-64 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
          />
          <select
            value={level}
            onChange={(event) => setLevel(event.target.value as "" | LogLevel)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
          >
            {LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={source}
            onChange={(event) => setSource(event.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
          >
            {SOURCE_OPTIONS.filter(
              (option) =>
                !option.value ||
                domain === "all" ||
                (domain === "telegram"
                  ? TELEGRAM_SOURCES.includes(option.value)
                  : SYSTEM_SOURCES.includes(option.value)),
            ).map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            value={proxy}
            onChange={(event) => setProxy(event.target.value)}
            className="max-w-64 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
          >
            <option value="">Все прокси</option>
            {proxyOptions.map(([label, count]) => (
              <option key={label} value={label}>
                {label} ({count})
              </option>
            ))}
          </select>
          <select
            value={sort}
            onChange={(event) =>
              setSort(
                event.target.value as (typeof SORT_OPTIONS)[number]["value"],
              )
            }
            className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm text-zinc-100 outline-none focus:border-sky-500"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {(hasScopeFilters || urlError) && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-zinc-500">Фильтры:</span>
            {accountId && (
              <FilterChip
                label={`аккаунт: ${accountId}`}
                onRemove={() => setAccountId("")}
              />
            )}
            {chatId && (
              <FilterChip
                label={`чат: ${chatId}`}
                onRemove={() => setChatId("")}
              />
            )}
            {level && (
              <FilterChip
                label={`уровень: ${levelLabel}`}
                onRemove={() => setLevel("")}
              />
            )}
            <button
              type="button"
              onClick={clearScopeFilters}
              title="Убрать фильтры по аккаунту, чату и уровню и очистить адрес"
              className="rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-500"
            >
              Сбросить фильтры
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <label className="flex items-center gap-1.5">
            С
            <input
              type="date"
              value={since}
              onChange={(event) => setSince(event.target.value)}
              autoComplete="off"
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-500"
            />
          </label>
          <label className="flex items-center gap-1.5">
            По
            <input
              type="date"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              autoComplete="off"
              className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-sky-500"
            />
          </label>
          {(since || until || proxy) && (
            <button
              type="button"
              onClick={() => {
                setSince("");
                setUntil("");
                setProxy("");
              }}
              className="rounded-md border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:border-zinc-500"
            >
              Сбросить даты и прокси
            </button>
          )}

          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="ml-auto rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 disabled:opacity-40"
          >
            Обновить
          </button>
          <a
            href={`${API_URL}/logs/export?${queryString()}`}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500"
            title="Скачать NDJSON для агента"
          >
            Экспорт
          </a>
          <button
            type="button"
            onClick={() => void clearLogs()}
            className="rounded-md border border-red-900/60 px-3 py-1.5 text-xs text-red-300 transition-colors hover:border-red-600"
          >
            Очистить
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs text-zinc-400">
          <span className="rounded-md border border-zinc-800 bg-zinc-900/60 px-2.5 py-1">
            Всего: {stats?.total ?? 0}
          </span>
          <span className="rounded-md border border-red-900/40 bg-red-950/20 px-2.5 py-1 text-red-300">
            Ошибки: {errorCount}
          </span>
          <span className="rounded-md border border-amber-900/40 bg-amber-950/20 px-2.5 py-1 text-amber-300">
            Предупреждения: {warnCount}
          </span>
          {stats?.newest && (
            <span>Последняя: {formatDateTime(stats.newest)}</span>
          )}
          <label className="ml-auto flex items-center gap-2 text-zinc-300">
            <input
              type="checkbox"
              checked={live}
              autoComplete="off"
              onChange={(event) => {
                setLive(event.target.checked);
                if (event.target.checked) void load();
              }}
            />
            <span
              className={`h-2 w-2 rounded-full ${
                live ? "bg-emerald-500" : "bg-zinc-600"
              }`}
            />
            Live по WebSocket
          </label>
        </div>

        {(error || urlError) && (
          <div
            role="alert"
            className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
          >
            <p>{error ?? urlError}</p>
            {urlError && (
              <button
                type="button"
                onClick={() => setUrlError(null)}
                className="mt-1 text-xs text-red-200 underline-offset-2 hover:underline"
              >
                Скрыть
              </button>
            )}
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Журнал событий
            </h2>
            <span className="text-xs text-zinc-500">
              {loading ? "загрузка…" : `показано: ${entries.length}`}
            </span>
          </div>

          {!loading && entries.length === 0 && (
            <p className="px-4 py-8 text-sm text-zinc-500">
              {accountId || chatId
                ? "По выбранному аккаунту и чату записей нет. Проверьте id или уберите фильтр."
                : "Записей нет. Сделайте запрос к API — он появится здесь."}
            </p>
          )}

          {entries.map((entry) => {
            const expanded = expandedId === entry.id;
            return (
              <div
                key={entry.id}
                className="border-b border-zinc-800 last:border-b-0"
              >
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : entry.id)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-zinc-800/40"
                >
                  <span className="w-32 shrink-0 font-mono text-[11px] text-zinc-500">
                    {formatDateTime(entry.createdAt)}
                  </span>
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${LEVEL_STYLES[entry.level]}`}
                  >
                    {entry.level}
                  </span>
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {entry.source}
                  </span>
                  {entry.proxyLabel && (
                    <span
                      title={`Прокси: ${entry.proxyLabel}`}
                      className="max-w-40 shrink-0 truncate rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-300"
                    >
                      {entry.proxyLabel}
                    </span>
                  )}
                  <span className="min-w-56 flex-1">
                    <span className="block truncate text-sm text-zinc-100">
                      {entry.message}
                    </span>
                    <span className="block truncate font-mono text-[11px] text-zinc-500">
                      {entry.action}
                      {entry.errorCode ? ` · ${entry.errorCode}` : ""}
                      {entry.telegramError ? ` · ${entry.telegramError}` : ""}
                    </span>
                  </span>
                  {entry.durationMs !== null && (
                    <span className="shrink-0 font-mono text-[11px] text-zinc-500">
                      {entry.durationMs} мс
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-zinc-600">
                    {expanded ? "▴" : "▾"}
                  </span>
                </button>

                {expanded && (
                  <div className="border-t border-zinc-800 bg-zinc-950/60 px-4 py-3">
                    <div className="mb-3 flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
                      <span>request: {entry.requestId ?? "—"}</span>
                      {entry.accountId && (
                        <span>account: {entry.accountId}</span>
                      )}
                      {entry.sessionId && (
                        <span>session: {entry.sessionId}</span>
                      )}
                      {entry.chatId !== null && (
                        <span>chat: {entry.chatId}</span>
                      )}
                      {entry.attemptId && (
                        <span>attempt: {entry.attemptId}</span>
                      )}
                      {entry.proxyId && <span>proxy: {entry.proxyId}</span>}
                      <button
                        type="button"
                        onClick={() => void copyEntry(entry)}
                        className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:border-zinc-500"
                      >
                        {copiedId === entry.id
                          ? "Скопировано"
                          : "Копировать JSON"}
                      </button>
                    </div>

                    {entry.proxySnapshot !== null && (
                      <div className="mb-3">
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                          Прокси при запросе
                        </p>
                        <pre className="max-h-48 overflow-auto rounded-md border border-violet-900/40 bg-violet-950/10 p-3 font-mono text-[11px] leading-relaxed text-violet-200">
                          {JSON.stringify(entry.proxySnapshot, null, 2)}
                        </pre>
                      </div>
                    )}

                    {entry.proxyId !== null && entry.proxySnapshot === null && (
                      <p className="mb-3 text-[11px] text-amber-300">
                        Прокси {entry.proxyId} был назначен, но его профиль уже
                        удалён — сохранён только идентификатор.
                      </p>
                    )}

                    {entry.telegramResponse !== null && (
                      <div className="mb-3">
                        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                          Ответ Telegram
                        </p>
                        <pre className="max-h-64 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-[11px] leading-relaxed text-amber-200">
                          {JSON.stringify(entry.telegramResponse, null, 2)}
                        </pre>
                      </div>
                    )}

                    <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
                      Детали
                    </p>
                    <pre className="max-h-80 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                      {JSON.stringify(entry.details, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {nextOffset !== null && (
          <button
            type="button"
            onClick={() => void load({ append: true })}
            disabled={loading}
            className="mx-auto rounded-md border border-zinc-700 px-4 py-2 text-sm text-zinc-300 hover:border-zinc-500 disabled:opacity-40"
          >
            Показать ещё
          </button>
        )}
      </div>
    </div>
  );
}

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-sky-800/60 bg-sky-500/10 px-2 py-0.5 text-sky-200">
      <span className="max-w-72 truncate" title={label}>
        {label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        title={`Убрать фильтр «${label}»`}
        aria-label={`Убрать фильтр ${label}`}
        className="rounded-full px-1 text-sky-300 transition-colors hover:bg-sky-500/20 hover:text-sky-100"
      >
        ×
      </button>
    </span>
  );
}
