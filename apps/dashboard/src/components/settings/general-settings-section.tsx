"use client";

import Link from "next/link";
import { API_URL } from "../../lib/api";
import { Card } from "../dashboard/ai-ui";
import { useAppData } from "../dashboard/app-data";

const SECTION_LINKS: Array<{
  href: string;
  title: string;
  description: string;
}> = [
  {
    href: "/settings/ai",
    title: "AI",
    description: "Провайдер, модель, лимиты, распознавание речи, ключи и MCP.",
  },
  {
    href: "/settings/proxy",
    title: "Прокси",
    description: "Пул прокси для аккаунтов Telegram.",
  },
  {
    href: "/settings/accounts",
    title: "Аккаунты",
    description: "Подключённые аккаунты, сессии и профили устройств.",
  },
  {
    href: "/settings/logs",
    title: "Логи",
    description: "Действия HTTP, ответы Telegram и ошибки.",
  },
];

export function GeneralSettingsSection() {
  const { accounts, realtimeOnline } = useAppData();

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">Общие</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Интерфейс и подключение к API. Настройки хранятся на этом устройстве и
          сервере — регистрации и входа нет.
        </p>
      </div>

      <Card
        title="Интерфейс"
        description="Дашборд использует одну тёмную тему, чтобы совпадать с оформлением мессенджера."
      >
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <Row label="Тема" value="Тёмная" />
          <Row label="Язык" value="Русский" />
          <Row label="Аккаунтов подключено" value={String(accounts.length)} />
          <Row
            label="Real-time"
            value={realtimeOnline ? "подключён" : "офлайн"}
          />
        </dl>
      </Card>

      <Card
        title="Сервер"
        description="Адрес API задаётся переменной NEXT_PUBLIC_API_URL при сборке дашборда."
      >
        <dl className="grid gap-2 text-xs">
          <Row label="API" value={API_URL} mono />
          <Row label="База" value="SQLite через Prisma (на сервере API)" />
        </dl>
      </Card>

      <Card title="Разделы настроек">
        <div className="grid gap-2 sm:grid-cols-2">
          {SECTION_LINKS.map((section) => (
            <Link
              key={section.href}
              href={section.href}
              className="group rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 transition-colors hover:border-sky-700 hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              <p className="text-sm font-medium text-zinc-200 group-hover:text-sky-300">
                {section.title}
              </p>
              <p className="mt-1 text-[11px] text-zinc-500">
                {section.description}
              </p>
            </Link>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-950/40 px-2.5 py-1.5">
      <dt className="shrink-0 text-zinc-500">{label}</dt>
      <dd
        className={`min-w-0 break-words text-right text-zinc-300 ${
          mono ? "font-mono text-[11px]" : ""
        }`}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}
