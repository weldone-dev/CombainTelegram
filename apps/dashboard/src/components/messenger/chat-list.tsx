"use client";

import { useEffect, useState } from "react";
import { errorMessage } from "../../lib/api";
import { chatAvatarUrl } from "../../lib/avatar";
import { formatDay } from "../../lib/format";
import type {
  ChatFolderSelection,
  ChatPatch,
  ChatView,
  FolderView,
} from "../../lib/types";
import { Avatar } from "../avatar";
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
  onDeleteChat: (chatId: number) => Promise<void>;
  onReadAll: () => Promise<void>;
  /** Adds the chat to the list when missing and selects it. */
  onOpenChat: (chat: ChatView) => void;
  /** Resolves `@name`/`name`/`t.me/name`; rejects on failure. */
  onResolveUsername: (username: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [menuId, setMenuId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [readAllBusy, setReadAllBusy] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  const [inChatSearchOpen, setInChatSearchOpen] = useState(false);

  // Folder state is per account; every account-scoped surface starts clean.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets on account switch
  useEffect(() => {
    setFilter("");
    setMenuId(null);
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

  const selectedChat = chats.find((chat) => chat.id === selectedId) ?? null;

  const runAction = async (chat: ChatView, action: ChatMenuAction) => {
    if (busyId !== null) return;
    if (
      action === "clear" &&
      !window.confirm(
        `Очистить историю чата «${chat.title}»? Сообщения будут удалены у всех участников.`,
      )
    ) {
      return;
    }
    if (
      action === "delete" &&
      !window.confirm(`Удалить чат «${chat.title}»? Действие необратимо.`)
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
          await onDeleteChat(chat.id);
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
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Фильтр по названию или @username"
              aria-label="Фильтр загруженных чатов"
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 pr-7 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
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
            onOpenChat={onSelect}
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
          return (
            <div
              key={chat.id}
              className={`flex items-stretch border-b border-zinc-800/60 transition-colors ${
                active ? "bg-sky-500/10" : "hover:bg-zinc-800/60"
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
                      <span className="truncate text-sm font-medium text-zinc-100">
                        {chat.title}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] text-zinc-500">
                      {last ? formatDay(last.date) : ""}
                    </span>
                  </span>
                  <span className="mt-0.5 flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-zinc-400">
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
