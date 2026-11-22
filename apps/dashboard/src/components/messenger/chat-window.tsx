"use client";

import {
  Fragment,
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { mediaUrl } from "../../lib/api";
import { chatAvatarUrl } from "../../lib/avatar";
import { copyToClipboard } from "../../lib/clipboard";
import {
  clearDraft,
  draftStorageKey,
  readDraft,
  writeDraft,
} from "../../lib/drafts";
import { formatFileSize, formatTime } from "../../lib/format";
import type {
  AccountView,
  ChatView,
  MessageView,
  TypingEntry,
} from "../../lib/types";
import { Avatar } from "../avatar";
import { ForwardModal } from "./forward-modal";
import { MessageText } from "./message-text";

function messagePreview(message: MessageView | undefined): string {
  if (!message) return "";
  const text = message.text.trim();
  if (text) return text;
  return message.mediaType ? `[${message.mediaType}]` : "(без текста)";
}

export function ChatWindow({
  account,
  chat,
  chats,
  messages,
  loading,
  error,
  nextOffsetId,
  loadingMore,
  typing,
  onLoadMore,
  onSend,
  onSendMedia,
  onEdit,
  onDelete,
  onDeleteMany,
  onForward,
  onTyping,
  onRead,
}: {
  account: AccountView | null;
  chat: ChatView | null;
  /** Loaded chats of the active account, used by the forward picker. */
  chats: ChatView[];
  messages: MessageView[];
  loading: boolean;
  error: string | null;
  nextOffsetId: number | null;
  loadingMore: boolean;
  typing: TypingEntry[];
  onLoadMore: () => void;
  onSend: (text: string, replyToId?: number) => Promise<void>;
  onSendMedia: (
    file: File,
    caption: string,
    replyToId?: number,
  ) => Promise<void>;
  onEdit: (messageId: number, text: string) => void;
  onDelete: (messageId: number) => void;
  onDeleteMany: (messageIds: number[]) => Promise<void>;
  onForward: (toChatId: number, messageIds: number[]) => Promise<void>;
  onTyping: () => void;
  /** Called with the newest visible id once the user is at the bottom. */
  onRead: (maxId: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const [attachment, setAttachment] = useState<File | null>(null);
  const [attachmentPreview, setAttachmentPreview] = useState<string | null>(
    null,
  );
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [forwardIds, setForwardIds] = useState<number[] | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stickRef = useRef(true);
  const activeChatRef = useRef<number | null>(null);
  const pendingUnreadRef = useRef(0);
  const readUpToRef = useRef(0);
  const [unreadAnchor, setUnreadAnchor] = useState(0);

  const accountId = account?.id ?? null;
  const chatId = chat?.id ?? null;
  const draftKey =
    accountId !== null && chatId !== null
      ? draftStorageKey(accountId, chatId)
      : null;
  const draftKeyRef = useRef<string | null>(draftKey);
  draftKeyRef.current = draftKey;

  const visible = [...messages].reverse();
  const activeTyping = typing.filter((entry) => entry.until > Date.now());

  // Restore the per-account/per-chat draft and reset transient composer state
  // whenever the open chat changes. localStorage is only touched here.
  useEffect(() => {
    setAttachment(null);
    setAttachmentPreview(null);
    if (!draftKey) {
      setDraft("");
      return;
    }
    setDraft(readDraft(draftKey));
    setEditingId(null);
    setEditDraft("");
    setReplyTo(null);
    setSelecting(false);
    setSelected(new Set());
    setForwardIds(null);
    setStatus(null);
  }, [draftKey]);

  // Revoke the previous object URL whenever the preview changes or the
  // composer unmounts; the browser keeps blobs alive until then.
  useEffect(() => {
    if (!attachmentPreview) return;
    return () => URL.revokeObjectURL(attachmentPreview);
  }, [attachmentPreview]);

  const chooseAttachment = (file: File | null) => {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) {
      setStatus("Файл больше 50 МБ");
      return;
    }
    setStatus(null);
    setAttachment(file);
    setAttachmentPreview(
      file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    );
  };

  const clearAttachment = () => {
    setAttachment(null);
    setAttachmentPreview(null);
  };

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
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
    };
  }, []);

  const unreadDividerIndex =
    unreadAnchor > 0 ? Math.max(visible.length - unreadAnchor, 0) : -1;

  const handleDraftChange = (value: string) => {
    setDraft(value);
    if (draftKeyRef.current) writeDraft(draftKeyRef.current, value);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    if (value.trim()) {
      typingTimer.current = setTimeout(() => {
        onTyping();
      }, 1200);
    }
  };

  const showCopied = (key: string) => {
    setCopiedKey(key);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopiedKey(null), 1600);
  };

  const submit = async () => {
    const text = draft.trim();
    if ((!text && !attachment) || !account || !chat) return;
    const key = draftStorageKey(account.id, chat.id);
    const replyTargetId = replyTo?.id;
    try {
      if (attachment) {
        await onSendMedia(attachment, text, replyTargetId);
        clearDraft(key);
      } else {
        await onSend(text, replyTargetId);
        clearDraft(key);
      }
      if (draftKeyRef.current === key) {
        setDraft("");
        setAttachment(null);
        setAttachmentPreview(null);
        setReplyTo(null);
        setStatus(null);
      }
    } catch (caught) {
      setStatus(
        caught instanceof Error ? caught.message : "Не удалось отправить",
      );
    }
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

  const jumpToMessage = (id: number) => {
    const container = scrollRef.current;
    if (!container) return;
    const target = container.querySelector<HTMLElement>(
      `[data-message-id="${id}"]`,
    );
    if (!target) {
      setStatus("Сообщение не загружено");
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    container.scrollTop +=
      targetRect.top -
      containerRect.top -
      container.clientHeight / 2 +
      targetRect.height / 2;
    setHighlightId(id);
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightId(null), 1800);
  };

  const toggleSelection = () => {
    setSelecting((current) => {
      if (!current) setSelected(new Set());
      return !current;
    });
    setForwardIds(null);
  };

  const exitSelection = () => {
    setSelecting(false);
    setSelected(new Set());
  };

  const toggleSelected = (id: number) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const copyMessage = async (message: MessageView) => {
    const text = message.text || messagePreview(message);
    const ok = await copyToClipboard(text);
    if (ok) showCopied(`message:${message.id}`);
    else setStatus("Не удалось скопировать текст");
  };

  const copySelected = async () => {
    const text = visible
      .filter((message) => selected.has(message.id))
      .map((message) => message.text)
      .filter(Boolean)
      .join("\n\n");
    const ok = await copyToClipboard(text);
    if (ok) showCopied("selection");
    else setStatus("Не удалось скопировать текст");
  };

  const deleteSelected = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`Удалить выбранные сообщения (${ids.length})?`)) return;
    try {
      await onDeleteMany(ids);
      setStatus(null);
    } catch (caught) {
      setStatus(
        caught instanceof Error ? caught.message : "Не удалось удалить",
      );
    } finally {
      exitSelection();
    }
  };

  if (!account || !chat) {
    return (
      <section className="flex min-w-[420px] flex-1 items-center justify-center bg-zinc-950 text-sm text-zinc-500">
        Выберите аккаунт и чат, чтобы начать переписку.
      </section>
    );
  }

  const byId = new Map(messages.map((message) => [message.id, message]));
  const forwardTargets = chats.filter((item) => item.id !== chat.id);
  const selectedIds = [...selected];

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
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {activeTyping.length > 0 && (
            <span className="text-xs text-sky-400">
              печатает
              {activeTyping[0]?.status === "typing"
                ? "…"
                : ` (${activeTyping[0]?.status})`}
            </span>
          )}
          <button
            type="button"
            onClick={toggleSelection}
            title={selecting ? "Отменить выбор" : "Выбрать сообщения"}
            aria-label={selecting ? "Отменить выбор" : "Выбрать сообщения"}
            aria-pressed={selecting}
            className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
              selecting
                ? "border-sky-500 bg-sky-500/15 text-sky-300"
                : "border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
            }`}
          >
            {selecting ? "Отмена" : "Выбрать"}
          </button>
        </div>
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

        {visible.map((message, index) => {
          const quoted = message.replyToId
            ? byId.get(message.replyToId)
            : undefined;
          const isSelected = selected.has(message.id);
          return (
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
                {...(selecting
                  ? {
                      onClick: () => toggleSelected(message.id),
                      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleSelected(message.id);
                        }
                      },
                      role: "checkbox" as const,
                      "aria-checked": isSelected,
                      tabIndex: 0,
                    }
                  : {})}
                className={`group flex ${
                  message.outgoing ? "justify-end" : "justify-start"
                } ${selecting ? "cursor-pointer" : ""}`}
              >
                <div className="flex max-w-[75%] items-start gap-2">
                  {selecting && !message.outgoing && (
                    <SelectionMark checked={isSelected} />
                  )}
                  <div
                    className={`min-w-0 rounded-2xl px-3.5 py-2 transition-shadow ${
                      message.outgoing
                        ? "bg-sky-600 text-white"
                        : "bg-zinc-800 text-zinc-100"
                    } ${
                      isSelected
                        ? "ring-2 ring-sky-300"
                        : highlightId === message.id
                          ? "ring-2 ring-sky-400"
                          : ""
                    }`}
                  >
                    {!message.outgoing && (
                      <p className="mb-0.5 text-xs font-medium text-sky-400">
                        {message.senderName}
                      </p>
                    )}

                    {message.replyToId !== null && (
                      <button
                        type="button"
                        onClick={(event) => {
                          if (selecting) return;
                          event.stopPropagation();
                          if (message.replyToId !== null) {
                            jumpToMessage(message.replyToId);
                          }
                        }}
                        title="Перейти к сообщению"
                        className="mb-1 flex w-full items-baseline gap-1.5 overflow-hidden rounded border-l-2 border-sky-400/70 bg-black/20 px-2 py-1 text-left text-[11px] opacity-80 transition-opacity hover:opacity-100"
                      >
                        <span className="shrink-0 font-medium">
                          {quoted ? quoted.senderName : `#${message.replyToId}`}
                        </span>
                        <span className="truncate">
                          {quoted
                            ? messagePreview(quoted)
                            : "сообщение не загружено"}
                        </span>
                      </button>
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
                      <>
                        <MessageMedia
                          message={message}
                          accountId={account.id}
                          selecting={selecting}
                        />
                        {(message.text || !message.mediaType) && (
                          <MessageText text={message.text} links={!selecting} />
                        )}
                        {!message.text &&
                          message.mediaType &&
                          message.media?.kind !== "photo" &&
                          message.media?.kind !== "document" && (
                            <p className="text-sm opacity-80">
                              [{message.mediaType}]
                            </p>
                          )}
                      </>
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

                    {!selecting && editingId !== message.id && (
                      <div
                        className={`mt-1 flex flex-wrap items-center gap-2 text-[11px] opacity-0 transition-opacity group-hover:opacity-100 ${
                          message.outgoing ? "justify-end" : "justify-start"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            setReplyTo(message);
                            inputRef.current?.focus();
                          }}
                          title="Ответить"
                          aria-label="Ответить"
                          className="underline underline-offset-2 hover:text-white"
                        >
                          Ответить
                        </button>
                        <button
                          type="button"
                          onClick={() => setForwardIds([message.id])}
                          title="Переслать"
                          aria-label="Переслать"
                          className="underline underline-offset-2 hover:text-white"
                        >
                          Переслать
                        </button>
                        <button
                          type="button"
                          onClick={() => void copyMessage(message)}
                          title="Копировать"
                          aria-label="Копировать"
                          className="underline underline-offset-2 hover:text-white"
                        >
                          {copiedKey === `message:${message.id}`
                            ? "Скопировано"
                            : "Копировать"}
                        </button>
                        {message.outgoing && (
                          <>
                            <button
                              type="button"
                              onClick={() => startEdit(message)}
                              title="Изменить"
                              aria-label="Изменить"
                              className="underline underline-offset-2 hover:text-white"
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
                              title="Удалить"
                              aria-label="Удалить"
                              className="text-red-200 underline underline-offset-2 hover:text-red-100"
                            >
                              Удалить
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                  {selecting && message.outgoing && (
                    <SelectionMark checked={isSelected} />
                  )}
                </div>
              </article>
            </Fragment>
          );
        })}
      </div>

      {status && (
        <p className="border-t border-zinc-800 bg-zinc-900/60 px-5 py-1.5 text-xs text-red-300">
          {status}
        </p>
      )}

      {selecting && (
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 bg-zinc-900/70 px-5 py-2 text-xs text-zinc-300">
          <span className="font-medium">Выбрано: {selected.size}</span>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => setForwardIds(selectedIds)}
            title="Переслать выбранные сообщения"
            className="rounded-md border border-zinc-700 px-2 py-1 transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-40"
          >
            Переслать ({selected.size})
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => void copySelected()}
            title="Копировать выбранные сообщения"
            className="rounded-md border border-zinc-700 px-2 py-1 transition-colors hover:border-zinc-500 hover:text-white disabled:opacity-40"
          >
            Копировать
          </button>
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => void deleteSelected()}
            title="Удалить выбранные сообщения"
            className="rounded-md border border-red-900/70 px-2 py-1 text-red-300 transition-colors hover:border-red-600 hover:text-red-200 disabled:opacity-40"
          >
            Удалить
          </button>
          <button
            type="button"
            onClick={exitSelection}
            title="Отменить выбор"
            className="rounded-md border border-zinc-700 px-2 py-1 transition-colors hover:border-zinc-500 hover:text-white"
          >
            Отмена
          </button>
          {copiedKey === "selection" && (
            <span className="text-emerald-400">Скопировано</span>
          )}
        </div>
      )}

      {replyTo && (
        <div className="flex items-start gap-2 border-t border-zinc-800 bg-zinc-900/60 px-5 py-2">
          <div className="min-w-0 flex-1 border-l-2 border-sky-500 pl-2">
            <p className="truncate text-[11px] font-medium text-sky-400">
              Ответ на {replyTo.senderName}
            </p>
            <p className="truncate text-xs text-zinc-400">
              {messagePreview(replyTo)}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setReplyTo(null)}
            title="Отменить ответ"
            aria-label="Отменить ответ"
            className="shrink-0 rounded-md px-1.5 py-0.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        className="border-t border-zinc-800 px-5 py-3"
      >
        {attachment && (
          <div className="mb-2 flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900/70 p-2">
            {attachmentPreview ? (
              <img
                src={attachmentPreview}
                alt={attachment.name}
                className="h-14 w-14 rounded object-cover"
              />
            ) : (
              <span
                aria-hidden="true"
                className="flex h-14 w-14 items-center justify-center rounded bg-zinc-800 text-xl"
              >
                📄
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm text-zinc-100">
                {attachment.name}
              </p>
              <p className="text-xs text-zinc-500">
                {formatFileSize(attachment.size)}
              </p>
            </div>
            <button
              type="button"
              onClick={clearAttachment}
              title="Убрать файл"
              aria-label="Убрать файл"
              className="shrink-0 rounded-md px-2 py-1 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            >
              ✕
            </button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              chooseAttachment(event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="Прикрепить фото или файл"
            aria-label="Прикрепить фото или файл"
            className="rounded-full border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
          >
            📎
          </button>
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => handleDraftChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submit();
              }
              if (event.key === "Escape") setReplyTo(null);
            }}
            placeholder={
              attachment ? "Подпись к файлу…" : `Сообщение в ${chat.title}`
            }
            className="flex-1 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
          />
          <button
            type="submit"
            disabled={!draft.trim() && !attachment}
            className="rounded-full bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-40"
          >
            Отправить
          </button>
        </div>
      </form>

      {forwardIds && (
        <ForwardModal
          chats={forwardTargets}
          accountId={account.id}
          count={forwardIds.length}
          onForward={async (toChatId) => {
            await onForward(toChatId, forwardIds);
            if (selecting) exitSelection();
          }}
          onClose={() => setForwardIds(null)}
        />
      )}
    </section>
  );
}

function MessageMedia({
  message,
  accountId,
  selecting,
}: {
  message: MessageView;
  accountId: string;
  selecting: boolean;
}) {
  const media = message.media;
  if (!media || !media.downloadable) return null;

  const url = mediaUrl(accountId, message.chatId, message.id, media.fileName);

  if (media.kind === "photo") {
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        onClick={(event) => {
          if (selecting) event.preventDefault();
        }}
        className="my-1 block"
        title="Открыть фото"
      >
        <img
          src={url}
          alt={media.fileName ?? "Фото"}
          loading="lazy"
          className="max-h-72 max-w-full rounded-lg object-contain"
        />
      </a>
    );
  }

  if (media.kind === "document") {
    const fileName = media.fileName ?? "Документ";
    return (
      <a
        href={url}
        download={media.fileName ?? undefined}
        onClick={(event) => {
          if (selecting) event.preventDefault();
        }}
        className="my-1 flex max-w-xs items-center gap-3 rounded-lg bg-black/20 px-3 py-2 transition-colors hover:bg-black/30"
        title="Скачать файл"
      >
        <span aria-hidden="true" className="text-xl">
          📄
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{fileName}</span>
          <span className="block text-[11px] opacity-75">
            {formatFileSize(media.size) || media.mimeType || "файл"}
          </span>
        </span>
        <span className="shrink-0 text-[11px] underline underline-offset-2">
          Скачать
        </span>
      </a>
    );
  }

  return null;
}

function SelectionMark({ checked }: { checked: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`mt-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-colors ${
        checked
          ? "border-sky-400 bg-sky-500 text-white"
          : "border-zinc-600 text-transparent"
      }`}
    >
      ✓
    </span>
  );
}
