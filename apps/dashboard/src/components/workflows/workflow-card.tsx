"use client";

import { useEffect, useState } from "react";
import { accountName } from "../../lib/format";
import type { AccountView } from "../../lib/types";
import {
  deleteWorkflow,
  listN8nExecutions,
  type N8nExecutionSummary,
  type N8nExecutionsResult,
  n8nWorkflowUrl,
  setWorkflowAccounts,
  updateWorkflow,
  type WorkflowAccountView,
  type WorkflowView,
  workflowErrorMessage,
} from "../../lib/workflows-api";
import {
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
  Toggle,
} from "../dashboard/ai-ui";

function executionTone(status: string): "green" | "amber" | "red" | "zinc" {
  const value = status.toLowerCase();
  if (["success", "succeeded"].includes(value)) return "green";
  if (["error", "failed", "crashed"].includes(value)) return "red";
  if (["running", "waiting", "new"].includes(value)) return "amber";
  return "zinc";
}

function formatDateTime(iso: string | null): string {
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

function durationOf(execution: N8nExecutionSummary): string {
  if (!execution.startedAt || !execution.stoppedAt) return "";
  const started = new Date(execution.startedAt).getTime();
  const stopped = new Date(execution.stoppedAt).getTime();
  if (Number.isNaN(started) || Number.isNaN(stopped)) return "";
  const seconds = Math.max(0, Math.round((stopped - started) / 100) / 10);
  return ` · ${seconds} с`;
}

/**
 * One local workflow: rename, enable/disable, assigned accounts and their
 * editor, link into n8n and the latest executions. Assignment and toggle are
 * applied optimistically and rolled back on failure.
 */
export function WorkflowCard({
  workflow,
  accounts,
  baseUrl,
  onUpdated,
  onRemoved,
  onNotice,
}: {
  workflow: WorkflowView;
  accounts: AccountView[];
  baseUrl: string;
  onUpdated: (workflow: WorkflowView) => void;
  onRemoved: (id: string) => void;
  onNotice?: (message: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(workflow.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [draftIds, setDraftIds] = useState<string[]>([]);
  const [savingAccounts, setSavingAccounts] = useState(false);

  const [executionsOpen, setExecutionsOpen] = useState(false);
  const [executionsLoading, setExecutionsLoading] = useState(false);
  const [executions, setExecutions] = useState<N8nExecutionsResult | null>(
    null,
  );

  useEffect(() => {
    setDraftName(workflow.name);
  }, [workflow.name]);

  const toggleEnabled = async (next: boolean) => {
    const previous = workflow;
    setBusy(true);
    setError(null);
    setStatus(null);
    onUpdated({ ...workflow, enabled: next });
    try {
      const saved = await updateWorkflow(workflow.id, { enabled: next });
      onUpdated(saved);
    } catch (toggleError) {
      onUpdated(previous);
      setError(workflowErrorMessage(toggleError));
    } finally {
      setBusy(false);
    }
  };

  const saveName = async () => {
    const name = draftName.trim();
    if (!name) {
      setError("Название не может быть пустым");
      return;
    }
    if (name === workflow.name) {
      setEditing(false);
      return;
    }
    const previous = workflow;
    setBusy(true);
    setError(null);
    onUpdated({ ...workflow, name });
    try {
      const saved = await updateWorkflow(workflow.id, { name });
      onUpdated(saved);
      setEditing(false);
      onNotice?.(`Workflow переименован в «${saved.name}»`);
    } catch (renameError) {
      onUpdated(previous);
      setError(workflowErrorMessage(renameError));
    } finally {
      setBusy(false);
    }
  };

  const openPicker = () => {
    setDraftIds(workflow.accounts.map((account) => account.id));
    setPickerOpen((open) => !open);
  };

  const saveAccounts = async () => {
    const previous = workflow;
    const nextAccounts: WorkflowAccountView[] = accounts
      .filter((account) => draftIds.includes(account.id))
      .map((account) => ({
        id: account.id,
        title: accountName(account),
        username: account.username,
      }));
    setSavingAccounts(true);
    setError(null);
    setStatus(null);
    onUpdated({ ...workflow, accounts: nextAccounts });
    try {
      const saved = await setWorkflowAccounts(workflow.id, draftIds);
      onUpdated(saved);
      setPickerOpen(false);
      setStatus("Назначения сохранены");
    } catch (assignError) {
      onUpdated(previous);
      setError(workflowErrorMessage(assignError));
    } finally {
      setSavingAccounts(false);
    }
  };

  const toggleExecutionPanel = async () => {
    if (!workflow.n8nWorkflowId) return;
    const open = !executionsOpen;
    setExecutionsOpen(open);
    if (!open || executions) return;
    setExecutionsLoading(true);
    try {
      setExecutions(await listN8nExecutions(workflow.n8nWorkflowId, 10));
    } catch (loadError) {
      setExecutions({
        ok: false,
        executions: [],
        error: workflowErrorMessage(loadError),
      });
    } finally {
      setExecutionsLoading(false);
    }
  };

  const remove = async () => {
    const confirmed = window.confirm(
      `Удалить workflow «${workflow.name}» из списка?\n\nСам workflow в n8n останется. Аккаунты (${workflow.accounts.length}) будут отвязаны и вернутся в legacy-режим.`,
    );
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await deleteWorkflow(workflow.id);
      onRemoved(workflow.id);
      onNotice?.(`Workflow «${workflow.name}» удалён из списка`);
    } catch (deleteError) {
      setError(workflowErrorMessage(deleteError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="min-w-0 rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-[12rem] flex-1">
          {editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void saveName();
                  if (event.key === "Escape") {
                    setDraftName(workflow.name);
                    setEditing(false);
                  }
                }}
                autoComplete="off"
                spellCheck={false}
                name={`ct-workflow-name-${workflow.id}`}
                className={`${inputClass} mt-0 max-w-sm`}
              />
              <GhostButton onClick={() => void saveName()} disabled={busy}>
                Сохранить
              </GhostButton>
              <GhostButton
                onClick={() => {
                  setDraftName(workflow.name);
                  setEditing(false);
                }}
              >
                Отмена
              </GhostButton>
            </div>
          ) : (
            <h3 className="flex flex-wrap items-center gap-1.5 break-words text-sm font-semibold text-zinc-100">
              {workflow.name}
              {workflow.isDraft && <Pill tone="amber">Эксперимент</Pill>}
              {!workflow.enabled && <Pill tone="zinc">выключен</Pill>}
            </h3>
          )}
          <p className="mt-0.5 truncate text-[11px] text-zinc-500">
            {workflow.n8nWorkflowId ? (
              <>
                n8n ID {workflow.n8nWorkflowId}
                {workflow.n8nWorkflowName
                  ? ` · ${workflow.n8nWorkflowName}`
                  : ""}
              </>
            ) : (
              "n8n ID не задан"
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Toggle
            checked={workflow.enabled}
            onChange={(next) => void toggleEnabled(next)}
            label="Включён"
            disabled={busy}
          />
          {!editing && (
            <GhostButton onClick={() => setEditing(true)} disabled={busy}>
              Переименовать
            </GhostButton>
          )}
          {workflow.n8nWorkflowId && (
            <a
              href={n8nWorkflowUrl(baseUrl, workflow.n8nWorkflowId)}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border border-zinc-700 px-2.5 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              Открыть в n8n
            </a>
          )}
          <GhostButton onClick={() => void remove()} disabled={busy} danger>
            Удалить
          </GhostButton>
        </div>
      </div>

      <ErrorBanner message={error} />
      <OkBanner message={status} />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {workflow.accounts.length === 0 ? (
          <span className="text-[11px] text-amber-300/80">
            Нет аккаунтов — workflow пока никого не обслуживает
          </span>
        ) : (
          workflow.accounts.map((account) => (
            <span
              key={account.id}
              title={account.username ? `@${account.username}` : account.id}
              className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] text-sky-200"
            >
              {account.title}
            </span>
          ))
        )}
        <GhostButton onClick={openPicker} disabled={savingAccounts}>
          {pickerOpen ? "Скрыть аккаунты" : "Аккаунты"}
        </GhostButton>
        {workflow.n8nWorkflowId && (
          <GhostButton
            onClick={() => void toggleExecutionPanel()}
            disabled={executionsLoading}
          >
            {executionsLoading
              ? "Запуски…"
              : executionsOpen
                ? "Скрыть запуски"
                : "Последние запуски"}
          </GhostButton>
        )}
      </div>

      {pickerOpen && (
        <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          <Field
            label="Аккаунты этого workflow"
            hint="Один workflow можно повесить на несколько аккаунтов. Аккаунт без workflow работает в legacy-режиме (или без ИИ, если включён strict)."
          >
            <div className="mt-1 grid max-h-56 gap-1 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-2 sm:grid-cols-2">
              {accounts.length === 0 ? (
                <span className="text-[11px] text-zinc-500">
                  Аккаунтов пока нет
                </span>
              ) : (
                accounts.map((account) => {
                  const checked = draftIds.includes(account.id);
                  return (
                    <label
                      key={account.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800/60"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) =>
                          setDraftIds((current) =>
                            event.target.checked
                              ? [...current, account.id]
                              : current.filter((id) => id !== account.id),
                          )
                        }
                        autoComplete="off"
                        className="h-3.5 w-3.5 accent-sky-500"
                      />
                      <span className="truncate">{accountName(account)}</span>
                      {account.username && (
                        <span className="truncate text-[10px] text-zinc-500">
                          @{account.username}
                        </span>
                      )}
                    </label>
                  );
                })
              )}
            </div>
          </Field>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <GhostButton
              onClick={() => void saveAccounts()}
              disabled={savingAccounts}
            >
              {savingAccounts ? "Сохранение…" : "Сохранить назначения"}
            </GhostButton>
            <span className="text-[11px] text-zinc-500">
              Аккаунт может быть только в одном workflow — выбор здесь
              переназначит его.
            </span>
          </div>
        </div>
      )}

      {executionsOpen && (
        <div className="mt-2 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
          {executionsLoading && (
            <p className="text-[11px] text-zinc-500">Загрузка запусков…</p>
          )}
          {!executionsLoading && executions && !executions.ok && (
            <p className="break-words text-[11px] text-amber-300">
              n8n недоступен
              {executions.error ? `: ${executions.error}` : ""}
            </p>
          )}
          {!executionsLoading &&
            executions?.ok &&
            executions.executions.length === 0 && (
              <p className="text-[11px] text-zinc-500">Запусков ещё не было</p>
            )}
          {!executionsLoading &&
            executions?.ok &&
            executions.executions.length > 0 && (
              <ul className="divide-y divide-zinc-800/70">
                {executions.executions.map((execution) => (
                  <li
                    key={execution.id}
                    className="flex flex-wrap items-center gap-2 py-1.5 text-[11px] text-zinc-400"
                  >
                    <Pill tone={executionTone(execution.status)}>
                      {execution.status}
                    </Pill>
                    <span className="min-w-0 flex-1 truncate">
                      #{execution.id}
                      {execution.mode ? ` · ${execution.mode}` : ""}
                    </span>
                    <span className="shrink-0 text-zinc-500">
                      {formatDateTime(execution.startedAt)}
                      {durationOf(execution)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
        </div>
      )}
    </section>
  );
}
