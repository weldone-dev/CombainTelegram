"use client";

import Link from "next/link";
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
import { ApiError } from "../../../lib/api";
import {
  type EveDelayedActionView,
  listDelayedActions,
} from "../../../lib/eve-actions";
import {
  type EvePersonaView,
  eveErrorMessage,
  listPersonas,
} from "../../../lib/eve-api";
import type {
  EveContextQuery,
  EveContextSnapshot,
} from "../../../lib/eve-context";
import { listContextSnapshots } from "../../../lib/eve-context";
import { accountName } from "../../../lib/format";
import {
  formatClock,
  formatCount,
  formatSnapshotTime,
  previewText,
  SNAPSHOT_KIND_LABELS,
  snapshotKindTone,
  snapshotSize,
  tokenLabel,
} from "./context-utils";
import { ContextViewer } from "./context-viewer";
import { DEMO_SNAPSHOTS } from "./demo-snapshots";
import { PendingTurns } from "./pending-turns";

const AUTO_REFRESH_MS = 5000;
const CHAT_DEBOUNCE_MS = 450;
/** Per-browser preference; absent means "on". */
const AUTOREFRESH_KEY = "eve-context-autorefresh";
/** How many pending rows to ask Nest for; the queue is usually tiny. */
const PENDING_LIMIT = 200;
/** Fixtures are a development aid only; production always reads the API. */
const DEMO_ENABLED = process.env.NODE_ENV !== "production";

/** Server filters persona/state; account and chat are narrowed here. */
function pendingTurnsOf(
  rows: EveDelayedActionView[],
  query: EveContextQuery,
): EveDelayedActionView[] {
  return rows
    .filter((row) => row.kind === "turn" && row.state === "pending")
    .filter((row) => !query.accountId || row.accountId === query.accountId)
    .filter((row) => !query.chatId || row.chatId === query.chatId)
    .sort((a, b) => {
      const at = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
      const bt = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.createdAt.localeCompare(b.createdAt);
    });
}

/**
 * Eve context inspector: the list of turns and exactly what the model received.
 *
 * Data goes through the dashboard's `/api/eve` proxy, so `EVE_TOKEN` never
 * reaches the browser. A 404 from Nest (the phase-2 route not mounted yet) is
 * rendered as an empty state, not as an error.
 */
