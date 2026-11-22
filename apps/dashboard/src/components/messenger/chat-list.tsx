"use client";

import { chatAvatarUrl } from "../../lib/avatar";
import { formatDay } from "../../lib/format";
import type { ChatView } from "../../lib/types";
import { Avatar } from "../avatar";

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
}) {
  return (
    <section className="flex w-80 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/30">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-200">Чаты</h2>
          <p className="truncate text-[11px] text-zinc-500">{accountLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {chats.length > 0 && (
            <span className="text-[11px] text-zinc-500">{chats.length}</span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            title="Обновить чаты"
            disabled={!hasAccount || loading}
            className="rounded-md px-1.5 py-0.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
          >
            ↻
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!hasAccount && (
          <p className="px-4 py-4 text-sm text-zinc-500">
            Выберите аккаунт слева, чтобы увидеть его чаты.
          </p>
        )}

        {hasAccount && loading && (
          <p className="px-4 py-4 text-sm text-zinc-500">Загрузка чатов…</p>
        )}

        {hasAccount && error && (
          <p className="px-4 py-4 text-sm text-red-300">{error}</p>
        )}

        {hasAccount && !loading && !error && chats.length === 0 && (
          <p className="px-4 py-4 text-sm text-zinc-500">Чаты не найдены.</p>
        )}

        {chats.map((chat) => {
          const active = chat.id === selectedId;
          const last = chat.lastMessage;
          return (
            <button
              key={chat.id}
              type="button"
              onClick={() => onSelect(chat.id)}
              className={`flex w-full items-start gap-3 border-b border-zinc-800/60 px-4 py-3 text-left transition-colors ${
                active ? "bg-sky-500/10" : "hover:bg-zinc-800/60"
              }`}
            >
              <Avatar
                src={accountId ? chatAvatarUrl(accountId, chat.id) : null}
                label={chat.title}
                className="h-10 w-10 text-sm"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-sm font-medium text-zinc-100">
                    {chat.title}
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
                  {chat.unreadCount > 0 && (
                    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-sky-500 px-1.5 text-[11px] font-semibold text-white">
                      {chat.unreadCount}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
