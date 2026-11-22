"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { chatAvatarUrl } from "../../lib/avatar";
import { formatTime } from "../../lib/format";
import type {
  AccountView,
  ChatView,
  MessageView,
  TypingEntry,
} from "../../lib/types";
import { Avatar } from "../avatar";

export function ChatWindow({
  account,
  chat,
  messages,
  loading,
  error,
  nextOffsetId,
  loadingMore,
  typing,
  onLoadMore,
  onSend,
  onEdit,
  onDelete,
  onTyping,
  onRead,
}: {
  account: AccountView | null;
  chat: ChatView | null;
  messages: MessageView[];
  loading: boolean;
  error: string | null;
  nextOffsetId: number | null;
  loadingMore: boolean;
  typing: TypingEntry[];
  onLoadMore: () => void;
  onSend: (text: string) => void;
  onEdit: (messageId: number, text: string) => void;
  onDelete: (messageId: number) => void;
  onTyping: () => void;
  /** Called with the newest visible id once the user is at the bottom. */
  onRead: (maxId: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stickRef = useRef(true);
  const activeChatRef = useRef<number | null>(null);
  const pendingUnreadRef = useRef(0);
  const readUpToRef = useRef(0);
  const [unreadAnchor, setUnreadAnchor] = useState(0);

  const visible = [...messages].reverse();
  const activeTyping = typing.filter((entry) => entry.until > Date.now());

  // Snapshot the unread counter once per chat: this is where the divider and
  // the initial scroll position come from. Opening a chat no longer marks
  // everything read; it only scrolls to the first unread message.
  useEffect(() => {
    if (!chat) {
      activeChatRef.current = null;
      setUnreadAnchor(0);
      return;
    }
    if (activeChatRef.current === chat.id) return;
    activeChatRef.current = chat.id;
    pendingUnreadRef.current = chat.unreadCount;
    setUnreadAnchor(chat.unreadCount);
    stickRef.current = chat.unreadCount === 0;
    // Everything up to the inbox read marker is already read; only newer ids
    // should ever be sent to the API.
    readUpToRef.current = chat.readInboxMaxId ?? 0;
  }, [chat]);

  /**
   * Advances the read marker to `maxId` (message ids grow towards the newest
   * message). Called for every group of messages that actually became visible,
   * not only at the bottom, so partially scrolled chats are read progressively.
   */
  const markReadUpTo = useCallback(
    (maxId: number) => {
      if (!chat || messages.length === 0) return;
      if (maxId <= readUpToRef.current) return;
      readUpToRef.current = maxId;
      onRead(maxId);
      const newestId = messages[0].id;
      if (maxId >= newestId) setUnreadAnchor(0);
    },
    [chat, messages, onRead],
  );

  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !chat) return;

    if (pendingUnreadRef.current > 0) {
      // Wait for the loaded messages: the divider only exists once the render
      // with `messages` has been committed.
      const divider = container.querySelector<HTMLElement>(
        "[data-unread-divider]",
      );
      if (!divider) return;
      // Manual scroll: `scrollIntoView` also scrolls the outer horizontal
      // container and shifts the whole dashboard sideways.
      const containerRect = container.getBoundingClientRect();
      const dividerRect = divider.getBoundingClientRect();
      const offset =
        dividerRect.top -
        containerRect.top -
        container.clientHeight / 2 +
        dividerRect.height / 2;
      container.scrollTop = Math.max(container.scrollTop + offset, 0);
      pendingUnreadRef.current = 0;
      return;
    }

    if (stickRef.current) {
      container.scrollTop = container.scrollHeight;
      markReadUpTo(messages[0]?.id ?? 0);
    }
  }, [chat, markReadUpTo, messages]);

  // Telegram-style read tracking: whichever messages are on screen count as
  // read, debounced to one request per settling of the scroll.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container || !chat) return;
    const items = container.querySelectorAll<HTMLElement>("[data-message-id]");
    if (items.length === 0) return;

    const visibleIds = new Set<number>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      timer = null;
      if (document.visibilityState !== "visible" || visibleIds.size === 0) {
        return;
      }
      const maxId = Math.max(...visibleIds);
      markReadUpTo(maxId);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = Number((entry.target as HTMLElement).dataset.messageId);
          if (!Number.isFinite(id)) continue;
          if (entry.isIntersecting) visibleIds.add(id);
          else visibleIds.delete(id);
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 400);
      },
      { root: container, threshold: 0.5 },
    );

    for (const item of items) observer.observe(item);

    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [chat, markReadUpTo]);

  const handleScroll = () => {
    const container = scrollRef.current;
    if (!container) return;
    const atBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight <
      64;
    stickRef.current = atBottom;
    if (atBottom) markReadUpTo(messages[0]?.id ?? 0);
  };

  useEffect(() => {
    return () => {
      if (typingTimer.current) clearTimeout(typingTimer.current);
    };
  }, []);

  const unreadDividerIndex =
    unreadAnchor > 0 ? Math.max(visible.length - unreadAnchor, 0) : -1;

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (value.trim()) {
      typingTimer.current = setTimeout(() => {
        onTyping();
      }, 1200);
    }
  };

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft("");
    if (typingTimer.current) clearTimeout(typingTimer.current);
  };

  const startEdit = (message: MessageView) => {
    setEditingId(message.id);
    setEditDraft(message.text);
  };

  const submitEdit = () => {
    if (editingId === null) return;
    const text = editDraft.trim();
    if (!text) return;
    onEdit(editingId, text);
    setEditingId(null);
    setEditDraft("");
  };

  if (!account || !chat) {
    return (
      <section className="flex min-w-[420px] flex-1 items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Выберите аккаунт и чат, чтобы начать переписку.
      </section>
    );
  }

  return (
    <section className="flex min-w-[420px] flex-1 flex-col bg-zinc-950">
      <div className="flex items-center gap-3 border-b border-zinc-800 px-5 py-3">
        <Avatar
          key={chat.id}
          src={chatAvatarUrl(account.id, chat.id)}
          label={chat.title}
          className="h-9 w-9 text-xs"
        />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-zinc-100">
            {chat.title}
          </h2>
          <p className="truncate text-xs text-zinc-500">
            {chat.username ? `@${chat.username}` : `чат ${chat.id}`}
            {chat.unreadCount > 0 ? ` · ${chat.unreadCount} непрочитанных` : ""}
          </p>
        </div>
        {activeTyping.length > 0 && (
          <span className="ml-auto text-xs text-sky-400">
            печатает
            {activeTyping[0]?.status === "typing"
              ? "…"
              : ` (${activeTyping[0]?.status})`}
          </span>
        )}
      </div>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 space-y-3 overflow-y-auto px-5 py-4"
      >
        {nextOffsetId !== null && (
          <div className="flex justify-center">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore}
              className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-500 disabled:opacity-50"
            >
              {loadingMore ? "Загрузка…" : "Показать ещё"}
            </button>
          </div>
        )}

        {loading && (
          <p className="text-center text-sm text-zinc-500">
            Загрузка сообщений…
          </p>
        )}
        {error && <p className="text-center text-sm text-red-300">{error}</p>}
        {!loading && !error && visible.length === 0 && (
          <p className="text-center text-sm text-zinc-500">
            Пока нет сообщений.
          </p>
        )}

        {visible.map((message, index) => (
          <Fragment key={message.id}>
            {index === unreadDividerIndex && (
              <div
                data-unread-divider
                className="flex items-center gap-3 py-1 text-[11px] font-medium text-sky-400"
              >
                <span className="h-px flex-1 bg-sky-500/40" />
                Непрочитанные сообщения
                <span className="h-px flex-1 bg-sky-500/40" />
              </div>
            )}
            <article
              data-message-id={message.id}
              className={`group flex ${message.outgoing ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-3.5 py-2 ${
                  message.outgoing
                    ? "bg-sky-600 text-white"
                    : "bg-zinc-800 text-zinc-100"
                }`}
              >
                {!message.outgoing && (
                  <p className="mb-0.5 text-xs font-medium text-sky-400">
                    {message.senderName}
                  </p>
                )}

                {message.replyToId !== null && (
                  <p className="mb-1 text-[11px] opacity-70">
                    ↩ ответ на #{message.replyToId}
                  </p>
                )}

                {editingId === message.id ? (
                  <div className="space-y-2">
                    <input
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitEdit();
                        if (event.key === "Escape") setEditingId(null);
                      }}
                      className="w-full rounded-md border border-zinc-500 bg-zinc-900 px-2 py-1 text-sm text-zinc-100 outline-none focus:border-sky-400"
                    />
                    <div className="flex gap-2 text-xs">
                      <button
                        type="button"
                        onClick={submitEdit}
                        className="rounded bg-sky-500 px-2 py-1 font-medium text-white hover:bg-sky-400"
                      >
                        Сохранить
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        className="rounded bg-zinc-600 px-2 py-1 text-zinc-100 hover:bg-zinc-500"
                      >
                        Отмена
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="whitespace-pre-wrap break-words text-sm">
                    {message.text ||
                      (message.mediaType ? `[${message.mediaType}]` : "")}
                  </p>
                )}

                <div className="mt-1 flex items-center justify-end gap-2 text-[11px] opacity-80">
                  {message.mediaType && message.text && (
                    <span className="rounded bg-black/20 px-1.5 py-0.5 text-[10px]">
                      {message.mediaType}
                    </span>
                  )}
                  {message.edited && <span>изменено</span>}
                  <span>{formatTime(message.date)}</span>
                </div>

                {message.outgoing && editingId !== message.id && (
                  <div className="mt-1 flex justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <button
                      type="button"
                      onClick={() => startEdit(message)}
                      className="text-[11px] underline underline-offset-2 hover:text-white"
                    >
                      Изменить
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm("Удалить это сообщение?")) {
                          onDelete(message.id);
                        }
                      }}
                      className="text-[11px] text-red-200 underline underline-offset-2 hover:text-red-100"
                    >
                      Удалить
                    </button>
                  </div>
                )}
              </div>
            </article>
          </Fragment>
        ))}
      </div>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        className="flex items-center gap-2 border-t border-zinc-800 px-5 py-3"
      >
        <input
          value={draft}
          onChange={(event) => handleDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={`Сообщение в ${chat.title}`}
          className="flex-1 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
        />
        <button
          type="submit"
          disabled={!draft.trim()}
          className="rounded-full bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-40"
        >
          Отправить
        </button>
      </form>
    </section>
  );
}
