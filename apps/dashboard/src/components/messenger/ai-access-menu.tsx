"use client";

import { useEffect, useRef, useState } from "react";
import { useAiAccess } from "./ai-access-store";

const ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40";

const DANGER_ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-red-300 transition-colors hover:bg-red-950/50 disabled:opacity-40";

const SPARKLE_ICON = (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="h-3.5 w-3.5 shrink-0 fill-current"
  >
    <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9z" />
  </svg>
);

const SHIELD_OFF_ICON = (
  <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    className="h-3.5 w-3.5 shrink-0 stroke-current"
    fill="none"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 3 4.5 6v5.5c0 4.2 3 7.9 7.5 9.5 4.5-1.6 7.5-5.3 7.5-9.5V6z" />
    <path d="m4 4 16 16" />
  </svg>
);

/** Current whole-chat/thread state; only the two flags drive the labels. */
export interface AiMenuState {
  allowed: boolean;
  blocked: boolean;
}

/**
 * The four AI actions shared by the chat row menu, the transcript background
 * menu and the header chip. `Заблокировать ИИ` opens a small inline reason
 * prompt instead of a browser dialog, so the action stays in context.
 */
export function AiAccessActionItems({
  chatId,
  state,
  threadId = 0,
  onDone,
}: {
  chatId: number;
  state?: AiMenuState;
  threadId?: number;
  onDone?: () => void;
}) {
  const { setAccess, block, unblock, busyFor, error, clearError } =
    useAiAccess();
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = busyFor(chatId, threadId);
  const blocked = state?.blocked ?? false;
  const allowed = state?.allowed ?? false;

  useEffect(() => {
    if (reasonOpen) inputRef.current?.focus();
  }, [reasonOpen]);

  const allowOrDeny = () => {
    clearError();
    void setAccess(chatId, { enabled: !allowed, threadId }).then((view) => {
      if (view) onDone?.();
    });
  };

  const submitBlock = () => {
    void block(chatId, {
      reason: reason.trim() || null,
      threadId,
    }).then((view) => {
      if (!view) return;
      setReasonOpen(false);
      setReason("");
      onDone?.();
    });
  };

  return (
    <>
      {!blocked && (
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={allowOrDeny}
          className={allowed ? DANGER_ITEM_CLASS : ITEM_CLASS}
        >
          <span aria-hidden="true" className="shrink-0">
            {allowed ? "🚫" : "✦"}
          </span>
          {allowed ? "ИИ: запретить" : "ИИ: разрешить"}
        </button>
      )}
      {!blocked && !reasonOpen && (
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={() => {
            clearError();
            setReasonOpen(true);
          }}
          className={DANGER_ITEM_CLASS}
        >
          <span aria-hidden="true" className="shrink-0">
            {SHIELD_OFF_ICON}
          </span>
          Заблокировать ИИ
        </button>
      )}
      {!blocked && reasonOpen && (
        <div className="space-y-1.5 px-3 py-1.5">
          <input
            ref={inputRef}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submitBlock();
              }
              if (event.key === "Escape") setReasonOpen(false);
            }}
            placeholder="Причина (необязательно)"
            aria-label="Причина блокировки ИИ"
            className="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-red-500 focus:outline-none"
            autoComplete="off"
          />
          <div className="flex gap-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={submitBlock}
              className="rounded bg-red-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-red-500 disabled:opacity-50"
            >
              {busy ? "…" : "Заблокировать"}
            </button>
            <button
              type="button"
              onClick={() => setReasonOpen(false)}
              className="rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:border-zinc-500"
            >
              Отмена
            </button>
          </div>
        </div>
      )}
      {blocked && (
        <button
          type="button"
          role="menuitem"
          disabled={busy}
          onClick={() => {
            clearError();
            void unblock(chatId, threadId).then((ok) => {
              if (ok) onDone?.();
            });
          }}
          className={ITEM_CLASS}
        >
          <span aria-hidden="true" className="shrink-0">
            {SPARKLE_ICON}
          </span>
          {busy ? "…" : "Разблокировать"}
        </button>
      )}
      {error && (
        <p
          role="alert"
          className="border-t border-red-900/60 bg-red-950/30 px-3 py-1.5 text-[11px] text-red-300"
        >
          {error}
        </p>
      )}
    </>
  );
}

/** Standalone dropdown pinned to a pointer or a header button. */
export function AiAccessMenu({
  chatId,
  chatTitle,
  state,
  position,
  threadId = 0,
  onClose,
}: {
  chatId: number;
  chatTitle: string;
  state?: AiMenuState;
  position: { x: number; y: number };
  threadId?: number;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Доступ ИИ: ${chatTitle}`}
      style={{ left: position.x, top: position.y }}
      className="fixed z-50 w-60 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
    >
      <p className="truncate px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
        {threadId > 0 ? `ИИ · тред #${threadId}` : "Доступ ИИ"}
      </p>
      <AiAccessActionItems
        chatId={chatId}
        state={state}
        threadId={threadId}
        onDone={onClose}
      />
    </div>
  );
}
