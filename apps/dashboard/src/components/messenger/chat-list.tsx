"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api";
import { chatAvatarUrl } from "../../lib/avatar";
import { formatDay } from "../../lib/format";
import { MAX_CHAT_LIMIT } from "../../lib/messaging-api";
import type {
  ChatFolderSelection,
  ChatPatch,
  ChatView,
  FolderView,
} from "../../lib/types";
import { Avatar } from "../avatar";
import { AiAccessMenu } from "./ai-access-menu";
import { useAiAccess } from "./ai-access-store";
import { ChatActionsMenu, type ChatMenuAction } from "./chat-actions-menu";
import { ChatFolderTabs } from "./chat-folder-tabs";
import { ChatSearchPanel } from "./chat-search-panel";
import { GlobalSearchModal } from "./global-search-modal";
import { NewChatModal } from "./new-chat-modal";

const HEADER_BUTTON =
  "rounded-md border border-zinc-800 bg-zinc-800/40 px-2 py-1 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40";

export function ChatList({
  chats,
  loading,
  error,
  selectedId,
  onSelect,
  accountLabel,
  accountId,
  hasAccount,
  onRefresh,
  folders,
  foldersLoading,
  selectedFolder,
  onSelectFolder,
  canLoadMore,
  loadingMore,
  onLoadMore,
  onUpdateChat,
  onMarkRead,
  onClearHistory,
  onDeleteChat,
  onReadAll,
  onOpenChat,
  onOpenMessage,
  onResolveUsername,
}: {
  chats: ChatView[];
  loading: boolean;
  error: string | null;
  selectedId: number | null;
  onSelect: (chatId: number) => void;
  accountLabel: string;
  accountId: string | null;
  hasAccount: boolean;
  onRefresh: () => void;
  folders: FolderView[];
  foldersLoading: boolean;
  selectedFolder: ChatFolderSelection;
  onSelectFolder: (selection: ChatFolderSelection) => void;
  canLoadMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  onUpdateChat: (chatId: number, patch: ChatPatch) => Promise<void>;
  onMarkRead: (chatId: number) => Promise<void>;
  onClearHistory: (chatId: number) => Promise<void>;
  /** `everyone=false` deletes only this account's copy; `true` revokes it for all. */
  onDeleteChat: (chatId: number, everyone: boolean) => Promise<void>;
  onReadAll: () => Promise<void>;
  /** Adds the chat to the list when missing and selects it. */
  onOpenChat: (chat: ChatView) => void;
  /** Opens a message of the already selected chat without reloading it. */
  onOpenMessage: (chatId: number, messageId: number) => void;
  /** Resolves `@name`/`name`/`t.me/name`; rejects on failure. */
  onResolveUsername: (username: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const filterTouched = useRef(false);
  const [menuId, setMenuId] = useState<number | null>(null);
  const [aiMenu, setAiMenu] = useState<{
    chatId: number;
    x: number;
    y: number;
  } | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [readAllBusy, setReadAllBusy] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [inChatSearchOpen, setInChatSearchOpen] = useState(false);
  const { statusFor, error: aiError } = useAiAccess();

  // Folder state is per account; every account-scoped surface starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on account switch
  useEffect(() => {
    setFilter("");
    filterTouched.current = false;
    setMenuId(null);
    setAiMenu(null);
    setBusyId(null);
    setActionError(null);
    setInChatSearchOpen(false);
    setNewChatOpen(false);
    setGlobalSearchOpen(false);
  }, [accountId]);

  // The in-chat search needs an open chat.
  useEffect(() => {
    if (selectedId === null) setInChatSearchOpen(false);
  }, [selectedId]);

  // Chrome/Safari and password managers sometimes write a saved value into a
  // plain text input without a keypress, and occasionally without React's
  // `onChange`. The filter is never persisted, so any value that appears
  // before the user touches the field is injected: drop it.
  useEffect(() => {
    const dropInjected = () => {
      if (filterTouched.current) return;
      const input = filterRef.current;
      if (!input) return;
      if (input.value !== "") input.value = "";
      setFilter("");
    };
    const timers = [0, 300, 1200].map((ms) =>
      window.setTimeout(dropInjected, ms),
    );
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);

  const selectedChat = chats.find((chat) => chat.id === selectedId) ?? null;

  const runAction = async (chat: ChatView, action: ChatMenuAction) => {
    if (busyId !== null) return;
    if (
      action === "clear" &&
      !window.confirm(
        `Очистить историю чата «${chat.title}»? Сообщения будут удалены только у вас, у других участников они останутся.`,
      )
    ) {
      return;
    }
    if (
      action === "delete" &&
      !window.confirm(
        `Удалить чат «${chat.title}» у себя? История и диалог исчезнут только на вашем аккаунте.`,
      )
    ) {
      return;
    }
    if (
      action === "delete-all" &&
      !window.confirm(
        `Удалить чат «${chat.title}» у всех? История будет удалена у всех участников, действие необратимо.`,
      )
    ) {
      return;
    }
    setBusyId(chat.id);
    setActionError(null);
    try {
      switch (action) {
        case "pin":
          await onUpdateChat(chat.id, { pinned: !chat.pinned });
          break;
        case "mute":
          await onUpdateChat(chat.id, { muted: !chat.muted });
          break;
        case "unread":
          await onUpdateChat(chat.id, { unread: true });
          break;
        case "read":
          await onMarkRead(chat.id);
          break;
        case "clear":
          await onClearHistory(chat.id);
          break;
        case "delete":
          await onDeleteChat(chat.id, false);
          break;
        case "delete-all":
          await onDeleteChat(chat.id, true);
          break;
      }
      setMenuId(null);
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setBusyId(null);
    }
  };

  const readAll = async () => {
    if (readAllBusy) return;
    setReadAllBusy(true);
    setActionError(null);
    try {
      await onReadAll();
    } catch (caught) {
      setActionError(errorMessage(caught));
    } finally {
      setReadAllBusy(false);
    }
  };

  const needle = filter.trim().toLowerCase();
  const visibleChats = needle
    ? chats.filter(
        (chat) =>
          chat.title.toLowerCase().includes(needle) ||
          (chat.username ?? "").toLowerCase().includes(needle),
      )
    : chats;

  return (
    <section className="flex w-80 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/30">
      <div className="border-b border-zinc-800">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-200">Чаты</h2>
            <p className="truncate text-[11px] text-zinc-500">{accountLabel}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {chats.length > 0 && (
              <span className="text-[11px] text-zinc-500">
                {needle
                  ? `${visibleChats.length}/${chats.length}`
                  : chats.length}
              </span>
            )}
            <button
              type="button"
              onClick={onRefresh}
              title="Обновить чаты и папки"
              aria-label="Обновить чаты и папки"
              disabled={!hasAccount || loading}
              className="rounded-md px-1.5 py-0.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            >
              ↻
            </button>
          </div>
        </div>

        {hasAccount && (
          <div className="flex flex-wrap gap-1 px-3 pb-2">
            <button
              type="button"
              onClick={() => setNewChatOpen(true)}
              title="Открыть чат по username"
              className={HEADER_BUTTON}
            >
              + Новый чат
            </button>
            <button
              type="button"
              onClick={() => setGlobalSearchOpen(true)}
              title="Глобальный поиск по чатам и пользователям"
              className={HEADER_BUTTON}
            >
              🔍 Поиск
            </button>
            <button
              type="button"
              onClick={() => setInChatSearchOpen((open) => !open)}
              disabled={selectedId === null}
              aria-pressed={inChatSearchOpen}
              title={
                selectedId === null
                  ? "Сначала откройте чат"
                  : "Поиск сообщений в открытом чате"
              }
              className={`${HEADER_BUTTON} ${
                inChatSearchOpen ? "border-sky-500/40 text-sky-300" : ""
              }`}
            >
              ⌕ В чате
            </button>
            <button
              type="button"
              onClick={() => void readAll()}
              disabled={readAllBusy || loading || chats.length === 0}
              title="Отметить все чаты прочитанными"
              className={HEADER_BUTTON}
            >
              {readAllBusy ? "…" : "✓✓ Прочитать всё"}
            </button>
          </div>
        )}
      </div>

      {hasAccount && (
        <ChatFolderTabs
          folders={folders}
          selected={selectedFolder}
          loading={foldersLoading}
          onSelect={onSelectFolder}
        />
      )}

      {hasAccount && (
        <div className="border-b border-zinc-800 px-3 py-2">
          <div className="relative">
            <input
              ref={filterRef}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              onPointerDown={() => {
                filterTouched.current = true;
              }}
              onKeyDown={() => {
                filterTouched.current = true;
              }}
              onPaste={() => {
                filterTouched.current = true;
              }}
              type="search"
              name="combain-chat-filter"
              placeholder={`Фильтр загруженных чатов (до ${MAX_CHAT_LIMIT})`}
              aria-label="Фильтр загруженных чатов по названию или @username"
              className="w-full appearance-none rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 pr-7 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="search"
              data-1p-ignore="true"
              data-lpignore="true"
              data-bwignore="true"
              data-form-type="other"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter("")}
                title="Сбросить фильтр"
                aria-label="Сбросить фильтр"
                className="absolute top-1/2 right-1.5 -translate-y-1/2 rounded px-1 text-xs text-zinc-500 hover:text-zinc-200"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      )}

      {actionError && (
        <p className="border-b border-zinc-800 bg-red-950/40 px-4 py-2 text-[11px] text-red-300">
          {actionError}
        </p>
      )}

      {aiError && (
        <p
          role="alert"
          className="border-b border-zinc-800 bg-red-950/40 px-4 py-2 text-[11px] text-red-300"
        >
          {aiError}
        </p>
      )}

      {hasAccount &&
        inChatSearchOpen &&
        selectedId !== null &&
        selectedChat &&
        accountId && (
          <ChatSearchPanel
            key={selectedId}
            accountId={accountId}
            chatId={selectedId}
            chatTitle={selectedChat.title}
            onOpenChat={onOpenMessage}
          />
        )}

      <div className="flex-1 overflow-y-auto">
        {!hasAccount && (
          <p className="px-4 py-4 text-sm text-zinc-500">
            Выберите аккаунт слева, чтобы увидеть его чаты.
          </p>
        )}

        {hasAccount && loading && chats.length === 0 && (
          <p className="px-4 py-4 text-sm text-zinc-500">Загрузка чатов…</p>
        )}

        {hasAccount && error && (
          <p className="px-4 py-4 text-sm text-red-300">{error}</p>
        )}

        {hasAccount && !loading && !error && chats.length === 0 && (
          <p className="px-4 py-4 text-sm text-zinc-500">
            {selectedFolder.kind === "archive"
              ? "В архиве нет чатов."
              : selectedFolder.kind === "folder"
                ? "В этой папке нет чатов."
                : "Чаты не найдены."}
          </p>
        )}

        {hasAccount && chats.length > 0 && visibleChats.length === 0 && (
          <p className="px-4 py-4 text-sm text-zinc-500">
            Ничего не найдено по запросу «{filter.trim()}».
          </p>
        )}

        {visibleChats.map((chat) => {
          const active = chat.id === selectedId;
          const last = chat.lastMessage;
          const ai = statusFor(chat.id);
          const blocked = ai?.blocked ?? false;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: right-click opens the same AI menu that the row's ⋯ button and header chip expose.
            <div
              key={chat.id}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenuId(null);
                setAiMenu({
                  chatId: chat.id,
                  x: Math.max(
                    8,
                    Math.min(event.clientX, window.innerWidth - 248),
                  ),
                  y: Math.max(
                    8,
                    Math.min(event.clientY, window.innerHeight - 240),
                  ),
                });
              }}
              className={`flex items-stretch border-b border-zinc-800/60 border-l-2 transition-colors ${
                blocked
                  ? active
                    ? "border-l-red-700/80 bg-red-950/45"
                    : "border-l-red-700/80 bg-red-950/25 hover:bg-red-950/40"
                  : `${active ? "border-l-transparent bg-sky-500/10" : "border-l-transparent hover:bg-zinc-800/60"}`
              }`}
            >
              <button
                type="button"
                onClick={() => onSelect(chat.id)}
                title={`Открыть чат ${chat.title}`}
                className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left"
              >
                <Avatar
                  src={accountId ? chatAvatarUrl(accountId, chat.id) : null}
                  label={chat.title}
                  className="h-10 w-10 text-sm"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="flex min-w-0 items-center gap-1">
                      {chat.pinned && (
                        <span
                          aria-hidden="true"
                          title="Закреплён"
                          className="shrink-0 text-[10px]"
                        >
                          📌
                        </span>
                      )}
                      {blocked && (
                        <span
                          title={
                            ai?.reason
                              ? `ИИ заблокирован: ${ai.reason}`
                              : "ИИ заблокирован"
                          }
                          className="shrink-0 text-red-400"
                        >
                          <AiBlockedIcon />
                        </span>
                      )}
                      {!blocked && ai?.allowed && (
                        <span
                          title="ИИ разрешён"
                          className="shrink-0 text-sky-400"
                        >
                          <AiSparkleIcon />
                        </span>
                      )}
                      <span
                        className={`truncate text-sm font-medium ${
                          blocked ? "text-red-200" : "text-zinc-100"
                        }`}
                      >
                        {chat.title}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-500">
                      {last ? formatDay(last.date) : ""}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span
                      className={`truncate text-xs ${
                        blocked ? "text-red-300/80" : "text-zinc-400"
                      }`}
                    >
                      {last
                        ? last.text || `(${last.mediaType ?? "медиа"})`
                        : "Нет сообщений"}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      {chat.muted && (
                        <span
                          aria-hidden="true"
                          title="Без звука"
                          className="text-[10px] text-zinc-500"
                        >
                          🔇
                        </span>
                      )}
                      {chat.unreadCount > 0 && (
                        <span
                          className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold text-white ${
                            chat.muted ? "bg-zinc-600" : "bg-sky-500"
                          }`}
                        >
                          {chat.unreadCount}
                        </span>
                      )}
                    </span>
                  </span>
                </span>
              </button>

              <div className="relative flex items-start pt-2 pr-1.5">
                <button
                  type="button"
                  data-chat-menu-toggle
                  onClick={() =>
                    setMenuId((current) =>
                      current === chat.id ? null : chat.id,
                    )
                  }
                  disabled={busyId !== null}
                  aria-haspopup="menu"
                  aria-expanded={menuId === chat.id}
                  aria-label={`Действия с чатом ${chat.title}`}
                  title="Действия с чатом"
                  className="rounded-md px-1.5 py-0.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-700 hover:text-zinc-100 disabled:opacity-40"
                >
                  {busyId === chat.id ? "…" : "⋯"}
                </button>
                {menuId === chat.id && (
                  <ChatActionsMenu
                    chat={chat}
                    busy={busyId !== null}
                    onAction={(action) => void runAction(chat, action)}
                    onClose={() => setMenuId(null)}
                  />
                )}
              </div>
            </div>
          );
        })}

        {hasAccount && canLoadMore && !error && (
          <div className="p-2">
            <button
              type="button"
              onClick={onLoadMore}
              disabled={loadingMore || loading}
              title="Загрузить больше чатов"
              className="w-full rounded-md border border-zinc-800 bg-zinc-800/40 px-3 py-1.5 text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
            >
              {loadingMore ? "Загрузка…" : "Показать ещё"}
            </button>
          </div>
        )}
      </div>

      {aiMenu && (
        <AiAccessMenu
          chatId={aiMenu.chatId}
          chatTitle={
            chats.find((chat) => chat.id === aiMenu.chatId)?.title ?? "чат"
          }
          state={statusFor(aiMenu.chatId)}
          position={{ x: aiMenu.x, y: aiMenu.y }}
          onClose={() => setAiMenu(null)}
        />
      )}

      {newChatOpen && accountId && (
        <NewChatModal
          onResolve={onResolveUsername}
          onClose={() => setNewChatOpen(false)}
        />
      )}

      {globalSearchOpen && accountId && (
        <GlobalSearchModal
          accountId={accountId}
          onOpenChat={onOpenChat}
          onOpenUser={onResolveUsername}
          onClose={() => setGlobalSearchOpen(false)}
        />
      )}
    </section>
  );
}

/** Small sparkle shown on a row where the AI is explicitly allowed. */
function AiSparkleIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3.5 w-3.5 fill-current"
    >
      <path d="M12 2.5 14 9l6.5 2-6.5 2-2 6.5-2-6.5L3.5 11 10 9z" />
    </svg>
  );
}

/** Red shield with a slash: unmistakable blacklist marker. */
function AiBlockedIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3.5 w-3.5 stroke-current"
      fill="none"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3 4.5 6v5.5c0 4.2 3 7.9 7.5 9.5 4.5-1.6 7.5-5.3 7.5-9.5V6z" />
      <path d="m4 4 16 16" />
    </svg>
  );
}
