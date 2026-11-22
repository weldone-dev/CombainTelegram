"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { ApiError, apiFetch, errorMessage } from "../../lib/api";
import { accountName } from "../../lib/format";
import { loadAccounts, saveAccounts } from "../../lib/offline-cache";
import type { AccountView, RealtimeAuthDoneEvent } from "../../lib/types";
import { useRealtime } from "../../lib/use-realtime";
import { AddAccountModal } from "../messenger/add-account-modal";

interface AppDataValue {
  accounts: AccountView[];
  accountsLoading: boolean;
  accountsError: string | null;
  reloadAccounts: () => Promise<void>;
  upsertAccount: (account: AccountView) => void;
  removeAccountLocally: (accountId: string) => void;
  openAddAccount: () => void;
  notice: string | null;
  showNotice: (message: string) => void;
  realtimeOnline: boolean;
}

const AppDataContext = createContext<AppDataValue | null>(null);

/**
 * Accounts and the single Socket.IO connection live above the pages, so the
 * sidebar keeps its state and realtime events keep arriving while the user is
 * on the accounts or proxies page.
 */
export function AppDataProvider({ children }: { children: ReactNode }) {
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [accountsLoading, setAccountsLoading] = useState(true);
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [addAccountOpen, setAddAccountOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [realtimeOnline, setRealtimeOnline] = useState(false);

  const reloadAccounts = useCallback(async () => {
    setAccountsLoading(true);
    setAccountsError(null);
    try {
      const list = await apiFetch<AccountView[]>("/accounts", {});
      setAccounts(list);
      saveAccounts(list);
    } catch (error) {
      // The API being unreachable looks the same as a real offline load from
      // the browser's point of view, so the cached sidebar still renders.
      const networkDown =
        (typeof navigator !== "undefined" && !navigator.onLine) ||
        (error instanceof ApiError && error.code === "NETWORK_ERROR");
      const cached = networkDown ? loadAccounts() : null;
      if (cached && cached.length > 0) {
        setAccounts(cached);
        setAccountsError(null);
      } else {
        setAccountsError(errorMessage(error));
      }
    } finally {
      setAccountsLoading(false);
    }
  }, []);

  const upsertAccount = useCallback((account: AccountView) => {
    setAccounts((previous) =>
      previous.some((item) => item.id === account.id)
        ? previous.map((item) => (item.id === account.id ? account : item))
        : [...previous, account],
    );
  }, []);

  const removeAccountLocally = useCallback((accountId: string) => {
    setAccounts((previous) =>
      previous.filter((account) => account.id !== accountId),
    );
  }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
  }, []);

  const handleAuthDone = useCallback(
    (payload: RealtimeAuthDoneEvent) => {
      upsertAccount(payload.account);
      setNotice(`Аккаунт ${accountName(payload.account)} добавлен`);
    },
    [upsertAccount],
  );

  useRealtime({
    onAuthDone: handleAuthDone,
    onConnect: () => setRealtimeOnline(true),
    onDisconnect: () => setRealtimeOnline(false),
  });

  useEffect(() => {
    void reloadAccounts();
  }, [reloadAccounts]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  const handleAccountsAdded = useCallback(
    (added: AccountView[]) => {
      for (const account of added) upsertAccount(account);
      setAddAccountOpen(false);
      setNotice(
        added.length === 1
          ? `Аккаунт ${accountName(added[0])} добавлен`
          : `Добавлено аккаунтов: ${added.length}`,
      );
    },
    [upsertAccount],
  );

  return (
    <AppDataContext.Provider
      value={{
        accounts,
        accountsLoading,
        accountsError,
        reloadAccounts,
        upsertAccount,
        removeAccountLocally,
        openAddAccount: () => setAddAccountOpen(true),
        notice,
        showNotice,
        realtimeOnline,
      }}
    >
      {children}

      {addAccountOpen && (
        <AddAccountModal
          onClose={() => setAddAccountOpen(false)}
          onAccountsAdded={handleAccountsAdded}
        />
      )}
    </AppDataContext.Provider>
  );
}

export function useAppData(): AppDataValue {
  const value = useContext(AppDataContext);
  if (!value) {
    throw new Error("useAppData must be used inside AppDataProvider");
  }
  return value;
}
