"use client";

import { useCallback, useEffect, useState } from "react";
import {
  type AccountAiMode,
  type AccountWorkflowView,
  AI_MODE_LABELS,
  getAccountWorkflow,
  listWorkflows,
  setWorkflowAccounts,
  type WorkflowView,
  workflowErrorMessage,
} from "../../lib/workflows-api";
import {
  Card,
  ErrorBanner,
  Field,
  GhostButton,
  inputClass,
  OkBanner,
  Pill,
} from "../dashboard/ai-ui";

/** Compact engine badge: workflow / legacy / ИИ выключен. */
export function AiModeBadge({ mode }: { mode: AccountAiMode }) {
  const view = AI_MODE_LABELS[mode];
  return <Pill tone={view.tone}>{view.label}</Pill>;
}

/**
 * Account-side workflow assignment. The API keeps the relation on the workflow
 * side, so picking a workflow adds this account to its set and «Без workflow»
 * removes it from the current one. The effective `aiMode` comes from
 * `GET /accounts/:id/workflow`.
 */
export function AccountWorkflowPicker({
  accountId,
  onNotice,
}: {
  accountId: string;
  onNotice?: (message: string) => void;
}) {
  const [state, setState] = useState<AccountWorkflowView | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [accountState, list] = await Promise.all([
        getAccountWorkflow(accountId),
        listWorkflows(),
      ]);
      setState(accountState);
      setWorkflows(list);
    } catch (loadError) {
      setError(workflowErrorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const change = async (nextWorkflowId: string) => {
    const current = state;
    const currentId = current?.workflow?.id ?? "";
    if (nextWorkflowId === currentId) return;

    const target = workflows.find((item) => item.id === nextWorkflowId) ?? null;
    const previousAccounts = current?.workflow?.accounts ?? [];
    setBusy(true);
    setError(null);
    setStatus(null);
    // Optimistic badge: the account now follows the picked workflow.
    setState({
      workflow: target,
      aiMode: target
        ? "workflow"
        : current?.aiMode === "disabled"
          ? "disabled"
          : "legacy",
    });
    try {
      if (target) {
        const ids = target.accounts.map((account) => account.id);
        if (!ids.includes(accountId)) ids.push(accountId);
        await setWorkflowAccounts(target.id, ids);
      } else if (current?.workflow) {
        await setWorkflowAccounts(
          current.workflow.id,
          previousAccounts
            .map((account) => account.id)
            .filter((id) => id !== accountId),
        );
      }
      const [nextState, list] = await Promise.all([
        getAccountWorkflow(accountId),
        listWorkflows(),
      ]);
      setState(nextState);
      setWorkflows(list);
      setStatus(
        nextWorkflowId
          ? "Workflow назначен аккаунту"
          : "Аккаунт отвязан от workflow",
      );
      onNotice?.(
        nextWorkflowId
          ? "Workflow назначен аккаунту"
          : "Аккаунт отвязан от workflow",
      );
    } catch (saveError) {
      setState(current);
      setError(workflowErrorMessage(saveError));
    } finally {
      setBusy(false);
    }
  };

  const mode = state?.aiMode ?? "legacy";
  const modeView = AI_MODE_LABELS[mode];

  return (
    <Card
      title="Workflow аккаунта"
      description="Один workflow можно повесить на несколько аккаунтов. Без workflow аккаунт работает в legacy-режиме (или без ИИ, если включён strict)."
      actions={<AiModeBadge mode={mode} />}
    >
      <ErrorBanner message={error} />
      <OkBanner message={status} />

      {loading ? (
        <div className="space-y-2" aria-hidden="true">
          <div className="h-8 w-full animate-pulse rounded-md bg-zinc-800/60" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-zinc-800/60" />
        </div>
      ) : (
        <>
          <Field label="Workflow">
            <select
              value={state?.workflow?.id ?? ""}
              disabled={busy}
              onChange={(event) => void change(event.target.value)}
              autoComplete="off"
              name={`ct-account-workflow-${accountId}`}
              className={inputClass}
            >
              <option value="">Без workflow</option>
              {workflows.map((workflow) => (
                <option key={workflow.id} value={workflow.id}>
                  {workflow.name}
                  {workflow.isDraft ? " · эксперимент" : ""}
                  {workflow.enabled ? "" : " · выключен"}
                </option>
              ))}
            </select>
          </Field>

          <p className="mt-2 text-[11px] text-zinc-500">{modeView.hint}</p>

          {workflows.length === 0 && (
            <p className="mt-1 text-[11px] text-amber-300/80">
              Локальных workflow ещё нет — добавьте их на странице «Workflow».
            </p>
          )}

          {state?.workflow?.n8nWorkflowId && (
            <p className="mt-1 truncate text-[11px] text-zinc-600">
              n8n ID {state.workflow.n8nWorkflowId}
            </p>
          )}

          <div className="mt-2">
            <GhostButton onClick={() => void load()} disabled={busy || loading}>
              {busy ? "Сохранение…" : "Обновить"}
            </GhostButton>
          </div>
        </>
      )}
    </Card>
  );
}
