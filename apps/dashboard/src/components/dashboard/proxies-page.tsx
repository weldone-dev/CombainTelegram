"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage } from "../../lib/api";
import type { ProxyTestResult, ProxyView } from "../../lib/types";
import { ProxyFormModal } from "../messenger/proxy-form-modal";

/** Proxy store page. Adding and editing live in a separate form modal. */
export function ProxiesPage() {
  const [proxies, setProxies] = useState<ProxyView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyView | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<{
    id: string;
    nonce: number;
  } | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      setProxies(await apiFetch<ProxyView[]>("/proxies", {}));
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Scroll to (and briefly highlight) the proxy that was just saved. `scrollTo`
  // changes after the refreshed list has been committed, so the row exists.
  useEffect(() => {
    if (!scrollTo) return;
    const row = document.getElementById(`proxy-row-${scrollTo.id}`);
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setHighlightId(scrollTo.id);
    const timer = setTimeout(() => setHighlightId(null), 2500);
    return () => clearTimeout(timer);
  }, [scrollTo]);

  const openNew = () => {
    setEditing(null);
    setFormOpen(true);
  };

  const openEdit = (proxy: ProxyView) => {
    setEditing(proxy);
    setFormOpen(true);
  };

  const handleSaved = async (saved: ProxyView) => {
    setFormOpen(false);
    setEditing(null);
    await load(true);
    setScrollTo({ id: saved.id, nonce: Date.now() });
  };

  const remove = async (proxy: ProxyView) => {
    if (!window.confirm(`Удалить прокси «${proxy.name}»?`)) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/proxies/${proxy.id}`, { method: "DELETE" });
      setTestResult((previous) => {
        const next = { ...previous };
        delete next[proxy.id];
        return next;
      });
      await load(true);
    } catch (removeError) {
      setError(errorMessage(removeError));
    } finally {
      setBusy(false);
    }
  };

  const test = async (proxy: ProxyView) => {
    setTestingId(proxy.id);
    setError(null);
    try {
      const result = await apiFetch<ProxyTestResult>(
        `/proxies/${proxy.id}/test`,
        { method: "POST" },
      );
      setTestResult((previous) => ({
        ...previous,
        [proxy.id]: result.ok ? `OK · ${result.latencyMs} мс` : "Ошибка",
      }));
    } catch (testError) {
      setTestResult((previous) => ({
        ...previous,
        [proxy.id]: errorMessage(testError),
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 px-6 py-6">
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-56 flex-1 text-xs text-zinc-500">
            Хранилище прокси. Прокси назначается сессии в карточке аккаунта
            («Сессии и прокси») или выбирается при входе.
          </p>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 transition-colors hover:border-zinc-500 disabled:opacity-40"
          >
            {loading ? "Обновление…" : "Обновить"}
          </button>
          <button
            type="button"
            onClick={openNew}
            className="rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-sky-400"
          >
            + Добавить прокси
          </button>
        </div>

        {error && (
          <div className="rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-zinc-800">
          <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Список прокси
            </h2>
            <span className="text-xs text-zinc-500">
              Всего: {proxies.length}
            </span>
          </div>

          {loading && proxies.length === 0 && (
            <p className="px-4 py-6 text-sm text-zinc-500">Загрузка прокси…</p>
          )}

          {!loading && proxies.length === 0 && (
            <div className="px-4 py-10 text-center">
              <p className="text-sm text-zinc-400">Прокси пока нет.</p>
              <button
                type="button"
                onClick={openNew}
                className="mt-3 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400"
              >
                + Добавить прокси
              </button>
            </div>
          )}

          {proxies.map((proxy) => (
            <div
              key={proxy.id}
              id={`proxy-row-${proxy.id}`}
              className={`flex flex-wrap items-center gap-4 border-b border-zinc-800 px-4 py-3 transition-colors last:border-b-0 hover:bg-zinc-800/40 ${
                highlightId === proxy.id
                  ? "bg-sky-500/10 ring-1 ring-inset ring-sky-500/50"
                  : ""
              }`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-zinc-100">
                    {proxy.name}
                  </p>
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                      proxy.enabled
                        ? "bg-emerald-500/20 text-emerald-300"
                        : "bg-zinc-700 text-zinc-300"
                    }`}
                  >
                    {proxy.enabled ? "включён" : "выключен"}
                  </span>
                </div>
                <p className="truncate text-xs text-zinc-500">
                  {proxy.kind}://{proxy.host}:{proxy.port}
                  {proxy.username ? ` · ${proxy.username}` : ""}
                  {proxy.hasSecret ? " · с паролем" : ""}
                </p>
                {testResult[proxy.id] && (
                  <p className="truncate text-xs text-sky-400">
                    {testResult[proxy.id]}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void test(proxy)}
                  disabled={testingId === proxy.id}
                  className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
                >
                  {testingId === proxy.id ? "…" : "Проверить"}
                </button>
                <button
                  type="button"
                  onClick={() => openEdit(proxy)}
                  className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100"
                >
                  Изменить
                </button>
                <button
                  type="button"
                  onClick={() => void remove(proxy)}
                  disabled={busy}
                  className="rounded-md border border-red-900/60 px-2.5 py-1.5 text-xs text-red-300 transition-colors hover:border-red-600 disabled:opacity-40"
                >
                  Удалить
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {formOpen && (
        <ProxyFormModal
          initial={editing}
          onClose={() => {
            setFormOpen(false);
            setEditing(null);
          }}
          onSaved={(saved) => void handleSaved(saved)}
        />
      )}
    </div>
  );
}
