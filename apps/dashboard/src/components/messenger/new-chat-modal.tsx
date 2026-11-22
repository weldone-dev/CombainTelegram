"use client";

import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../lib/api";

/**
 * "Новый чат": resolves `@name`, `name` or a `t.me/name` link to a dialog and
 * opens it. The parent resolves and selects the chat, so errors are shown here
 * only until the modal closes.
 */
export function NewChatModal({
  onResolve,
  onClose,
}: {
  /** Resolves on success; the modal closes only then. */
  onResolve: (username: string) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const submit = async () => {
    const username = value.trim();
    if (!username || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onResolve(username);
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes the modal
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Новый чат по username"
        className="w-full max-w-sm overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-zinc-100">Новый чат</h2>
            <p className="text-[11px] text-zinc-500">
              @username, username или t.me/username
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title="Закрыть"
            aria-label="Закрыть"
            className="rounded-md px-2 py-1 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            ✕
          </button>
        </div>

        <form
          className="flex flex-col gap-2 px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="@durov или t.me/durov"
            aria-label="Username или ссылка t.me"
            className="rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-sky-500 focus:outline-none"
          />
          {error && <p className="text-xs text-red-300">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md px-3 py-1.5 text-xs text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={busy || value.trim().length === 0}
              className="rounded-md bg-sky-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 disabled:opacity-40"
            >
              {busy ? "Поиск…" : "Открыть"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
