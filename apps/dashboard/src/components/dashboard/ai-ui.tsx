"use client";

import type { ReactNode } from "react";

export const inputClass =
  "mt-1 w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30";

export const textareaClass = `${inputClass} min-h-24 resize-y font-normal`;

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  // A real `<label>` associates the caption with the single control inside.
  // Callers must not put buttons or other controls inside `children`.
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: children is always one control
    <label className={`block min-w-0 text-xs text-zinc-400 ${className}`}>
      <span className="block">{label}</span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px] text-zinc-500">{hint}</span>
      )}
    </label>
  );
}

export function Card({
  title,
  description,
  actions,
  children,
  className = "",
}: {
  title?: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 ${className}`}
    >
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-[12rem] flex-1">
            {title && (
              <h2 className="break-words text-sm font-semibold text-zinc-100">
                {title}
              </h2>
            )}
            {description && (
              <p className="mt-1 break-words text-xs text-zinc-500">
                {description}
              </p>
            )}
          </div>
          {actions && <div className="min-w-0">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2 text-xs text-zinc-300 ${
        disabled ? "opacity-50" : "cursor-pointer"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-3.5 w-3.5 accent-sky-500"
      />
      <span>
        <span className="block">{label}</span>
        {hint && (
          <span className="block text-[11px] text-zinc-500">{hint}</span>
        )}
      </span>
    </label>
  );
}

export function Pill({
  children,
  tone = "zinc",
}: {
  children: ReactNode;
  tone?: "zinc" | "sky" | "green" | "amber" | "red";
}) {
  const tones: Record<string, string> = {
    zinc: "bg-zinc-800 text-zinc-300",
    sky: "bg-sky-500/15 text-sky-300",
    green: "bg-emerald-500/15 text-emerald-300",
    amber: "bg-amber-500/15 text-amber-300",
    red: "bg-red-500/15 text-red-300",
  };
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md border px-2.5 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-900 disabled:cursor-not-allowed disabled:opacity-40 ${
        danger
          ? "border-red-900/60 text-red-300 hover:bg-red-950/40"
          : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mb-3 break-words rounded-md border border-red-900/60 bg-red-950/40 px-3 py-2 text-sm text-red-300"
    >
      {message}
    </div>
  );
}

export function OkBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      aria-live="polite"
      className="mb-3 break-words rounded-md border border-emerald-900/60 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300"
    >
      {message}
    </div>
  );
}
