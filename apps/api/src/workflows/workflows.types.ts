/** Public shapes of the workflow registry. Raw Prisma rows never leave the API. */

/** Account entry shown next to a workflow. */
export interface WorkflowAccountView {
  id: string;
  /** Display name: first + last name, falling back to `@username`/id. */
  title: string;
  username: string | null;
}

/** One local workflow pointer plus the accounts it is assigned to. */
export interface WorkflowView {
  id: string;
  name: string;
  n8nWorkflowId: string | null;
  n8nWorkflowName: string | null;
  enabled: boolean;
  isDraft: boolean;
  accounts: WorkflowAccountView[];
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

export interface N8nTestResult {
  ok: boolean;
  status: number | null;
  latencyMs: number;
  error?: string;
}

/** One n8n execution, reduced to what the dashboard shows. */
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

/** Resolved n8n address and key; never leaves the server. */
export interface N8nConnection {
  baseUrl: string;
  apiKey: string | null;
}

/** Which engine answers the account's DMs. */
export type AccountAiMode = 'workflow' | 'legacy' | 'disabled';

export interface AccountWorkflowView {
  workflow: WorkflowView | null;
  aiMode: AccountAiMode;
}

export interface WorkflowCreateInput {
  name?: unknown;
  n8nWorkflowId?: unknown;
  n8nWorkflowName?: unknown;
  isDraft?: unknown;
  enabled?: unknown;
}

export interface WorkflowUpdateInput {
  name?: unknown;
  n8nWorkflowId?: unknown;
  n8nWorkflowName?: unknown;
  isDraft?: unknown;
  enabled?: unknown;
}

export interface WorkflowAccountsInput {
  accountIds?: unknown;
}
