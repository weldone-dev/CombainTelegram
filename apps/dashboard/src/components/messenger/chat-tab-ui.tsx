"use client";

import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { errorMessage } from "../../lib/api";
import { formatDay, formatTime } from "../../lib/format";

/** Shared compact button of the AI tabs (same look as the access card). */
export const SMALL_BUTTON =
  "rounded border border-zinc-700 px-2 py-1 text-[11px] text-zinc-200 transition-colors hover:border-zinc-500 disabled:opacity-40";

/**
 * Module-level cache of the tab payloads, keyed by account/chat/thread.
 * Switching tabs or reopening the drawer renders the last page immediately and
 * revalidates it in the background, so no tab blocks the panel's first paint.
 */
const cache = new Map<string, unknown>();

/** Synchronously read a cached page (used by the hook on the first render). */
export function peekCache<T>(key: string): T | null {
  const value = cache.get(key);
  return value === undefined ? null : (value as T);
}

export interface CachedResource<T> {
  data: T | null;
  /** True only while there is nothing to show yet. */
  loading: boolean;
  error: string | null;
  /** Re-runs the request, keeping the current data on screen. */
  reload: () => void;
}

/** Cache-first resource: renders the last page, then refreshes it silently. */
export function useCachedResource<T>(
  key: string,
  load: () => Promise<T>,
): CachedResource<T> {
  const [data, setData] = useState<T | null>(() => peekCache<T>(key));
  const [loading, setLoading] = useState(() => !cache.has(key));
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  // biome-ignore lint/correctness/useExhaustiveDependencies: token is a manual refetch trigger
  useEffect(() => {
    let active = true;
    const cached = peekCache<T>(key);
    if (cached !== null) {
      setData(cached);
      setLoading(false);
    } else {
      setData(null);
      setLoading(true);
    }
    setError(null);
    loadRef
      .current()
      .then((result) => {
        if (!active) return;
        cache.set(key, result);
        setData(result);
      })
      .catch((caught: unknown) => {
        if (active) setError(errorMessage(caught));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [key, token]);

  const reload = useCallback(() => setToken((value) => value + 1), []);

  return { data, loading, error, reload };
}

/** "24 ноя, 18:08" — the panel's compact timestamp. */
export function formatStamp(iso: string): string {
  return [formatDay(iso), formatTime(iso)].filter(Boolean).join(", ");
}

/** One bordered block of an AI tab. */
export function PanelCard({
  title,
  hint,
  badge,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  hint?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-xl border border-zinc-800 bg-zinc-950/50 p-3 ${className}`}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && (
              <h4 className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                {title}
              </h4>
            )}
            {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {badge}
            {actions}
          </div>
        </div>
      )}
      {children}
    </section>
  );
}

/** Small "тред #id / весь чат" pill shown by every AI tab. */
export function ScopeChip({ threadId }: { threadId: number }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
        threadId > 0
          ? "border-sky-800/70 bg-sky-500/10 text-sky-300"
          : "border-zinc-700 text-zinc-400"
      }`}
    >
      {threadId > 0 ? `тред #${threadId}` : "весь чат"}
    </span>
  );
}

export function TabHeader({
  threadId,
  onRefresh,
  refreshing,
  children,
}: {
  threadId: number;
  onRefresh: () => void;
  refreshing: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <ScopeChip threadId={threadId} />
      {children}
      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        title="Обновить данные"
        className={`ml-auto ${SMALL_BUTTON}`}
      >
        {refreshing ? "…" : "Обновить"}
      </button>
    </div>
  );
}

export function TabError({
  text,
  onRetry,
}: {
  text: string;
  onRetry?: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <p role="alert" className="text-[11px] text-red-300">
        {text}
      </p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          title="Повторить загрузку"
          className={SMALL_BUTTON}
        >
          Повторить
        </button>
      )}
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-zinc-800 px-2 py-2 text-[11px] text-zinc-500">
      {children}
    </p>
  );
}

export function RowsSkeleton({ rows }: { rows: number }) {
  return (
    <div aria-hidden="true" className="animate-pulse space-y-2">
      {Array.from({ length: rows }, (_, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders.
          key={`row-${index}`}
          className="h-10 rounded-lg bg-zinc-800"
        />
      ))}
    </div>
  );
}
