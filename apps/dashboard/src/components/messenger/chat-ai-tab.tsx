"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { type AiAccessView, getAiAccess } from "../../lib/ai-access-api";
import { listSouls, type SoulView } from "../../lib/ai-api";
import { errorMessage } from "../../lib/api";
import { useAiAccess } from "./ai-access-store";
import {
  type AiChatEventKind,
  type AiChatEventView,
  clearAiChatWarnings,
  getAccountAiSettings,
  getAiChatEvents,
} from "./chat-ai-api";
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
import { ChatTypingOverride } from "./chat-typing-override";

/** Matches the API default (`AI_BLOCK_AFTER_WARNINGS`). */
const WARNINGS_TO_BLOCK = 3;
const MAX_TEXT = 1000;

const EVENT_KINDS: Record<AiChatEventKind, { label: string; tone: string }> = {
  warning: {
    label: "Предупреждение",
    tone: "border-amber-800/60 bg-amber-950/20",
  },
  block: { label: "Блокировка", tone: "border-red-900/60 bg-red-950/25" },
  unblock: {
    label: "Разблокировка",
    tone: "border-emerald-800/60 bg-emerald-950/20",
  },
  clear: { label: "Сброс", tone: "border-sky-800/60 bg-sky-950/20" },
  access: { label: "Доступ", tone: "border-zinc-800 bg-black/20" },
};

const EVENT_BADGES: Record<AiChatEventKind, string> = {
  warning: "bg-amber-500/15 text-amber-300",
  block: "bg-red-500/15 text-red-300",
  unblock: "bg-emerald-500/15 text-emerald-300",
  clear: "bg-sky-500/15 text-sky-300",
  access: "bg-zinc-800 text-zinc-400",
};

/** API-side event reasons are stable English tokens; the panel is Russian. */
const EVENT_REASONS: Record<string, string> = {
  "warnings cleared": "предупреждения сброшены",
  enabled: "доступ включён",
  disabled: "доступ выключен",
  removed: "доступ сброшен",
};

function reasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  return EVENT_REASONS[reason] ?? reason;
}

function actorLabel(view: AiChatEventView): string {
  if (view.actor === "soul") return "душа";
  if (view.actor === "system") return "система";
  return "я";
}

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
 * «Доступ ИИ» tab: the permission editor of one chat/topic, its audit history
 * and a compact read-only view of the account-wide permission deltas.
 */
