"use client";

import { useState } from "react";
import { apiFetch, errorMessage } from "../../lib/api";
import type { ProxyView } from "../../lib/types";
import { InfoHint } from "../info-hint";

type Kind = "socks5" | "socks4" | "http" | "https" | "mtproto";

const KIND_OPTIONS: Array<{ value: Kind; label: string }> = [
  { value: "socks5", label: "SOCKS5" },
  { value: "socks4", label: "SOCKS4" },
  { value: "http", label: "HTTP" },
  { value: "https", label: "HTTPS" },
  { value: "mtproto", label: "MTProto (t.me/proxy)" },
];

interface FormState {
  name: string;
  kind: Kind;
  host: string;
  port: string;
  username: string;
  secret: string;
  enabled: boolean;
  clearSecret: boolean;
}

function initialState(proxy: ProxyView | null): FormState {
  return {
    name: proxy?.name ?? "",
    kind: (proxy?.kind as Kind) ?? "socks5",
    host: proxy?.host ?? "",
    port: proxy ? String(proxy.port) : "",
    username: proxy?.username ?? "",
    secret: "",
    enabled: proxy?.enabled ?? true,
    clearSecret: false,
  };
}

/** Add/edit form, opened from the "+" button or "Изменить" in the list. */
export function ProxyFormModal({
  initial,
  onClose,
  onSaved,
}: {
  initial: ProxyView | null;
  onClose: () => void;
  onSaved: (proxy: ProxyView) => void;
}) {
  const [form, setForm] = useState<FormState>(() => initialState(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: form.name,
        kind: form.kind,
        host: form.host,
        port: Number(form.port),
        username: form.username || null,
        enabled: form.enabled,
      };
      if (form.clearSecret) body.secret = "";
      else if (form.secret) body.secret = form.secret;

      const saved = initial
        ? await apiFetch<ProxyView>(`/proxies/${initial.id}`, {
            method: "PATCH",
            body,
          })
        : await apiFetch<ProxyView>("/proxies", { method: "POST", body });
      onSaved(saved);
    } catch (saveError) {
      setError(errorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-base font-semibold text-zinc-100">
            {initial ? "Изменить прокси" : "Новый прокси"}
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

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-xs text-zinc-400">
              Название
              <input
                value={form.name}
                onChange={(event) =>
                  setForm({ ...form, name: event.target.value })
                }
                placeholder="Германия 1"
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Тип
              <select
                value={form.kind}
                onChange={(event) =>
                  setForm({ ...form, kind: event.target.value as Kind })
                }
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
              >
                {KIND_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs text-zinc-400">
              Хост
              <input
                value={form.host}
                onChange={(event) =>
                  setForm({ ...form, host: event.target.value })
                }
                placeholder="127.0.0.1"
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
              />
            </label>
            <label className="block text-xs text-zinc-400">
              Порт
              <input
                value={form.port}
                onChange={(event) =>
                  setForm({ ...form, port: event.target.value })
                }
                inputMode="numeric"
                placeholder="1080"
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
              />
            </label>
            {form.kind !== "mtproto" && (
              <label className="block text-xs text-zinc-400">
                Логин (необязательно)
                <input
                  value={form.username}
                  onChange={(event) =>
                    setForm({ ...form, username: event.target.value })
                  }
                  className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
                />
              </label>
            )}
            <label className="block text-xs text-zinc-400">
              {form.kind === "mtproto" ? "Secret" : "Пароль"}
              <input
                type="password"
                value={form.secret}
                onChange={(event) =>
                  setForm({
                    ...form,
                    secret: event.target.value,
                    clearSecret: false,
                  })
                }
                placeholder={initial ? "оставьте пустым, чтобы не менять" : ""}
                className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none focus:border-sky-500"
              />
              {initial && (
                <div className="mt-1 flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={form.clearSecret}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          clearSecret: event.target.checked,
                          secret: "",
                        })
                      }
                    />
                    Удалить сохранённый секрет
                  </label>
                  <InfoHint placement="top">
                    Сотрёт сохранённый пароль (или MTProto-secret). Если прокси
                    требует авторизацию, подключение через него перестанет
                    работать до ввода нового пароля.
                  </InfoHint>
                </div>
              )}
            </label>
          </div>

          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) =>
                  setForm({ ...form, enabled: event.target.checked })
                }
              />
              Включён
            </label>
            <InfoHint placement="top">
              Выключенный прокси остаётся в списке, но его нельзя выбрать для
              нового входа. У сессий, где он уже назначен, подключение
              остановится с ошибкой, а не перейдёт на прямое соединение — чтобы
              не раскрывать реальный IP.
            </InfoHint>
          </div>
        </div>

        <div className="flex gap-2 border-t border-zinc-800 px-5 py-3">
          <button
            type="button"
            onClick={() => void save()}
            disabled={
              busy ||
              !form.name.trim() ||
              !form.host.trim() ||
              !form.port.trim()
            }
            className="flex-1 rounded-md bg-sky-500 px-3 py-2 text-sm font-medium text-white hover:bg-sky-400 disabled:opacity-40"
          >
            {initial ? "Сохранить" : "Добавить прокси"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:border-zinc-500"
          >
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
