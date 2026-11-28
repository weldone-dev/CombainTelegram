"use client";

import { useState } from "react";
import {
  Card,
  ErrorBanner,
  Field,
  inputClass,
  Pill,
  PrimaryButton,
} from "../../components/dashboard/ai-ui";
import { BipolarMetric } from "../../components/dashboard/bipolar-metric";
import {
  type EveChatBindingView,
  type EveConflictView,
  type EveRelationshipView,
  eveErrorMessage,
  getConflict,
  getRelationship,
} from "../../lib/eve-api";
import { accountName } from "../../lib/format";
import type { AccountView } from "../../lib/types";

function labelOf(accountId: string, accounts: AccountView[]): string {
  const account = accounts.find((item) => item.id === accountId);
  return account ? accountName(account) : accountId;
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function conflictTone(level: number): "green" | "amber" | "red" {
  if (level <= 0) return "green";
  if (level === 1) return "amber";
  return "red";
}

export function PersonaStateCard({
  personaId,
  accounts,
  boundAccountIds,
  bindings,
}: {
  personaId: string;
  accounts: AccountView[];
  boundAccountIds: string[];
  bindings: EveChatBindingView[];
}) {
  const stateAccountIds = [
    ...new Set([
      ...boundAccountIds,
      ...bindings.map((binding) => binding.accountId),
    ]),
  ];

  const [account, setAccount] = useState("");
  const [chatId, setChatId] = useState("");
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [relationshipError, setRelationshipError] = useState<string | null>(
    null,
  );
  const [conflictError, setConflictError] = useState<string | null>(null);
  const [relationship, setRelationship] = useState<EveRelationshipView | null>(
    null,
  );
  const [conflict, setConflict] = useState<EveConflictView | null>(null);

  const accountId = stateAccountIds.includes(account)
    ? account
    : (stateAccountIds[0] ?? "");

  const load = async () => {
    setLocalError(null);
    setRelationshipError(null);
    setConflictError(null);

    const raw = chatId.trim();
    const parsed = Number(raw);
    if (!raw || !Number.isSafeInteger(parsed) || parsed === 0) {
      setLocalError("Chat ID должен быть целым ненулевым числом");
      return;
    }
    if (!accountId) {
      setLocalError("Сначала привяжите аккаунт к персоне");
      return;
    }

    setLoading(true);
    setRelationship(null);
    setConflict(null);
    const [relationshipResult, conflictResult] = await Promise.allSettled([
      getRelationship(personaId, accountId, raw),
      getConflict(personaId, accountId, raw),
    ]);

    if (relationshipResult.status === "fulfilled") {
      setRelationship(relationshipResult.value);
    } else {
      setRelationshipError(eveErrorMessage(relationshipResult.reason));
    }
    if (conflictResult.status === "fulfilled") {
      setConflict(conflictResult.value);
    } else {
      setConflictError(eveErrorMessage(conflictResult.reason));
    }
    setLoading(false);
  };

  const pickBinding = (key: string) => {
    const binding = bindings.find((item) => item.id === key);
    if (!binding) return;
    setAccount(binding.accountId);
    setChatId(String(binding.chatId));
    setRelationship(null);
    setConflict(null);
  };

  return (
    <Card
      title="Состояние отношений"
      description="Relationship и conflict выбранного чата. Просмотр без редактирования."
      actions={<Pill>только чтение</Pill>}
    >
      <ErrorBanner message={localError} />

      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Аккаунт">
          <select
            value={accountId}
            onChange={(event) => {
              setAccount(event.target.value);
              setRelationship(null);
              setConflict(null);
            }}
            disabled={stateAccountIds.length === 0}
            className={inputClass}
          >
            {stateAccountIds.length === 0 && (
              <option value="">Нет привязанных аккаунтов</option>
            )}
            {stateAccountIds.map((id) => (
              <option key={id} value={id}>
                {labelOf(id, accounts)}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="Chat ID"
          hint="Можно взять из allowlist или ввести вручную."
        >
          <input
            value={chatId}
            onChange={(event) => {
              setChatId(event.target.value);
              setRelationship(null);
              setConflict(null);
            }}
            className={`${inputClass} font-mono`}
            placeholder="-1001234567890"
            inputMode="numeric"
            autoComplete="off"
          />
        </Field>
        {bindings.length > 0 && (
          <Field
            label="Из allowlist"
            hint="Подставить пару аккаунт + chat ID."
            className="sm:col-span-2"
          >
            <select
              value=""
              onChange={(event) => pickBinding(event.target.value)}
              className={inputClass}
            >
              <option value="">— выбрать чат —</option>
              {bindings.map((binding) => (
                <option key={binding.id} value={binding.id}>
                  {labelOf(binding.accountId, accounts)} · chat{" "}
                  {String(binding.chatId)}
                  {binding.allowed ? "" : " (blocked)"}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>

      <div className="mt-3">
        <PrimaryButton
          onClick={() => void load()}
          disabled={loading || !accountId || !chatId.trim()}
        >
          {loading ? "Загрузка…" : "Показать состояние"}
        </PrimaryButton>
      </div>

      {!relationship && !conflict && !loading && !relationshipError && (
        <p className="mt-3 text-xs text-zinc-500">
          Выберите аккаунт и chat ID, чтобы увидеть текущие отношения и уровень
          конфликта.
        </p>
      )}

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold text-zinc-200">
              Relationship
            </h3>
            {relationship && (
              <>
                <Pill tone="sky">{relationship.stage}</Pill>
                <span className="font-mono text-[10px] text-zinc-500">
                  {relationship.scopeKey}
                </span>
              </>
            )}
          </div>
          <ErrorBanner message={relationshipError} />
          {relationship ? (
            <div className="space-y-2">
              <BipolarMetric label="Interest" value={relationship.interest} />
              <BipolarMetric label="Trust" value={relationship.trust} />
              <BipolarMetric
                label="Attraction"
                value={relationship.attraction}
              />
              <BipolarMetric label="Annoyance" value={relationship.annoyance} />
              <BipolarMetric label="Cringe" value={relationship.cringe} />
              <p className="break-words text-xs text-zinc-400">
                {relationship.notes || "Заметок нет"}
              </p>
              <p className="text-[10px] text-zinc-600">
                обновлено {formatDate(relationship.updatedAt)}
              </p>
            </div>
          ) : (
            !relationshipError && (
              <p className="text-xs text-zinc-500">
                {loading ? "Загрузка…" : "Нет данных"}
              </p>
            )
          )}
        </div>

        <div className="min-w-0 rounded-lg border border-zinc-800 bg-zinc-950/30 p-3">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <h3 className="text-xs font-semibold text-zinc-200">Conflict</h3>
            {conflict && (
              <Pill tone={conflictTone(conflict.level)}>
                level {conflict.level}
              </Pill>
            )}
          </div>
          <ErrorBanner message={conflictError} />
          {conflict ? (
            <div className="space-y-1 text-xs text-zinc-400">
              <p>
                Холодная пауза до:{" "}
                <span className="text-zinc-200">
                  {formatDate(conflict.coldUntil)}
                </span>
              </p>
              <p className="break-words">
                Причина:{" "}
                <span className="text-zinc-200">
                  {conflict.reason || "не указана"}
                </span>
              </p>
              {conflict.history && conflict.history !== "[]" && (
                <details>
                  <summary className="cursor-pointer text-[11px] text-zinc-500">
                    История
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-900 p-2 font-mono text-[10px] text-zinc-400">
                    {conflict.history}
                  </pre>
                </details>
              )}
              <p className="text-[10px] text-zinc-600">
                обновлено {formatDate(conflict.updatedAt)}
              </p>
            </div>
          ) : (
            !conflictError && (
              <p className="text-xs text-zinc-500">
                {loading ? "Загрузка…" : "Нет данных"}
              </p>
            )
          )}
        </div>
      </div>
    </Card>
  );
}
