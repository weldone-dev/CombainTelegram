"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Local-only reasoning strip that sits directly above the composer.
 *
 * `streaming` — the model is emitting reasoning (`Агент думает…`).
 * `waiting` — reasoning is complete but the answer is still being generated
 * (`Готовлю ответ…`). `done` never removes the strip; only the answer does.
 * The container is capped so a long stream cannot push the composer off a
 * narrow screen; the inner block scrolls and can be expanded on demand.
 */
export function ThinkingStrip({
  text,
  phase,
}: {
  text: string;
  phase: "streaming" | "waiting";
}) {
  const [expanded, setExpanded] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const canExpand = text.length > 220;

  // biome-ignore lint/correctness/useExhaustiveDependencies: text/expanded are scroll triggers
  useEffect(() => {
    const element = textRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [text, expanded]);

  return (
    <div className="max-h-40 overflow-hidden border-t border-zinc-800 bg-zinc-900/50 px-5 py-2">
      <div className="flex min-w-0 items-center gap-2 text-[11px]">
        {phase === "streaming" ? (
          <span
            aria-hidden="true"
            className="h-3 w-3 shrink-0 animate-spin rounded-full border border-violet-400/30 border-t-violet-300"
          />
        ) : (
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-300"
          />
        )}
        <span className="shrink-0 font-medium text-violet-200">
          {phase === "streaming" ? "Агент думает…" : "Готовлю ответ…"}
        </span>
        <span className="min-w-0 flex-1 truncate text-zinc-500">
          локально, собеседнику не отправляется
        </span>
        {canExpand && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="shrink-0 rounded px-1 py-0.5 text-[10px] text-zinc-400 underline underline-offset-2 transition-colors hover:text-zinc-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-violet-400/50"
          >
            {expanded ? "Свернуть" : "Показать полностью"}
          </button>
        )}
      </div>
      <div
        ref={textRef}
        className={`mt-1 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-400 ${
          expanded ? "max-h-56" : "max-h-[4.5rem]"
        }`}
      >
        {text || "…"}
      </div>
    </div>
  );
}
