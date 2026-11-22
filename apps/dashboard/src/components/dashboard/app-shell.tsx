"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import {
  type NotificationsState,
  notificationsSupported,
  readNotificationsEnabled,
  writeNotificationsEnabled,
} from "../../lib/notifications";
import { useAppData } from "./app-data";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { href: "/accounts", label: "Аккаунты", icon: <AccountsIcon /> },
  { href: "/proxies", label: "Прокси", icon: <ProxyIcon /> },
  { href: "/chats", label: "Чаты", icon: <ChatsIcon /> },
  { href: "/logs", label: "Логи", icon: <LogsIcon /> },
];

const PAGE_TITLES: Record<string, string> = {
  "/accounts": "Аккаунты",
  "/proxies": "Прокси",
  "/chats": "Чаты",
  "/logs": "Логи",
};

const COLLAPSE_KEY = "ct:sidebar-collapsed";

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { accounts, notice, realtimeOnline } = useAppData();
  const [collapsed, setCollapsed] = useState(false);
  const [notifications, setNotifications] = useState<NotificationsState>("off");

  useEffect(() => {
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);

  // The permission may have been granted or denied outside this tab, so the
  // stored preference is reconciled with the live permission on mount.
  useEffect(() => {
    if (!notificationsSupported()) {
      setNotifications("unavailable");
      return;
    }
    if (window.Notification.permission === "denied") {
      setNotifications("unavailable");
      return;
    }
    setNotifications(readNotificationsEnabled() ? "on" : "off");
  }, []);

  const toggle = () => {
    setCollapsed((previous) => {
      const next = !previous;
      window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  const toggleNotifications = async () => {
    if (notifications === "unavailable") return;
    if (notifications === "on") {
      writeNotificationsEnabled(false);
      setNotifications("off");
      return;
    }
    if (!notificationsSupported()) return;
    let permission = window.Notification.permission;
    if (permission === "default") {
      // Permission is only ever requested from this user gesture.
      permission = await window.Notification.requestPermission();
    }
    if (permission !== "granted") {
      writeNotificationsEnabled(false);
      setNotifications("unavailable");
      return;
    }
    writeNotificationsEnabled(true);
    setNotifications("on");
  };

  const notificationsLabel =
    notifications === "on"
      ? "Выключить уведомления"
      : notifications === "unavailable"
        ? "Уведомления недоступны: нет разрешения браузера"
        : "Включить уведомления";

  const pageTitle = PAGE_TITLES[pathname] ?? "CombainTelegram";

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-zinc-950 text-zinc-100">
      <aside
        className={`flex shrink-0 flex-col border-r border-zinc-800 bg-zinc-900 transition-[width] duration-200 ${
          collapsed ? "w-16" : "w-60"
        }`}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-800 px-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-sky-500 text-sm font-bold text-white">
            C
          </span>
          {!collapsed && (
            <span className="truncate text-sm font-semibold">
              CombainTelegram
            </span>
          )}
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-2">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                title={item.label}
                className={`flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors ${
                  active
                    ? "bg-sky-500/15 font-medium text-sky-300"
                    : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                } ${collapsed ? "justify-center" : ""}`}
              >
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  {item.icon}
                </span>
                {!collapsed && (
                  <span className="flex min-w-0 flex-1 items-center justify-between gap-2">
                    <span className="truncate">{item.label}</span>
                    {item.href === "/accounts" && accounts.length > 0 && (
                      <span className="rounded-full bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                        {accounts.length}
                      </span>
                    )}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-zinc-800 p-2">
          <button
            type="button"
            onClick={toggle}
            title={collapsed ? "Развернуть меню" : "Свернуть меню"}
            className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 ${
              collapsed ? "justify-center" : ""
            }`}
          >
            <span className="flex h-5 w-5 shrink-0 items-center justify-center">
              <MenuIcon />
            </span>
            {!collapsed && <span>Свернуть</span>}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-zinc-800 bg-zinc-900/60 px-5">
          <div className="flex min-w-0 items-baseline gap-3">
            <h1 className="truncate text-base font-semibold">{pageTitle}</h1>
            <span className="hidden truncate text-xs text-zinc-500 sm:block">
              Главная / {pageTitle}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-3 text-xs text-zinc-500">
            <button
              type="button"
              onClick={() => void toggleNotifications()}
              disabled={notifications === "unavailable"}
              title={notificationsLabel}
              aria-label={notificationsLabel}
              aria-pressed={notifications === "on"}
              className={`rounded-md p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                notifications === "on"
                  ? "text-sky-400 hover:bg-zinc-800 hover:text-sky-300"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              }`}
            >
              <BellIcon muted={notifications !== "on"} />
            </button>
            <span className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  realtimeOnline ? "bg-emerald-500" : "bg-zinc-600"
                }`}
              />
              {realtimeOnline ? "real-time" : "офлайн"}
            </span>
          </span>
        </header>

        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>

      {notice && (
        <div className="fixed bottom-4 right-4 z-40 rounded-md border border-emerald-800 bg-emerald-950/90 px-4 py-2 text-sm text-emerald-200 shadow-lg">
          {notice}
        </div>
      )}
    </div>
  );
}

function BellIcon({ muted }: { muted: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path d="M18 8a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6" />
      <path d="M10.3 18a2 2 0 0 0 3.4 0" />
      {muted && <path d="M3 3l18 18" />}
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}

function AccountsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c0-2.8 2.5-5 5.5-5s5.5 2.2 5.5 5" />
      <path d="M16 5.5a3 3 0 0 1 0 5.6M17.5 14.4c1.8.7 3 2.4 3 4.6" />
    </svg>
  );
}

function ProxyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <circle cx="7" cy="7.5" r="1" />
      <circle cx="7" cy="16.5" r="1" />
    </svg>
  );
}

function ChatsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.4 8.9 8.9 0 0 1-3.8-.8L3 21l1.9-5.2a8.3 8.3 0 0 1-.9-3.8A8.4 8.4 0 0 1 12.5 3 8.4 8.4 0 0 1 21 11.5Z" />
    </svg>
  );
}

function LogsIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="h-5 w-5"
    >
      <path d="M5 3.5h9l5 5V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" />
      <path d="M14 3.5V9h5M8 13h8M8 17h5" />
    </svg>
  );
}
