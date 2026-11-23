import type { SessionEngine } from "../lib/types";

/**
 * Transport pill for a session: native `TDLib` or the legacy `mtcute`
 * string-session client.
 */
export function EngineBadge({
  engine,
  active = false,
}: {
  engine: SessionEngine | string;
  active?: boolean;
}) {
  const tdlib = engine === "tdlib";
  return (
    <span
      title={
        tdlib
          ? "Сессия работает через TDLib"
          : "Сессия работает через mtcute (строковая сессия)"
      }
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        tdlib ? "bg-sky-500/20 text-sky-300" : "bg-zinc-700/60 text-zinc-300"
      } ${active ? "ring-1 ring-emerald-400/70" : ""}`}
    >
      {tdlib ? "TDLib" : "mtcute"}
    </span>
  );
}
