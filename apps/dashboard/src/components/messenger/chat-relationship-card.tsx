"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { ApiError } from "../../lib/api";
import {
  type EveConflictView,
  type EveRelationshipView,
  eveErrorMessage,
  getConflict,
  getRelationship,
} from "../../lib/eve-api";
import {
  type ChatPersonaMatch,
  resolveChatPersonas,
} from "../../lib/eve-chat-personas";
import {
  hasReflectNotes,
  parseRelationshipNotes,
} from "../../lib/eve-relationship-notes";
import { eveStageLabel } from "../../lib/eve-stages";
import { Pill } from "../dashboard/ai-ui";
import { BipolarMetric } from "../dashboard/bipolar-metric";
import {
  EmptyNote,
  formatStamp,
  PanelCard,
  RowsSkeleton,
  SMALL_BUTTON,
  TabError,
  useCachedResource,
} from "./chat-tab-ui";

/** Relationship + conflict pair of the selected persona for this chat. */
interface ChatState {
  relationship: EveRelationshipView | null;
  conflict: EveConflictView | null;
  /** `true` when Nest answered 404: the relationship row was never created. */
  relationshipMissing: boolean;
  /** Conflict failed while the relationship loaded; shown inline. */
  conflictError: string | null;
}

const EMPTY_STATE: ChatState = {
  relationship: null,
  conflict: null,
  relationshipMissing: false,
  conflictError: null,
};

const METRICS = [
  { key: "interest", label: "Интерес" },
  { key: "trust", label: "Доверие" },
  { key: "attraction", label: "Влечение" },
  { key: "annoyance", label: "Раздражение" },
  { key: "cringe", label: "Кринж" },
] as const;

function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

async function loadChatState(
  personaId: string,
  accountId: string,
  chatId: string,
): Promise<ChatState> {
  if (!personaId) return EMPTY_STATE;

  const [relationshipResult, conflictResult] = await Promise.allSettled([
    getRelationship(personaId, accountId, chatId),
    getConflict(personaId, accountId, chatId),
  ]);

  if (relationshipResult.status === "rejected") {
    if (isNotFound(relationshipResult.reason)) {
      return { ...EMPTY_STATE, relationshipMissing: true };
    }
    throw new Error(eveErrorMessage(relationshipResult.reason));
  }

  let conflict: EveConflictView | null = null;
  let conflictError: string | null = null;
  if (conflictResult.status === "fulfilled") {
    conflict = conflictResult.value;
  } else if (!isNotFound(conflictResult.reason)) {
    conflictError = eveErrorMessage(conflictResult.reason);
  }

  return {
    relationship: relationshipResult.value,
    conflict,
    relationshipMissing: false,
    conflictError,
  };
}

function conflictTone(level: number): "green" | "amber" | "red" {
  if (level <= 0) return "green";
  if (level === 1) return "amber";
  return "red";
}

function coldActive(coldUntil: string | null): boolean {
  if (!coldUntil) return false;
  const time = new Date(coldUntil).getTime();
  return Number.isFinite(time) && time > Date.now();
}

const NOTES_PREVIEW = 3;

/**
 * `notes` block of the relationship card. Reflect lines (`[reflect YYYY-MM-DD]`)
 * become buttons that jump to the persona memory of that day; legacy free-form
 * lines stay plain text. Long lists collapse to {@link NOTES_PREVIEW} rows.
 */
