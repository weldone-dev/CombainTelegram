"use client";

import { useState } from "react";

function BrainIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="h-3.5 w-3.5 shrink-0 stroke-current"
      fill="none"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M9.5 4.5A2.5 2.5 0 0 0 7 7a2.5 2.5 0 0 0-1.5 4.5A2.5 2.5 0 0 0 7 16a2.5 2.5 0 0 0 2.5 3.5V4.5Z" />
      <path d="M14.5 4.5A2.5 2.5 0 0 1 17 7a2.5 2.5 0 0 1 1.5 4.5A2.5 2.5 0 0 1 17 16a2.5 2.5 0 0 1-2.5 3.5V4.5Z" />
      <path d="M9.5 9H12m-2.5 4H12m2.5-4H12m2.5 4H12" />
    </svg>
  );
}

/**
 * Local-only model reasoning under one bot bubble.
 *
 * A run may produce several Telegram bubbles; the caller attaches the block to
 * the last bubble of `run.messageIds` and passes the total as `bubbles`, so the
 * row can say how many messages the run covered without repeating the text.
 * Collapsed by default; nothing is ever written into the message text.
 */
export function ReasoningBlock({
  reasoning,
  bubbles = 1,
  createdAt,
}: {
  reasoning: string;
  bubbles?: number;
  createdAt?: string;
}) {
  const [open, setOpen] = useState(false);
  const preview = reasoning.replace(/\s+/g, " ").trim();
  const more = bubbles > 1 ? bubbles - 1 : 0;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the wrapper only stops clicks/keys from selecting the message; the toggle inside is a real button.
    <div
      className="mt-1 rounded-lg border border-violet-500/20 bg-violet-950/15"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title="Размышления модели (локально)"
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] text-violet-200/85 transition-colors hover:text-violet-100"
      >
        <BrainIcon />
        <span className="shrink-0 font-medium">Размышления</span>
        {more > 0 && (
          <span
            className="shrink-0 rounded-full bg-violet-500/15 px-1.5 py-0.5 text-[10px] text-violet-200/80"
            title={`Один запуск покрыл ${bubbles} сообщения, блок показан под последним`}
          >
            ещё {more}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate opacity-60">{preview}</span>
        <span aria-hidden="true" className="shrink-0 text-[10px] opacity-70">
          {open ? "▴" : "▾"}
        </span>
      </button>
      {open && (
        <div className="border-t border-violet-500/20 px-2 py-1.5">
          <p className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-400">
            {reasoning}
          </p>
          <p className="mt-1 text-[10px] text-zinc-500">
            локально, собеседнику не отправляется
            {createdAt
              ? ` · ${new Date(createdAt).toLocaleString("ru-RU")}`
              : ""}
          </p>
        </div>
      )}
    </div>
  );
}
