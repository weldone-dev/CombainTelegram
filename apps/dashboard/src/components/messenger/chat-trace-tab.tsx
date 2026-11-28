"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  formatCount,
  formatSnapshotTime,
} from "../../app/eve/context/context-utils";
import {
  type EveTimelineEntryView,
  type EveTurnWhyView,
  eveErrorMessage,
  getChatTimeline,
  getTurnWhy,
} from "../../lib/eve-api";
import {
  type ChatPersonaMatch,
  resolveChatPersonas,
} from "../../lib/eve-chat-personas";
import {
  type EveContextSnapshot,
  listContextSnapshots,
} from "../../lib/eve-context";
import { Pill } from "../dashboard/ai-ui";
import {
  EmptyNote,
  PanelCard,
  RowsSkeleton,
  TabError,
  TabHeader,
  useCachedResource,
} from "./chat-tab-ui";

const TRACE_POLL_MS = 5_000;
const TRACE_SNAPSHOTS = 10;
const TRACE_ENTRIES = 120;
/** A timeline row belongs to the nearest turn within this window. */
const TURN_WINDOW_MS = 10 * 60_000;

const METRICS = [
  { key: "interest", label: "интерес" },
  { key: "trust", label: "доверие" },
  { key: "attraction", label: "влечение" },
  { key: "annoyance", label: "раздражение" },
  { key: "cringe", label: "кринж" },
] as const;

const SOURCE_LABELS: Record<string, string> = {
  inbound: "входящее",
  proactive: "инициатива",
  reaction: "реакция",
  ignore: "игнор",
};

type TurnEvent = EveTimelineEntryView;

interface TraceTurn {
  snapshot: EveContextSnapshot;
  events: TurnEvent[];
}

interface TraceState {
  snapshots: EveContextSnapshot[];
  entries: TurnEvent[];
  why: EveTurnWhyView | null;
}

const EMPTY_TRACE: TraceState = { snapshots: [], entries: [], why: null };

/** "5 мин назад" for the turn header; the exact stamp lives in `title`. */
function relativeTime(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  const diff = Math.max(0, Date.now() - time);
  if (diff < 60_000) return "только что";
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "вчера";
  return `${days} дн назад`;
}

function signed(value: number): string {
  return `${value > 0 ? "+" : "−"}${Math.abs(value)}`;
}

/**
 * Assigns every timeline row to the nearest turn snapshot. A row further than
 * {@link TURN_WINDOW_MS} from any snapshot stays loose (for example, a turn
 * that settled before the snapshot retention started).
 */
export function groupTraceTurns(
  snapshots: EveContextSnapshot[],
  entries: TurnEvent[],
): { turns: TraceTurn[]; loose: TurnEvent[] } {
  const turns: TraceTurn[] = snapshots.map((snapshot) => ({
    snapshot,
    events: [],
  }));
  const loose: TurnEvent[] = [];

  for (const entry of entries) {
    const time = Date.parse(entry.at);
    if (!Number.isFinite(time)) {
      loose.push(entry);
      continue;
    }
    let best: { turn: TraceTurn; distance: number } | null = null;
    for (const turn of turns) {
      const at = Date.parse(turn.snapshot.createdAt);
      if (!Number.isFinite(at)) continue;
      const distance = Math.abs(at - time);
      if (!best || distance < best.distance) best = { turn, distance };
    }
    if (best && best.distance <= TURN_WINDOW_MS) best.turn.events.push(entry);
    else loose.push(entry);
  }

  for (const turn of turns) {
    turn.events.sort(
      (left, right) => Date.parse(left.at) - Date.parse(right.at),
    );
  }
  return { turns, loose };
}

/** Behavior decision carried in `snapshot.meta`, when a backend added it. */
function decisionFromMeta(meta: Record<string, unknown> | undefined): {
  intent: string;
  shouldReply: boolean;
  delaySec: number;
  source?: string;
  ignoreReason?: string;
} | null {
  if (!meta) return null;
  const raw = meta.behavior ?? meta.decision;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const intent = typeof row.intent === "string" ? row.intent : "";
  if (!intent) return null;
  const delay = Number(row.delaySec);
  const source = typeof row.source === "string" ? row.source : "";
  const ignoreReason =
    typeof row.ignoreReason === "string" ? row.ignoreReason : "";
  return {
    intent,
    shouldReply: row.shouldReply === true,
    delaySec: Number.isFinite(delay) && delay >= 0 ? Math.trunc(delay) : 0,
    ...(source ? { source } : {}),
    ...(ignoreReason ? { ignoreReason } : {}),
  };
}

