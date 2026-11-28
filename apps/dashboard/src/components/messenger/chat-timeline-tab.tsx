"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type ChatPersonaMatch,
  resolveChatPersonas,
} from "../../lib/eve-chat-personas";
import {
  type EveTimelineEntryView,
  type EveTimelineScoreKey,
  type EveTimelineView,
  eveErrorMessage,
  getChatTimeline,
} from "../../lib/eve-api";
import { eveStageLabel } from "../../lib/eve-stages";
import { Pill } from "../dashboard/ai-ui";
import {
  EmptyNote,
  formatStamp,
  PanelCard,
  RowsSkeleton,
  SMALL_BUTTON,
  TabError,
  TabHeader,
  useCachedResource,
} from "./chat-tab-ui";

type TimelineFilter = "all" | "messages" | "relationship";

const FILTERS: Array<{ id: TimelineFilter; label: string }> = [
  { id: "all", label: "Всё" },
  { id: "messages", label: "Сообщения" },
  { id: "relationship", label: "Отношения" },
];

const METRICS: Array<{ key: EveTimelineScoreKey; label: string }> = [
  { key: "interest", label: "интерес" },
  { key: "trust", label: "доверие" },
  { key: "attraction", label: "влечение" },
  { key: "annoyance", label: "раздражение" },
  { key: "cringe", label: "кринж" },
];

const SOURCE_LABELS: Record<string, string> = {
  inbound: "входящее",
  proactive: "инициатива",
  reaction: "реакция",
  ignore: "игнор",
};

const POLL_MS = 5_000;
const PAGE_LIMIT = 100;

/** "5 мин назад" — the absolute timestamp lives in the `title` attribute. */
function relativeTime(iso: string): string {
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return "";
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60_000) return "только что";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  if (days < 7) return `${days} дн назад`;
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      day: "numeric",
      month: "short",
    }).format(new Date(time));
  } catch {
    return new Date(time).toLocaleDateString();
  }
}

function signed(value: number): string {
  return `${value > 0 ? "+" : "−"}${Math.abs(value)}`;
}

/** Fresh page first, then older rows that are not in it yet. */
function mergeEntries(
  current: EveTimelineEntryView[],
  incoming: EveTimelineEntryView[],
): EveTimelineEntryView[] {
  const seen = new Set(incoming.map((entry) => entry.id));
  return [...incoming, ...current.filter((entry) => !seen.has(entry.id))];
}

function matchesFilter(
  entry: EveTimelineEntryView,
  filter: TimelineFilter,
): boolean {
  if (filter === "all") return true;
  if (filter === "relationship") return entry.kind === "relationship";
  return entry.kind !== "relationship";
}

/**
 * «Хроника» tab: his messages, her replies/ignores and the relationship
 * deltas applied for those turns, newest first. Polls every five seconds while
 * the document is visible; a hidden tab makes no requests.
 */
