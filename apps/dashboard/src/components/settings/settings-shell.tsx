"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const SETTINGS_TABS = [
  { href: "/settings/ai", label: "AI" },
  { href: "/settings/workflows", label: "Workflow" },
];

/**
 * Shared frame of the settings area. Tabs are plain links so each section can
 * lazy-load its own data; the active tab follows the current pathname.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-zinc-800 px-4 py-2">
        {SETTINGS_TABS.map((tab) => {
          const active =
            pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                active
                  ? "bg-sky-500/15 font-medium text-sky-300"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
