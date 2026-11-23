"use client";

import { useState } from "react";
import { apiFetch, errorMessage } from "../../lib/api";
import { accountName, activeSession } from "../../lib/format";
import type { AccountView, ProxyView } from "../../lib/types";
import { EngineBadge } from "../engine-badge";

/**
 * Per-session proxy assignment. A Telegram account can have several sessions
 * (desktop, phone, ...) and each one keeps its own proxy.
 */
export function SessionsModal({
  account,
  proxies,
  onClose,
  onUpdated,
}: {
  account: AccountView;
  proxies: ProxyView[];
  onClose: () => void;
  onUpdated: (account: AccountView) => void;
}) {
  const [current, setCurrent] = useState(account);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [bulkProxyId, setBulkProxyId] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeId = activeSession(current)?.id;

  const assign = async (sessionId: string, proxyId: string) => {
    setBusySessionId(sessionId);
    setError(null);
    try {
      const updated = await apiFetch<AccountView>(
        `/accounts/${current.id}/sessions/${sessionId}`,
        {
          method: "PATCH",
          body: { proxyId: proxyId || null },
        },
      );
      setCurrent(updated);
      onUpdated(updated);
    } catch (assignError) {
      setError(errorMessage(assignError));
    } finally {
      setBusySessionId(null);
    }
  };

  /** Applies one proxy to every session of the account, one request at a time. */
  const assignAll = async (proxyId: string) => {
    setBulkProxyId(proxyId);
    setBulkBusy(true);
    setError(null);
    try {
      let updated: AccountView | null = null;
      for (const session of current.sessions) {
        if (session.revokedAt) continue;
        if ((session.proxyId ?? "") === proxyId) continue;
        updated = await apiFetch<AccountView>(
          `/accounts/${current.id}/sessions/${session.id}`,
          {
            method: "PATCH",
            body: { proxyId: proxyId || null },
          },
        );
      }
      if (updated) {
        setCurrent(updated);
        onUpdated(updated);
      }
    } catch (assignError) {
      setError(errorMessage(assignError));
    } finally {
      setBulkBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-100">
            Сессии и прокси · {accountName(current)}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-xl leading-none text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
          >
            ×
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-4 rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
              {error}
            </div>
          )}

          <p className="mb-3 text-[11px] text-zinc-500">
            Плашка <span className="font-medium text-zinc-300">TDLib</span> или{" "}
            <span className="font-medium text-zinc-300">mtcute</span>{" "}
            показывает, какой движок реально обслуживает сессию. Сессия с
            зелёной рамкой — активный транспорт аккаунта.
          </p>

          {proxies.length === 0 && (
            <p className="mb-4 rounded-md border border-amber-800/60 bg-amber-950/40 px-3 py-2 text-xs text-amber-300">
              Сначала добавьте хотя бы один прокси в разделе «Прокси».
            </p>
          )}

          {current.sessions.length > 1 && (
            <label className="mb-4 block rounded-md border border-zinc-800 bg-zinc-800/40 px-3 py-2 text-xs text-zinc-400">
              Применить прокси ко всем сессиям аккаунта
              <select
                value={bulkProxyId}
                disabled={bulkBusy}
                onChange={(event) => void assignAll(event.target.value)}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500 disabled:opacity-50"
              >
                <option value="">Напрямую (без прокси)</option>
                {proxies
                  .filter((proxy) => proxy.enabled)
                  .map((proxy) => (
                    <option key={proxy.id} value={proxy.id}>
                      {proxy.name} · {proxy.kind}://{proxy.host}:{proxy.port}
                    </option>
                  ))}
              </select>
              {bulkBusy && (
                <span className="mt-1 block text-[11px] text-sky-400">
                  Применяю ко всем сессиям…
                </span>
              )}
            </label>
          )}

          <div className="space-y-3">
            {current.sessions.map((session) => {
              const isActive = !session.revokedAt && session.id === activeId;
              return (
                <div
                  key={session.id}
                  className={`rounded-md border px-3 py-3 ${
                    isActive
                      ? "border-emerald-500/60 bg-emerald-500/5"
                      : "border-zinc-800 bg-zinc-800/40"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <p className="truncate text-sm font-medium text-zinc-100">
                          {session.label ?? session.deviceId}
                        </p>
                        <EngineBadge
                          engine={session.engine}
                          active={isActive}
                        />
                        {isActive && (
                          <span className="shrink-0 rounded-full bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                            активный транспорт
                          </span>
                        )}
                      </div>
                      <p className="truncate text-xs text-zinc-500">
                        {session.profile} · {session.platform}
                        {session.revokedAt ? " · отозвана" : ""}
                      </p>
                    </div>
                    {session.proxyId && (
                      <span className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
                        через прокси
                      </span>
                    )}
                  </div>

                  <label className="mt-2 block text-xs text-zinc-400">
                    Прокси
                    <select
                      value={session.proxyId ?? ""}
                      disabled={busySessionId === session.id}
                      onChange={(event) =>
                        void assign(session.id, event.target.value)
                      }
                      className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500 disabled:opacity-50"
                    >
                      <option value="">Напрямую (без прокси)</option>
                      {proxies
                        .filter(
                          (proxy) =>
                            proxy.enabled || proxy.id === session.proxyId,
                        )
                        .map((proxy) => (
                          <option key={proxy.id} value={proxy.id}>
                            {proxy.name} · {proxy.kind}://{proxy.host}:
                            {proxy.port}
                          </option>
                        ))}
                    </select>
                  </label>
                  <p className="mt-1 text-[11px] text-zinc-500">
                    Смена прокси перезапускает подключение этой сессии.
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
