import type { Metadata } from "next";
import { Suspense } from "react";
import { SchedulesPage } from "./schedules-page";

export const metadata: Metadata = {
  title: "Eve · Schedules",
  description:
    "Что Eve отложила или запланировала: cron-расписания и durable-очередь",
};

export default function EveSchedulesRoute() {
  return (
    <Suspense
      fallback={
        <div className="p-4 text-sm text-zinc-500">Загрузка расписаний…</div>
      }
    >
      <SchedulesPage />
    </Suspense>
  );
}
