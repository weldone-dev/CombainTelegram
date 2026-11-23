"use client";

import Link from "next/link";
import { Fragment, useEffect, useState } from "react";
import { apiFetch, errorMessage } from "../../lib/api";
import { accountAvatarUrl } from "../../lib/avatar";
import { accountName, activeSession, sessionSummary } from "../../lib/format";
import type { AccountView, ProxyView } from "../../lib/types";
import { Avatar } from "../avatar";
import { EngineBadge } from "../engine-badge";
import { SessionsModal } from "../messenger/sessions-modal";
import { ProxyInfo } from "../proxy-info";
import { useAppData } from "./app-data";
import { TdlibAccountPanel } from "./tdlib-account-panel";

export function AccountsPage() {
  const {
    accounts,
    accountsLoading,
    accountsError,
    reloadAccounts,
    upsertAccount,
    removeAccountLocally,
    openAddAccount,
    showNotice,
  } = useAppData();

  const [query, setQuery] = useState("");
  const [sessionsAccount, setSessionsAccount] = useState<AccountView | null>(
    null,
  );
  const [tdlibAccountId, setTdlibAccountId] = useState<string | null>(null);
  const [proxyList, setProxyList] = useState<ProxyView[]>([]);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Proxy names are needed for the chip before the sessions modal is opened.
  useEffect(() => {
    let cancelled = false;
    apiFetch<ProxyView[]>("/proxies", {})
      .then((list) => {
        if (!cancelled) setProxyList(list);
      })
      .catch(() => {
        // The chip falls back to «Напрямую»; the modal loads the list itself.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visible = accounts.filter((account) => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [accountName(account), account.username, account.phone]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });

  const openSessions = async (account: AccountView) => {
    try {
      setProxyList(await apiFetch<ProxyView[]>("/proxies", {}));
    } catch {
      setProxyList([]);
    }
    setSessionsAccount(account);
  };

  const removeAccount = async (account: AccountView) => {
    const confirmed = window.confirm(
      `Удалить аккаунт «${accountName(account)}»?\n\nСессии будут завершены и в Telegram, и локально.`,
    );
    if (!confirmed) return;
    setDeletingId(account.id);
    try {
      await apiFetch(`/accounts/${account.id}?revokeSession=true`, {
        method: "DELETE",
      });
      removeAccountLocally(account.id);
      showNotice(`Аккаунт ${accountName(account)} удалён`);
    } catch (error) {
      showNotice(errorMessage(error));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Поиск по имени, @username или телефону"
            className="min-w-56 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-sky-500"
          />
          <button
            type="button"
            onClick={() => void reloadAccounts()}
            disabled={accountsLoading}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500 disabled:opacity-40"
          >
            {accountsLoading ? "Обновление…" : "Обновить"}
          </button>
          <button
            type="button"
            onClick={openAddAccount}
            className="rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400"
          >
            + Добавить аккаунт
          </button>
        </div>

        {accountsError && (
          <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {accountsError}
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Список аккаунтов
            </h2>
            <span className="text-xs text-zinc-500">
              Всего: {accounts.length}
            </span>
          </div>

          {accountsLoading && accounts.length === 0 && (
            <p className="px-4 py-6 text-sm text-zinc-500">
              Загрузка аккаунтов…
            </p>
          )}

          {!accountsLoading && accounts.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-zinc-400">
                Пока нет подключённых аккаунтов Telegram.
              </p>
              <button
                type="button"
                onClick={openAddAccount}
                className="mt-3 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400"
              >
                + Добавить аккаунт
              </button>
            </div>
          )}

          {!accountsLoading && accounts.length > 0 && visible.length === 0 && (
            <p className="px-4 py-6 text-sm text-zinc-500">
              Ничего не найдено.
            </p>
          )}

          {visible.map((account) => {
            const active = activeSession(account);
            return (
              <Fragment key={account.id}>
                <div className="flex flex-wrap items-center gap-4 border-b border-zinc-800 px-4 py-3 transition-colors last:border-b-0 hover:bg-zinc-800/40">
                  <Avatar
                    src={accountAvatarUrl(account.id)}
                    label={accountName(account)}
                    className="h-11 w-11 text-sm"
                  />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-zinc-100">
                        {accountName(account)}
                      </p>
                      {account.isActive && (
                        <span className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                          active
                        </span>
                      )}
                      {active && <EngineBadge engine={active.engine} />}
                    </div>
                    <p className="truncate text-xs text-zinc-500">
                      {account.phone
                        ? `${account.username ? `@${account.username} · ` : ""}${account.phone}`
                        : account.username
                          ? `@${account.username}`
                          : `ID ${account.tgUserId}`}
                    </p>
                    <p className="truncate text-xs text-zinc-500">
                      {sessionSummary(account)}
                    </p>
                    {active && (
                      <div className="mt-1.5 flex">
                        <ProxyInfo
                          proxy={
                            proxyList.find(
                              (proxy) => proxy.id === active.proxyId,
                            ) ?? null
                          }
                          assigned={Boolean(active.proxyId)}
                          onActivate={() => void openSessions(account)}
                        />
                      </div>
                    )}
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <Link
                      href={`/chats?account=${account.id}`}
                      className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                    >
                      Чаты
                    </Link>
                    <button
                      type="button"
                      onClick={() =>
                        setTdlibAccountId((current) =>
                          current === account.id ? null : account.id,
                        )
                      }
                      className={`rounded-md border px-2.5 py-1.5 text-xs transition-colors ${
                        tdlibAccountId === account.id
                          ? "border-sky-500 text-sky-300"
                          : "border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-zinc-100"
                      }`}
                    >
                      TDLib
                    </button>
                    <button
                      type="button"
                      onClick={() => void openSessions(account)}
                      className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                    >
                      Сессии и прокси
                    </button>
                    <button
                      type="button"
                      onClick={() => void removeAccount(account)}
                      disabled={deletingId === account.id}
                      className="rounded-md border border-red-900/60 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:border-red-600 disabled:opacity-40"
                    >
                      {deletingId === account.id ? "Удаление…" : "Удалить"}
                    </button>
                  </div>
                </div>

                {tdlibAccountId === account.id && (
                  <TdlibAccountPanel
                    account={account}
                    onClose={() => setTdlibAccountId(null)}
                    onMigrated={() => void reloadAccounts()}
                    onNotice={showNotice}
                  />
                )}
              </Fragment>
            );
          })}
        </div>
      </div>

      {sessionsAccount && (
        <SessionsModal
          account={sessionsAccount}
          proxies={proxyList}
          onClose={() => setSessionsAccount(null)}
          onUpdated={upsertAccount}
          onNotice={showNotice}
          onAccountRemoved={removeAccountLocally}
        />
      )}
    </div>
  );
}
