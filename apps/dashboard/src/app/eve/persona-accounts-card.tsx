"use client";

import { useState } from "react";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
  PrimaryButton,
} from "../../components/dashboard/ai-ui";
import {
  bindAccount,
  type EvePersonaView,
  eveErrorMessage,
  unbindAccount,
} from "../../lib/eve-api";
import { accountName } from "../../lib/format";
import type { AccountView } from "../../lib/types";

type RelationshipMode = "shared" | "isolated";

function asMode(value: string): RelationshipMode {
  return value === "shared" ? "shared" : "isolated";
}

function labelOf(accountId: string, accounts: AccountView[]): string {
  const account = accounts.find((item) => item.id === accountId);
  return account ? accountName(account) : accountId;
}

export function PersonaAccountsCard({
  persona,
  accounts,
  accountsLoading,
  accountsError,
  onChanged,
  onNotice,
}: {
  persona: EvePersonaView;
  accounts: AccountView[];
  accountsLoading: boolean;
  accountsError: string | null;
  onChanged: () => Promise<void> | void;
  onNotice: (message: string) => void;
}) {
  const [pick, setPick] = useState("");
  const [mode, setMode] = useState<RelationshipMode>("isolated");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const bound = persona.accounts ?? [];
  const boundIds = new Set(bound.map((item) => item.accountId));
  const available = accounts.filter((account) => !boundIds.has(account.id));
  const pickId = available.some((account) => account.id === pick)
    ? pick
    : (available[0]?.id ?? "");

  const attach = async (
    accountId: string,
    relationshipMode: RelationshipMode,
  ) => {
    setBusy(accountId);
    setError(null);
    setSaved(null);
    try {
      await bindAccount(persona.id, { accountId, relationshipMode });
      setSaved(
        `Аккаунт ${labelOf(accountId, accounts)} привязан (${relationshipMode})`,
      );
      onNotice(`Аккаунт привязан к персоне «${persona.name}»`);
      await onChanged();
    } catch (bindError) {
      setError(eveErrorMessage(bindError));
    } finally {
      setBusy(null);
    }
  };

  const detach = async (accountId: string) => {
    if (
      !window.confirm(
        `Отвязать ${labelOf(accountId, accounts)} от персоны «${persona.name}»?`,
      )
    ) {
      return;
    }
    setBusy(accountId);
    setError(null);
    setSaved(null);
    try {
      await unbindAccount(persona.id, accountId);
      setSaved("Аккаунт отвязан");
      onNotice("Аккаунт отвязан от персоны");
      await onChanged();
    } catch (unbindError) {
      setError(eveErrorMessage(unbindError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title="Аккаунты"
      description="С одного аккаунта Eve отвечает только по явному allowlist. Режим отношений задаётся отдельно для каждой привязки."
    >
      <ErrorBanner message={error} />
      <ErrorBanner
        message={
          accountsError
            ? `Аккаунты Telegram не загрузились: ${accountsError}`
            : null
        }
      />
      <OkBanner message={saved} />

      {bound.length === 0 ? (
        <p className="text-xs text-zinc-500">
          К персоне пока не привязан ни один аккаунт.
        </p>
      ) : (
        <div className="space-y-2">
          {bound.map((binding) => (
            <div
              key={binding.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/30 px-2.5 py-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">
                {labelOf(binding.accountId, accounts)}
              </span>
              {!binding.enabled && <Pill tone="red">off</Pill>}
              <select
                value={asMode(binding.relationshipMode)}
                disabled={busy !== null}
                onChange={(event) =>
                  void attach(binding.accountId, asMode(event.target.value))
                }
                aria-label="Режим отношений"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-sky-500"
              >
                <option value="isolated">isolated</option>
                <option value="shared">shared</option>
              </select>
              <GhostButton
                onClick={() => void detach(binding.accountId)}
                disabled={busy !== null}
                danger
              >
                {busy === binding.accountId ? "…" : "Отвязать"}
              </GhostButton>
            </div>
          ))}
        </div>
      )}

      <div className="mt-3 grid items-end gap-2 sm:grid-cols-[minmax(0,1fr)_150px_auto]">
        <Field
          label="Добавить аккаунт"
          hint={
            accountsLoading
              ? "Загрузка аккаунтов…"
              : available.length === 0
                ? "Все доступные аккаунты уже привязаны"
                : "Аккаунт, от имени которого будет отвечать Eve"
          }
        >
          <select
            value={pickId}
            onChange={(event) => setPick(event.target.value)}
            disabled={
              accountsLoading || available.length === 0 || busy !== null
            }
            className={inputClass}
          >
            {available.length === 0 && <option value="">Нет доступных</option>}
            {available.map((account) => (
              <option key={account.id} value={account.id}>
                {accountName(account)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Режим отношений"
          hint="shared: одна история на собеседника; isolated: на аккаунт"
        >
          <select
            value={mode}
            onChange={(event) => setMode(asMode(event.target.value))}
            disabled={busy !== null}
            className={inputClass}
          >
            <option value="isolated">isolated</option>
            <option value="shared">shared</option>
          </select>
        </Field>
        <PrimaryButton
          onClick={() => {
            if (pickId) void attach(pickId, mode);
          }}
          disabled={!pickId || busy !== null}
        >
          {busy === pickId && busy !== null ? "Привязка…" : "Привязать"}
        </PrimaryButton>
      </div>
    </Card>
  );
}