/** One timeline row rendered as a compact line inside a turn card. */
function EventLine({ entry }: { entry: TurnEvent }) {
  const stamp = (
    <time
      dateTime={entry.at}
      title={formatSnapshotTime(entry.at)}
      className="shrink-0 font-mono text-[10px] text-zinc-600"
    >
      {relativeTime(entry.at)}
    </time>
  );

  if (entry.kind === "incoming") {
    return (
      <li className="flex items-start gap-1.5">
        <span className="shrink-0 rounded bg-sky-500/10 px-1 py-0.5 text-[10px] text-sky-300">
          он
        </span>
        <span className="min-w-0 flex-1 break-words text-[11px] text-zinc-300">
          {entry.text}
        </span>
        {stamp}
      </li>
    );
  }

  if (entry.kind === "reply") {
    return (
      <li className="flex items-start gap-1.5">
        <span className="shrink-0 rounded bg-emerald-500/10 px-1 py-0.5 text-[10px] text-emerald-300">
          она
        </span>
        <span className="min-w-0 flex-1 break-words text-[11px] text-zinc-300">
          {entry.text}
        </span>
        {entry.dryRun && <Pill tone="amber">dry-run</Pill>}
        {stamp}
      </li>
    );
  }

  if (entry.kind === "ignored") {
    return (
      <li className="flex items-start gap-1.5">
        <span className="shrink-0 rounded bg-zinc-800 px-1 py-0.5 text-[10px] text-zinc-400">
          игнор
        </span>
        <span className="min-w-0 flex-1 break-words text-[11px] italic text-zinc-500">
          {entry.reason || "без причины"}
        </span>
        {stamp}
      </li>
    );
  }

  const deltas = METRICS.filter(
    (metric) => (entry.delta[metric.key] ?? 0) !== 0,
  );
  const conflictMoved =
    entry.conflictTo !== undefined && entry.conflictTo !== entry.conflictFrom;
  return (
    <li className="flex flex-wrap items-center gap-1.5">
      <span className="shrink-0 rounded bg-violet-500/10 px-1 py-0.5 text-[10px] text-violet-300">
        отношения
      </span>
      {deltas.map((metric) => {
        const value = entry.delta[metric.key] ?? 0;
        return (
          <span
            key={metric.key}
            className={`text-[11px] ${
              value > 0 ? "text-emerald-300" : "text-red-300"
            }`}
          >
            {signed(value)} {metric.label}
          </span>
        );
      })}
      {entry.stageTo !== undefined && entry.stageFrom !== entry.stageTo && (
        <span className="text-[11px] text-zinc-400">
          стадия → {entry.stageTo}
        </span>
      )}
      {conflictMoved && (
        <span className="text-[11px] text-amber-300">
          конфликт {entry.conflictFrom ?? 0} → {entry.conflictTo}
        </span>
      )}
      <span className="ml-auto text-[10px] text-zinc-600">
        {SOURCE_LABELS[entry.source] ?? entry.source}
      </span>
      {stamp}
    </li>
  );
}

/**
 * «Трассировка» tab: the last turns of this chat in a technical view — model,
 * ids, token usage, prompt size and the timeline rows that belong to each
 * turn, plus the behavior decision Eve reports for the chat. Everything is
 * soft: a stopped Eve process or an old snapshot without a decision renders a
 * note, never an error page.
 */
