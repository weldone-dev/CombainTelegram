"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api";
import { formatDay, formatTime } from "../../lib/format";
import { searchChatMessages } from "../../lib/messaging-api";
import type { MessageView } from "../../lib/types";

/**
 * In-chat message search for the currently open chat
 * (`GET /accounts/:accountId/chats/:chatId/search`). The query is debounced so
 * typing does not fire a Telegram request per keystroke.
 */
export function ChatSearchPanel({
  accountId,
  chatId,
  chatTitle,
  onOpenChat,
}: {
  accountId: string;
  chatId: number;
  chatTitle: string;
  onOpenChat: (chatId: number, messageId: number) => void;
}) {
  const [value, setValue] = useState("");
  const [messages, setMessages] = useState<MessageView[]>([]);
  const [nextOffsetId, setNextOffsetId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickedId, setPickedId] = useState<number | null>(null);
  const requestRef = useRef(0);

  // The parent remounts this panel per chat (via `key`), so no reset effect is
  // needed when the open chat changes.
  useEffect(() => {
    const query = value.trim();
    if (!query) {
      setMessages([]);
      setNextOffsetId(null);
      setBusy(false);
      setError(null);
      requestRef.current += 1;
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setBusy(true);
    setError(null);
    const timer = setTimeout(() => {
      searchChatMessages(accountId, chatId, query)
        .then((result) => {
          if (requestRef.current !== requestId) return;
          setMessages(result.messages);
          setNextOffsetId(result.nextOffsetId);
        })
        .catch((caught) => {
          if (requestRef.current !== requestId) return;
          setMessages([]);
          setNextOffsetId(null);
          setError(errorMessage(caught));
        })
        .finally(() => {
          if (requestRef.current !== requestId) return;
          setBusy(false);
        });
    }, 350);
    return () => clearTimeout(timer);
  }, [accountId, chatId, value]);

  const loadMore = async () => {
    const query = value.trim();
    if (!query || nextOffsetId === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const result = await searchChatMessages(
        accountId,
        chatId,
        query,
        30,
        nextOffsetId,
      );
      setMessages((previous) => {
        const existing = new Set(previous.map((message) => message.id));
        return [
          ...previous,
          ...result.messages.filter((message) => !existing.has(message.id)),
        ];
      });
      setNextOffsetId(result.nextOffsetId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <div className="border-b border-zinc-800 bg-zinc-900/60">
      <div className="flex items-center gap-2 px-3 py-2">
        <input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={`Поиск в «${chatTitle}»`}
          aria-label={`Поиск сообщений в чате ${chatTitle}`}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          autoComplete="off"
        />
        {busy && <span className="text-[11px] text-zinc-500">…</span>}
      </div>

      {error && <p className="px-3 pb-2 text-[11px] text-red-300">{error}</p>}

      {value.trim() && !busy && !error && messages.length === 0 && (
        <p className="px-3 pb-2 text-[11px] text-zinc-500">
          Сообщения не найдены.
        </p>
      )}

      {messages.length > 0 && (
        <div className="max-h-56 overflow-y-auto">
          {messages.map((message) => (
            <button
              key={message.id}
              type="button"
              onClick={() => {
                setPickedId(message.id);
                onOpenChat(chatId, message.id);
              }}
              title="Выбрать это сообщение в открытом чате"
              aria-label="Выбрать это сообщение в открытом чате"
              className={`block w-full border-t border-zinc-800/60 px-3 py-2 text-left transition-colors hover:bg-zinc-800/60 ${
                pickedId === message.id ? "bg-sky-500/10" : ""
              }`}
            >
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-[11px] text-zinc-500">
                  {message.outgoing ? "Вы" : message.senderName}
                </span>
                <span className="shrink-0 text-[10px] text-zinc-600">
                  {formatDay(message.date)} {formatTime(message.date)}
                </span>
              </span>
              <span className="mt-0.5 block truncate text-xs text-zinc-300">
                {message.text || `(${message.mediaType ?? "медиа"})`}
              </span>
            </button>
          ))}
          {nextOffsetId !== null && (
            <button
              type="button"
              onClick={() => void loadMore()}
              disabled={loadingMore}
              className="w-full border-t border-zinc-800 px-3 py-1.5 text-[11px] text-sky-400 transition-colors hover:bg-zinc-800/60 disabled:opacity-40"
            >
              {loadingMore ? "Загрузка…" : "Показать ещё"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
