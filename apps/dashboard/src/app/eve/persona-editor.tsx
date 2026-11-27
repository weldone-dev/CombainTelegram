"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type EveChatBindingView,
  type EvePersonaView,
  eveErrorMessage,
  listChats,
} from "../../lib/eve-api";
import type { AccountView } from "../../lib/types";
import { PersonaAccountsCard } from "./persona-accounts-card";
import { PersonaAllowlistCard } from "./persona-allowlist-card";
import { PersonaDocsCard } from "./persona-docs-card";
import { PersonaForm } from "./persona-form";
import { PersonaMemoryCard } from "./persona-memory-card";
import { PersonaStateCard } from "./persona-state-card";

export function PersonaEditor({
  persona,
  accounts,
  accountsLoading,
  accountsError,
  onSaved,
  onChanged,
  onNotice,
}: {
  persona: EvePersonaView | null;
  accounts: AccountView[];
  accountsLoading: boolean;
  accountsError: string | null;
  onSaved: (persona: EvePersonaView) => Promise<void> | void;
  onChanged: () => Promise<void> | void;
  onNotice: (message: string) => void;
}) {
  const personaId = persona?.id ?? null;
  const [bindings, setBindings] = useState<EveChatBindingView[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(false);
  const [bindingsError, setBindingsError] = useState<string | null>(null);

  const loadBindings = useCallback(async (id: string) => {
    setBindingsLoading(true);
    setBindingsError(null);
    try {
      setBindings(await listChats(id));
    } catch (loadError) {
      setBindingsError(eveErrorMessage(loadError));
    } finally {
      setBindingsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!personaId) {
      setBindings([]);
      setBindingsError(null);
      return;
    }
    void loadBindings(personaId);
  }, [personaId, loadBindings]);

  const boundAccountIds = useMemo(
    () => persona?.accounts?.map((account) => account.accountId) ?? [],
    [persona],
  );

  return (
    <div className="min-w-0 space-y-4">
      <PersonaForm persona={persona} onSaved={onSaved} onNotice={onNotice} />

      {persona ? (
        <>
          <PersonaDocsCard personaId={persona.id} onNotice={onNotice} />

          <PersonaAccountsCard
            persona={persona}
            accounts={accounts}
            accountsLoading={accountsLoading}
            accountsError={accountsError}
            onChanged={onChanged}
            onNotice={onNotice}
          />

          <PersonaAllowlistCard
            personaId={persona.id}
            accounts={accounts}
            boundAccountIds={boundAccountIds}
            bindings={bindings}
            loading={bindingsLoading}
            error={bindingsError}
            onReload={() => loadBindings(persona.id)}
            onNotice={onNotice}
          />

          <PersonaStateCard
            personaId={persona.id}
            accounts={accounts}
            boundAccountIds={boundAccountIds}
            bindings={bindings}
          />

          <PersonaMemoryCard personaId={persona.id} />
        </>
      ) : (
        <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 p-4 text-sm text-zinc-400">
          Сохраните персону — после этого здесь появятся документы, привязки
          аккаунтов, allowlist чатов, состояние отношений и память.
        </div>
      )}
    </div>
  );
}