export function ChatAiTab({
  accountId,
  chatId,
  threadId,
}: {
  accountId: string;
  chatId: number;
  threadId: number;
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
    reload,
  } = useAiAccess();
  // The store's account-wide list drops warning-only rows, so the counter of a
  // chat outside a block must be re-read from its own endpoint.
  const [view, setView] = useState<AiAccessView | null>(
    () => viewFor(chatId, threadId) ?? null,
  );
  const [souls, setSouls] = useState<SoulView[] | null>(null);
  const [soulsError, setSoulsError] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [warnReason, setWarnReason] = useState("");
  const [clearing, setClearing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const busy = busyFor(chatId, threadId);
  const scopeLabel = threadId > 0 ? `тред #${threadId}` : "весь чат";

  const events = useCachedResource(
    `chat-events:${accountId}:${chatId}:${threadId}`,
    () => getAiChatEvents(accountId, chatId, threadId, 50),
  );
  const settings = useCachedResource(`account-ai-settings:${accountId}`, () =>
    getAccountAiSettings(accountId),
  );

  const refreshView = useCallback(async () => {
    try {
      setView(await getAiAccess(accountId, chatId, threadId));
    } catch {
      // Keep the last known state; the action errors show up inline.
    }
  }, [accountId, chatId, threadId]);

  useEffect(() => {
    void ensureView(chatId, threadId);
    void refreshView();
  }, [chatId, threadId, ensureView, refreshView]);

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

  const saveNote = () => {
    if (!view || noteDraft.trim() === (view.note ?? "").trim()) return;
    clearError();
    setLocalError(null);
    void setAccess(chatId, {
      note: noteDraft.trim() || null,
      threadId,
    }).then((result) => {
      if (!result) return;
      setView(result);
      events.reload();
    });
  };

  const submitWarning = async () => {
    clearError();
    setLocalError(null);
    const result = await warn(chatId, {
      reason: warnReason.trim() || null,
      threadId,
    });
    if (!result) return;
    setWarnReason("");
    setView((previous) =>
      previous
        ? {
            ...previous,
            warnings: result.warnings,
            blocked: result.blocked,
            allowed: result.blocked ? false : previous.allowed,
          }
        : previous,
    );
    events.reload();
  };

  const clearWarnings = async () => {
    setClearing(true);
    setLocalError(null);
    try {
      await clearAiChatWarnings(accountId, chatId, threadId);
      // The counter lives in the account-wide store as well; re-read it once.
      await refreshView();
      reload();
      events.reload();
    } catch (caught) {
      setLocalError(errorMessage(caught));
    } finally {
      setClearing(false);
    }
  };

  const overrideCount = settings.data
    ? Object.values(settings.data.permissions).filter(
        (value) => typeof value === "boolean",
      ).length
    : 0;

  return (
    <div className="space-y-4">
      <TabHeader
        threadId={threadId}
        onRefresh={() => {
          void refreshView();
          events.reload();
          settings.reload();
        }}
        refreshing={events.loading}
      />

      <PanelCard
        title={
          <>
            <span aria-hidden="true" className="text-sky-400">
              ✦
            </span>
            Доступ ИИ
          </>
        }
        hint={`Правило: ${scopeLabel}`}
        badge={
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
        }
      >
        {!view ? (
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
                    threadId,
                  }).then((result) => {
                    if (!result) return;
                    setView(result);
                    events.reload();
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
                  value={view.soulId ?? ""}
                  disabled={busy || souls === null || souls.length === 0}
                  onChange={(event) => {
                    clearError();
                    void setAccess(chatId, {
                      soulId: event.target.value || null,
                      threadId,
                    }).then((result) => {
                      if (!result) return;
                      setView(result);
                      events.reload();
                    });
                  }}
                  aria-label="Соул для этого чата"
                  title="Какая душа отвечает в этом чате"
                  autoComplete="off"
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
                htmlFor={`ai-note-${accountId}-${chatId}-${threadId}`}
                className="mb-1 block text-[11px] font-medium text-zinc-500"
              >
                Заметка
              </label>
              <div className="flex gap-1.5">
                <input
                  id={`ai-note-${accountId}-${chatId}-${threadId}`}
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  placeholder="Почему ИИ разрешён или выключен"
                  maxLength={MAX_TEXT}
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={
                    busy || noteDraft.trim() === (view.note ?? "").trim()
                  }
                  onClick={saveNote}
                  title="Сохранить заметку"
                  className="shrink-0 rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:border-zinc-500 disabled:opacity-40"
                >
                  Сохранить
                </button>
              </div>
            </div>

            <div className="rounded-lg bg-black/20 px-2 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-[11px] text-zinc-400">
                  Предупреждения:{" "}
                  <span className="text-zinc-200">{warnings}</span>{" "}
                  <span className="text-zinc-500">
                    / {WARNINGS_TO_BLOCK} · {warningsWord(warnings)}
                  </span>
                </span>
                <button
                  type="button"
                  disabled={clearing || warnings === 0}
                  onClick={() => void clearWarnings()}
                  title={
                    warnings === 0
                      ? "Счётчик уже равен нулю"
                      : "Обнулить предупреждения, не снимая блок"
                  }
                  className={SMALL_BUTTON}
                >
                  {clearing ? "…" : "Сбросить предупреждения"}
                </button>
              </div>
              <div className="mt-1.5 flex gap-1.5">
                <input
                  value={warnReason}
                  onChange={(event) => setWarnReason(event.target.value)}
                  placeholder="Причина предупреждения (необязательно)"
                  aria-label="Причина предупреждения"
                  maxLength={MAX_TEXT}
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-amber-500 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={busy || blocked}
                  onClick={() => void submitWarning()}
                  title={
                    blocked
                      ? "Причина блокировки уже записана"
                      : `Предупредить ИИ и записать причину (автоблокировка после ${WARNINGS_TO_BLOCK})`
                  }
                  className="shrink-0 rounded border border-amber-800/70 px-2 py-1 text-[11px] text-amber-200 transition-colors hover:bg-amber-950/40 disabled:opacity-40"
                >
                  {busy ? "…" : "Предупредить"}
                </button>
              </div>
            </div>

            {blocked ? (
              <div className="space-y-1.5 rounded-lg border border-red-900/60 bg-red-950/25 px-2 py-2">
                <p className="text-[11px] text-red-200">
                  Заблокирован{warnings > 0 ? ` · ${warnings} предупр.` : ""}
                  {view.reason ? ` · ${view.reason}` : ""}
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    clearError();
                    void unblock(chatId, threadId).then(async (ok) => {
                      if (!ok) return;
                      await refreshView();
                      events.reload();
                    });
                  }}
                  className="rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
                >
                  {busy ? "…" : "Разблокировать"}
                </button>
              </div>
            ) : (
              <div className="flex gap-1.5">
                <input
                  value={blockReason}
                  onChange={(event) => setBlockReason(event.target.value)}
                  placeholder="Причина блокировки (необязательно)"
                  aria-label="Причина блокировки ИИ"
                  maxLength={MAX_TEXT}
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-red-500 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    clearError();
                    void block(chatId, {
                      reason: blockReason.trim() || null,
                      threadId,
                    }).then((result) => {
                      if (!result) return;
                      setBlockReason("");
                      setView(result);
                      events.reload();
                    });
                  }}
                  className="shrink-0 rounded border border-red-800/80 px-2 py-1 text-[11px] text-red-200 transition-colors hover:bg-red-950/50 disabled:opacity-40"
                >
                  {busy ? "…" : "Заблокировать"}
                </button>
              </div>
            )}

            {error && (
              <p role="alert" className="text-[11px] text-red-300">
                {error}
              </p>
            )}
            {localError && (
              <p role="alert" className="text-[11px] text-red-300">
                {localError}
              </p>
            )}
          </div>
        )}
      </PanelCard>

      <ChatTypingOverride
        accountId={accountId}
        chatId={chatId}
        threadId={threadId}
      />

      <PanelCard
        title="История"
        hint="Предупреждения, блокировки и сбросы этого чата"
        actions={
          <button
            type="button"
            onClick={events.reload}
            disabled={events.loading}
            title="Обновить историю"
            className={SMALL_BUTTON}
          >
            {events.loading ? "…" : "Обновить"}
          </button>
        }
      >
        <div className="mt-2 space-y-1.5">
          {events.loading && !events.data && <RowsSkeleton rows={3} />}
          {events.error && (
            <TabError text={events.error} onRetry={events.reload} />
          )}
          {events.data && events.data.length === 0 && (
            <EmptyNote>
              Событий пока нет. Предупреждения, блокировки и снятия блокировки
              появятся здесь с причиной и автором.
            </EmptyNote>
          )}
          {events.data?.map((event) => {
            const kind = EVENT_KINDS[event.kind];
            return (
              <article
                key={event.id}
                className={`rounded-lg border px-2 py-1.5 ${kind.tone}`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${EVENT_BADGES[event.kind]}`}
                  >
                    {kind.label}
                  </span>
                  <span className="rounded-full bg-black/20 px-1.5 py-0.5 text-[10px] text-zinc-400">
                    {actorLabel(event)}
                  </span>
                  <span className="text-[10px] text-zinc-500">
                    {event.warnings} предупр.
                  </span>
                  <span className="ml-auto text-[10px] text-zinc-500">
                    {formatStamp(event.createdAt)}
                  </span>
                </div>
                <p
                  className={`mt-1 break-words text-[11px] ${
                    event.reason ? "text-zinc-300" : "text-zinc-600"
                  }`}
                >
                  {reasonLabel(event.reason) ?? "Без причины"}
                </p>
              </article>
            );
          })}
        </div>
      </PanelCard>

      <div className="rounded-xl border border-zinc-800 bg-zinc-950/50 px-2.5 py-2">
        {settings.loading && !settings.data ? (
          <p className="text-[11px] text-zinc-500">Права: загрузка…</p>
        ) : settings.error ? (
          <p className="text-[11px] text-red-300">
            Права аккаунта: {settings.error}
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="text-zinc-400">
              {overrideCount === 0
                ? "Права: по умолчанию"
                : `Права: ${overrideCount} отличий от глобальных`}
            </span>
            <Link
              href="/accounts"
              title="Открыть страницу аккаунтов и изменить права"
              className="text-sky-400 hover:text-sky-300"
            >
              Изменить в аккаунтах →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
