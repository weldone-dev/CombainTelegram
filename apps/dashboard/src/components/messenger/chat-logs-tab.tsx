"use client";

import Link from "next/link";
import { useState } from "react";
import { getChatLogs } from "../../lib/chat-logs-api";
import type { LogEntryView, LogLevel } from "../../lib/types";
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

const LEVEL_OPTIONS: Array<{ value: "" | LogLevel; label: string }> = [
  { value: "", label: "Все уровни" },
  { value: "error", label: "Ошибки" },
  { value: "warn", label: "Предупреждения" },
  { value: "info", label: "Информация" },
  { value: "debug", label: "Отладка" },
];

const LEVEL_STYLES: Record<LogLevel, string> = {
  debug: "bg-zinc-700 text-zinc-300",
  info: "bg-sky-500/20 text-sky-300",
  warn: "bg-amber-500/20 text-amber-300",
  error: "bg-red-500/20 text-red-300",
};

function logsHref(
  accountId: string,
  chatId: number,
  level: "" | LogLevel,
): string {
  const params = new URLSearchParams({
    accountId,
    chatId: String(chatId),
  });
  if (level) params.set("level", level);
  return `/logs?${params.toString()}`;
}

/**
 * «Логи» tab: structured entries of this account/chat with a level filter and
 * a deep link into the full journal prefiltered by the same scope.
 */
export function ChatLogsTab({
  accountId,
  chatId,
  threadId,
}: {
  accountId: string;
  chatId: number;
  threadId: number;
}) {
  const [level, setLevel] = useState<"" | LogLevel>("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const logs = useCachedResource(
    `chat-logs:${accountId}:${chatId}:${level}`,
    () => getChatLogs(accountId, chatId, { level, limit: 50 }),
  );

  const entries = logs.data?.entries ?? [];

  return (
    <div className="space-y-4">
      <TabHeader
        threadId={threadId}
        onRefresh={logs.reload}
        refreshing={logs.loading}
      >
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
          <span className="sr-only">Уровень логов</span>
          <select
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as "" | LogLevel);
              setExpandedId(null);
            }}
            aria-label="Уровень логов"
            title="Показывать только выбранный уровень"
            autoComplete="off"
            className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200 outline-none focus:border-sky-500"
          >
            {LEVEL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </TabHeader>

      <PanelCard
        title="Журнал чата"
        hint="HTTP-действия, сообщения и ошибки Telegram по этому чату"
        actions={
          <Link
            href={logsHref(accountId, chatId, level)}
            title="Открыть полный журнал с фильтром по этому чату"
            className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-sky-300 transition-colors hover:border-zinc-500"
          >
            Все логи →
          </Link>
        }
      >
        <div className="mt-2 space-y-1.5">
          {logs.loading && !logs.data && <RowsSkeleton rows={5} />}
          {logs.error && <TabError text={logs.error} onRetry={logs.reload} />}
          {logs.data && entries.length === 0 && (
            <EmptyNote>
              Для этого чата логов пока нет. Записи появятся после обмена
              сообщениями или запросов ИИ.
            </EmptyNote>
          )}
          {entries.map((entry) => (
            <LogRow
              key={entry.id}
              entry={entry}
              expanded={expandedId === entry.id}
              onToggle={() =>
                setExpandedId((current) =>
                  current === entry.id ? null : entry.id,
                )
              }
            />
          ))}
        </div>

        {logs.data && entries.length > 0 && (
          <p className="mt-2 flex items-center gap-2 text-[10px] text-zinc-600">
            <span>Показаны последние {entries.length} записей.</span>
            <button
              type="button"
              onClick={logs.reload}
              disabled={logs.loading}
              className={SMALL_BUTTON}
            >
              {logs.loading ? "…" : "Обновить"}
            </button>
          </p>
        )}
      </PanelCard>
    </div>
  );
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: LogEntryView;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-black/20">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        title={expanded ? "Свернуть запись" : "Показать детали записи"}
        className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-zinc-800/40"
      >
        <span className="w-20 shrink-0 text-[10px] text-zinc-500">
          {formatStamp(entry.createdAt)}
        </span>
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase ${LEVEL_STYLES[entry.level]}`}
        >
          {entry.level}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-[11px] text-zinc-300">
            {entry.action}
            {entry.errorCode ? ` · ${entry.errorCode}` : ""}
          </span>
          <span className="mt-0.5 line-clamp-2 break-words text-[11px] text-zinc-400">
            {entry.message}
          </span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-[10px] text-zinc-600">
          {expanded ? "▴" : "▾"}
        </span>
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-zinc-800 bg-zinc-950/60 px-2 py-2">
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-zinc-500">
            <span>source: {entry.source}</span>
            <span>status: {entry.status ?? "—"}</span>
            {entry.durationMs !== null && <span>{entry.durationMs} мс</span>}
            {entry.requestId && (
              <span className="truncate">request: {entry.requestId}</span>
            )}
            {entry.telegramMethod && <span>tg: {entry.telegramMethod}</span>}
            {entry.telegramError && (
              <span className="text-red-300">
                ошибка: {entry.telegramError}
              </span>
            )}
          </div>

          {entry.telegramResponse !== null && (
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                Ответ Telegram
              </p>
              <pre className="max-h-48 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-[10px] leading-relaxed text-amber-200">
                {JSON.stringify(entry.telegramResponse, null, 2)}
              </pre>
            </div>
          )}

          <div>
            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Детали
            </p>
            <pre className="max-h-56 overflow-auto rounded border border-zinc-800 bg-zinc-900 p-2 font-mono text-[10px] leading-relaxed text-zinc-300">
              {JSON.stringify(entry.details, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
