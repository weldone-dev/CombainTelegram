"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api";
import { chatAvatarUrl } from "../../lib/avatar";
import { formatTime } from "../../lib/format";
import { listMessageThread, sendMessageComment } from "../../lib/messaging-api";
import { subscribeRealtime } from "../../lib/realtime-bus";
import type {
  MessageThreadView,
  MessageView,
  RealtimeMessageEvent,
} from "../../lib/types";
import { Avatar } from "../avatar";
import { AiAccessSection } from "./ai-access-section";

const COMMENT_LIMIT = 30;
/** Mirrors the API validation; Telegram rejects longer texts. */
const MAX_COMMENT_LENGTH = 4096;

/**
 * Right-side comments drawer of one channel post.
 *
 * The API returns comments newest first; the drawer renders them oldest first
 * (like a conversation) and "Показать ещё" at the top fetches the next, older
 * page by passing the oldest loaded id as `offsetId`.
 */
export function CommentThreadDrawer({
  accountId,
  chatId,
  messageId,
  title,
  onClose,
  onCommentSent,
}: {
  accountId: string;
  chatId: number;
  messageId: number;
  /** Channel title shown in the header. */
  title: string;
  onClose: () => void;
  /** Bumps the comment counter under the post after a successful send. */
  onCommentSent?: (comment: MessageView) => void;
}) {
  const [thread, setThread] = useState<MessageThreadView | null>(null);
  const [comments, setComments] = useState<MessageView[]>([]);
  const [nextOffsetId, setNextOffsetId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const sendingRef = useRef(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const result = await listMessageThread(accountId, chatId, messageId, {
        limit: COMMENT_LIMIT,
      });
      if (request !== requestRef.current) return;
      setThread(result);
      setComments(result.comments);
      setNextOffsetId(result.nextOffsetId);
    } catch (caught) {
      if (request !== requestRef.current) return;
      setError(errorMessage(caught));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [accountId, chatId, messageId]);

  useEffect(() => {
    void load();
  }, [load]);

  // New comments arrive as regular messages in the discussion chat: prepend
  // them without refetching, so pagination and the composer stay untouched.
  useEffect(() => {
    const discussionChatId = thread?.discussionChatId ?? null;
    if (discussionChatId === null) return;
    return subscribeRealtime(({ event, payload }) => {
      if (event !== "message.new") return;
      const data = payload as RealtimeMessageEvent;
      if (data.accountId !== accountId || data.chatId !== discussionChatId) {
        return;
      }
      const incoming = data.message;
      if (incoming.id === messageId) return;
      setComments((previous) =>
        previous.some((comment) => comment.id === incoming.id)
          ? previous
          : [incoming, ...previous],
      );
    });
  }, [accountId, messageId, thread?.discussionChatId]);

  const loadMore = async () => {
    if (nextOffsetId === null || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const result = await listMessageThread(accountId, chatId, messageId, {
        limit: COMMENT_LIMIT,
        offsetId: nextOffsetId,
      });
      setComments((previous) => {
        const seen = new Set(previous.map((comment) => comment.id));
        const older = result.comments.filter(
          (comment) => !seen.has(comment.id),
        );
        return [...previous, ...older];
      });
      setNextOffsetId(result.nextOffsetId);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingMore(false);
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || sendingRef.current) return;
    if (text.length > MAX_COMMENT_LENGTH) {
      setComposerError(`Комментарий длиннее ${MAX_COMMENT_LENGTH} символов`);
      return;
    }
    sendingRef.current = true;
    setSending(true);
    setComposerError(null);
    try {
      const created = await sendMessageComment(
        accountId,
        chatId,
        messageId,
        text,
      );
      setComments((previous) =>
        previous.some((comment) => comment.id === created.id)
          ? previous
          : [created, ...previous],
      );
      setDraft("");
      onCommentSent?.(created);
      // The new comment is the oldest-in-viewport? It is the newest, so scroll
      // to the bottom where the composer is.
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ block: "end" });
      });
    } catch (caught) {
      setComposerError(errorMessage(caught));
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  // Close on Escape, like the other overlays.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Oldest first for display.
  const ordered = [...comments].reverse();
  const noDiscussion = !loading && thread?.discussionChatId === null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button
        type="button"
        onClick={onClose}
        aria-label="Закрыть комментарии"
        className="absolute inset-0 cursor-default bg-black/50"
      />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
        <header className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-zinc-100">
              Комментарии
            </p>
            <p className="truncate text-xs text-zinc-500">
              {title}
              {thread && thread.discussionChatId !== null
                ? ` · ${thread.comments.length}`
                : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть комментарии"
            className="shrink-0 rounded-md px-2 py-1 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </header>

        <div className="max-h-[48vh] overflow-y-auto border-b border-zinc-800 px-4 py-3">
          <AiAccessSection
            accountId={accountId}
            chatId={chatId}
            threadId={messageId}
            threadLabel={`пост #${messageId}`}
            allowWholeChat
          />
        </div>

        <div
          ref={listRef}
          className="flex-1 space-y-3 overflow-y-auto px-4 py-3"
        >
          {nextOffsetId !== null && (
            <div className="flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-500 disabled:opacity-50"
              >
                {loadingMore ? "Загрузка…" : "Показать ещё"}
              </button>
            </div>
          )}

          {loading && (
            <p className="text-center text-sm text-zinc-500">
              Загрузка комментариев…
            </p>
          )}
          {error && <p className="text-center text-sm text-red-300">{error}</p>}
          {noDiscussion && (
            <p className="text-center text-sm text-zinc-500">
              У этого поста нет обсуждения.
            </p>
          )}
          {!loading && !error && !noDiscussion && ordered.length === 0 && (
            <p className="text-center text-sm text-zinc-500">
              Комментариев пока нет.
            </p>
          )}

          {ordered.map((comment) => (
            <CommentRow
              key={comment.id}
              accountId={accountId}
              comment={comment}
            />
          ))}
          <div ref={bottomRef} />
        </div>

        {thread?.discussionChatId !== null &&
          thread?.discussionChatId !== undefined && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
              className="border-t border-zinc-800 px-4 py-3"
            >
              {composerError && (
                <p className="mb-1 text-xs text-red-300">{composerError}</p>
              )}
              <div className="flex items-center gap-2">
                <input
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  placeholder="Написать комментарий…"
                  disabled={sending}
                  className="flex-1 rounded-full border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500 disabled:opacity-60"
                  autoComplete="off"
                />
                <button
                  type="submit"
                  disabled={sending || !draft.trim()}
                  className="rounded-full bg-sky-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400 disabled:opacity-40"
                >
                  {sending ? "Отправка…" : "Отправить"}
                </button>
              </div>
            </form>
          )}
      </aside>
    </div>
  );
}

function CommentRow({
  accountId,
  comment,
}: {
  accountId: string;
  comment: MessageView;
}) {
  const preview = comment.text.trim() || comment.mediaType || "без текста";
  return (
    <div className="flex items-start gap-2">
      <Avatar
        src={chatAvatarUrl(accountId, comment.senderId)}
        label={comment.senderName}
        className="h-8 w-8 text-[11px]"
      />
      <div className="min-w-0 flex-1 rounded-xl bg-zinc-900 px-3 py-2">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-xs font-medium text-sky-400">
            {comment.senderName}
          </span>
          <span className="shrink-0 text-[10px] text-zinc-500">
            {formatTime(comment.date)}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-zinc-100">
          {preview}
        </p>
      </div>
    </div>
  );
}
