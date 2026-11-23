"use client";

import type { FocusEvent } from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { apiFetch, errorCodeText, errorMessage } from "../lib/api";
import type { ProxyCheckResult, ProxyView } from "../lib/types";

const MAX_WIDTH = 288;
const VIEWPORT_MARGIN = 8;
const POPOVER_ESTIMATED_HEIGHT = 200;
/** An exit-node probe costs a real connection, so one result lives for 5 min. */
const CHECK_TTL_MS = 5 * 60 * 1000;
const CLOSE_DELAY_MS = 120;

interface Coords {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

type Variant = "chip" | "icon";

/**
 * Proxy chip with a hover/focus/tap popover that also names the exit node.
 *
 * The exit node is probed lazily through `POST /proxies/:id/check` on the first
 * open and cached in component state for five minutes. A proxy chip on an
 * account card still opens the sessions modal; the adjacent "i" button toggles
 * the popover on touch screens.
 */
export function ProxyInfo({
  proxy,
  assigned,
  variant = "chip",
  onActivate,
  className,
}: {
  proxy: ProxyView | null;
  /** True when the session points at a proxy that is missing from the list. */
  assigned?: boolean;
  variant?: Variant;
  /** Main action of the chip (opens the sessions modal on account cards). */
  onActivate?: () => void;
  className?: string;
}) {
  const tooltipId = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkedAt = useRef(0);
  const inFlight = useRef(false);

  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const [check, setCheck] = useState<ProxyCheckResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);

