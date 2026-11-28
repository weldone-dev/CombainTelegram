"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { copyToClipboard } from "../../lib/clipboard";

/** One labelled value rendered in the dialog's metadata list. */
export interface MemoryDetailField {
  label: string;
  value: string;
  /** Render with the monospace font (ids, hashes, chat ids). */
  mono?: boolean;
}

/** Pretty-print a JSON-looking string; keeps the original text otherwise. */
export function prettyJson(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return value;
  }
}

/** True when the value is a JSON array/object worth a dedicated code block. */
export function isStructuredJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * Full-view modal for one memory row. The card only passes already-formatted
 * strings, so every section (daily, fact, palace, agenda, session) can reuse
 * the same shell: full text without clamping, every field, JSON, copy, close.
 */
export function MemoryRecordDialog({
  eyebrow,
  title,
  badges,
  text,
  textLabel,
  textMono = false,
  fields,
  json,
  copyText,
  onClose,
}: {
  /** Record type shown above the title, e.g. `EveMemoryFact`. */
  eyebrow: string;
  title: string;
  badges?: ReactNode;
  /** Complete body: never clamped. */
  text?: string;
  textLabel?: string;
  textMono?: boolean;
  fields?: MemoryDetailField[];
  /** Structured payload rendered as formatted JSON. */
  json?: { label: string; text: string } | null;
  /** Plain text placed on the clipboard by «Копировать». */
  copyText: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Keep Tab inside the dialog while it is open.
  const trapFocus = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const node = dialogRef.current;
    if (!node) return;
    const focusables = Array.from(
      node.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((element) => element.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const copy = async () => {
    const copied = await copyToClipboard(copyText);
    setCopyState(copied ? "ok" : "fail");
    if (!copied) return;
    window.setTimeout(() => setCopyState("idle"), 1500);
  };

  const dialog = (
    // biome-ignore lint/a11y/noStaticElementInteractions: the backdrop closes the dialog
    <div
      role="presentation"
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/70 p-2 sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      onKeyDown={trapFocus}
    >      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="memory-record-dialog-title"
        className="flex max-h-[92vh] w-full max-w-lg min-w-0 flex-col overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
      >
        <div className="flex items-start gap-2 border-b border-zinc-800 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-wide text-zinc-500">
              {eyebrow}
            </p>
            <h2
              id="memory-record-dialog-title"
              className="mt-0.5 break-words text-sm font-semibold text-zinc-100"
            >
              {title}
            </h2>
            {badges && (
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {badges}
              </div>
            )}
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            title="Закрыть (Esc)"
            className="shrink-0 rounded-md px-2 py-1 text-lg leading-none text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
          {text !== undefined && (
            <div className="min-w-0">
              {textLabel && (
                <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                  {textLabel}
                </p>
              )}
              <p
                className={`whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-xs leading-relaxed text-zinc-200 ${
                  textMono ? "font-mono text-[11px]" : ""
                }`}
              >
                {text || "—"}
              </p>
            </div>
          )}

          {fields && fields.length > 0 && (
            <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
              {fields.map((field) => (
                <div key={field.label} className="contents">
                  <dt className="break-words text-zinc-500">{field.label}</dt>
                  <dd
                    className={`min-w-0 break-words text-zinc-300 ${
                      field.mono ? "font-mono text-[11px]" : ""
                    }`}
                  >
                    {field.value || "—"}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {json && json.text.trim() && (
            <div className="min-w-0">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500">
                {json.label}
              </p>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-800 bg-zinc-950/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                {prettyJson(json.text)}
              </pre>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-zinc-800 px-4 py-2.5">
          {copyState === "fail" && (
            <span className="mr-auto text-[11px] text-amber-300">
              Не удалось скопировать
            </span>
          )}
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 transition-colors hover:border-zinc-500 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-40"
          >
            {copyState === "ok" ? "Скопировано" : "Копировать"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-sky-600 px-2.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );

  // Rendered on `document.body`: the chat info panel sits in a transformed
  // container, where `position: fixed` would be clipped to the panel.
  if (typeof document === "undefined") return null;
  return createPortal(dialog, document.body);
}
