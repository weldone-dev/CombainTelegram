"use client";

import { useEffect, useState } from "react";
import { listSouls, type SoulView } from "../../lib/ai-api";
import { errorMessage } from "../../lib/api";
import { useAiAccess } from "./ai-access-store";

/** Matches the API default (`AI_BLOCK_AFTER_WARNINGS`). */
const WARNINGS_TO_BLOCK = 3;

function warningsWord(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "предупреждение";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "предупреждения";
  }
  return "предупреждений";
}

/**
 * Full AI permission editor. Used in the chat info panel (whole chat) and in
 * the comment drawer, where the same controls can target the open thread
 * (`threadId` = channel post id) or the whole chat.
 */
export function AiAccessSection({
  accountId,
  chatId,
  threadId = 0,
  threadLabel,
  allowWholeChat = false,
}: {
  accountId: string;
  chatId: number;
  threadId?: number;
  threadLabel?: string;
  allowWholeChat?: boolean;
}) {
  const {
    viewFor,
    ensureView,
    setAccess,
    block,
    unblock,
    warn,
    busyFor,
    error,
    clearError,
  } = useAiAccess();
  const [scope, setScope] = useState<"chat" | "thread">(
    threadId > 0 && allowWholeChat ? "thread" : "chat",
  );
  const [souls, setSouls] = useState<SoulView[] | null>(null);
  const [soulsError, setSoulsError] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [loadingView, setLoadingView] = useState(true);

  const activeThread = scope === "thread" ? threadId : 0;
  const busy = busyFor(chatId, activeThread);
  const view = viewFor(chatId, activeThread);

  useEffect(() => {
    setScope(threadId > 0 && allowWholeChat ? "thread" : "chat");
  }, [threadId, allowWholeChat]);

  useEffect(() => {
    let active = true;
    setLoadingView(true);
    void ensureView(chatId, activeThread).finally(() => {
      if (active) setLoadingView(false);
    });
    return () => {
      active = false;
    };
  }, [chatId, activeThread, ensureView]);

  useEffect(() => {
    let active = true;
    listSouls()
      .then((result) => {
        if (!active) return;
        setSouls(result.souls.filter((soul) => soul.accountId === accountId));
      })
      .catch((caught: unknown) => {
        if (active) setSoulsError(errorMessage(caught));
      });
    return () => {
      active = false;
    };
  }, [accountId]);

  // Keep the note editor in sync with the stored value, but let the user type.
  useEffect(() => {
    setNoteDraft(view?.note ?? "");
  }, [view?.note]);

  const allowed = view?.allowed ?? false;
  const blocked = view?.blocked ?? false;
  const warnings = view?.warnings ?? 0;
  const scopeLabel = activeThread > 0 ? `тред #${activeThread}` : "весь чат";

  const saveNote = () => {
    if (!view || noteDraft.trim() === (view.note ?? "")) return;
    clearError();
    void setAccess(chatId, {
      note: noteDraft.trim() || null,
      threadId: activeThread,
    });
  };

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/50 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
            <span aria-hidden="true" className="text-sky-400">
              ✦
            </span>
            Доступ ИИ
          </h4>
          <p className="mt-0.5 text-[11px] text-zinc-500">
            Правило: {scopeLabel}
            {threadLabel && activeThread > 0 ? ` · ${threadLabel}` : ""}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${
            blocked
              ? "border-red-700/80 bg-red-950/50 text-red-200"
              : allowed
                ? "border-emerald-700/70 bg-emerald-950/40 text-emerald-200"
                : "border-zinc-700 text-zinc-400"
          }`}
        >
          {blocked ? "Заблокирован" : allowed ? "Отвечает" : "Выключен"}
        </span>
      </div>

      {allowWholeChat && threadId > 0 && (
        <div className="mt-2 flex gap-1">
          <button
            type="button"
            onClick={() => setScope("thread")}
            aria-pressed={scope === "thread"}
            className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
              scope === "thread"
                ? "border-sky-500/60 bg-sky-500/15 text-sky-300"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
            }`}
          >
            Тред #{threadId}
          </button>
          <button
            type="button"
            onClick={() => setScope("chat")}
            aria-pressed={scope === "chat"}
            className={`rounded-md border px-2 py-1 text-[11px] transition-colors ${
              scope === "chat"
                ? "border-sky-500/60 bg-sky-500/15 text-sky-300"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
            }`}
          >
            Весь чат
          </button>
        </div>
      )}

      {loadingView && !view ? (
        <p className="mt-3 text-xs text-zinc-500">Загрузка доступа…</p>
      ) : (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || blocked}
              onClick={() => {
                clearError();
                void setAccess(chatId, {
                  enabled: !allowed,
                  threadId: activeThread,
                });
              }}
              title={
                blocked
                  ? "Сначала разблокируйте ИИ"
                  : allowed
                    ? "Запретить ИИ в этом чате"
                    : "Разрешить ИИ в этом чате"
              }
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
                allowed
                  ? "border border-zinc-700 text-zinc-200 hover:border-zinc-500"
                  : "bg-sky-600 text-white hover:bg-sky-500"
              }`}
            >
              {busy ? "…" : allowed ? "Выключить ИИ" : "Включить ИИ"}
            </button>
            <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-zinc-500">
              <span className="shrink-0">Соул</span>
              <select
                value={view?.soulId ?? ""}
                disabled={busy || souls === null || souls.length === 0}
                onChange={(event) => {
                  clearError();
                  void setAccess(chatId, {
                    soulId: event.target.value || null,
                    threadId: activeThread,
                  });
                }}
                aria-label="Соул для этого чата"
                title="Какая душа отвечает в этом чате"
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-1.5 py-1 text-[11px] text-zinc-200 outline-none focus:border-sky-500 disabled:opacity-50"
              >
                <option value="">
                  {souls === null
                    ? "Загрузка…"
                    : souls.length === 0
                      ? "Нет соулов"
                      : "По умолчанию"}
                </option>
                {(souls ?? []).map((soul) => (
                  <option key={soul.id} value={soul.id}>
                    {soul.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {soulsError && (
            <p className="text-[11px] text-red-300">
              Не удалось загрузить соулов: {soulsError}
            </p>
          )}

          <div>
            <label
              htmlFor={`ai-note-${chatId}-${activeThread}`}
              className="mb-1 block text-[11px] font-medium text-zinc-500"
            >
              Заметка
            </label>
            <div className="flex gap-1.5">
              <input
                id={`ai-note-${chatId}-${activeThread}`}
                value={noteDraft}
                onChange={(event) => setNoteDraft(event.target.value)}
                placeholder="Почему ИИ разрешён или выключен"
                maxLength={1000}
                className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                autoComplete="off"
              />
              <button
                type="button"
                disabled={
                  busy || !view || noteDraft.trim() === (view.note ?? "").trim()
                }
                onClick={saveNote}
                title="Сохранить заметку"
                className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:border-zinc-500 disabled:opacity-40"
              >
                Сохранить
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-black/20 px-2 py-1.5">
            <span className="text-[11px] text-zinc-400">
              Предупреждения: <span className="text-zinc-200">{warnings}</span>{" "}
              <span className="text-zinc-500">
                / {WARNINGS_TO_BLOCK} · {warningsWord(warnings)}
              </span>
            </span>
            <button
              type="button"
              disabled={busy || blocked}
              onClick={() => {
                clearError();
                void warn(chatId, { threadId: activeThread });
              }}
              title={
                blocked
                  ? "Чат уже заблокирован"
                  : `Предупредить ИИ (автоблокировка после ${WARNINGS_TO_BLOCK})`
              }
              className="rounded border border-amber-800/70 px-2 py-1 text-[11px] text-amber-200 transition-colors hover:bg-amber-950/40 disabled:opacity-40"
            >
              Предупредить
            </button>
          </div>

          {blocked ? (
            <div className="space-y-1.5 rounded-lg border border-red-900/60 bg-red-950/25 px-2 py-2">
              <p className="text-[11px] text-red-200">
                Заблокирован{warnings > 0 ? ` · ${warnings} предупр.` : ""}
                {view?.reason ? ` · ${view.reason}` : ""}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  clearError();
                  void unblock(chatId, activeThread);
                }}
                className="rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
              >
                {busy ? "…" : "Разблокировать"}
              </button>
            </div>
          ) : (
            <div className="space-y-1.5">
              <div className="flex gap-1.5">
                <input
                  value={blockReason}
                  onChange={(event) => setBlockReason(event.target.value)}
                  placeholder="Причина блокировки (необязательно)"
                  aria-label="Причина блокировки ИИ"
                  maxLength={1000}
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-red-500 focus:outline-none"
                  autoComplete="off"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    clearError();
                    void block(chatId, {
                      reason: blockReason.trim() || null,
                      threadId: activeThread,
                    }).then((result) => {
                      if (result) setBlockReason("");
                    });
                  }}
                  className="shrink-0 rounded border border-red-800/80 px-2 py-1 text-[11px] text-red-200 transition-colors hover:bg-red-950/50 disabled:opacity-40"
                >
                  {busy ? "…" : "Заблокировать"}
                </button>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="text-[11px] text-red-300">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
