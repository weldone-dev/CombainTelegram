"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, errorMessage } from "../../lib/api";
import type { AccountView } from "../../lib/types";
import {
  createWorkflow,
  getN8nSettings,
  listN8nWorkflows,
  listWorkflows,
  type N8nConnectionSettings,
  type N8nWorkflowsResult,
  type WorkflowView,
  workflowErrorMessage,
} from "../../lib/workflows-api";
import { ErrorBanner, GhostButton } from "../dashboard/ai-ui";
import { useAppData } from "../dashboard/app-data";
import { N8nConnectionCard } from "./n8n-connection-card";
import { N8nWorkflowList } from "./n8n-workflow-list";
import { WorkflowCard } from "./workflow-card";

/**
 * Workflow workspace: n8n connection, the workflows available in n8n and the
 * local registry whose entries are assigned to Telegram accounts. Rendering is
 * resilient — n8n being down only greys out its section, the local list and
 * the manual "add by id" form keep working.
 */
export function WorkflowsPage() {
  const { showNotice } = useAppData();
  const [settings, setSettings] = useState<N8nConnectionSettings | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowView[] | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [n8n, setN8n] = useState<N8nWorkflowsResult | null>(null);
  const [n8nLoading, setN8nLoading] = useState(true);
  const [n8nError, setN8nError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [settingsResult, workflowsResult, accountsResult] =
      await Promise.allSettled([
        getN8nSettings(),
        listWorkflows(),
        apiFetch<AccountView[]>("/accounts", {}),
      ]);

    const failures: string[] = [];
    if (settingsResult.status === "fulfilled") {
      setSettings(settingsResult.value);
    } else {
      failures.push(
        `Настройки n8n: ${workflowErrorMessage(settingsResult.reason)}`,
      );
    }
    if (workflowsResult.status === "fulfilled") {
      setWorkflows(workflowsResult.value);
    } else {
      setWorkflows(null);
      failures.push(
        `Workflow: ${workflowErrorMessage(workflowsResult.reason)}`,
      );
    }
    if (accountsResult.status === "fulfilled") {
      setAccounts(accountsResult.value);
    } else {
      failures.push(`Аккаунты: ${errorMessage(accountsResult.reason)}`);
    }
    setError(failures.length > 0 ? failures.join(" · ") : null);
    setLoading(false);
  }, []);

  const loadN8n = useCallback(async () => {
    setN8nLoading(true);
    setN8nError(null);
    try {
      setN8n(await listN8nWorkflows());
    } catch (loadError) {
      setN8n(null);
      setN8nError(workflowErrorMessage(loadError));
    } finally {
      setN8nLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadN8n();
  }, [loadN8n]);

  const useRemote = async (pick: { id: string; name: string }) => {
    const created = await createWorkflow({
      name: pick.name,
      n8nWorkflowId: pick.id,
      n8nWorkflowName: pick.name,
    });
    setWorkflows((current) => [...(current ?? []), created]);
    showNotice(`Workflow «${created.name}» добавлен в список`);
  };

  const replaceWorkflow = (next: WorkflowView) => {
    setWorkflows((current) =>
      (current ?? []).map((item) => (item.id === next.id ? next : item)),
    );
  };

  const removeWorkflow = (id: string) => {
    setWorkflows((current) => (current ?? []).filter((item) => item.id !== id));
  };

  const existingIds = new Set(
    (workflows ?? [])
      .map((workflow) => workflow.n8nWorkflowId)
      .filter((id): id is string => Boolean(id)),
  );

  return (
    <div className="mx-auto grid w-full max-w-5xl gap-4 p-4">
      <div>
        <h2 className="text-sm font-semibold text-zinc-100">Workflow</h2>
        <p className="mt-1 text-xs text-zinc-500">
          Один workflow можно повесить на несколько аккаунтов; аккаунт без
          workflow работает в legacy-режиме (или без ИИ, если включён strict).
        </p>
      </div>

      <ErrorBanner message={error} />
      {(error || loading) && (
        <div className="-mt-2">
          <GhostButton onClick={() => void load()} disabled={loading}>
            {loading ? "Загрузка…" : "Повторить"}
          </GhostButton>
        </div>
      )}

      {settings ? (
        <N8nConnectionCard
          settings={settings}
          onSaved={(next) => {
            setSettings(next);
            void loadN8n();
          }}
          onTested={(result) => {
            if (result.ok) void loadN8n();
          }}
        />
      ) : (
        !loading && (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-xs text-zinc-500">
            Настройки подключения n8n недоступны — проверьте, что API запущен.
            Ручное добавление workflow по ID ниже всё равно работает.
          </div>
        )
      )}

      <N8nWorkflowList
        result={n8n}
        loading={n8nLoading}
        error={n8nError}
        baseUrl={settings?.n8nBaseUrl ?? ""}
        existingIds={existingIds}
        onUse={useRemote}
        onRefresh={() => void loadN8n()}
      />

      <section className="grid gap-3">
        <div>
          <h2 className="text-sm font-semibold text-zinc-100">Мои workflow</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Локальные записи, которые указывают на workflow в n8n. Правки самого
            workflow делаются в n8n.
          </p>
        </div>

        {loading && !workflows ? (
          <div className="space-y-2" aria-hidden="true">
            {[0, 1].map((row) => (
              <div
                key={row}
                className="h-24 animate-pulse rounded-xl bg-zinc-900/60"
              />
            ))}
          </div>
        ) : !workflows || workflows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-700 bg-zinc-900/40 p-4 text-sm text-zinc-400">
            Пока ни один workflow не добавлен. Возьмите workflow из списка выше
            или добавьте его по ID.
          </div>
        ) : (
          workflows.map((workflow) => (
            <WorkflowCard
              key={workflow.id}
              workflow={workflow}
              accounts={accounts}
              baseUrl={settings?.n8nBaseUrl ?? ""}
              onUpdated={replaceWorkflow}
              onRemoved={removeWorkflow}
              onNotice={showNotice}
            />
          ))
        )}
      </section>
    </div>
  );
}
