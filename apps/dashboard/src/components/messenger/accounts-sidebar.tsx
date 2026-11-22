"use client";

import { accountAvatarUrl } from "../../lib/avatar";
import { accountName, sessionSummary } from "../../lib/format";
import type { AccountView } from "../../lib/types";
import { Avatar } from "../avatar";

/** Accounts side of the chats screen: one row per attached Telegram account. */
export function AccountsSidebar({
  accounts,
  loading,
  error,
  selectedId,
  onSelect,
  onAdd,
  onRefresh,
}: {
  accounts: AccountView[];
  loading: boolean;
  error: string | null;
  selectedId: string | null;
  onSelect: (accountId: string) => void;
  onAdd: () => void;
  onRefresh: () => void;
}) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/50">
      <div className="flex items-center justify-between border-b border-zinc-800 px-3 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          Аккаунты
        </h2>
        <div className="flex items-center gap-1">
          {accounts.length > 0 && (
            <span className="text-[11px] text-zinc-500">{accounts.length}</span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            title="Обновить аккаунты"
            className="rounded-md px-1.5 py-0.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:opacity-40"
          >
            ↻
          </button>
        </div>
      </div>

      {error && (
        <div className="m-2 rounded-md border border-red-900/60 bg-red-950/40 p-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {loading && accounts.length === 0 && (
          <p className="px-2 py-4 text-xs text-zinc-500">Загрузка аккаунтов…</p>
        )}

        {!loading && accounts.length === 0 && (
          <p className="px-2 py-4 text-xs text-zinc-500">
            Нет аккаунтов. Добавьте первый.
          </p>
        )}

        {accounts.map((account) => {
          const active = account.id === selectedId;
          return (
            <button
              key={account.id}
              type="button"
              onClick={() => onSelect(account.id)}
              className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
                active
                  ? "bg-sky-500/15 text-zinc-100"
                  : "text-zinc-300 hover:bg-zinc-800"
              }`}
            >
              <Avatar
                src={accountAvatarUrl(account.id)}
                label={accountName(account)}
                className="h-8 w-8 text-[11px]"
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-medium">
                    {accountName(account)}
                  </span>
                  {account.isActive && (
                    <span className="shrink-0 rounded-full bg-emerald-500/20 px-1 py-0.5 text-[9px] font-medium text-emerald-300">
                      active
                    </span>
                  )}
                </span>
                <span className="block truncate text-[11px] text-zinc-500">
                  {account.username ? `@${account.username}` : ""}
                  {account.username && account.phoneMasked ? " · " : ""}
                  {account.phoneMasked ??
                    (account.username ? "" : `ID ${account.tgUserId}`)}
                </span>
                <span className="block truncate text-[11px] text-zinc-600">
                  {sessionSummary(account)}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="border-t border-zinc-800 p-2">
        <button
          type="button"
          onClick={onAdd}
          className="w-full rounded-md bg-sky-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-400"
        >
          + Добавить аккаунт
        </button>
      </div>
    </aside>
  );
}
