"use client";

import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  Card,
  ErrorBanner,
  GhostButton,
  Pill,
} from "../../components/dashboard/ai-ui";
import {
  type EveAgendaItemView,
  type EveListPage,
  type EveMemoryDailyView,
  type EveMemoryFactView,
  type EvePalaceDrawerView,
  type EveSessionLogView,
  eveErrorMessage,
  listAgendaItems,
  listMemoryDaily,
  listMemoryFacts,
  listPalaceDrawers,
  listSessionLogs,
} from "../../lib/eve-api";

const PREVIEW = 4;

interface Slice<T> {
  page: EveListPage<T> | null;
  error: string | null;
}

interface MemoryState {
  daily: Slice<EveMemoryDailyView>;
  facts: Slice<EveMemoryFactView>;
  palace: Slice<EvePalaceDrawerView>;
  agenda: Slice<EveAgendaItemView>;
  sessions: Slice<EveSessionLogView>;
}

function emptySlice<T>(): Slice<T> {
  return { page: null, error: null };
}

function emptyState(): MemoryState {
  return {
    daily: emptySlice(),
    facts: emptySlice(),
    palace: emptySlice(),
    agenda: emptySlice(),
    sessions: emptySlice(),
  };
}

function sliceOf<T>(result: PromiseSettledResult<EveListPage<T>>): Slice<T> {
  return result.status === "fulfilled"
    ? { page: result.value, error: null }
    : { page: null, error: eveErrorMessage(result.reason) };
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function excerpt(value: string, max = 220): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function MemorySlice({
  title,
  hint,
  slice,
  children,
}: {
  title: string;
  hint: string;
  slice: Slice<unknown>;
  children: ReactNode;
}) {
  const total = slice.page?.total ?? 0;
  const items = slice.page?.items ?? [];
  return (
    <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <h3 className="min-w-0 flex-1 text-xs font-semibold text-zinc-200">
          {title}
        </h3>
        <Pill tone={total > 0 ? "sky" : "zinc"}>{total}</Pill>
      </div>
      <p className="mb-2 text-[10px] text-zinc-500">{hint}</p>
      <ErrorBanner message={slice.error} />
      {slice.page && items.length === 0 ? (
        <p className="text-xs text-zinc-500">Пока пусто.</p>
      ) : (
        <>
          {children}
          {total > items.length && (
            <p className="mt-1 text-[10px] text-zinc-600">
              показаны {items.length} из {total}
            </p>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Read-only memory dashboard for one persona. Each table is fetched through
 * the same Eve proxy; a missing Nest route only breaks its own tile.
 */
export function PersonaMemoryCard({ personaId }: { personaId: string }) {
  const [state, setState] = useState<MemoryState>(emptyState);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const results = await Promise.allSettled([
      listMemoryDaily(personaId),
      listMemoryFacts(personaId),
      listPalaceDrawers(personaId),
      listAgendaItems(personaId),
      listSessionLogs(personaId),
    ]);
    setState({
      daily: sliceOf(
        results[0] as PromiseSettledResult<EveListPage<EveMemoryDailyView>>,
      ),
      facts: sliceOf(
        results[1] as PromiseSettledResult<EveListPage<EveMemoryFactView>>,
      ),
      palace: sliceOf(
        results[2] as PromiseSettledResult<EveListPage<EvePalaceDrawerView>>,
      ),
      agenda: sliceOf(
        results[3] as PromiseSettledResult<EveListPage<EveAgendaItemView>>,
      ),
      sessions: sliceOf(
        results[4] as PromiseSettledResult<EveListPage<EveSessionLogView>>,
      ),
    });
    setLoading(false);
  }, [personaId]);

  useEffect(() => {
    setState(emptyState());
    void load();
  }, [load]);

  const total =
    (state.daily.page?.total ?? 0) +
    (state.facts.page?.total ?? 0) +
    (state.palace.page?.total ?? 0) +
    (state.agenda.page?.total ?? 0) +
    (state.sessions.page?.total ?? 0);

  return (
    <Card
      title="Память"
      description="Что Eve помнит об этой персоне: дневные сводки, факты, Memory Palace, повестка и сырой лог сессий. Только чтение."
      actions={
        <GhostButton onClick={() => void load()} disabled={loading}>
          {loading ? "Загрузка…" : "Обновить"}
        </GhostButton>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <Pill tone={total > 0 ? "green" : "zinc"}>всего записей: {total}</Pill>
        <span>
          Превью по 4 записи; счётчик показывает полный размер таблицы, если
          Nest его отдаёт.
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <MemorySlice
          title="EveMemoryDaily"
          hint="Дневные сводки переписки."
          slice={state.daily}
        >
          <ul className="space-y-2">
            {(state.daily.page?.items ?? []).slice(0, PREVIEW).map((item) => (
              <li
                key={item.id}
                className="rounded border border-zinc-800/70 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[11px] text-zinc-300">
                    {item.date}
                  </span>
                  <Pill tone={item.complete ? "green" : "amber"}>
                    {item.complete ? "complete" : "draft"}
                  </Pill>
                </div>
                <p className="mt-1 break-words text-[11px] text-zinc-400">
                  {excerpt(item.markdown) || "Пустая сводка"}
                </p>
              </li>
            ))}
          </ul>
        </MemorySlice>

        <MemorySlice
          title="EveMemoryFact"
          hint="Извлечённые факты о собеседниках и мире."
          slice={state.facts}
        >
          <ul className="space-y-2">
            {(state.facts.page?.items ?? []).slice(0, PREVIEW).map((item) => (
              <li
                key={item.id}
                className="rounded border border-zinc-800/70 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone="zinc">{item.kind}</Pill>
                  <Pill tone="sky">важность {item.importance}</Pill>
                  <span className="ml-auto text-[10px] text-zinc-600">
                    {item.source}
                  </span>
                </div>
                <p className="mt-1 break-words text-[11px] text-zinc-300">
                  {excerpt(item.content, 260)}
                </p>
              </li>
            ))}
          </ul>
        </MemorySlice>

        <MemorySlice
          title="EvePalaceDrawer"
          hint="Атомы Memory Palace: wing / hall / room."
          slice={state.palace}
        >
          <ul className="space-y-2">
            {(state.palace.page?.items ?? []).slice(0, PREVIEW).map((item) => (
              <li
                key={item.id}
                className="rounded border border-zinc-800/70 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                  <span className="text-zinc-300">{item.wing}</span>
                  <span>/</span>
                  <span>{item.hall}</span>
                  <span>/</span>
                  <span>{item.room}</span>
                  <Pill tone="amber">{item.salience}</Pill>
                </div>
                <p className="mt-1 break-words text-[11px] text-zinc-400">
                  {excerpt(item.content)}
                </p>
              </li>
            ))}
          </ul>
        </MemorySlice>

        <MemorySlice
          title="EveAgendaItem"
          hint="Проактивные поводы написать."
          slice={state.agenda}
        >
          <ul className="space-y-2">
            {(state.agenda.page?.items ?? []).slice(0, PREVIEW).map((item) => (
              <li
                key={item.id}
                className="rounded border border-zinc-800/70 px-2 py-1.5"
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Pill tone={item.state === "pending" ? "amber" : "zinc"}>
                    {item.state}
                  </Pill>
                  <span className="font-mono text-[10px] text-zinc-500">
                    {formatDate(item.pingAt)}
                  </span>
                  <span className="ml-auto text-[10px] text-zinc-600">
                    chat {String(item.chatId)}
                  </span>
                </div>
                <p className="mt-1 break-words text-[11px] text-zinc-300">
                  {item.about}
                </p>
                {item.reason && (
                  <p className="mt-0.5 break-words text-[10px] text-zinc-500">
                    {excerpt(item.reason, 160)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </MemorySlice>

        <MemorySlice
          title="EveSessionLog"
          hint="Последние строки лога сессий, из которых собирается память."
          slice={state.sessions}
        >
          <ul className="space-y-2">
            {(state.sessions.page?.items ?? [])
              .slice(0, PREVIEW)
              .map((item) => (
                <li
                  key={item.id}
                  className="rounded border border-zinc-800/70 px-2 py-1.5"
                >
                  <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                    <span className="text-zinc-300">{item.day}</span>
                    <span>chat {String(item.chatId)}</span>
                    <span className="ml-auto">
                      {formatDate(item.createdAt)}
                    </span>
                  </div>
                  <p className="mt-1 break-words font-mono text-[10px] text-zinc-400">
                    {excerpt(item.line, 240)}
                  </p>
                </li>
              ))}
          </ul>
        </MemorySlice>
      </div>

      <p className="mt-3 text-[10px] text-zinc-600">
        Daily, Palace и SessionLog читаются через <code>GET memory/daily</code>,{" "}
        <code>GET memory/palace</code> и <code>GET memory/sessions</code>. Если
        Nest их ещё не отдаёт, плитка покажет ошибку, остальные продолжат
        работать.
      </p>
    </Card>
  );
}
