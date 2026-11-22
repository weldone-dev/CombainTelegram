"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Placement = "top" | "bottom";

interface Coords {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
}

const MAX_WIDTH = 288;
const VIEWPORT_MARGIN = 8;

/**
 * Small "i" badge with a tooltip. The tooltip is rendered into `document.body`
 * with fixed coordinates, so scroll containers or `overflow-hidden` modals
 * cannot clip it or add a horizontal scrollbar.
 */
export function InfoHint({
  children,
  placement = "bottom",
}: {
  children: ReactNode;
  placement?: Placement;
}) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [coords, setCoords] = useState<Coords | null>(null);

  useEffect(() => {
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, []);

  const open = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(MAX_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    const left = Math.min(
      Math.max(VIEWPORT_MARGIN, rect.left + rect.width / 2 - width / 2),
      window.innerWidth - width - VIEWPORT_MARGIN,
    );
    const openAbove =
      placement === "top" || rect.bottom + 140 > window.innerHeight;

    setCoords(
      openAbove
        ? { left, width, bottom: window.innerHeight - rect.top + 8 }
        : { left, width, top: rect.bottom + 8 },
    );
  }, [placement]);

  const close = useCallback(() => {
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      setCoords(null);
    }, 120);
  }, []);

  const closeNow = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setCoords(null);
  }, []);

  return (
    <span className="inline-flex align-middle">
      <button
        ref={anchorRef}
        type="button"
        aria-label="Подсказка"
        onMouseEnter={open}
        onMouseLeave={close}
        onFocus={open}
        onBlur={close}
        onClick={() => (coords ? closeNow() : open())}
        className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-zinc-600 text-[10px] font-semibold leading-none text-zinc-400 outline-none transition-colors hover:border-sky-500 hover:text-sky-400 focus-visible:border-sky-500 focus-visible:text-sky-400"
      >
        i
      </button>
      {coords &&
        createPortal(
          <span
            role="tooltip"
            onMouseEnter={open}
            onMouseLeave={close}
            style={{
              position: "fixed",
              left: coords.left,
              width: coords.width,
              ...(coords.top !== undefined
                ? { top: coords.top }
                : { bottom: coords.bottom }),
            }}
            className="z-[100] rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-left text-[11px] font-normal leading-relaxed text-zinc-200 shadow-xl"
          >
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}
