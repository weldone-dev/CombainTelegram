"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  ErrorBanner,
  GhostButton,
  Pill,
} from "../../components/dashboard/ai-ui";
import { useAppData } from "../../components/dashboard/app-data";
import type { EvePersonaView } from "../../lib/eve-api";
import { eveErrorMessage, listPersonas } from "../../lib/eve-api";
import { PersonaEditor } from "./persona-editor";

/**
 * Eve workspace: one persona at a time, with its Telegram account bindings,
 * explicit chat allowlist and read-only relationship/conflict state.
 *
 * All calls go through `/api/eve/*`; the browser never sees `EVE_TOKEN`.
 */
export function EvePage() {
  const { accounts, accountsLoading, accountsError, showNotice } = useAppData();
  const [personas, setPersonas] = useState<EvePersonaView[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (preferId?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const list = await listPersonas();
      setPersonas(list);
      setSelectedId((current) => {
        const wanted = preferId === undefined ? current : preferId;
        if (wanted && list.some((persona) => persona.id === wanted)) {
          return wanted;
        }
        return list[0]?.id ?? null;
      });
    } catch (loadError) {
      setError(eveErrorMessage(loadError));
      setPersonas((current) => current ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selected = useMemo(
    () => personas?.find((persona) => persona.id === selectedId) ?? null,
    [personas, selectedId],
  );

  const handleSaved = useCallback(
    async (saved: EvePersonaView) => {
      await load(saved.id);
      showNotice(`Персона «${saved.name}» сохранена`);
    },
    [load, showNotice],
  );

  const handleChanged = useCallback(async () => {
    await load(selectedId);
  }, [load, selectedId]);

  return (
    <div className="mx-auto grid h-full w-full max-w-6xl content-start gap-4 overflow-y-auto p-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <div className="flex flex-wrap items-start justify-between gap-2 lg:col-span-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Eve</h2>
          <p className="mt-1 max-w-3xl text-xs text-zinc-500">
            Персоны живут в отдельном Eve-процессе, а Telegram остаётся у Nest.
            Eve отвечает только на чаты из allowlist и только для привязанных
            аккаунтов.
          </p>
        </div>
        <Link
          href="/eve/context"
          className="text-xs text-sky-400 hover:text-sky-300"
        >
          Контекст модели →
        </Link>
      </div>

      {error && (
        <div className="lg:col-span-2">
          <ErrorBanner message={error} />
          <div className="-mt-1">
            <GhostButton onClick={() => void load()} disabled={loading}>
              {loading ? "Повторная загрузка…" : "Повторить"}
            </GhostButton>
          </div>
        </div>
      )}

      <Card
        title="Персоны"
        description={
          loading && !personas ? "Загрузка…" : `Всего: ${personas?.length ?? 0}`
        }
        actions={
          <GhostButton
            onClick={() => {
              setSelectedId(null);
            }}
          >
            + Новая
          </GhostButton>
        }
      >
        {loading && !personas ? (
          <div className="space-y-1" aria-hidden="true">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className="h-12 animate-pulse rounded-md bg-zinc-800/60"
              />
            ))}
          </div>
        ) : error && (!personas || personas.length === 0) ? (
          <p className="text-xs text-zinc-500">
            Список персон не загрузился — повторите запрос выше.
          </p>
        ) : !personas || personas.length === 0 ? (
          <p className="text-xs text-zinc-500">
            Персон пока нет. Создайте первую кнопкой «+ Новая».
          </p>
        ) : (
          <div className="space-y-1">
            {personas.map((persona) => {
              const active = persona.id === selectedId;
              const bound = persona.accounts?.length ?? 0;
              return (
                <button
                  key={persona.id}
                  type="button"
                  onClick={() => setSelectedId(persona.id)}
                  aria-pressed={active}
                  className={`flex w-full flex-col gap-0.5 rounded-md px-2 py-2 text-left text-sm ${
                    active
                      ? "bg-sky-500/15 text-sky-200"
                      : "text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate">
                      {persona.name}
                    </span>
                    <Pill tone={bound > 0 ? "green" : "zinc"}>
                      {bound} акк.
                    </Pill>
                  </span>
                  <span className="truncate text-[11px] text-zinc-500">
                    {persona.age} лет · {persona.nationality} ·{" "}
                    {persona.timezone}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <PersonaEditor
        key={selected?.id ?? "new"}
        persona={selected}
        accounts={accounts}
        accountsLoading={accountsLoading}
        accountsError={accountsError}
        onSaved={handleSaved}
        onChanged={handleChanged}
        onNotice={showNotice}
      />
    </div>
  );
}
