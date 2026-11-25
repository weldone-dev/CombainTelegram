import { Injectable } from '@nestjs/common';
import type { WorkflowModel } from '@repo/database';
import { apiError, notFound } from '../common/api-error.js';
import { parseBoolean, requireString } from '../common/validation.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { N8nClientService } from './n8n-client.service.js';
import type {
  AccountAiMode,
  AccountWorkflowView,
  WorkflowAccountView,
  WorkflowAccountsInput,
  WorkflowCreateInput,
  WorkflowUpdateInput,
  WorkflowView,
} from './workflows.types.js';

const ACCOUNT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
} as const;

interface AccountRow {
  id: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
}

interface WorkflowWithAccounts extends WorkflowModel {
  accounts?: AccountRow[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Optional human text: `undefined` keeps, `null`/empty clears. */
function optionalText(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw apiError('VALIDATION_ERROR', `${field} must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length > 200) {
    throw apiError(
      'VALIDATION_ERROR',
      `${field} must be at most 200 characters`,
    );
  }
  return trimmed || null;
}

/** `AI_WORKFLOW_STRICT` and friends: `1`/`true` mean on. */
function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value?.toLowerCase() === 'true';
}

/** One workflow pointer per account, one shared workflow for many accounts. */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly n8n: N8nClientService,
  ) {}

  /** Every workflow of the user with the accounts assigned to it. */
  async list(userId: string): Promise<WorkflowView[]> {
    const rows = (await this.prisma.workflow.findMany({
      where: { userId },
      include: { accounts: { select: ACCOUNT_SELECT } },
      orderBy: { createdAt: 'asc' },
    })) as WorkflowWithAccounts[];
    return rows.map((row) => this.view(row));
  }

  /**
   * Creates the local pointer. The n8n workflow must exist when n8n answers:
   * otherwise a typo would silently point at nothing. An unreachable n8n does
   * not block creation — the dashboard must work while the container is down.
   */
  async create(
    userId: string,
    input: WorkflowCreateInput,
  ): Promise<WorkflowView> {
    const name = requireString(input.name, 'name', { max: 120 });
    const n8nWorkflowId = requireString(input.n8nWorkflowId, 'n8nWorkflowId', {
      max: 100,
    });
    const n8nWorkflowName = optionalText(input.n8nWorkflowName, 'n8nWorkflowName');
    const isDraft =
      input.isDraft === undefined ? false : parseBoolean(input.isDraft, false);
    const enabled =
      input.enabled === undefined ? true : parseBoolean(input.enabled, true);

    await this.assertN8nWorkflow(n8nWorkflowId);

    const row = (await this.prisma.workflow.create({
      data: {
        userId,
        name,
        n8nWorkflowId,
        n8nWorkflowName,
        isDraft,
        enabled,
      },
      include: { accounts: { select: ACCOUNT_SELECT } },
    })) as WorkflowWithAccounts;
    return this.view(row);
  }

  /** Rename / enable / draft / re-point the n8n workflow. */
  async update(
    userId: string,
    id: string,
    input: WorkflowUpdateInput,
  ): Promise<WorkflowView> {
    const existing = await this.requireWorkflow(userId, id);
    const data: {
      name?: string;
      n8nWorkflowId?: string | null;
      n8nWorkflowName?: string | null;
      isDraft?: boolean;
      enabled?: boolean;
    } = {};

    if (input.name !== undefined) {
      data.name = requireString(input.name, 'name', { max: 120 });
    }
    if (input.n8nWorkflowId !== undefined) {
      const next = optionalText(input.n8nWorkflowId, 'n8nWorkflowId');
      if (next && next !== existing.n8nWorkflowId) {
        await this.assertN8nWorkflow(next);
      }
      data.n8nWorkflowId = next;
    }
    if (input.n8nWorkflowName !== undefined) {
      data.n8nWorkflowName = optionalText(input.n8nWorkflowName, 'n8nWorkflowName');
    }
    if (input.isDraft !== undefined) {
      data.isDraft = parseBoolean(input.isDraft, existing.isDraft);
    }
    if (input.enabled !== undefined) {
      data.enabled = parseBoolean(input.enabled, existing.enabled);
    }

    if (Object.keys(data).length > 0) {
      await this.prisma.workflow.update({ where: { id: existing.id }, data });
    }
    return this.loadView(userId, existing.id);
  }

  /**
   * Deletes the pointer. Accounts are unassigned in the same transaction, so
   * the AI turns off for them instead of keeping a dangling workflow id.
   */
  async remove(userId: string, id: string): Promise<{ removed: boolean }> {
    const existing = await this.requireWorkflow(userId, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.telegramAccount.updateMany({
        where: { userId, workflowId: existing.id },
        data: { workflowId: null },
      });
      await tx.workflow.delete({ where: { id: existing.id } });
    });
    return { removed: true };
  }

  /**
   * Assigns the workflow to exactly these accounts: everyone else currently
   * pointing here is unassigned first, then the listed accounts are moved over
   * from any other workflow. Every id must belong to the user.
   */
  async assignAccounts(
    userId: string,
    id: string,
    input: WorkflowAccountsInput,
  ): Promise<WorkflowView> {
    const existing = await this.requireWorkflow(userId, id);
    const accountIds = this.parseAccountIds(input.accountIds);

    if (accountIds.length > 0) {
      const owned = (await this.prisma.telegramAccount.findMany({
        where: { userId, id: { in: accountIds } },
        select: { id: true },
      })) as Pick<AccountRow, 'id'>[];
      const found = new Set(owned.map((row) => row.id));
      const missing = accountIds.find((accountId) => !found.has(accountId));
      if (missing) {
        throw notFound(
          'ACCOUNT_NOT_FOUND',
          `Telegram account ${missing} not found`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.telegramAccount.updateMany({
        where: {
          userId,
          workflowId: existing.id,
          ...(accountIds.length > 0 ? { id: { notIn: accountIds } } : {}),
        },
        data: { workflowId: null },
      });
      if (accountIds.length > 0) {
        await tx.telegramAccount.updateMany({
          where: { userId, id: { in: accountIds } },
          data: { workflowId: existing.id },
        });
      }
    });

    return this.loadView(userId, existing.id);
  }

  /**
   * The account's engine. An assignment always wins; without one
   * `AI_WORKFLOW_STRICT` decides between "AI off" and the legacy autopilot.
   */
  async accountWorkflow(
    userId: string,
    accountId: string,
  ): Promise<AccountWorkflowView> {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      select: { id: true, workflowId: true },
    });
    if (!account) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
    const fallbackMode: AccountAiMode = envFlag('AI_WORKFLOW_STRICT')
      ? 'disabled'
      : 'legacy';
    if (!account.workflowId) {
      return { workflow: null, aiMode: fallbackMode };
    }
    const row = (await this.prisma.workflow.findFirst({
      where: { id: account.workflowId, userId },
      include: { accounts: { select: ACCOUNT_SELECT } },
    })) as WorkflowWithAccounts | null;
    if (!row) {
      // A dangling pointer (hand-edited DB) behaves like "no workflow".
      return { workflow: null, aiMode: fallbackMode };
    }
    return { workflow: this.view(row), aiMode: 'workflow' };
  }

  /** Validates the n8n pointer when n8n is reachable; offline passes. */
  private async assertN8nWorkflow(n8nWorkflowId: string): Promise<void> {
    const remote = await this.n8n.listWorkflows();
    if (!remote.ok) return;
    if (!remote.workflows.some((workflow) => workflow.id === n8nWorkflowId)) {
      throw notFound(
        'N8N_WORKFLOW_NOT_FOUND',
        `n8n has no workflow with id ${n8nWorkflowId}`,
      );
    }
  }

  private parseAccountIds(value: unknown): string[] {
    if (value === undefined || value === null) {
      throw apiError('VALIDATION_ERROR', 'accountIds is required');
    }
    if (!Array.isArray(value)) {
      throw apiError('VALIDATION_ERROR', 'accountIds must be an array of ids');
    }
    const ids: string[] = [];
    for (const item of value) {
      if (typeof item !== 'string' && typeof item !== 'number') {
        throw apiError('VALIDATION_ERROR', 'accountIds must be an array of ids');
      }
      const id = String(item).trim();
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  }

  private async loadView(userId: string, id: string): Promise<WorkflowView> {
    const row = (await this.prisma.workflow.findFirst({
      where: { id, userId },
      include: { accounts: { select: ACCOUNT_SELECT } },
    })) as WorkflowWithAccounts | null;
    if (!row) {
      throw notFound('WORKFLOW_NOT_FOUND', `Workflow ${id} does not exist`);
    }
    return this.view(row);
  }

  private async requireWorkflow(
    userId: string,
    id: string,
  ): Promise<WorkflowModel> {
    const row = (await this.prisma.workflow.findFirst({
      where: { id, userId },
    })) as WorkflowModel | null;
    if (!row) {
      throw notFound('WORKFLOW_NOT_FOUND', `Workflow ${id} does not exist`);
    }
    return row;
  }

  private view(row: WorkflowWithAccounts): WorkflowView {
    const accounts = (row.accounts ?? [])
      .map((account) => this.accountView(account))
      .sort((left, right) => left.title.localeCompare(right.title));
    return {
      id: row.id,
      name: row.name,
      n8nWorkflowId: row.n8nWorkflowId ?? null,
      n8nWorkflowName: row.n8nWorkflowName ?? null,
      enabled: row.enabled,
      isDraft: row.isDraft,
      accounts,
    };
  }

  private accountView(account: AccountRow): WorkflowAccountView {
    const title =
      [account.firstName, account.lastName].map(text).filter(Boolean).join(' ') ||
      (account.username ? `@${account.username}` : account.id);
    return {
      id: account.id,
      title,
      username: account.username ?? null,
    };
  }
}
