import { Suspense } from "react";
import { LogsPage } from "../../components/dashboard/logs-page";

export default function LogsRoute() {
  return (
    <Suspense
      fallback={
        <p className="p-6 text-sm text-zinc-500">Загрузка журнала событий…</p>
      }
    >
      <LogsPage />
    </Suspense>
  );
}
