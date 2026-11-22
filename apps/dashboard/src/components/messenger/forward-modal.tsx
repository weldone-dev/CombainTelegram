"use client";

import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/api";
import { chatAvatarUrl } from "../../lib/avatar";
import type { ChatView } from "../../lib/types";
import { Avatar } from "../avatar";

/**
 * Small chat picker used by both the per-message and the multi-select forward
 * actions. The parent passes the chats of the active account without the
 * current chat.
 */
export function ForwardModal({
  chats,
  accountId,
  count,
  onForward,
  onClose,
}: {
  chats: ChatView[];
  accountId: string;
  count: number;
  /** Resolves on success; the modal closes only then. */
  onForward: (chatId: number) => Promise<void>;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const choose = async (chatId: number) => {
    if (busyId !== null) return;
    setBusyId(chatId);
    setError(null);
    try {
      await onForward(chatId);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes the modal
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Переслать сообщения"
        className="flex max-h-[70vh] w-full max-w-sm flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">
              Переслать {count > 1 ? `сообщения (${count})` : "сообщение"}
            </h2>
            <p className="text-[11px] text-zinc-500">Выберите чат</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть"
            className="rounded-md px-2 py-1 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>

        {error && (
          <p className="border-b border-zinc-800 bg-red-950/40 px-4 py-2 text-xs text-red-300">
            {error}
          </p>
        )}

        <div className="flex-1 overflow-y-auto">
          {chats.length === 0 && (
            <p className="px-4 py-4 text-sm text-zinc-500">
              Нет других чатов для пересылки.
            </p>
          )}
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              onClick={() => void choose(chat.id)}
              disabled={busyId !== null}
              title={`Переслать в ${chat.title}`}
              className="flex w-full items-center gap-3 border-b border-zinc-800/60 px-4 py-2.5 text-left transition-colors hover:bg-zinc-800/60 disabled:opacity-50"
            >
              <Avatar
                src={chatAvatarUrl(accountId, chat.id)}
                label={chat.title}
                className="h-8 w-8 text-xs"
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-100">
                  {chat.title}
                </span>
                <span className="block truncate text-[11px] text-zinc-500">
                  {chat.username ? `@${chat.username}` : `чат ${chat.id}`}
                </span>
              </span>
              {busyId === chat.id && (
                <span className="shrink-0 text-[11px] text-sky-400">
                  отправка…
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
