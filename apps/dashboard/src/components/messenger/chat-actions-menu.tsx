"use client";

import { useEffect, useRef } from "react";
import type { ChatView } from "../../lib/types";
import { AiAccessActionItems } from "./ai-access-menu";
import { useAiAccess } from "./ai-access-store";

export type ChatMenuAction =
  | "pin"
  | "mute"
  | "read"
  | "unread"
  | "clear"
  | "delete"
  | "delete-all";

const ITEM_CLASS =
  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-800 disabled:opacity-40";

/**
 * Dropdown with the per-chat actions. Rendered inside the chat row and closed
 * on Escape, on a click outside, or after an action succeeds.
 */
export function ChatActionsMenu({
  chat,
  busy,
  onAction,
  onClose,
}: {
  chat: ChatView;
  busy: boolean;
  onAction: (action: ChatMenuAction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { statusFor } = useAiAccess();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      // The "⋯" toggle owns its own open/close; ignore it here so a second
      // click closes the menu instead of closing and immediately reopening it.
      if (target?.closest("[data-chat-menu-toggle]")) return;
      if (ref.current && target && !ref.current.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={`Действия с чатом ${chat.title}`}
      className="absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
    >
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => onAction("pin")}
        className={ITEM_CLASS}
      >
        <span aria-hidden="true">📌</span>
        {chat.pinned ? "Открепить" : "Закрепить"}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => onAction("mute")}
        className={ITEM_CLASS}
      >
        <span aria-hidden="true">{chat.muted ? "🔔" : "🔇"}</span>
        {chat.muted ? "Включить звук" : "Без звука"}
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy || chat.unreadCount === 0}
        onClick={() => onAction("read")}
        className={ITEM_CLASS}
      >
        <span aria-hidden="true">✓</span>
        Прочитать
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => onAction("unread")}
        className={ITEM_CLASS}
      >
        <span aria-hidden="true">●</span>
        Отметить непрочитанным
      </button>
      <div className="my-1 border-t border-zinc-800" />
      <AiAccessActionItems
        chatId={chat.id}
        state={statusFor(chat.id)}
        onDone={onClose}
      />
      <div className="my-1 border-t border-zinc-800" />
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => onAction("clear")}
        className={ITEM_CLASS}
      >
        <span aria-hidden="true">🧹</span>
        Очистить историю у себя
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => onAction("delete")}
        className={ITEM_CLASS}
      >
        <span aria-hidden="true">🗑</span>
        Удалить у себя
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        onClick={() => onAction("delete-all")}
        className={`${ITEM_CLASS} text-red-300 hover:bg-red-950/50`}
      >
        <span aria-hidden="true">🗑</span>
        Удалить у всех
      </button>
    </div>
  );
}
