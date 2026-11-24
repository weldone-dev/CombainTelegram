"use client";

import { useEffect, useRef, useState } from "react";
import { AiAccessMenu } from "./ai-access-menu";
import { useAiAccess } from "./ai-access-store";

function warningsLabel(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "предупреждение";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "предупреждения";
  }
  return "предупреждений";
}

/**
 * Header status of the current chat: neutral when no rule exists, emerald when
 * the soul answers, red and unmistakable when the chat is blacklisted. The chip
 * is also the menu trigger, so the four AI actions need no extra header button.
 */
export function ChatAiChip({
  chatId,
  chatTitle,
}: {
  chatId: number;
  chatTitle: string;
}) {
  const { statusFor, viewFor, ensureView, unblock, busyFor, error } =
    useAiAccess();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const view = viewFor(chatId, 0);
  const status = view
    ? {
        allowed: view.allowed,
        blocked: view.blocked,
        warnings: view.warnings,
        reason: view.reason,
      }
    : statusFor(chatId);
  const busy = busyFor(chatId, 0);

  useEffect(() => {
    if (!view) void ensureView(chatId, 0);
  }, [chatId, view, ensureView]);

  const openMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 240;
    setMenu({
      x: Math.max(
        8,
        Math.min(rect.right - width, window.innerWidth - width - 8),
      ),
      y: Math.min(rect.bottom + 4, window.innerHeight - 220),
    });
  };

  const blocked = status?.blocked ?? false;
  const allowed = status?.allowed ?? false;
  const warnings = status?.warnings ?? 0;
  const label = blocked
    ? `Заблокирован${warnings > 0 ? ` · ${warnings} ${warningsLabel(warnings)}` : ""}`
    : allowed
      ? "ИИ отвечает"
      : "ИИ выключен";

  return (
    <div className="flex items-center gap-1">
      <button
        ref={buttonRef}
        type="button"
        onClick={openMenu}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        title={
          blocked
            ? `ИИ заблокирован${status?.reason ? `: ${status.reason}` : ""}`
            : allowed
              ? "ИИ разрешён в этом чате"
              : "ИИ не разрешён в этом чате"
        }
        className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/50 ${
          blocked
            ? "border-red-700/80 bg-red-950/50 text-red-200 hover:bg-red-950/70"
            : allowed
              ? "border-emerald-700/70 bg-emerald-950/40 text-emerald-200 hover:bg-emerald-950/60"
              : "border-zinc-700 bg-zinc-900/60 text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
        }`}
      >
        {blocked ? (
          <span aria-hidden="true" className="text-[11px]">
            ⛔
          </span>
        ) : (
          <span aria-hidden="true" className="text-[11px]">
            ✦
          </span>
        )}
        <span>{label}</span>
        <span aria-hidden="true" className="text-[9px] opacity-70">
          ▾
        </span>
      </button>
      {blocked && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void unblock(chatId, 0)}
          title="Разблокировать ИИ в этом чате"
          className="rounded border border-red-700/80 px-1.5 py-0.5 text-[11px] text-red-200 transition-colors hover:bg-red-950/60 disabled:opacity-40"
        >
          {busy ? "…" : "Разблокировать"}
        </button>
      )}
      {error && (
        <span
          role="alert"
          title={error}
          className="text-[11px] font-medium text-red-400"
        >
          !
        </span>
      )}
      {menu && (
        <AiAccessMenu
          chatId={chatId}
          chatTitle={chatTitle}
          state={status}
          position={menu}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