  const hasProxy = assigned ?? proxy !== null;
  const label = proxy?.name ?? (hasProxy ? "Прокси недоступен" : "Напрямую");

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const closeNow = useCallback(() => {
    cancelClose();
    setOpen(false);
    setCoords(null);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setOpen(false);
      setCoords(null);
    }, CLOSE_DELAY_MS);
  }, [cancelClose]);

  const requestCheck = useCallback(async () => {
    if (!proxy || inFlight.current) return;
    if (Date.now() - checkedAt.current < CHECK_TTL_MS) return;
    inFlight.current = true;
    setChecking(true);
    setCheckError(null);
    try {
      const result = await apiFetch<ProxyCheckResult>(
        `/proxies/${proxy.id}/check`,
        { method: "POST" },
      );
      setCheck(result);
    } catch (error) {
      setCheck(null);
      setCheckError(errorMessage(error));
    } finally {
      // A failed probe is cached too: reopening must not hammer a dead proxy.
      checkedAt.current = Date.now();
      inFlight.current = false;
      setChecking(false);
    }
  }, [proxy]);

  // A different proxy must never show the previous proxy's exit node.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset is keyed by the proxy id alone
  useEffect(() => {
    setCheck(null);
    setCheckError(null);
    checkedAt.current = 0;
  }, [proxy?.id]);

  useEffect(() => {
    if (open) void requestCheck();
  }, [open, requestCheck]);

  const openPopover = useCallback(() => {
    cancelClose();
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );
    const fitsBelow =
      rect.bottom + POPOVER_ESTIMATED_HEIGHT + VIEWPORT_MARGIN <=
      window.innerHeight;
    const fitsAbove = rect.top - POPOVER_ESTIMATED_HEIGHT - VIEWPORT_MARGIN > 0;
    // Prefer below; flip above when the card is near the bottom edge. When
    // neither side fits, keep it below and let the popover scroll internally.
    const above = !fitsBelow && fitsAbove;

    setCoords(
      above
        ? {
            left,
            width,
            maxHeight: Math.max(120, rect.top - VIEWPORT_MARGIN * 2),
            bottom: window.innerHeight - rect.top + 8,
          }
        : {
            left,
            width,
            maxHeight: Math.max(
              120,
              window.innerHeight - rect.bottom - VIEWPORT_MARGIN * 2,
            ),
            top: rect.bottom + 8,
          },
    );
    setOpen(true);
  }, [cancelClose]);

  const toggle = useCallback(() => {
    if (open) closeNow();
    else openPopover();
  }, [closeNow, open, openPopover]);

  // Escape closes the popover and returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      closeNow();
      anchorRef.current?.querySelector<HTMLElement>("button")?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeNow, open]);

  // Tapping anywhere outside closes the popover on touch screens.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (anchorRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      closeNow();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [closeNow, open]);

  const handleBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (next && anchorRef.current?.contains(next)) return;
    if (next && popoverRef.current?.contains(next)) return;
    scheduleClose();
  };

  const describedBy = open ? tooltipId : undefined;
  const accent = hasProxy ? "bg-sky-400" : "bg-zinc-500";

  return (
    <span
      ref={anchorRef}
      className={
        variant === "chip"
          ? `inline-flex max-w-full items-stretch overflow-hidden rounded-full border border-zinc-700 bg-zinc-800/60 text-[11px] text-zinc-300 ${className ?? ""}`
          : `inline-flex items-center ${className ?? ""}`
      }
    >
      {variant === "chip" ? (
        <button
          type="button"
          onClick={() => {
            if (!onActivate) {
              toggle();
              return;
            }
            closeNow();
            onActivate();
          }}
          onMouseEnter={openPopover}
          onMouseLeave={scheduleClose}
          onFocus={openPopover}
          onBlur={handleBlur}
          aria-describedby={describedBy}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 px-2 py-0.5 text-left outline-none transition-colors hover:text-zinc-100 focus-visible:text-sky-300"
        >
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${accent}`} />
          <span className="truncate">{label}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={toggle}
          onMouseEnter={openPopover}
          onMouseLeave={scheduleClose}
          onFocus={openPopover}
          onBlur={handleBlur}
          aria-label={`Информация о прокси: ${label}`}
          aria-describedby={describedBy}
          className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-zinc-600 text-[10px] font-semibold leading-none text-zinc-400 outline-none transition-colors hover:border-sky-500 hover:text-sky-400 focus-visible:border-sky-500 focus-visible:text-sky-400"
        >
          i
        </button>
      )}

      {variant === "chip" && (
        <button
          type="button"
          onClick={toggle}
          onMouseEnter={openPopover}
          onMouseLeave={scheduleClose}
          onFocus={openPopover}
          onBlur={handleBlur}
          aria-label={`Информация о прокси: ${label}`}
          aria-describedby={describedBy}
          className="shrink-0 border-l border-zinc-700 px-1.5 text-[10px] font-semibold text-zinc-400 outline-none transition-colors hover:bg-zinc-700/60 hover:text-sky-300 focus-visible:bg-zinc-700/60 focus-visible:text-sky-300"
        >
          i
        </button>
      )}

      {open &&
        coords &&
        createPortal(
          <span
            ref={popoverRef}
            id={tooltipId}
            role="tooltip"
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={{
              position: "fixed",
              left: coords.left,
              width: coords.width,
              maxHeight: coords.maxHeight,
              ...(coords.top !== undefined
                ? { top: coords.top }
                : { bottom: coords.bottom }),
            }}
            className="z-[100] block overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-[11px] font-normal leading-relaxed text-zinc-200 shadow-xl"
          >
            <ProxyDetails
              proxy={proxy}
              assigned={hasProxy}
              check={check}
              checking={checking}
              checkError={checkError}
            />
          </span>,
          document.body,
        )}
    </span>
  );
}

function ProxyDetails({
  proxy,
  assigned,
  check,
  checking,
  checkError,
}: {
  proxy: ProxyView | null;
  assigned: boolean;
  check: ProxyCheckResult | null;
  checking: boolean;
  checkError: string | null;
}) {
  if (!proxy) {
    return assigned ? (
      <>
        <span className="block font-medium text-zinc-100">
          Прокси недоступен
        </span>
        <span className="mt-0.5 block text-zinc-400">
          Прокси сессии не найден в списке — возможно, он удалён.
        </span>
      </>
    ) : (
      <>
        <span className="block font-medium text-zinc-100">Напрямую</span>
        <span className="mt-0.5 block text-zinc-400">
          Без прокси — соединение идёт с вашего IP.
        </span>
      </>
    );
  }

  return (
    <>
      <span className="block font-medium text-zinc-100">{proxy.name}</span>
      <span className="mt-0.5 block text-zinc-400">
        {proxy.kind} · {proxy.host}:{proxy.port}
      </span>
      {proxy.username && (
        <span className="block text-zinc-400">Логин: {proxy.username}</span>
      )}
      {!proxy.enabled && (
        <span className="block text-amber-300">Прокси выключен</span>
      )}

      <span className="mt-1.5 block border-t border-zinc-700 pt-1.5">
        <ExitNode check={check} checking={checking} checkError={checkError} />
      </span>
    </>
  );
}

function ExitNode({
  check,
  checking,
  checkError,
}: {
  check: ProxyCheckResult | null;
  checking: boolean;
  checkError: string | null;
}) {
  if (checkError) {
    return <span className="block text-red-300">{checkError}</span>;
  }

  if (checking && !check) {
    return <span className="block text-zinc-400">Проверяем…</span>;
  }

  if (!check) {
    return <span className="block text-zinc-400">Выходная нода: —</span>;
  }

  if (check.unsupported) {
    return (
      <>
        <span className="block text-zinc-300">
          MTProto — выход не определяется
        </span>
        {formatLatency(check.latencyMs) && (
          <span className="block text-zinc-400">
            {formatLatency(check.latencyMs)}
          </span>
        )}
      </>
    );
  }

  if (!check.ok) {
    return (
      <span className="block text-red-300">
        {check.error ? errorCodeText(check.error) : "Прокси не отвечает"}
      </span>
    );
  }

  return (
    <>
      <span className="block text-zinc-300">
        Выходная нода: {check.exitIp ?? "не определена"}
        {check.country ? ` · ${check.country}` : ""}
      </span>
      {formatLatency(check.latencyMs) && (
        <span className="block text-zinc-400">
          {formatLatency(check.latencyMs)}
        </span>
      )}
    </>
  );
}

function formatLatency(latencyMs: number | undefined): string {
  if (latencyMs === undefined || !Number.isFinite(latencyMs)) return "";
  return `Задержка: ${Math.round(latencyMs)} мс`;
}
