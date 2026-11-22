"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api";
import { chatAvatarUrl } from "../../lib/avatar";
import { searchGlobal } from "../../lib/messaging-api";
import type {
  ChatView,
  GlobalSearchView,
  SearchUserView,
} from "../../lib/types";
import { Avatar } from "../avatar";

const EMPTY: GlobalSearchView = { chats: [], users: [] };

/**
 * Global Telegram search (`GET /accounts/:accountId/search`) with results
 * grouped into chats and users. A user hit is opened through the resolve
 * endpoint, because search returns only the peer identity.
 */
export function GlobalSearchModal({
  accountId,
  onOpenChat,
  onOpenUser,
  onClose,
}: {
  accountId: string;
  onOpenChat: (chat: ChatView) => void;
  /** Resolves on success; the modal closes only then. */
  onOpenUser: (username: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [resolvingId, setResolvingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<GlobalSearchView | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async () => {
    const query = value.trim();
    if (!query || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResults(await searchGlobal(accountId, query));
    } catch (caught) {
      setResults(EMPTY);
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const openUser = async (user: SearchUserView) => {
    if (!user.username || resolvingId !== null) return;
    setResolvingId(user.id);
    setError(null);
    try {
      await onOpenUser(user.username);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setResolvingId(null);
    }
  };

  const openChat = (chat: ChatView) => {
    onOpenChat(chat);
    onClose();
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
        aria-label="Глобальный поиск по Telegram"
        className="flex max-h-[75vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">Поиск</h2>
            <p className="text-[11px] text-zinc-500">
              Чаты и пользователи Telegram
            </p>
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

        <form
          className="flex gap-2 border-b border-zinc-800 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Название, @username…"
            aria-label="Поисковый запрос"
            className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || value.trim().length === 0}
            className="shrink-0 rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
          >
            {busy ? "Поиск…" : "Найти"}
          </button>
        </form>

        <div className="flex-1 overflow-y-auto">
          {error && (
            <p className="border-b border-zinc-800 bg-red-950/40 px-4 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          {!results && !busy && !error && (
            <p className="px-4 py-4 text-sm text-zinc-500">
              Введите запрос и нажмите «Найти».
            </p>
          )}

          {results &&
            results.chats.length === 0 &&
            results.users.length === 0 && (
              <p className="px-4 py-4 text-sm text-zinc-500">
                Ничего не найдено.
              </p>
            )}

          {results && results.chats.length > 0 && (
            <div>
              <p className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Чаты
              </p>
              {results.chats.map((chat) => (
                <button
                  key={`chat-${chat.id}`}
                  type="button"
                  onClick={() => openChat(chat)}
                  title={`Открыть чат ${chat.title}`}
                  className="flex w-full items-center gap-3 border-b border-zinc-800/60 px-4 py-2.5 text-left transition-colors hover:bg-zinc-800/60"
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
                </button>
              ))}
            </div>
          )}

          {results && results.users.length > 0 && (
            <div>
              <p className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Пользователи
              </p>
              {results.users.map((user) => (
                <button
                  key={`user-${user.id}`}
                  type="button"
                  onClick={() => void openUser(user)}
                  disabled={!user.username || resolvingId !== null}
                  title={
                    user.username
                      ? `Открыть чат с ${user.title}`
                      : "У пользователя нет username"
                  }
                  className="flex w-full items-center gap-3 border-b border-zinc-800/60 px-4 py-2.5 text-left transition-colors hover:bg-zinc-800/60 disabled:opacity-50"
                >
                  <Avatar label={user.title} className="h-8 w-8 text-xs" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-100">
                      {user.title}
                    </span>
                    <span className="block truncate text-[11px] text-zinc-500">
                      {user.username ? `@${user.username}` : "без username"}
                    </span>
                  </span>
                  {resolvingId === user.id && (
                    <span className="shrink-0 text-[11px] text-sky-400">…</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
