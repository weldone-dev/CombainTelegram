"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  Pill,
  Toggle,
} from "../../../components/dashboard/ai-ui";
import { useAppData } from "../../../components/dashboard/app-data";
import {
  fireChatDelayedTurns,
  fireDelayedAction,
} from "../../../lib/eve-actions";
import {
  type EvePersonaView,
  eveErrorMessage,
  listPersonas,
} from "../../../lib/eve-api";
import {
  type EveScheduleDelayedAction,
  type EveSchedulesOverview,
  getSchedulesOverview,
} from "../../../lib/eve-schedules";
import { accountName, formatTime } from "../../../lib/format";
import { demoSchedules } from "./demo-schedules";
import {
  formatCreated,
  formatDue,
  humanCron,
  isOverdue,
  KIND_LABELS,
  kindTone,
  matchesSearch,
  nextDueAt,
  REASON_LABELS,
  relativeDue,
  STATE_LABELS,
  stateTone,
  waitsForState,
} from "./schedules-utils";

const AUTO_REFRESH_MS = 5000;
const CHAT_DEBOUNCE_MS = 450;
/** Per-browser preference; absent means "on". */
const AUTOREFRESH_KEY = "eve-schedules-autorefresh";
const DEMO_ENABLED = process.env.NODE_ENV !== "production";

type StateFilter = "pending" | "failed" | "dropped" | "all";

const STATE_OPTIONS: Array<{ value: StateFilter; label: string }> = [
  { value: "pending", label: "pending — ждут" },
  { value: "failed", label: "failed — ошибки" },
  { value: "dropped", label: "dropped — снятые" },
  { value: "all", label: "все состояния" },
];

const KIND_OPTIONS = Object.entries(KIND_LABELS);
const REASON_OPTIONS = Object.entries(REASON_LABELS);

function Stat({
  label,
  value,
  tone = "zinc",
  hint,
}: {
  label: string;
  value: string;
  tone?: "zinc" | "sky" | "green" | "amber" | "red";
  hint?: string;
}) {
  const colors: Record<string, string> = {
    zinc: "text-zinc-200",
    sky: "text-sky-300",
    green: "text-emerald-300",
    amber: "text-amber-300",
    red: "text-red-300",
  };
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      <div className={`mt-1 text-xl font-semibold ${colors[tone]}`}>
        {value}
      </div>
      {hint && <div className="mt-0.5 text-[11px] text-zinc-500">{hint}</div>}
    </div>
  );
}

/**
 * "Отложено и запланировано": every non-immediate piece of Eve's work.
 *
 * Static cron schedules come from the live Eve process, delayed rows from
 * Nest's SQLite queue. Both are read-only here; the dashboard never enqueues
 * or dispatches anything.
 */
