"use client";

import { useCallback, useEffect, useState } from "react";
import {
  aiErrorMessage,
  type ChatAutomationsView,
  type ChatAutomationView,
  getChatAutomations,
  pauseChatAutomations,
  resumeAutomation,
  resumeChatAutomations,
  updateAutomation,
} from "../../lib/ai-api";
import {
  createdByLabel,
  formatInZone,
  triggerSchedule,
} from "../../lib/automations-format";

const SMALL_BUTTON =
  "rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:border-zinc-500 disabled:opacity-40";

/**
 * «Автоматизации» card of the chat info panel. Lists automations bound to this
 * chat (whole chat and threads), their schedule in the row's timezone, a
 * soul-created badge and pause/resume controls. Chat pause/resume use the
 * dedicated endpoints, single rows use PATCH / resume.
 */
export function ChatAutomationsSection({
  accountId,
  chatId,
}: {
  accountId: string;
  chatId: number;
}) {
  const [data, setData] = useState<ChatAutomationsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getChatAutomations(accountId, chatId));
    } catch (caught) {
      setError(aiErrorMessage(caught));
    } finally {
      setLoading(false);
    }
  }, [accountId, chatId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, request: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await request();
      await load();
    } catch (caught) {
      setError(aiErrorMessage(caught));
    } finally {
      setBusy(null);
    }
  };

  const pauseAll = () =>
    run("chat:pause", () => pauseChatAutomations(accountId, chatId));
  const resumeAll = () =>
    run("chat:resume", () => resumeChatAutomations(accountId, chatId));

  const pauseRow = (row: ChatAutomationView) =>
    run(`row:${row.id}`, () => updateAutomation(row.id, { enabled: false }));

  const resumeRow = (row: ChatAutomationView) =>
    run(`row:${row.id}`, () =>
      row.selfPaused
        ? resumeAutomation(row.id)
        : updateAutomation(row.id, { enabled: true }),
    );

  const summary = data?.summary;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
            <span aria-hidden="true">⏱</span>
            Автоматизации
          </h4>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            {summary
              ? `Активно: ${summary.active} · на паузе: ${summary.paused}` +
                (summary.nextDueAt
                  ? ` · ближайший: ${formatInZone(
                      summary.nextDueAt,
                      data?.automations.find(
                        (item) => item.nextDueAt === summary.nextDueAt,
                      )?.timezone,
                    )}`
                  : " · ближайших запусков нет")
              : "Правила, привязанные к этому чату"}
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <button
            type="button"
            disabled={busy !== null || (summary?.active ?? 0) === 0}
            onClick={() => void pauseAll()}
            title="Приостановить все автоматизации этого чата"
            className={SMALL_BUTTON}
          >
            {busy === "chat:pause" ? "…" : "Пауза"}
          </button>
          <button
            type="button"
            disabled={busy !== null || (summary?.paused ?? 0) === 0}
            onClick={() => void resumeAll()}
            title="Снять паузу души со всех автоматизаций этого чата"
            className={SMALL_BUTTON}
          >
            {busy === "chat:resume" ? "…" : "Возобновить"}
          </button>
        </div>
      </div>

      {loading && !data && (
        <p className="mt-3 text-xs text-zinc-500">Загрузка автоматизаций…</p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[11px] text-red-300">
          {error}
        </p>
      )}

      {data && data.automations.length === 0 && (
        <p className="mt-3 rounded-lg border border-dashed border-zinc-800 px-2 py-2 text-[11px] text-zinc-500">
          У этого чата нет автоматизаций. Попросите душу, например: «Напоминай
          мне каждый день в 9:00 проверить сообщения» — правило появится здесь.
        </p>
      )}

      <div className="mt-2 space-y-1.5">
        {data?.automations.map((row) => {
          const active = row.enabled && !row.selfPaused;
          return (
            <div
              key={row.id}
              className={`rounded-lg border px-2 py-1.5 ${
                row.selfPaused
                  ? "border-amber-800/60 bg-amber-950/20"
                  : "border-zinc-800 bg-black/20"
              }`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-200">
                  {row.name}
                </span>
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${
                    active
                      ? "bg-emerald-500/15 text-emerald-300"
                      : "bg-zinc-800 text-zinc-400"
                  }`}
                >
                  {row.selfPaused
                    ? "на паузе душой"
                    : row.enabled
                      ? "включена"
                      : "выключена"}
                </span>
                {row.createdBy === "soul" && (
                  <span className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-300">
                    создано душой
                  </span>
                )}
              </div>
              <p className="mt-0.5 truncate text-[11px] text-zinc-400">
                {triggerSchedule(row)} ·{" "}
                <span className="text-zinc-500">
                  следующий: {formatInZone(row.nextDueAt, row.timezone)}
                </span>
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {row.threadId > 0 && (
                  <span className="text-[10px] text-zinc-500">
                    тред #{row.threadId}
                  </span>
                )}
                <span className="text-[10px] text-zinc-500">
                  {createdByLabel(row.createdBy)}
                </span>
                {row.lastRunStatus && row.lastRunStatus !== "ok" && (
                  <span
                    className="text-[10px] text-red-300"
                    title={row.lastRunError ?? undefined}
                  >
                    последний запуск: {row.lastRunStatus}
                  </span>
                )}
                <span className="ml-auto flex gap-1">
                  {active ? (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void pauseRow(row)}
                      className={SMALL_BUTTON}
                    >
                      {busy === `row:${row.id}` ? "…" : "Пауза"}
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => void resumeRow(row)}
                      className={SMALL_BUTTON}
                    >
                      {busy === `row:${row.id}` ? "…" : "Возобновить"}
                    </button>
                  )}
                </span>
              </div>
              {row.selfPaused && row.selfPauseReason && (
                <p className="mt-1 text-[10px] text-amber-200/80">
                  Причина: {row.selfPauseReason}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