function RelationshipNotes({
  notes,
  onOpenMemory,
}: {
  notes: string;
  onOpenMemory?: (date: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const lines = useMemo(() => parseRelationshipNotes(notes), [notes]);

  if (!hasReflectNotes(lines)) {
    return (
      <p
        title={notes}
        className="mt-3 line-clamp-4 whitespace-pre-wrap break-words text-[11px] text-zinc-400"
      >
        {notes}
      </p>
    );
  }

  const collapsible = lines.length > NOTES_PREVIEW;
  const visible =
    collapsible && !expanded ? lines.slice(0, NOTES_PREVIEW) : lines;

  return (
    <div className="mt-3">
      <ul
        className={`space-y-1 ${
          collapsible && expanded ? "max-h-48 overflow-y-auto pr-1" : ""
        }`}
      >
        {visible.map((line, index) => {
          const date = line.date;
          return (
            <li key={`${date ?? "note"}:${index}`}>
              {date && onOpenMemory ? (
                <button
                  type="button"
                  onClick={() => onOpenMemory(date)}
                  title={`Открыть память за ${date}`}
                  className="group flex w-full items-start gap-1.5 rounded-md border border-zinc-800/80 bg-zinc-900/60 px-1.5 py-1 text-left transition-colors hover:border-sky-700 hover:bg-sky-500/10 focus-visible:border-sky-500 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/50"
                >
                  <span className="shrink-0 rounded bg-sky-500/10 px-1 py-0.5 font-mono text-[10px] leading-4 text-sky-300">
                    {date}
                  </span>
                  <span className="line-clamp-2 min-w-0 flex-1 break-words text-[11px] leading-4 text-zinc-300 group-hover:text-zinc-100">
                    {line.text || "без текста"}
                  </span>
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-[10px] leading-4 text-zinc-600 transition-colors group-hover:text-sky-300"
                  >
                    →
                  </span>
                </button>
              ) : (
                <div className="flex w-full items-start gap-1.5 px-1.5 py-1">
                  {date && (
                    <span className="shrink-0 rounded bg-zinc-800 px-1 py-0.5 font-mono text-[10px] leading-4 text-zinc-400">
                      {date}
                    </span>
                  )}
                  <span className="line-clamp-2 min-w-0 flex-1 break-words text-[11px] leading-4 text-zinc-400">
                    {line.text || "без текста"}
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          title={expanded ? "Свернуть заметки" : "Показать все заметки"}
          className="mt-1 text-[10px] text-sky-400 transition-colors hover:text-sky-300"
        >
          {expanded ? "Свернуть" : `Показать все (${lines.length})`}
        </button>
      )}
    </div>
  );
}

/**
 * «Отношения» card of the chat info drawer: the Eve persona that owns this chat,
 * its current stage and the five relationship metrics. Read-only: the values are
 * written by Eve turns, the user only refreshes them.
 */
export function ChatRelationshipCard({
  accountId,
  chatId,
  threadId = 0,
  onOpenPersona,
  onOpenMemory,
}: {
  accountId: string;
  /** Prisma `BigInt` may arrive as a number or a string. */
  chatId: number | string | bigint;
  threadId?: number;
  onOpenPersona?: (personaId: string) => void;
  /** Reflect note clicked: open the «Память» tab focused on this day. */
  onOpenMemory?: (date: string) => void;
}) {
  const chatIdText = String(chatId);
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
  const state = useCachedResource<ChatState>(
    `eve-chat-state:${personaId}:${accountId}:${chatIdText}`,
    () => loadChatState(personaId, accountId, chatIdText),
  );

  const refresh = () => {
    matches.reload();
    state.reload();
  };

  if (matches.loading && !matches.data) {
    return (
      <PanelCard title="Отношения Eve">
        <RowsSkeleton rows={3} />
      </PanelCard>
    );
  }

  if (matches.error) {
    return (
      <PanelCard title="Отношения Eve">
        <TabError text={matches.error} onRetry={refresh} />
      </PanelCard>
    );
  }

  if (!active) {
    return (
      <PanelCard title="Отношения Eve">
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

  const relationship = state.data?.relationship ?? null;
  const conflict = state.data?.conflict ?? null;
  const stage = relationship?.stage ?? "";
  const stageLabel = stage ? eveStageLabel(stage) : "";
  const cold = conflict ? coldActive(conflict.coldUntil) : false;

  return (
    <PanelCard
      title="Отношения Eve"
      hint={
        onOpenPersona ? (
          <button
            type="button"
            onClick={() => onOpenPersona(active.persona.id)}
            title="Открыть персону в Eve"
            className="text-left text-sky-400 transition-colors hover:text-sky-300"
          >
            {active.persona.name} · открыть в Eve
          </button>
        ) : (
          <Link
            href="/eve"
            className="text-sky-400 transition-colors hover:text-sky-300"
          >
            {active.persona.name} · Eve →
          </Link>
        )
      }
      actions={
        <button
          type="button"
          onClick={refresh}
          disabled={state.loading}
          title="Обновить отношения"
          className={SMALL_BUTTON}
        >
          {state.loading ? "…" : "Обновить"}
        </button>
      }
    >
      {list.length > 1 && (
        <label className="mb-3 block text-[10px] text-zinc-500">
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

      {state.loading && !state.data && <RowsSkeleton rows={5} />}
      {state.error && <TabError text={state.error} onRetry={state.reload} />}

      {state.data && !state.data.relationship && (
        <EmptyNote>
          {state.data.relationshipMissing
            ? "Отношения ещё не созданы: записи нет (404)."
            : "Отношения ещё не созданы: первое входящее создаст запись."}
        </EmptyNote>
      )}

      {relationship && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <Pill tone="sky">{stageLabel}</Pill>
            <span className="font-mono text-[10px] text-zinc-500">{stage}</span>
            <span className="ml-auto text-[10px] text-zinc-600">
              обновлено {formatStamp(relationship.updatedAt)}
            </span>
          </div>

          <div className="mt-3 space-y-2">
            {METRICS.map((metric) => (
              <BipolarMetric
                key={metric.key}
                label={metric.label}
                value={relationship[metric.key]}
              />
            ))}
          </div>

          {relationship.notes.trim() && (
            <RelationshipNotes
              notes={relationship.notes}
              onOpenMemory={onOpenMemory}
            />
          )}
        </>
      )}

      <div className="mt-3 border-t border-zinc-800 pt-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-600">
            Конфликт
          </span>
          {conflict ? (
            <Pill tone={conflictTone(conflict.level)}>
              уровень {conflict.level}
            </Pill>
          ) : (
            !state.data?.conflictError &&
            state.data?.relationship && (
              <span className="text-[11px] text-zinc-500">нет записи</span>
            )
          )}
          {cold && <Pill tone="red">холод активен</Pill>}
        </div>
        {conflict?.coldUntil && (
          <p className="mt-1 text-[11px] text-zinc-400">
            Холод до {formatStamp(conflict.coldUntil)}
            {cold ? "" : " (уже истёк)"}
          </p>
        )}
        {state.data?.conflictError && (
          <p role="alert" className="mt-1 text-[11px] text-red-300">
            {state.data.conflictError}
          </p>
        )}
      </div>
    </PanelCard>
  );
}