export function ContextPage() {
  const { accounts } = useAppData();

  const [demo, setDemo] = useState(false);
  const [demoKnown, setDemoKnown] = useState(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setDemo(DEMO_ENABLED && params.get("demo") === "1");
    setDemoKnown(true);
  }, []);

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
  const [limit, setLimit] = useState(30);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setChatId(chatInput.trim()),
      CHAT_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [chatInput]);

  const query = useMemo<EveContextQuery>(
    () => ({
      personaId: personaId || undefined,
      accountId: accountId || undefined,
      chatId: chatId || undefined,
      limit,
    }),
    [personaId, accountId, chatId, limit],
  );

  const [snapshots, setSnapshots] = useState<EveContextSnapshot[] | null>(null);
  const [pending, setPending] = useState<EveDelayedActionView[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Starts at 0: `Date.now()` during render is unstable for prerendering.
  // The first load and a 15-second timer keep it current.
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

  // Keeps "через N мин" and the overdue highlight truthful with auto off too.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, []);

  const load = useCallback(async () => {
    if (!demoKnown) return;
    if (demo) {
      setSnapshots(DEMO_SNAPSHOTS);
      setPending([]);
      setError(null);
      setUnavailable(false);
      setLoading(false);
      setRefreshing(false);
      setLastUpdated(new Date());
      setNowMs(Date.now());
      return;
    }

    setRefreshing(true);
    try {
      // The queue is a bonus: a missing or failing route must never break the
      // snapshots list, so both requests settle independently.
      const [snapshotsResult, actionsResult] = await Promise.allSettled([
        listContextSnapshots(query),
        listDelayedActions({
          personaId: query.personaId,
          state: "pending",
          limit: PENDING_LIMIT,
        }),
      ]);

      if (snapshotsResult.status === "fulfilled") {
        setSnapshots(snapshotsResult.value);
        setError(null);
        setUnavailable(false);
      } else if (
        snapshotsResult.reason instanceof ApiError &&
        snapshotsResult.reason.status === 404
      ) {
        setSnapshots([]);
        setUnavailable(true);
        setError(null);
      } else {
        setError(eveErrorMessage(snapshotsResult.reason));
      }

      setPending(
        actionsResult.status === "fulfilled"
          ? pendingTurnsOf(actionsResult.value, query)
          : [],
      );
      setLastUpdated(new Date());
      setNowMs(Date.now());
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

  useEffect(() => {
    if (!snapshots) return;
    setSelectedId((current) =>
      current && snapshots.some((snapshot) => snapshot.id === current)
        ? current
        : (snapshots[0]?.id ?? null),
    );
  }, [snapshots]);

  const selected = useMemo(
    () => snapshots?.find((snapshot) => snapshot.id === selectedId) ?? null,
    [snapshots, selectedId],
  );

  const overduePending = pending.filter(
    (action) => action.dueAt !== null && Date.parse(action.dueAt) <= nowMs,
  ).length;

  const filtersActive = personaId !== "" || accountId !== "" || chatId !== "";
  const resetFilters = () => {
    setPersonaId("");
    setAccountId("");
    setChatInput("");
    setChatId("");
  };

  const personaOptions = personas ?? [];

  return (
    <div className="mx-auto grid h-full w-full max-w-7xl content-start gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
      <div className="flex flex-wrap items-start justify-between gap-2 lg:col-span-2">
        <div>
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-100">
            Контекст модели
            {demo && <Pill tone="amber">демо-режим</Pill>}
            {!demo && unavailable && (
              <Pill tone="zinc">бэкенд не подключён</Pill>
            )}
          </h2>
          <p className="mt-1 max-w-3xl text-xs text-zinc-500">
            Что реально уходит в модель на каждом turn'е Eve: system-блоки
            (instructions, persona, memory, media) и сообщения в порядке
            запроса.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Link href="/eve" className="text-sky-400 hover:text-sky-300">
            ← Eve
          </Link>
          {demo ? (
            <Link
              href="/eve/context"
              className="text-zinc-400 hover:text-zinc-200"
            >
              выйти из демо
            </Link>
          ) : (
            DEMO_ENABLED && (
              <Link
                href="/eve/context?demo=1"
                className="text-zinc-400 hover:text-zinc-200"
              >
                демо-снапшот
              </Link>
            )
          )}
        </div>
      </div>

      {error && (
        <div className="lg:col-span-2">
          <ErrorBanner message={error} />
          <div className="-mt-1">
            <GhostButton onClick={() => void load()} disabled={refreshing}>
              {refreshing ? "Повторная загрузка…" : "Повторить"}
            </GhostButton>
          </div>
        </div>
      )}

      <div className="lg:col-span-2">
        <Card
          title="Фильтры"
          description="Пустые поля не ограничивают выборку. Chat ID применяется после короткой паузы."
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

            <Field label="Лимит" hint="Сколько последних снапшотов запросить">
              <select
                value={String(limit)}
                onChange={(event) => setLimit(Number(event.target.value))}
                className={inputClass}
              >
                {[20, 30, 50, 100].map((value) => (
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
                  ? `обновлено ${formatClock(lastUpdated)}`
                  : "ещё не обновлялось"}
              <span className="text-zinc-600">
                · {auto ? `авто ${AUTO_REFRESH_MS / 1000} с` : "авто выкл."}
              </span>
            </span>
            {!demo && pending.length > 0 && (
              <Pill tone="amber">в очереди: {pending.length}</Pill>
            )}
            {!demo && overduePending > 0 && (
              <Pill tone="red">просрочено: {overduePending}</Pill>
            )}
          </div>
        </Card>
      </div>

      {!demo && pending.length > 0 && (
        <div className="lg:col-span-2">
          <PendingTurns
            actions={pending}
            personas={personaOptions}
            accounts={accounts}
            nowMs={nowMs}
          />
        </div>
      )}

      <Card
        title="Снапшоты"
        description={
          loading && !snapshots
            ? "Загрузка…"
            : `Всего: ${snapshots?.length ?? 0}${
                lastUpdated ? ` · ${formatClock(lastUpdated)}` : ""
              }`
        }
        className="self-start lg:sticky lg:top-4"
      >
        {loading && !snapshots ? (
          <div className="space-y-1" aria-hidden="true">
            {[0, 1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-16 animate-pulse rounded-md bg-zinc-800/60"
              />
            ))}
          </div>
        ) : !snapshots || snapshots.length === 0 ? (
          <div className="space-y-2 py-4 text-center">
            <p className="text-sm text-zinc-300">Снапшотов пока нет</p>
            <p className="text-xs text-zinc-500">
              {unavailable
                ? "Бэкенд появится в фазе 2 — маршрут GET /internal/eve/context/snapshots ещё не подключён."
                : "Eve ещё не записала ни одного turn'а под эти фильтры."}
            </p>
            {!demo && DEMO_ENABLED && (
              <Link
                href="/eve/context?demo=1"
                className="inline-block text-xs text-sky-400 hover:text-sky-300"
              >
                Посмотреть демо-снапшот →
              </Link>
            )}
          </div>
        ) : (
          <div className="space-y-1">
            {snapshots.map((snapshot) => {
              const active = snapshot.id === selectedId;
              const size = snapshotSize(snapshot);
              return (
                <button
                  key={snapshot.id}
                  type="button"
                  onClick={() => setSelectedId(snapshot.id)}
                  aria-pressed={active}
                  className={`flex w-full flex-col gap-1 rounded-md border px-2 py-2 text-left transition-colors ${
                    active
                      ? "border-sky-800 bg-sky-500/10"
                      : "border-transparent hover:bg-zinc-800/70"
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[10px] text-zinc-500">
                      {formatSnapshotTime(snapshot.createdAt)}
                    </span>
                    <Pill tone={snapshotKindTone(snapshot.kind)}>
                      {SNAPSHOT_KIND_LABELS[snapshot.kind]}
                    </Pill>
                    {snapshot.dryRun && <Pill tone="red">dry-run</Pill>}
                    <span className="ml-auto max-w-[9rem] truncate font-mono text-[10px] text-zinc-500">
                      {snapshot.model || "—"}
                    </span>
                  </span>
                  <span className="line-clamp-2 text-[11px] text-zinc-300">
                    {previewText(snapshot, 60) || "пустой turn"}
                  </span>
                  <span className="flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                    <span>{formatCount(size.chars)} симв</span>
                    <span>·</span>
                    <span>{tokenLabel(snapshot.tokens.total, size.chars)}</span>
                    <span>·</span>
                    <span className="truncate">
                      chat {snapshot.chatId}
                      {snapshot.threadId ? ` / ${snapshot.threadId}` : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <div className="min-w-0">
        {selected ? (
          <ContextViewer key={selected.id} snapshot={selected} demo={demo} />
        ) : (
          <Card title="Детали turn'а">
            <p className="text-xs text-zinc-500">
              {loading && !snapshots
                ? "Загрузка снапшотов…"
                : snapshots && snapshots.length > 0
                  ? "Выберите снапшот слева."
                  : "Когда Eve запишет первый turn, здесь появится точный список system-блоков и сообщений, отправленных в модель."}
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