export function ChatTraceTab({
  accountId,
  chatId,
  threadId,
}: {
  accountId: string;
  chatId: number;
  threadId: number;
}) {
  const chatIdText = String(chatId);
  const matches = useCachedResource<ChatPersonaMatch[]>(
    `eve-chat-matches:${accountId}:${chatIdText}:${threadId}`,
    () => resolveChatPersonas(accountId, chatIdText, threadId),
  );
  const active = matches.data?.[0] ?? null;
  const personaId = active?.persona.id ?? "";

  const [trace, setTrace] = useState<TraceState>(EMPTY_TRACE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (mode: "initial" | "refresh") => {
      if (!personaId) {
        setTrace(EMPTY_TRACE);
        setLoading(false);
        return;
      }
      if (mode === "refresh") setRefreshing(true);
      const [snapshotsResult, timelineResult, whyResult] =
        await Promise.allSettled([
          listContextSnapshots({
            personaId,
            accountId,
            chatId: chatIdText,
            limit: TRACE_SNAPSHOTS,
          }),
          getChatTimeline(personaId, accountId, chatIdText, {
            threadId,
            limit: TRACE_ENTRIES,
          }),
          getTurnWhy(personaId, accountId, chatIdText),
        ]);

      // A failed read keeps the previous value: the tab must not flicker while
      // one of the three sources is temporarily down.
      setTrace((previous) => ({
        snapshots:
          snapshotsResult.status === "fulfilled"
            ? snapshotsResult.value
            : previous.snapshots,
        entries:
          timelineResult.status === "fulfilled"
            ? timelineResult.value.entries
            : previous.entries,
        why: whyResult.status === "fulfilled" ? whyResult.value : previous.why,
      }));

      const failure =
        snapshotsResult.status === "rejected"
          ? snapshotsResult.reason
          : timelineResult.status === "rejected"
            ? timelineResult.reason
            : null;
      setError(failure ? eveErrorMessage(failure) : null);
      setLoading(false);
      setRefreshing(false);
    },
    [personaId, accountId, chatIdText, threadId],
  );

  // A new chat/persona starts from an empty trace instead of stale rows.
  useEffect(() => {
    setTrace(EMPTY_TRACE);
    setError(null);
    setLoading(true);
    void load("initial");
  }, [load]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void load("refresh");
    };
    const timer = window.setInterval(tick, TRACE_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  const { turns, loose } = useMemo(
    () => groupTraceTurns(trace.snapshots, trace.entries),
    [trace.snapshots, trace.entries],
  );

  if (matches.loading && !matches.data) {
    return (
      <PanelCard title="Трассировка">
        <RowsSkeleton rows={4} />
      </PanelCard>
    );
  }

  if (matches.error) {
    return (
      <PanelCard title="Трассировка">
        <TabError
          text={matches.error}
          onRetry={() => {
            matches.reload();
            void load("initial");
          }}
        />
      </PanelCard>
    );
  }

  if (!active) {
    return (
      <PanelCard title="Трассировка">
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

  const why = trace.why;
  const empty =
    trace.snapshots.length === 0 &&
    trace.entries.length === 0 &&
    !why?.decision;

  return (
    <div className="space-y-3">
      <TabHeader
        threadId={threadId}
        onRefresh={() => void load("refresh")}
        refreshing={refreshing}
      >
        <span className="text-[10px] text-zinc-500">
          авто {TRACE_POLL_MS / 1000} с
        </span>
      </TabHeader>

      {error && <TabError text={error} onRetry={() => void load("refresh")} />}

      {why && (
        <PanelCard
          title="Последнее решение поведения"
          hint={
            why.decision?.at
              ? `Eve · ${formatSnapshotTime(why.decision.at)}`
              : "Eve · /eve/v1/nest/why"
          }
        >
          {why.decision ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill tone={why.decision.shouldReply ? "green" : "zinc"}>
                {why.decision.intent}
              </Pill>
              <Pill tone={why.decision.shouldReply ? "green" : "amber"}>
                {why.decision.shouldReply ? "ответит" : "не ответит"}
              </Pill>
              <Pill tone={why.decision.delaySec === 0 ? "zinc" : "sky"}>
                delay {why.decision.delaySec} с
              </Pill>
              {why.decision.source && (
                <Pill tone="zinc">source {why.decision.source}</Pill>
              )}
              {why.decision.reaction && (
                <Pill tone="zinc">реакция {why.decision.reaction}</Pill>
              )}
              {why.decision.ignoreReason && (
                <span className="basis-full break-words text-[11px] text-amber-300">
                  причина: {why.decision.ignoreReason}
                </span>
              )}
            </div>
          ) : (
            <p className="break-words text-[11px] text-zinc-500">
              {why.error ||
                "Eve ещё не принимала решений по этому чату после запуска."}
            </p>
          )}
        </PanelCard>
      )}

      {empty ? (
        <PanelCard title="Ходы">
          <EmptyNote>Для этого чата ещё нет трассировки</EmptyNote>
        </PanelCard>
      ) : (
        <PanelCard
          title="Ходы"
          hint={`${trace.snapshots.length} снапшотов · ${trace.entries.length} событий хроники`}
        >
          {loading && trace.snapshots.length === 0 ? (
            <RowsSkeleton rows={3} />
          ) : (
            <ol className="space-y-2">
              {turns.map(({ snapshot, events }) => {
                const metaDecision = decisionFromMeta(snapshot.meta);
                const tokens = snapshot.tokens;
                return (
                  <li
                    key={snapshot.id}
                    className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className="font-mono text-[10px] text-zinc-400"
                        title={formatSnapshotTime(snapshot.createdAt)}
                      >
                        {relativeTime(snapshot.createdAt)}
                      </span>
                      <Pill tone="zinc">{snapshot.kind}</Pill>
                      {snapshot.dryRun && <Pill tone="red">dry-run</Pill>}
                      <span className="ml-auto max-w-[12rem] truncate font-mono text-[10px] text-zinc-500">
                        {snapshot.model || "модель не указана"}
                      </span>
                    </div>

                    <dl className="mt-1.5 grid grid-cols-2 gap-1 text-[10px] text-zinc-500">
                      <div className="min-w-0">
                        <dt className="uppercase tracking-wide">turn</dt>
                        <dd
                          className="truncate font-mono text-zinc-300"
                          title={snapshot.turnId ?? ""}
                        >
                          {snapshot.turnId || "—"}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="uppercase tracking-wide">токены</dt>
                        <dd className="font-mono text-zinc-300">
                          {tokens.input !== undefined
                            ? `in ${formatCount(tokens.input)}`
                            : "in —"}
                          {" · "}
                          {tokens.output !== undefined
                            ? `out ${formatCount(tokens.output)}`
                            : "out —"}
                          {tokens.total !== undefined
                            ? ` · всего ${formatCount(tokens.total)}`
                            : ""}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="uppercase tracking-wide">контекст</dt>
                        <dd className="font-mono text-zinc-300">
                          {formatCount(snapshot.system.length)} блоков ·{" "}
                          {formatCount(snapshot.messages.length)} сообщ.
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="uppercase tracking-wide">события</dt>
                        <dd className="font-mono text-zinc-300">
                          {events.length}
                        </dd>
                      </div>
                    </dl>

                    {metaDecision && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 border-t border-zinc-800/70 pt-1.5 text-[10px]">
                        <span className="text-zinc-500">meta:</span>
                        <span className="text-zinc-300">
                          {metaDecision.intent}
                        </span>
                        <span className="text-zinc-500">
                          {metaDecision.shouldReply ? "ответит" : "не ответит"}
                        </span>
                        <span className="text-zinc-500">
                          delay {metaDecision.delaySec} с
                        </span>
                        {metaDecision.source && (
                          <span className="text-zinc-500">
                            {metaDecision.source}
                          </span>
                        )}
                        {metaDecision.ignoreReason && (
                          <span className="text-amber-300">
                            {metaDecision.ignoreReason}
                          </span>
                        )}
                      </div>
                    )}

                    {events.length > 0 && (
                      <ul className="mt-1.5 space-y-1 border-t border-zinc-800/70 pt-1.5">
                        {events.map((entry) => (
                          <EventLine key={entry.id} entry={entry} />
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </PanelCard>
      )}

      {loose.length > 0 && (
        <PanelCard
          title="События вне ходов"
          hint="старше последних снапшотов или без подходящего turn'а"
        >
          <ul className="space-y-1">
            {[...loose]
              .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
              .map((entry) => (
                <EventLine key={entry.id} entry={entry} />
              ))}
          </ul>
        </PanelCard>
      )}
    </div>
  );
}
