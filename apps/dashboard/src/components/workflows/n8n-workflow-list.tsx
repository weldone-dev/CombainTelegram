"use client";

import { useState } from "react";
import type { N8nWorkflowsResult } from "../../lib/workflows-api";
import { n8nWorkflowUrl, workflowErrorMessage } from "../../lib/workflows-api";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  Pill,
  PrimaryButton,
} from "../dashboard/ai-ui";

interface RemotePick {
  id: string;
  name: string;
}

function formatUpdated(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Read-only list of workflows that live in n8n. Each row can be pointed at by
 * the local registry; editing happens in n8n itself. When n8n is unreachable
 * the manual "add by id" form stays available.
 */
export function N8nWorkflowList({
  result,
  loading,
  error,
  baseUrl,
  existingIds,
  onUse,
  onRefresh,
}: {
  result: N8nWorkflowsResult | null;
  loading: boolean;
  error: string | null;
  baseUrl: string;
  existingIds: Set<string>;
  onUse: (pick: RemotePick) => Promise<void>;
  onRefresh: () => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const [manualName, setManualName] = useState("");
  const [manualId, setManualId] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);

  const remote = result?.workflows ?? [];
  const remoteError = error ?? (result && !result.ok ? result.error : null);
  const unreachable = Boolean(remoteError);

  const ordered = [...remote].sort((left, right) => {
    if (left.active !== right.active) return left.active ? -1 : 1;
    const updated = (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "");
    if (updated !== 0) return updated;
    return left.name.localeCompare(right.name);
  });

  const use = async (pick: RemotePick) => {
    setBusyId(pick.id);
    setAddError(null);
    try {
      await onUse(pick);
    } catch (useError) {
      setAddError(workflowErrorMessage(useError));
    } finally {
      setBusyId(null);
    }
  };

  const addManual = async () => {
    const id = manualId.trim();
    if (!id) {
      setAddError("Укажите ID workflow из n8n");
      return;
    }
    setBusyId(id);
    setAddError(null);
    try {
      await onUse({ id, name: manualName.trim() || id });
      setManualId("");
      setManualName("");
      setManualOpen(false);
    } catch (useError) {
      setAddError(workflowErrorMessage(useError));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card
      title="Workflow в n8n"
      description="Список читается из n8n. «Использовать» добавляет workflow в локальный список и дальше его можно повесить на аккаунты."
      actions={
        <div className="flex flex-wrap gap-2">
          <GhostButton onClick={onRefresh} disabled={loading}>
            {loading ? "Обновление…" : "Обновить список"}
          </GhostButton>
          <GhostButton onClick={() => setManualOpen((open) => !open)}>
            {manualOpen ? "Скрыть ручное добавление" : "Добавить по ID"}
          </GhostButton>
        </div>
      }
    >
      <ErrorBanner message={addError} />
      {unreachable && (
        <div
          role="alert"
          className="mb-3 break-words rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-sm text-amber-200"
        >
          n8n недоступен
          {remoteError ? `: ${remoteError}` : ""}. Проверьте адрес и ключ выше
          либо добавьте workflow по ID вручную.
        </div>
      )}

      {manualOpen && (
        <div className="mb-3 grid gap-3 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <Field label="Название в списке">
            <input
              value={manualName}
              onChange={(event) => setManualName(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              name="ct-manual-workflow-name"
              className={inputClass}
              placeholder="Например, Поддержка"
            />
          </Field>
          <Field label="ID workflow в n8n">
            <input
              value={manualId}
              onChange={(event) => setManualId(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              name="ct-manual-workflow-id"
              className={inputClass}
              placeholder="AbC123xyz"
            />
          </Field>
          <PrimaryButton
            onClick={() => void addManual()}
            disabled={busyId !== null}
          >
            {busyId !== null ? "Добавление…" : "Добавить"}
          </PrimaryButton>
        </div>
      )}

      {loading && !result ? (
        <div className="space-y-2" aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <div
              key={row}
              className="h-11 animate-pulse rounded-lg bg-zinc-800/60"
            />
          ))}
        </div>
      ) : ordered.length === 0 ? (
        !unreachable && (
          <p className="text-xs text-zinc-500">
            В n8n пока нет workflow. Создайте первый в самом n8n и обновите
            список.
          </p>
        )
      ) : (
        <ul className="divide-y divide-zinc-800">
          {ordered.map((workflow) => {
            const added = existingIds.has(workflow.id);
            return (
              <li
                key={workflow.id}
                className="flex flex-wrap items-center gap-2 py-2 first:pt-0 last:pb-0"
              >
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5 text-sm text-zinc-100">
                    <span className="break-words">{workflow.name}</span>
                    <Pill tone={workflow.active ? "green" : "zinc"}>
                      {workflow.active ? "активен" : "выключен"}
                    </Pill>
                  </p>
                  <p className="truncate text-[11px] text-zinc-500">
                    ID {workflow.id} · изменён{" "}
                    {formatUpdated(workflow.updatedAt)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <a
                    href={n8nWorkflowUrl(baseUrl, workflow.id)}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                  >
                    Открыть
                  </a>
                  <GhostButton
                    onClick={() => void use(workflow)}
                    disabled={added || busyId !== null}
                  >
                    {added
                      ? "Уже добавлен"
                      : busyId === workflow.id
                        ? "Добавление…"
                        : "Использовать"}
                  </GhostButton>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