export function ChatTimelineTab({
  accountId,
  chatId,
  threadId,
}: {
  accountId: string;
  chatId: number;
  threadId: number;
}) {
  const chatIdText = String(chatId);
  const [filter, setFilter] = useState<TimelineFilter>("all");
  const [preferredPersonaId, setPreferredPersonaId] = useState<string | null>(
    null,
  );

  const matches = useCachedResource<ChatPersonaMatch[]>(
    `eve-chat-matches:${accountId}:${chatIdText}:${threadId}`,
    () => resolveChatPersonas(accountId, chatIdText, threadId),
  );
  const list = matches.data ?? [];
  const active = useMemo(
    () =>
      list.find((item) => item.persona.id === preferredPersonaId) ??
      list[0] ??
      null,
    [list, preferredPersonaId],
  );
  const personaId = active?.persona.id ?? "";

  const [entries, setEntries] = useState<EveTimelineEntryView[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const loadedRef = useRef(false);

  const fetchPage = useCallback(
    async (before: string | null, mode: "initial" | "refresh" | "more") => {
      if (!personaId) {
        setEntries([]);
        setNextBefore(null);
        setLoading(false);
        return;
      }
      const requestId = ++requestRef.current;
      if (mode === "more") setLoadingMore(true);
      else if (!loadedRef.current) setLoading(true);
      try {
        const page: EveTimelineView = await getChatTimeline(
          personaId,
          accountId,
          chatIdText,
          { threadId, limit: PAGE_LIMIT, before },
        );
        if (requestId !== requestRef.current) return;
        loadedRef.current = true;
        setEntries((current) =>
          mode === "initial"
            ? page.entries
            : mergeEntries(current, page.entries),
        );
        setNextBefore((current) =>
          mode === "refresh" && current !== null
            ? current
            : page.nextBefore,
        );
        setError(null);
      } catch (caught) {
        if (requestId === requestRef.current) {
          setError(eveErrorMessage(caught));
        }
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [personaId, accountId, chatIdText, threadId],
  );

  // A new persona/chat starts a fresh feed.
  useEffect(() => {
    loadedRef.current = false;
    setEntries([]);
    setNextBefore(null);
    setError(null);
    void fetchPage(null, "initial");
  }, [fetchPage]);

  // Live tail: paused while the browser tab is hidden.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") {
        void fetchPage(null, "refresh");
      }
    };
    const timer = window.setInterval(tick, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [fetchPage]);

  const visible = entries.filter((entry) => matchesFilter(entry, filter));
  const refresh = () => {
    matches.reload();
    void fetchPage(null, "refresh");
  };

  if (matches.loading && !matches.data) {
    return (
      <PanelCard title="Хроника">
        <RowsSkeleton rows={4} />
      </PanelCard>
    );
  }

  if (matches.error) {
    return (
      <PanelCard title="Хроника">
        <TabError text={matches.error} onRetry={refresh} />
      </PanelCard>
    );
  }

  if (!active) {
    return (
      <PanelCard title="Хроника">
        <EmptyNote>Чат не привязан к персоне Eve</EmptyNote>
        <Link
          href="/eve"
          className="mt-2 inline-block text-[11px] text-sky-400 hover:text-sky-300"
        >
          Настроить персону в Eve →
        </Link>
      </PanelCard>
    );
  }

  return (
    <div className="space-y-3">
      <TabHeader
        threadId={threadId}
        onRefresh={refresh}
        refreshing={loading || matches.loading}
      >
        <div className="flex items-center gap-1 rounded-md border border-zinc-800 p-0.5">
          {FILTERS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setFilter(item.id)}
              title={`Показать: ${item.label.toLowerCase()}`}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                filter === item.id
                  ? "bg-sky-500/20 text-sky-200"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </TabHeader>

      {list.length > 1 && (
        <label className="block text-[10px] text-zinc-500">
          Персона
          <select
            value={personaId}
            onChange={(event) => setPreferredPersonaId(event.target.value)}
            className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-100 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30"
          >
            {list.map((item) => (
              <option key={item.persona.id} value={item.persona.id}>
                {item.persona.name}
                {item.binding.threadId > 0
                  ? ` · тред #${item.binding.threadId}`
                  : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      <PanelCard
        title="Хроника чата"
        hint={`${active.persona.name} · его сообщения, её ответы и изменения отношений`}
        badge={<span className="text-[10px] text-zinc-500">обновляется</span>}
      >
        <div className="mt-2">
          {loading && !loadedRef.current && <RowsSkeleton rows={5} />}
          {error && (
            <TabError
              text={error}
              onRetry={() => void fetchPage(null, "refresh")}
            />
          )}
          {!loading && !error && visible.length === 0 && (
            <EmptyNote>
              {entries.length === 0
                ? "Записей пока нет. Хроника заполнится после первого обмена сообщениями в этом чате."
                : filter === "relationship"
                  ? "Изменений отношений в этом чате пока нет."
                  : "Сообщений в этом чате пока нет."}
            </EmptyNote>
          )}

          {visible.length > 0 && (
            <ol className="space-y-2">
              {visible.map((entry) => (
                <TimelineRow key={entry.id} entry={entry} />
              ))}
            </ol>
          )}

          {nextBefore && !error && (
            <button
              type="button"
              disabled={loadingMore}
              onClick={() => void fetchPage(nextBefore, "more")}
              className={`mt-3 w-full ${SMALL_BUTTON}`}
            >
              {loadingMore ? "Загрузка…" : "Загрузить более ранние"}
            </button>
          )}
        </div>
      </PanelCard>
    </div>
  );
}

function TimelineRow({ entry }: { entry: EveTimelineEntryView }) {
  const stamp = formatStamp(entry.at);
  const time = (
    <time
      dateTime={entry.at}
      title={stamp}
      className="shrink-0 text-[10px] text-zinc-600"
    >
      {relativeTime(entry.at)}
    </time>
  );

  if (entry.kind === "incoming") {
    return (
      <li className="flex flex-col items-start">
        <div className="mr-6 max-w-[92%] rounded-xl rounded-bl-sm border border-zinc-700/80 bg-zinc-800/70 px-2.5 py-1.5">
          <p className="whitespace-pre-wrap break-words text-[11px] text-zinc-200">
            {entry.text}
          </p>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 pl-1">
          <span className="text-[10px] font-medium text-zinc-500">он</span>
          {entry.messageId !== undefined && (
            <span className="font-mono text-[9px] text-zinc-600">
              #{entry.messageId}
            </span>
          )}
          {time}
        </div>
      </li>
    );
  }

  if (entry.kind === "reply") {
    return (
      <li className="flex flex-col items-end">
        <div className="ml-6 max-w-[92%] rounded-xl rounded-br-sm border border-sky-500/30 bg-sky-500/10 px-2.5 py-1.5">
          <p className="whitespace-pre-wrap break-words text-[11px] text-sky-100">
            {entry.text}
          </p>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 pr-1">
          {time}
          <span className="text-[10px] font-medium text-sky-400/80">она</span>
          {entry.dryRun && <Pill tone="amber">dry-run</Pill>}
        </div>
      </li>
    );
  }

  if (entry.kind === "ignored") {
    return (
      <li className="flex flex-col items-start">
        <div className="mr-6 max-w-[92%] rounded-xl border border-dashed border-zinc-700 bg-transparent px-2.5 py-1.5">
          <p className="text-[11px] italic text-zinc-500">
            игнор{entry.reason ? ` · ${entry.reason}` : ""}
          </p>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 pl-1">
          <span className="text-[10px] font-medium text-zinc-600">она</span>
          {time}
        </div>
      </li>
    );
  }

  const deltas = METRICS.filter(
    (metric) => (entry.delta[metric.key] ?? 0) !== 0,
  );
  const stageMoved =
    entry.stageTo !== undefined && entry.stageFrom !== entry.stageTo;
  const conflictMoved =
    entry.conflictTo !== undefined &&
    entry.conflictTo !== entry.conflictFrom;

  return (
    <li>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/80 px-2.5 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
            отношения
          </span>
          {deltas.map((metric) => {
            const value = entry.delta[metric.key] ?? 0;
            return (
              <span
                key={metric.key}
                title={`${metric.label}: ${entry.before[metric.key]} → ${entry.after[metric.key]}`}
                className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                  value > 0
                    ? "bg-emerald-500/15 text-emerald-300"
                    : "bg-red-500/15 text-red-300"
                }`}
              >
                {signed(value)} {metric.label}
              </span>
            );
          })}
          {!deltas.length && (
            <span className="text-[10px] text-zinc-500">без изменения счётчиков</span>
          )}
          {entry.stageTo && (
            <Pill tone={stageMoved ? "sky" : "zinc"}>
              {stageMoved
                ? `${eveStageLabel(entry.stageFrom ?? "")} → ${eveStageLabel(entry.stageTo)}`
                : eveStageLabel(entry.stageTo)}
            </Pill>
          )}
          {(conflictMoved || entry.conflictTo !== undefined) && (
            <Pill
              tone={
                (entry.conflictTo ?? 0) >= 2
                  ? "red"
                  : (entry.conflictTo ?? 0) === 1
                    ? "amber"
                    : "green"
              }
            >
              {conflictMoved
                ? `конфликт ${entry.conflictFrom ?? 0} → ${entry.conflictTo}`
                : `конфликт ${entry.conflictTo ?? 0}`}
            </Pill>
          )}
          <span className="ml-auto text-[10px] text-zinc-600">
            {SOURCE_LABELS[entry.source] ?? entry.source}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-end">{time}</div>
      </div>
    </li>
  );
}