export function SchedulesPage() {
  const { accounts } = useAppData();
  const searchParams = useSearchParams();
  const demoParam = searchParams.get("demo") === "1";

  const [demo, setDemo] = useState(false);
  const [demoKnown, setDemoKnown] = useState(false);
  // Re-runs on client-side navigation too, so the header link actually toggles
  // demo mode instead of only working on a full page load.
  useEffect(() => {
    setDemo(DEMO_ENABLED && demoParam);
    setDemoKnown(true);
  }, [demoParam]);

  const [personas, setPersonas] = useState<EvePersonaView[] | null>(null);
  const [personasError, setPersonasError] = useState<string | null>(null);
  useEffect(() => {
    if (!demoKnown || demo) return;
    let cancelled = false;
    listPersonas()
      .then((list) => {
        if (!cancelled) setPersonas(list);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPersonas([]);
        setPersonasError(eveErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [demo, demoKnown]);

  const [personaId, setPersonaId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [chatInput, setChatInput] = useState("");
  const [chatId, setChatId] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(
      () => setChatId(chatInput.trim()),
      CHAT_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [chatInput]);

  const [stateFilter, setStateFilter] = useState<StateFilter>("pending");
  const [kindFilter, setKindFilter] = useState("all");
  const [reasonFilter, setReasonFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(100);

  const statesParam =
    stateFilter === "all" ? "pending,sent,failed,dropped" : stateFilter;

  const query = useMemo(
    () => ({
      personaId: personaId || undefined,
      accountId: accountId || undefined,
      chatId: chatId || undefined,
      states: statesParam,
      limit,
    }),
    [personaId, accountId, chatId, statesParam, limit],
  );

  const [overview, setOverview] = useState<EveSchedulesOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // "Reply now" feedback: one row at a time plus the bulk action.
  const [firingId, setFiringId] = useState<string | null>(null);
  const [firingAll, setFiringAll] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // Starts at 0: `Date.now()` during render is unstable for prerendering.
  const [nowMs, setNowMs] = useState(0);
  const [auto, setAuto] = useState(true);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(AUTOREFRESH_KEY);
      if (stored !== null) setAuto(stored !== "0");
    } catch {
      // Blocked localStorage: keep the default (on).
    }
  }, []);

  const changeAuto = useCallback((value: boolean) => {
    setAuto(value);
    try {
      window.localStorage.setItem(AUTOREFRESH_KEY, value ? "1" : "0");
    } catch {
      // Blocked localStorage: the toggle still works for this session.
    }
  }, []);

  // Relative labels stay truthful even with auto-refresh off.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    if (!demoKnown) return;
    if (demo) {
      setOverview(demoSchedules(Date.now()));
      setError(null);
      setLoading(false);
      setRefreshing(false);
      setLastUpdated(new Date());
      setNowMs(Date.now());
      return;
    }

    setRefreshing(true);
    try {
      setOverview(await getSchedulesOverview(query));
      setError(null);
      setLastUpdated(new Date());
      setNowMs(Date.now());
    } catch (reason) {
      setError(eveErrorMessage(reason));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [demo, demoKnown, query]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auto) return;
    const timer = window.setInterval(() => {
      // A hidden tab must not poll the API every 5 seconds.
      if (document.visibilityState !== "visible") return;
      void load();
    }, AUTO_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [auto, load]);

  // Catch up immediately when the user comes back to the tab.
  useEffect(() => {
    if (!auto) return;
    const onVisibility = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [auto, load]);

  const personaOptions = personas ?? [];
  const personaNames = useMemo(
    () => new Map(personaOptions.map((persona) => [persona.id, persona.name])),
    [personaOptions],
  );
  const accountNames = useMemo(
    () =>
      new Map(accounts.map((account) => [account.id, accountName(account)])),
    [accounts],
  );

  const filtered = useMemo(() => {
    // Live rows already come filtered by Nest. Fixtures carry every state, so
    // apply the same state filter here to keep the demo honest.
    const rows = (overview?.delayed ?? []).filter(
      (row) => !demo || stateFilter === "all" || row.state === stateFilter,
    );
    return rows
      .filter((row) => kindFilter === "all" || row.kind === kindFilter)
      .filter((row) => reasonFilter === "all" || row.reason === reasonFilter)
      .filter((row) => matchesSearch(row, search));
  }, [overview, demo, stateFilter, kindFilter, reasonFilter, search]);

  const counts = overview?.counts;
  const nextDue = useMemo(
    () => (nowMs > 0 ? nextDueAt(overview?.delayed ?? [], nowMs) : null),
    [overview, nowMs],
  );

  // Only a pending turn can be "answered now": sends/edits/reactions have a
  // clock but no model call, and a settled row must never be re-sent.
  const pendingTurns = useMemo(
    () =>
      filtered.filter((row) => row.kind === "turn" && row.state === "pending"),
    [filtered],
  );

  const fireOne = useCallback(
    async (action: EveScheduleDelayedAction) => {
      if (firingId !== null || firingAll) return;
      setFiringId(action.id);
      setActionNotice(null);
      setActionError(null);
      try {
        const result = await fireDelayedAction(action.id);
        if (result.ok) {
          setActionNotice(
            `Отправлено сейчас · чат ${action.chatId}${
              action.threadId ? ` / ${action.threadId}` : ""
            }`,
          );
        } else if (result.reason === "not-pending") {
          setActionNotice(
            "Действие уже не в очереди: его отправил тик или оно снято.",
          );
        } else {
          setActionError(
            `Не отправлено: ${result.reason ?? result.outcome ?? "неизвестная причина"}`,
          );
        }
      } catch (caught) {
        setActionError(eveErrorMessage(caught));
      } finally {
        setFiringId(null);
        await load();
      }
    },
    [firingId, firingAll, load],
  );

  const fireAll = useCallback(async () => {
    if (firingAll || firingId !== null) return;
    // `fireChat` is addressed to one persona/account/chat/thread: group the
    // visible pending turns and fire each group sequentially.
    const groups = new Map<string, EveScheduleDelayedAction>();
    for (const row of pendingTurns) {
      groups.set(
        `${row.personaId}|${row.accountId}|${row.chatId}|${row.threadId}`,
        row,
      );
    }
    if (groups.size === 0) {
      setActionNotice("Нет отложенных ответов для отправки.");
      return;
    }
    setFiringAll(true);
    setActionNotice(null);
    setActionError(null);
    let fired = 0;
    try {
      for (const row of groups.values()) {
        const result = await fireChatDelayedTurns({
          personaId: row.personaId,
          accountId: row.accountId,
          chatId: row.chatId,
          threadId: row.threadId,
        });
        fired += result.fired;
      }
      setActionNotice(
        `Отправлено сейчас: ${fired} из ${pendingTurns.length} отложенных ответов.`,
      );
    } catch (caught) {
      setActionError(eveErrorMessage(caught));
    } finally {
      setFiringAll(false);
      await load();
    }
  }, [firingAll, firingId, pendingTurns, load]);

  const filtersActive =
    personaId !== "" ||
    accountId !== "" ||
    chatId !== "" ||
    kindFilter !== "all" ||
    reasonFilter !== "all" ||
    search !== "" ||
    stateFilter !== "pending";
  const resetFilters = () => {
    setPersonaId("");
    setAccountId("");
    setChatInput("");
    setChatId("");
    setKindFilter("all");
    setReasonFilter("all");
    setSearch("");
    setStateFilter("pending");
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-7xl flex-col gap-4 overflow-y-auto p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-100">
            Отложено и запланировано
            {demo && <Pill tone="amber">демо-режим</Pill>}
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-zinc-500">
            Всё, что Eve сделает позже: cron-расписания агента и durable-очередь
            отложенных ответов, правок и реакций. Страница только читает
            состояние.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Link href="/eve" className="text-sky-400 hover:text-sky-300">
            ← Eve
          </Link>
          <Link
            href="/eve/context"
            className="text-zinc-400 hover:text-zinc-200"
          >
            Context
          </Link>
          {demo ? (
            <Link
              href="/eve/schedules"
              className="text-zinc-400 hover:text-zinc-200"
            >
              выйти из демо
            </Link>
          ) : (
            DEMO_ENABLED && (
              <Link
                href="/eve/schedules?demo=1"
                className="text-zinc-400 hover:text-zinc-200"
              >
                демо
              </Link>
            )
          )}
        </div>
      </div>

      {error && (
        <div>
          <ErrorBanner message={error} />
          <GhostButton onClick={() => void load()} disabled={refreshing}>
            {refreshing ? "Повторная загрузка…" : "Повторить"}
          </GhostButton>
        </div>
      )}

      <Card
        title="Сводка"
        description="Счётчики по всей очереди выбранной персоны/аккаунта/чата; фильтры state/kind/reason ниже сужают только список."
        actions={
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <span
                aria-hidden="true"
                className={`h-2 w-2 rounded-full ${
                  refreshing
                    ? "animate-pulse bg-amber-400"
                    : auto
                      ? "bg-emerald-500"
                      : "bg-zinc-600"
                }`}
              />
              {refreshing
                ? "обновляю…"
                : lastUpdated
                  ? `обновлено ${formatTime(lastUpdated.toISOString())}`
                  : "ещё не обновлялось"}
            </span>
            <GhostButton onClick={() => void load()} disabled={refreshing}>
              {refreshing ? "Обновление…" : "Обновить"}
            </GhostButton>
          </div>
        }
      >
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            label="pending"
            value={String(counts?.pending ?? "—")}
            tone="amber"
            hint="ждут тика или смены состояния"
          />
          <Stat
            label="overdue"
            value={String(counts?.overdue ?? "—")}
            tone={(counts?.overdue ?? 0) > 0 ? "red" : "zinc"}
            hint="dueAt уже прошёл"
          />
          <Stat
            label="failed"
            value={String(counts?.failed ?? "—")}
            tone={(counts?.failed ?? 0) > 0 ? "red" : "zinc"}
            hint="исчерпаны попытки"
          />
          <Stat
            label="dropped"
            value={String(counts?.dropped ?? "—")}
            hint="перекрыты новым входящим"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
          <Pill tone={nextDue ? "sky" : "zinc"}>ближайший</Pill>
          {nextDue ? (
            <>
              <span className="font-mono text-[11px] text-zinc-300">
                {formatDue(nextDue.iso)}
              </span>
              <span className="text-zinc-500">· {nextDue.relative}</span>
            </>
          ) : (
            <span className="text-zinc-500">
              {stateFilter === "pending" || stateFilter === "all"
                ? "нет запланированных по времени"
                : "в выбранном состоянии нет dueAt — переключите state на pending"}
            </span>
          )}
        </div>
      </Card>

      <Card
        title="Фильтры"
        description="Персона, аккаунт и chat id уходят в Nest; state — тоже. Kind, reason и поиск применяются к уже загруженному списку."
        actions={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {filtersActive && (
              <GhostButton onClick={resetFilters} disabled={refreshing}>
                Сбросить
              </GhostButton>
            )}
            <GhostButton onClick={() => void load()} disabled={refreshing}>
              {refreshing ? "Обновление…" : "Обновить"}
            </GhostButton>
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Персона" hint={personasError ?? undefined}>
            {personasError ? (
              <input
                type="text"
                value={personaId}
                onChange={(event) => setPersonaId(event.target.value)}
                placeholder="personaId"
                className={inputClass}
              />
            ) : (
              <select
                value={personaId}
                onChange={(event) => setPersonaId(event.target.value)}
                className={inputClass}
                disabled={!demoKnown || personas === null}
              >
                <option value="">все персоны</option>
                {personaOptions.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.name}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Аккаунт">
            <select
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
              className={inputClass}
            >
              <option value="">все аккаунты</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {accountName(account)}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Chat ID" hint="Telegram chat id, если нужен один чат">
            <input
              type="text"
              inputMode="numeric"
              value={chatInput}
              onChange={(event) => setChatInput(event.target.value)}
              placeholder="например 6123456789"
              className={inputClass}
            />
          </Field>

          <Field label="Состояние">
            <select
              value={stateFilter}
              onChange={(event) =>
                setStateFilter(event.target.value as StateFilter)
              }
              className={inputClass}
            >
              {STATE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Kind">
            <select
              value={kindFilter}
              onChange={(event) => setKindFilter(event.target.value)}
              className={inputClass}
            >
              <option value="all">любой kind</option>
              {KIND_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {value} — {label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Reason">
            <select
              value={reasonFilter}
              onChange={(event) => setReasonFilter(event.target.value)}
              className={inputClass}
            >
              <option value="all">любая причина</option>
              {REASON_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {value} — {label}
                </option>
              ))}
            </select>
          </Field>

          <Field
            label="Поиск"
            hint="по preview, ошибке, chat и id"
            className="sm:col-span-2 xl:col-span-1"
          >
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="текст сообщения…"
              className={inputClass}
            />
          </Field>

          <Field label="Лимит" hint="Сколько строк запросить у Nest">
            <select
              value={String(limit)}
              onChange={(event) => setLimit(Number(event.target.value))}
              className={inputClass}
            >
              {[50, 100, 200].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Toggle
            checked={auto}
            onChange={changeAuto}
            label="Автообновление"
            hint={`Каждые ${AUTO_REFRESH_MS / 1000} с, пока вкладка видима`}
          />
          {!demo && counts && counts.overdue > 0 && (
            <Pill tone="red">просрочено: {counts.overdue}</Pill>
          )}
          <span className="text-[11px] text-zinc-500">
            {filtered.length} из {overview?.delayed.length ?? 0} строк после
            локальных фильтров
          </span>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="Статические расписания"
          description="defineSchedule() в agent/schedules/. Источник — GET /eve/v1/info запущенного Eve."
        >
          {overview?.infoError && (
            <div className="mb-2 break-words rounded-md border border-amber-900/60 bg-amber-950/30 px-2.5 py-2 text-xs text-amber-200">
              {overview.infoError}
            </div>
          )}
          {loading && !overview ? (
            <div className="space-y-1" aria-hidden="true">
              {[0, 1].map((row) => (
                <div
                  key={row}
                  className="h-12 animate-pulse rounded-md bg-zinc-800/60"
                />
              ))}
            </div>
          ) : overview && overview.static.length > 0 ? (
            <ul className="space-y-1.5">
              {overview.static.map((schedule) => (
                <li
                  key={schedule.name}
                  className="rounded-md border border-zinc-800 bg-zinc-950/30 px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-zinc-200">
                      {schedule.name}
                    </span>
                    <Pill tone={schedule.hasRun ? "green" : "zinc"}>
                      {schedule.hasRun ? "запускался" : "ещё не было"}
                    </Pill>
                    {schedule.timezone && (
                      <Pill tone="sky">{schedule.timezone}</Pill>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-zinc-500">
                      {schedule.cron}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                    <span>{humanCron(schedule.cron)}</span>
                    {schedule.path && (
                      <span className="truncate font-mono text-[10px] text-zinc-600">
                        {schedule.path}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-4 text-center">
              <p className="text-sm text-zinc-300">Расписаний нет</p>
              <p className="mt-1 text-xs text-zinc-500">
                {overview?.infoError
                  ? "Eve не отдал info — проверьте, запущен ли `eve dev`/`eve start`."
                  : "В agent/schedules/ нет скомпилированных defineSchedule()."}
              </p>
            </div>
          )}
          <p className="mt-3 border-t border-zinc-800 pt-2 text-[11px] text-zinc-500">
            В `eve dev` cron не тикает: расписание можно запустить вручную через
            `POST /eve/v1/dev/schedules/&lt;name&gt;`. Nest при этом ведёт свои
            тики: delayed-очередь раз в 5 с, presence обновляется по вызову
            самого расписания.
          </p>
        </Card>

        <Card
          title="Динамические расписания"
          description="defineDynamicSchedules(): расписания, которые модель или пользователь создают во время работы."
        >
          {overview && overview.dynamic.length > 0 ? (
            <ul className="space-y-1.5">
              {overview.dynamic.map((schedule) => (
                <li
                  key={`${schedule.name}:${schedule.path}`}
                  className="rounded-md border border-zinc-800 bg-zinc-950/30 px-2.5 py-2"
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-zinc-200">
                      {schedule.name}
                    </span>
                    {schedule.creator && (
                      <Pill tone="sky">{schedule.creator}</Pill>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-zinc-500">
                      {schedule.cron ?? "без cron"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-400">
                    {schedule.cron && <span>{humanCron(schedule.cron)}</span>}
                    {schedule.path && (
                      <span className="truncate font-mono text-[10px] text-zinc-600">
                        {schedule.path}
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-4 text-center">
              <p className="text-sm text-zinc-300">Не используются</p>
              <p className="mx-auto mt-1 max-w-lg text-xs text-zinc-500">
                В проекте не подключён `defineDynamicSchedules`, поэтому
                runtime-расписаний нет. Eve 1.5 отдаёт в `/eve/v1/info` только
                скомпилированные статические schedules; список появится здесь,
                когда info начнёт отдавать коллекции.
              </p>
            </div>
          )}
        </Card>
      </div>

      <Card
        title="Очередь отложенного"
        description={`${filtered.length} строк из EveDelayedAction · состояние: ${stateFilter}${
          filtersActive ? " · фильтры активны" : ""
        }`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {counts && counts.overdue > 0 ? (
              <Pill tone="red">просрочено: {counts.overdue}</Pill>
            ) : null}
            {!demo && pendingTurns.length > 0 && (
              <GhostButton
                onClick={() => void fireAll()}
                disabled={firingAll || firingId !== null}
              >
                {firingAll
                  ? "Отправляю…"
                  : `Отправить все сейчас (${pendingTurns.length})`}
              </GhostButton>
            )}
          </div>
        }
      >
        {actionNotice && (
          <p className="mb-2 break-words rounded-md border border-emerald-900/60 bg-emerald-950/30 px-2.5 py-2 text-xs text-emerald-200">
            {actionNotice}
          </p>
        )}
        {actionError && (
          <p
            role="alert"
            className="mb-2 break-words rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-2 text-xs text-red-200"
          >
            {actionError}
          </p>
        )}
        {loading && !overview ? (
          <div className="space-y-1" aria-hidden="true">
            {[0, 1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-16 animate-pulse rounded-md bg-zinc-800/60"
              />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-4 text-center">
            <p className="text-sm text-zinc-300">
              {overview?.delayed.length === 0
                ? "Очередь пуста"
                : "Под фильтры ничего не попало"}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              {overview?.delayed.length === 0
                ? stateFilter === "pending"
                  ? "Нет отложенных действий: Eve ответит сразу или ничего не ждёт."
                  : "В выбранном состоянии строк нет. Переключите state или сбросьте фильтры."
                : "Измените kind/reason/поиск или сбросьте фильтры."}
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {filtered.map((action) => {
              const overdue = isOverdue(action, nowMs);
              const dueRelative =
                nowMs > 0 ? relativeDue(action.dueAt, nowMs) : "…";
              return (
                <li
                  key={action.id}
                  className={`rounded-md border px-2.5 py-2 ${
                    overdue
                      ? "border-red-900/70 bg-red-950/20"
                      : "border-zinc-800 bg-zinc-950/30"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={kindTone(action.kind)}>
                      {action.kind}
                      {KIND_LABELS[action.kind] ? (
                        <span className="ml-1 font-normal opacity-80">
                          {KIND_LABELS[action.kind]}
                        </span>
                      ) : null}
                    </Pill>
                    <Pill tone={action.reason === "sleep" ? "sky" : "zinc"}>
                      {REASON_LABELS[action.reason] || action.reason || "delay"}
                    </Pill>
                    <Pill tone={stateTone(action.state)}>
                      {STATE_LABELS[action.state] || action.state}
                    </Pill>
                    {overdue && <Pill tone="red">просрочено</Pill>}
                    {waitsForState(action) && (
                      <Pill tone="sky">
                        {["sleep", "busy", "offline"].includes(action.reason)
                          ? "ждёт состояния"
                          : "без времени"}
                      </Pill>
                    )}
                    <span className="ml-auto font-mono text-[10px] text-zinc-400">
                      {action.dueAt ? (
                        <>
                          {formatDue(action.dueAt)}
                          <span
                            className={`ml-1 ${
                              overdue ? "text-red-300" : "text-zinc-500"
                            }`}
                          >
                            · {dueRelative}
                          </span>
                        </>
                      ) : (
                        <span className="text-zinc-500">dueAt = null</span>
                      )}
                    </span>
                  </div>

                  <p className="mt-1.5 line-clamp-3 text-xs text-zinc-200">
                    {action.preview || "без текста"}
                  </p>

                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-zinc-500">
                    <span className="truncate">
                      персона{" "}
                      <span className="text-zinc-400">
                        {personaNames.get(action.personaId) ||
                          action.personaId ||
                          "—"}
                      </span>
                    </span>
                    <span>·</span>
                    <span className="truncate">
                      аккаунт{" "}
                      <span className="text-zinc-400">
                        {accountNames.get(action.accountId) ||
                          action.accountId ||
                          "—"}
                      </span>
                    </span>
                    <span>·</span>
                    <span className="truncate font-mono">
                      chat {action.chatId || "—"}
                      {action.threadId ? ` / ${action.threadId}` : ""}
                    </span>
                    <span>·</span>
                    <span title={formatDue(action.createdAt)}>
                      создано {formatCreated(action.createdAt, nowMs)}
                    </span>
                    {action.attempts > 0 && (
                      <>
                        <span>·</span>
                        <span
                          className={action.attempts >= 5 ? "text-red-300" : ""}
                        >
                          попыток: {action.attempts}
                        </span>
                      </>
                    )}
                  </div>

                  {action.lastError && (
                    <p className="mt-1 break-words rounded bg-red-950/30 px-1.5 py-1 font-mono text-[10px] text-red-300">
                      {action.lastError}
                    </p>
                  )}

                  {!demo &&
                    action.kind === "turn" &&
                    action.state === "pending" && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void fireOne(action)}
                          disabled={firingAll || firingId !== null}
                          title="Отправить этот отложенный ответ сейчас, не дожидаясь тика"
                          className="rounded border border-sky-800/80 bg-sky-500/10 px-2 py-1 text-[11px] text-sky-200 transition-colors hover:border-sky-500 hover:bg-sky-500/20 disabled:opacity-40"
                        >
                          {firingId === action.id
                            ? "Отправляю…"
                            : "Ответить сейчас"}
                        </button>
                      </div>
                    )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
