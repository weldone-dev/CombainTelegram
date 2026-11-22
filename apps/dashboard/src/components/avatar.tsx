"use client";

import { useState } from "react";
import { initials } from "../lib/format";

/**
 * Circular avatar: shows the Telegram profile photo when the API can provide
 * one and falls back to initials otherwise (or while it loads).
 */
export function Avatar({
  src,
  label,
  className = "h-10 w-10 text-sm",
}: {
  src?: string | null;
  label: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      className={`relative flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-zinc-700 font-semibold text-zinc-100 ${className}`}
    >
      {!failed && src ? (
        // biome-ignore lint/performance/noImgElement: avatar URLs are served by the API and change per chat/account; next/image would require a fixed remote host.
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        <span aria-hidden="true">{initials(label)}</span>
      )}
    </span>
  );
}
