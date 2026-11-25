import { ApiError, apiFetch, errorCodeText, errorMessage } from "./api";

/** Default address of the bundled n8n instance (`infra/n8n`). */
export const DEFAULT_N8N_BASE_URL = "http://127.0.0.1:5678";

/** Which engine answers an account's DMs. */
export type AccountAiMode = "workflow" | "legacy" | "disabled";

/** n8n connection fields of `GET /ai/settings`. */
export interface N8nConnectionSettings {
  n8nBaseUrl: string;
  hasN8nKey: boolean;
}

export interface N8nTestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error?: string;
}

/** One workflow as n8n itself reports it. */
export interface N8nWorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  updatedAt: string | null;
}

export interface N8nWorkflowsResult {
  ok: boolean;
  workflows: N8nWorkflowSummary[];
  error?: string;
}

export interface N8nExecutionSummary {
  id: string;
  status: string;
  startedAt: string | null;
  stoppedAt: string | null;
  mode: string | null;
}

export interface N8nExecutionsResult {
  ok: boolean;
  executions: N8nExecutionSummary[];
  error?: string;
}

/** Account shown next to a local workflow. */
export interface WorkflowAccountView {
  id: string;
  title: string;
  username: string | null;
}

/** Local pointer into n8n plus the accounts it is assigned to. */
export interface WorkflowView {
  id: string;
  name: string;
  n8nWorkflowId: string | null;
  n8nWorkflowName: string | null;
  enabled: boolean;
  isDraft: boolean;
  accounts: WorkflowAccountView[];
}

export interface AccountWorkflowView {
  workflow: WorkflowView | null;
  aiMode: AccountAiMode;
}

export interface WorkflowCreateInput {
  name: string;
  n8nWorkflowId: string;
  n8nWorkflowName?: string | null;
  isDraft?: boolean;
  enabled?: boolean;
}

export interface WorkflowUpdateInput {
  name?: string;
  n8nWorkflowId?: string | null;
  n8nWorkflowName?: string | null;
  isDraft?: boolean;
  enabled?: boolean;
}

const WORKFLOW_ERRORS: Record<string, string> = {
  INVALID_N8N_URL:
    "Некорректный адрес n8n: нужен абсолютный http(s) URL или пустое поле",
  WORKFLOW_NOT_FOUND: "Workflow не найден — обновите список",
  N8N_WORKFLOW_NOT_FOUND:
    "В n8n нет workflow с таким ID. Проверьте ID в самом n8n",
  ACCOUNT_NOT_FOUND: "Аккаунт не найден — обновите страницу",
  VALIDATION_ERROR: "Проверьте поля формы",
};

/** Russian message for workflow / n8n calls. */
export function workflowErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const localised = WORKFLOW_ERRORS[error.code];
    if (localised) return localised;
    const mapped = errorCodeText(error.code);
    const text =
      mapped === error.code && error.body.message ? error.body.message : mapped;
    return text;
  }
  return errorMessage(error);
}

/** n8n connection fields only; the rest of the AI settings is ignored. */
export function getN8nSettings(): Promise<N8nConnectionSettings> {
  return apiFetch("/ai/settings");
}

/** `null` clears the stored key, an omitted key keeps it. */
export function patchN8nSettings(body: {
  n8nBaseUrl?: string;
  n8nApiKey?: string | null;
}): Promise<N8nConnectionSettings> {
  return apiFetch("/ai/settings", { method: "PATCH", body });
}

export function testN8n(): Promise<N8nTestResult> {
  return apiFetch("/workflows/n8n/test", { method: "POST", body: {} });
}

/** Workflows available in n8n; never throws on the API side. */
export function listN8nWorkflows(): Promise<N8nWorkflowsResult> {
  return apiFetch("/workflows/n8n");
}

export function listN8nExecutions(
  n8nWorkflowId: string,
  limit = 10,
): Promise<N8nExecutionsResult> {
  return apiFetch(
    `/workflows/n8n/${encodeURIComponent(n8nWorkflowId)}/executions?limit=${limit}`,
  );
}

export function listWorkflows(): Promise<WorkflowView[]> {
  return apiFetch("/workflows");
}

export function createWorkflow(
  body: WorkflowCreateInput,
): Promise<WorkflowView> {
  return apiFetch("/workflows", { method: "POST", body });
}

export function updateWorkflow(
  id: string,
  body: WorkflowUpdateInput,
): Promise<WorkflowView> {
  return apiFetch(`/workflows/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function deleteWorkflow(id: string): Promise<{ removed: boolean }> {
  return apiFetch(`/workflows/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

/** Replaces the workflow's account set with exactly `accountIds`. */
export function setWorkflowAccounts(
  id: string,
  accountIds: string[],
): Promise<WorkflowView> {
  return apiFetch(`/workflows/${encodeURIComponent(id)}/accounts`, {
    method: "PUT",
    body: { accountIds },
  });
}

export function getAccountWorkflow(
  accountId: string,
): Promise<AccountWorkflowView> {
  return apiFetch(`/accounts/${encodeURIComponent(accountId)}/workflow`);
}

/** Base URL without the trailing slash; empty input falls back to the default. */
export function n8nBase(baseUrl: string | null | undefined): string {
  const trimmed = (baseUrl ?? "").trim().replace(/\/+$/, "");
  return trimmed || DEFAULT_N8N_BASE_URL;
}

/** Editor link of a workflow inside the n8n UI. */
export function n8nWorkflowUrl(
  baseUrl: string | null | undefined,
  id: string,
): string {
  return `${n8nBase(baseUrl)}/workflow/${encodeURIComponent(id)}`;
}

export type AiModeTone = "green" | "amber" | "red";

export const AI_MODE_LABELS: Record<
  AccountAiMode,
  { label: string; tone: AiModeTone; hint: string }
> = {
  workflow: {
    label: "workflow",
    tone: "green",
    hint: "Ответами занимается назначенный n8n workflow",
  },
  legacy: {
    label: "legacy",
    tone: "amber",
    hint: "Workflow не назначен — работает встроенный агент (legacy)",
  },
  disabled: {
    label: "ИИ выключен",
    tone: "red",
    hint: "Workflow не назначен, а AI_WORKFLOW_STRICT запрещает legacy",
  },
};
