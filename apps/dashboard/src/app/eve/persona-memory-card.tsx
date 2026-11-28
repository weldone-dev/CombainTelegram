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
import { matchesDay } from "../../lib/eve-relationship-notes";
import {
  isStructuredJson,
  MemoryRecordDialog,
  prettyJson,
} from "./memory-record-dialog";

/** Compact preview length until the section is expanded. */
const PREVIEW = 4;

/** Maximised section height while expanded, so the panel does not grow. */
const EXPANDED_LIST_CLASS = "max-h-[24rem] overflow-y-auto pr-1";

type SectionKey = "daily" | "facts" | "palace" | "agenda" | "sessions";

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

/** Display-only day filter: the page itself is never re-fetched. */
interface DayFilter {
  date: string;
  count: number;
}

/** One row opened in the full-view dialog. */
type MemoryDetail =
  | { kind: "daily"; item: EveMemoryDailyView }
  | { kind: "fact"; item: EveMemoryFactView }
  | { kind: "palace"; item: EvePalaceDrawerView }
  | { kind: "agenda"; item: EveAgendaItemView }
  | { kind: "session"; item: EveSessionLogView };

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

function collapsedSections(): Record<SectionKey, boolean> {
  return {
    daily: false,
    facts: false,
    palace: false,
    agenda: false,
    sessions: false,
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

/** Row highlight reused by every matched record while a day filter is active. */
function recordClass(matched: boolean): string {
  return matched
    ? "rounded border border-sky-800/70 bg-sky-500/[0.06] px-2 py-1.5"
    : "rounded border border-zinc-800/70 px-2 py-1.5";
}

/** A whole record is a button: the preview opens the full-text dialog. */
function RecordButton({
  matched,
  label,
  onClick,
  children,
}: {
  matched: boolean;
  /** Accessible name; the visible row stays compact. */
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Открыть полностью: ${label}`}
      className={`block w-full text-left transition-colors hover:border-zinc-600 hover:bg-zinc-800/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 ${recordClass(
        matched,
      )}`}
    >
      {children}
    </button>
  );
}

/** Clipboard payload: the full text followed by every metadata field. */
function detailCopyText({
  header,
  text,
  fields,
  json,
}: {
  header: string;
  text?: string;
  fields: { label: string; value: string }[];
  json?: { label: string; text: string } | null;
}): string {
  const lines = [header];
  if (text) lines.push("", text);
  if (fields.length > 0) {
    lines.push("", ...fields.map((field) => `${field.label}: ${field.value}`));
  }
  if (json?.text.trim()) {
    lines.push("", `${json.label}:`, prettyJson(json.text));
  }
  return lines.join("\n");
}

function MemoryDetailDialog({
  detail,
  onClose,
}: {
  detail: MemoryDetail;
  onClose: () => void;
}) {
  if (detail.kind === "daily") {
    const item = detail.item;
    const fields = [
      { label: "id", value: item.id, mono: true },
      { label: "personaId", value: item.personaId, mono: true },
      { label: "date", value: item.date, mono: true },
      { label: "complete", value: item.complete ? "да" : "нет (draft)" },
      { label: "создано", value: formatDate(item.createdAt) },
      { label: "обновлено", value: formatDate(item.updatedAt) },
    ];
    return (
      <MemoryRecordDialog
        eyebrow="EveMemoryDaily"
        title={`Дневная сводка · ${item.date}`}
        badges={
          <Pill tone={item.complete ? "green" : "amber"}>
            {item.complete ? "complete" : "draft"}
          </Pill>
        }
        text={item.markdown}
        textLabel="markdown"
        fields={fields}
        json={{ label: "json", text: item.json }}
        copyText={detailCopyText({
          header: `EveMemoryDaily ${item.date}`,
          text: item.markdown,
          fields,
          json: { label: "json", text: item.json },
        })}
        onClose={onClose}
      />
    );
  }

  if (detail.kind === "fact") {
    const item = detail.item;
    const fields = [
      { label: "kind", value: item.kind },
      { label: "importance", value: String(item.importance) },
      { label: "source", value: item.source },
      {
        label: "relationshipId",
        value: item.relationshipId ?? "—",
        mono: true,
      },
      { label: "создано", value: formatDate(item.createdAt) },
      { label: "обновлено", value: formatDate(item.updatedAt) },
      { label: "id", value: item.id, mono: true },
      { label: "personaId", value: item.personaId, mono: true },
    ];
    return (
      <MemoryRecordDialog
        eyebrow="EveMemoryFact"
        title={excerpt(item.content, 90) || "Факт"}
        badges={
          <>
            <Pill tone="zinc">{item.kind}</Pill>
            <Pill tone="sky">важность {item.importance}</Pill>
            <Pill tone="zinc">источник {item.source}</Pill>
          </>
        }
        text={item.content}
        textLabel="content"
        fields={fields}
        copyText={detailCopyText({
          header: `EveMemoryFact · ${item.kind}`,
          text: item.content,
          fields,
        })}
        onClose={onClose}
      />
    );
  }

  if (detail.kind === "palace") {
    const item = detail.item;
    const fields = [
      { label: "wing", value: item.wing },
      { label: "hall", value: item.hall },
      { label: "room", value: item.room },
      { label: "salience", value: String(item.salience) },
      { label: "source", value: item.source },
      { label: "keywords", value: item.keywords },
      { label: "drawerId", value: item.drawerId, mono: true },
      { label: "hash", value: item.hash, mono: true },
      { label: "создано", value: formatDate(item.createdAt) },
      { label: "обновлено", value: formatDate(item.updatedAt) },
      { label: "id", value: item.id, mono: true },
      { label: "personaId", value: item.personaId, mono: true },
    ];
    return (
      <MemoryRecordDialog
        eyebrow="EvePalaceDrawer"
        title={`${item.wing} / ${item.hall} / ${item.room}`}
        badges={<Pill tone="amber">salience {item.salience}</Pill>}
        text={item.content}
        textLabel="content"
        fields={fields}
        json={
          isStructuredJson(item.keywords)
            ? { label: "keywords (JSON)", text: item.keywords }
            : null
        }
        copyText={detailCopyText({
          header: `EvePalaceDrawer · ${item.wing} / ${item.hall} / ${item.room}`,
          text: item.content,
          fields,
        })}
        onClose={onClose}
      />
    );
  }

  if (detail.kind === "agenda") {
    const item = detail.item;
    const fields = [
      { label: "state", value: item.state },
      { label: "kind", value: item.kind },
      { label: "importance", value: String(item.importance) },
      { label: "pingAt", value: `${item.pingAt} · ${formatDate(item.pingAt)}` },
      { label: "attempts", value: String(item.attempts) },
      { label: "chatId", value: String(item.chatId), mono: true },
      { label: "accountId", value: item.accountId, mono: true },
      { label: "создано", value: formatDate(item.createdAt) },
      { label: "обновлено", value: formatDate(item.updatedAt) },
      { label: "id", value: item.id, mono: true },
      { label: "personaId", value: item.personaId, mono: true },
    ];
    return (
      <MemoryRecordDialog
        eyebrow="EveAgendaItem"
        title={item.about || "Повод написать"}
        badges={
          <>
            <Pill tone={item.state === "pending" ? "amber" : "zinc"}>
              {item.state}
            </Pill>
            <Pill tone="zinc">{item.kind}</Pill>
            <Pill tone="sky">важность {item.importance}</Pill>
          </>
        }
        text={item.reason}
        textLabel="reason"
        fields={fields}
        json={
          isStructuredJson(item.history)
            ? { label: "history (JSON)", text: item.history }
            : null
        }
        copyText={detailCopyText({
          header: `EveAgendaItem · ${item.about}`,
          text: item.reason,
          fields,
          json: { label: "history", text: item.history },
        })}
        onClose={onClose}
      />
    );
  }

  const item = detail.item;
  const fields = [
    { label: "day", value: item.day, mono: true },
    { label: "chatId", value: String(item.chatId), mono: true },
    { label: "accountId", value: item.accountId, mono: true },
    { label: "создано", value: formatDate(item.createdAt) },
    { label: "id", value: item.id, mono: true },
    { label: "personaId", value: item.personaId, mono: true },
  ];
  return (
    <MemoryRecordDialog
      eyebrow="EveSessionLog"
      title={`Строка лога · ${item.day}`}
      badges={
        <>
          <Pill tone="zinc">chat {String(item.chatId)}</Pill>
          <Pill tone="zinc">{formatDate(item.createdAt)}</Pill>
        </>
      }
      text={item.line}
      textLabel="line"
      textMono
      fields={fields}
      copyText={detailCopyText({
        header: `EveSessionLog ${item.day}`,
        text: item.line,
        fields,
      })}
      onClose={onClose}
    />
  );
}

function MemorySlice({
  title,
  hint,
  slice,
  filter = null,
  expanded = false,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  slice: Slice<unknown>;
  /** Non-null while a day filter is active; `count` is the matched row count. */
  filter?: DayFilter | null;
  expanded?: boolean;
  /** Omitted when every loaded row is already on screen. */
  onToggle?: () => void;
  children: ReactNode;
}) {
  const total = slice.page?.total ?? 0;
  const items = slice.page?.items ?? [];
  const shownCount = filter ? filter.count : total;
  return (
    <div
      className={`min-w-0 rounded-lg border bg-zinc-950/30 p-3 ${
        filter && filter.count > 0
          ? "border-sky-900/70"
          : "border-zinc-800"
      }`}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5">
        <h3 className="min-w-0 flex-1 text-xs font-semibold text-zinc-200">
          {title}
        </h3>
        <Pill tone={shownCount > 0 ? "sky" : "zinc"}>{shownCount}</Pill>
        {onToggle && (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {expanded ? "Свернуть" : `Показать все (${items.length})`}
          </button>
        )}
      </div>
      <p className="mb-2 text-[10px] text-zinc-500">
        {hint}
        {filter ? ` · фильтр: ${filter.date}` : ""}
      </p>
      <ErrorBanner message={slice.error} />
      {slice.page && items.length === 0 ? (
        <p className="text-xs text-zinc-500">Пока пусто.</p>
      ) : filter && filter.count === 0 ? (
        <p className="text-xs text-zinc-500">
          Нет записей за {filter.date}.
        </p>
      ) : (
        <>
          {/* Filtered lists scroll: a busy day can match hundreds of rows. */}
          <div className={filter || expanded ? EXPANDED_LIST_CLASS : ""}>
            {children}
          </div>
          {filter ? (
            filter.count > 0 && (
              <p className="mt-1 text-[10px] text-sky-300/70">
                найдено за {filter.date}: {filter.count}
              </p>
            )
          ) : expanded && total > items.length ? (
            <p className="mt-1 text-[10px] text-zinc-600">
              загружено {items.length} из {total}
            </p>
          ) : (
            total > items.length && (
              <p className="mt-1 text-[10px] text-zinc-600">
                показаны {items.length} из {total}
              </p>
            )
          )}
        </>
      )}
    </div>
  );
}

/**
 * Read-only memory dashboard for one persona. Each table is fetched through
 * the same Eve proxy; a missing Nest route only breaks its own tile.
 *
 * Sections show a compact preview (4 rows) and can be expanded in place; any
 * row opens a dialog with the complete text and every stored field.
 *
 * `focusDate` comes from a clicked relationship note. It only narrows what is
 * rendered — the five pages stay cached exactly as loaded, so «Сбросить»
 * restores the full list without a request.
 */
export function PersonaMemoryCard({
  personaId,
  focusDate = null,
  onClearFocus,
}: {
  personaId: string;
  /** `YYYY-MM-DD` to focus on; filters daily / facts / sessions previews. */
  focusDate?: string | null;
  /** Drops the focus filter; omitted on the read-only persona page. */
  onClearFocus?: () => void;
}) {
  const [state, setState] = useState<MemoryState>(emptyState);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] =
    useState<Record<SectionKey, boolean>>(collapsedSections);
  const [detail, setDetail] = useState<MemoryDetail | null>(null);

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
    setExpanded(collapsedSections());
    setDetail(null);
    void load();
  }, [load]);

  const total =
    (state.daily.page?.total ?? 0) +
    (state.facts.page?.total ?? 0) +
    (state.palace.page?.total ?? 0) +
    (state.agenda.page?.total ?? 0) +
    (state.sessions.page?.total ?? 0);

  // Filtering is render-time only: `daily` by its day key, `facts` and
  // `sessions` by `createdAt`. `palace` and `agenda` have no day the note
  // points at, so they keep their ordinary preview.
  const dailyItems = state.daily.page?.items ?? [];
  const factItems = state.facts.page?.items ?? [];
  const palaceItems = state.palace.page?.items ?? [];
  const agendaItems = state.agenda.page?.items ?? [];
  const sessionItems = state.sessions.page?.items ?? [];

  const dailyMatches = focusDate
    ? dailyItems.filter((item) => matchesDay(item.date, focusDate))
    : [];
  const factMatches = focusDate
    ? factItems.filter((item) => matchesDay(item.createdAt, focusDate))
    : [];
  const sessionMatches = focusDate
    ? sessionItems.filter((item) => matchesDay(item.createdAt, focusDate))
    : [];

  const matchCount =
    dailyMatches.length + factMatches.length + sessionMatches.length;
  // Nothing on that day: be honest in the banner and keep the ordinary lists.
  const filtering = Boolean(focusDate) && matchCount > 0;
  const activeDay = filtering ? focusDate : null;

  const preview = <T,>(items: T[], section: SectionKey): T[] =>
    expanded[section] ? items : items.slice(0, PREVIEW);
  const toggle = (section: SectionKey) => () =>
    setExpanded((current) => ({ ...current, [section]: !current[section] }));

  const dailyShown = activeDay ? dailyMatches : preview(dailyItems, "daily");
  const factsShown = activeDay ? factMatches : preview(factItems, "facts");
  // Palace and agenda are not date-filtered, so they keep the ordinary preview.
  const palaceShown = preview(palaceItems, "palace");
  const agendaShown = preview(agendaItems, "agenda");
  const sessionShown = activeDay
    ? sessionMatches
    : preview(sessionItems, "sessions");

  return (
    <Card
      title="Память"
      description="Что Eve помнит об этой персоне: дневные сводки, факты, Memory Palace, повестка и сырой лог сессий. Только чтение; клик по записи открывает её полностью."
      actions={
        <GhostButton onClick={() => void load()} disabled={loading}>
          {loading ? "Загрузка…" : "Обновить"}
        </GhostButton>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
        <Pill tone={total > 0 ? "green" : "zinc"}>всего записей: {total}</Pill>
        <span>
          Компактное превью: «Показать все» раскрывает секцию, клик по записи —
          полный текст и поля.
        </span>
      </div>

      {focusDate && (
        <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-sky-900/60 bg-sky-950/30 px-3 py-2">
          <span className="text-xs text-sky-200">
            Записи за <span className="font-mono">{focusDate}</span> ·{" "}
            {matchCount} найдено
          </span>
          {matchCount === 0 && (
            <span className="text-[11px] text-zinc-400">
              за эту дату записей не найдено — ниже обычный список
            </span>
          )}
          {onClearFocus && (
            <div className="ml-auto">
              <GhostButton onClick={onClearFocus}>Сбросить</GhostButton>
            </div>
          )}
        </div>
      )}

      <div className="@container">
        <div className="grid gap-3 @2xl:grid-cols-2">
        <MemorySlice
          title="EveMemoryDaily"
          hint="Дневные сводки переписки."
          slice={state.daily}
          filter={
            activeDay ? { date: activeDay, count: dailyMatches.length } : null
          }
          expanded={expanded.daily}
          onToggle={
            !activeDay && dailyItems.length > PREVIEW
              ? toggle("daily")
              : undefined
          }
        >
          <ul className="space-y-2">
            {dailyShown.map((item) => (
              <li key={item.id}>
                <RecordButton
                  matched={Boolean(activeDay)}
                  label={`сводка за ${item.date}`}
                  onClick={() => setDetail({ kind: "daily", item })}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-[11px] text-zinc-300">
                      {item.date}
                    </span>
                    <Pill tone={item.complete ? "green" : "amber"}>
                      {item.complete ? "complete" : "draft"}
                    </Pill>
                  </span>
                  <span className="mt-1 block break-words text-[11px] text-zinc-400">
                    {excerpt(item.markdown) || "Пустая сводка"}
                  </span>
                </RecordButton>
              </li>
            ))}
          </ul>
        </MemorySlice>

        <MemorySlice
          title="EveMemoryFact"
          hint="Извлечённые факты о собеседниках и мире."
          slice={state.facts}
          filter={
            activeDay ? { date: activeDay, count: factMatches.length } : null
          }
          expanded={expanded.facts}
          onToggle={
            !activeDay && factItems.length > PREVIEW
              ? toggle("facts")
              : undefined
          }
        >
          <ul className="space-y-2">
            {factsShown.map((item) => (
              <li key={item.id}>
                <RecordButton
                  matched={Boolean(activeDay)}
                  label={`факт ${item.kind}`}
                  onClick={() => setDetail({ kind: "fact", item })}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Pill tone="zinc">{item.kind}</Pill>
                    <Pill tone="sky">важность {item.importance}</Pill>
                    <span className="ml-auto text-[10px] text-zinc-600">
                      {item.source}
                    </span>
                  </span>
                  <span className="mt-1 block break-words text-[11px] text-zinc-300">
                    {excerpt(item.content, 260)}
                  </span>
                </RecordButton>
              </li>
            ))}
          </ul>
        </MemorySlice>

        <MemorySlice
          title="EvePalaceDrawer"
          hint="Атомы Memory Palace: wing / hall / room."
          slice={state.palace}
          expanded={expanded.palace}
          onToggle={
            !activeDay && palaceItems.length > PREVIEW
              ? toggle("palace")
              : undefined
          }
        >
          <ul className="space-y-2">
            {palaceShown.map((item) => (
              <li key={item.id}>
                <RecordButton
                  matched={Boolean(activeDay)}
                  label={`${item.wing} / ${item.hall} / ${item.room}`}
                  onClick={() => setDetail({ kind: "palace", item })}
                >
                  <span className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                    <span className="text-zinc-300">{item.wing}</span>
                    <span>/</span>
                    <span>{item.hall}</span>
                    <span>/</span>
                    <span>{item.room}</span>
                    <Pill tone="amber">{item.salience}</Pill>
                  </span>
                  <span className="mt-1 block break-words text-[11px] text-zinc-400">
                    {excerpt(item.content)}
                  </span>
                </RecordButton>
              </li>
            ))}
          </ul>
        </MemorySlice>

        <MemorySlice
          title="EveAgendaItem"
          hint="Проактивные поводы написать."
          slice={state.agenda}
          expanded={expanded.agenda}
          onToggle={
            !activeDay && agendaItems.length > PREVIEW
              ? toggle("agenda")
              : undefined
          }
        >
          <ul className="space-y-2">
            {agendaShown.map((item) => (
              <li key={item.id}>
                <RecordButton
                  matched={Boolean(activeDay)}
                  label={item.about}
                  onClick={() => setDetail({ kind: "agenda", item })}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={item.state === "pending" ? "amber" : "zinc"}>
                      {item.state}
                    </Pill>
                    <span className="font-mono text-[10px] text-zinc-500">
                      {formatDate(item.pingAt)}
                    </span>
                    <span className="ml-auto text-[10px] text-zinc-600">
                      chat {String(item.chatId)}
                    </span>
                  </span>
                  <span className="mt-1 block break-words text-[11px] text-zinc-300">
                    {item.about}
                  </span>
                  {item.reason && (
                    <span className="mt-0.5 block break-words text-[10px] text-zinc-500">
                      {excerpt(item.reason, 160)}
                    </span>
                  )}
                </RecordButton>
              </li>
            ))}
          </ul>
        </MemorySlice>

        <MemorySlice
          title="EveSessionLog"
          hint="Последние строки лога сессий, из которых собирается память."
          slice={state.sessions}
          filter={
            activeDay
              ? { date: activeDay, count: sessionMatches.length }
              : null
          }
          expanded={expanded.sessions}
          onToggle={
            !activeDay && sessionItems.length > PREVIEW
              ? toggle("sessions")
              : undefined
          }
        >
          <ul className="space-y-2">
            {sessionShown.map((item) => (
              <li key={item.id}>
                <RecordButton
                  matched={Boolean(activeDay)}
                  label={`строка лога за ${item.day}`}
                  onClick={() => setDetail({ kind: "session", item })}
                >
                  <span className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                    <span className="text-zinc-300">{item.day}</span>
                    <span>chat {String(item.chatId)}</span>
                    <span className="ml-auto">
                      {formatDate(item.createdAt)}
                    </span>
                  </span>
                  <span className="mt-1 block break-words font-mono text-[10px] text-zinc-400">
                    {excerpt(item.line, 240)}
                  </span>
                </RecordButton>
              </li>
            ))}
          </ul>
        </MemorySlice>
        </div>
      </div>

      <p className="mt-3 text-[10px] text-zinc-600">
        Daily, Palace и SessionLog читаются через <code>GET memory/daily</code>,{" "}
        <code>GET memory/palace</code> и <code>GET memory/sessions</code>. Если
        Nest их ещё не отдаёт, плитка покажет ошибку, остальные продолжат
        работать.
      </p>

      {detail && (
        <MemoryDetailDialog detail={detail} onClose={() => setDetail(null)} />
      )}
    </Card>
  );
}
