"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

interface SettingsSectionLink {
  href: string;
  label: string;
}

const SECTIONS: SettingsSectionLink[] = [
  { href: "/settings", label: "Общие" },
  { href: "/settings/ai", label: "AI" },
  { href: "/settings/proxy", label: "Прокси" },
  { href: "/settings/accounts", label: "Аккаунты" },
  { href: "/settings/logs", label: "Логи" },
];

/**
 * Two-pane settings area inside the main app shell: a section list on the left
 * (horizontal on narrow screens) and the active section on the right. The
 * section pages themselves own their padding so embedded panels can opt out.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <nav
        aria-label="Разделы настроек"
        className="shrink-0 border-b border-zinc-800 bg-zinc-900/40 p-2 lg:w-52 lg:border-b-0 lg:border-r lg:p-3"
      >
        <p className="hidden px-2 pb-2 text-[11px] font-medium uppercase tracking-wide text-zinc-500 lg:block">
          Настройки
        </p>
        <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
          {SECTIONS.map((section) => {
            // `/settings` is the index: only mark it active on the exact URL,
            // otherwise every section would highlight it.
            const active = pathname === section.href;
            return (
              <li key={section.href} className="shrink-0">
                <Link
                  href={section.href}
                  aria-current={active ? "page" : undefined}
                  className={`flex items-center rounded-md px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${
                    active
                      ? "bg-sky-500/15 font-medium text-sky-300"
                      : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  }`}
                >
                  {section.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
