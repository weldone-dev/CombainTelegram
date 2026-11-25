import { HttpException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowModel } from '@repo/database';
import type { N8nWorkflowsResult } from './workflows.types.js';
import { WorkflowsService } from './workflows.service.js';
import type { N8nClientService } from './n8n-client.service.js';

const NOW = new Date('2026-11-25T12:00:00.000Z');

interface WorkflowRow extends WorkflowModel {
  accounts?: AccountRow[];
}

interface AccountRow {
  id: string;
  userId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  workflowId: string | null;
}

type Where = Record<string, unknown>;

function workflowRow(overrides: Partial<WorkflowModel> = {}): WorkflowModel {
  return {
    id: 'w1',
    userId: 'u1',
    name: 'Support',
    description: '',
    n8nWorkflowId: 'n8n-1',
    n8nWorkflowName: 'Support bot',
    enabled: true,
    isDraft: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return {
    id: 'a1',
    userId: 'u1',
    firstName: 'Ann',
    lastName: 'Lee',
    username: 'ann',
    workflowId: null,
    ...overrides,
  };
}

/** Supports the scalar and `in`/`notIn` filters the service uses. */
function matchesId(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition && typeof condition === 'object') {
    const { in: within, notIn } = condition as {
      in?: string[];
      notIn?: string[];
    };
    if (within && !within.includes(String(value))) return false;
    if (notIn && notIn.includes(String(value))) return false;
    return true;
  }
  return value === condition;
}

function matchesRow(row: Record<string, unknown>, where?: Where): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (key === 'id') return matchesId(row.id, value);
    return row[key] === value;
  });
}

function pick<T extends Record<string, unknown>>(
  row: T,
  select?: Record<string, boolean>,
): Record<string, unknown> {
  if (!select) return { ...row };
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(select)) {
    if (select[key]) result[key] = row[key];
  }
  return result;
}

function harness(
  options: {
    workflows?: Partial<WorkflowModel>[];
    accounts?: Partial<AccountRow>[];
    n8n?: Partial<N8nWorkflowsResult>;
  } = {},
) {
  let workflows: WorkflowRow[] = (options.workflows ?? [workflowRow()]).map(
    (input) => ({ ...workflowRow(input) }),
  );
  const accounts: AccountRow[] = (options.accounts ?? []).map((input) =>
    accountRow(input),
  );

  function attach(
    row: WorkflowRow,
    include?: { accounts?: { select?: Record<string, boolean> } },
  ): WorkflowRow {
    if (!include?.accounts) return { ...row };
    return {
      ...row,
      accounts: accounts
        .filter((account) => account.workflowId === row.id)
        .map((account) => pick(account, include.accounts?.select) as AccountRow),
    } as WorkflowRow;
  }

  const prisma: Record<string, any> = {
    workflow: {
      findMany: vi.fn(
        async ({
          where,
          include,
        }: {
          where?: Where;
          include?: { accounts?: { select?: Record<string, boolean> } };
        } = {}) =>
          workflows
            .filter((row) => matchesRow(row, where))
            .map((row) => attach(row, include)),
      ),
      findFirst: vi.fn(
        async ({
          where,
          include,
        }: {
          where?: Where;
          include?: { accounts?: { select?: Record<string, boolean> } };
        } = {}) => {
          const row = workflows.find((item) => matchesRow(item, where));
          return row ? attach(row, include) : null;
        },
      ),
      create: vi.fn(
        async ({
          data,
          include,
        }: {
          data: Partial<WorkflowModel>;
          include?: { accounts?: { select?: Record<string, boolean> } };
        }) => {
          const row: WorkflowRow = {
            ...workflowRow(),
            id: `w${workflows.length + 1}`,
            ...data,
          };
          workflows.push(row);
          return attach(row, include);
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<WorkflowModel>;
        }) => {
          const row = workflows.find((item) => item.id === where.id);
          if (!row) throw new Error('workflow not found');
          Object.assign(row, data, { updatedAt: NOW });
          return { ...row };
        },
      ),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = workflows.findIndex((item) => item.id === where.id);
        if (index < 0) throw new Error('workflow not found');
        const [row] = workflows.splice(index, 1);
        return { ...row };
      }),
    },
    telegramAccount: {
      findFirst: vi.fn(
        async ({
          where,
          select,
        }: {
          where?: Where;
          select?: Record<string, boolean>;
        } = {}) => {
          const row = accounts.find((item) => matchesRow(item, where));
          return row ? pick(row as unknown as Record<string, unknown>, select) : null;
        },
      ),
      findMany: vi.fn(
        async ({
          where,
          select,
        }: {
          where?: Where;
          select?: Record<string, boolean>;
        } = {}) =>
          accounts
            .filter((row) => matchesRow(row, where))
            .map((row) => pick(row as unknown as Record<string, unknown>, select)),
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where?: Where;
          data: Partial<AccountRow>;
        } = {}) => {
          const rows = accounts.filter((row) => matchesRow(row, where));
          for (const row of rows) Object.assign(row, data);
          return { count: rows.length };
        },
      ),
    },
    $transaction: vi.fn(
      async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    ),
  };

  const n8n = {
    listWorkflows: vi.fn(
      async (): Promise<N8nWorkflowsResult> => ({
        ok: true,
        workflows: [
          { id: 'n8n-1', name: 'Support bot', active: true, updatedAt: null },
          { id: 'n8n-2', name: 'Sales bot', active: false, updatedAt: null },
        ],
        ...options.n8n,
      }),
    ),
  };

  const service = new WorkflowsService(prisma as never, n8n as N8nClientService);

  return {
    service,
    prisma,
    n8n,
    workflows: () => workflows,
    accounts,
  };
}

async function apiErrorOf(
  promise: Promise<unknown>,
): Promise<{ status: number; code: string }> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(HttpException);
  const exception = error as HttpException;
  const body = exception.getResponse() as { code?: string };
  return { status: exception.getStatus(), code: body.code ?? '' };
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('WorkflowsService registry', () => {
  it('lists workflows with their assigned accounts', async () => {
    const h = harness({
      workflows: [workflowRow()],
      accounts: [
        accountRow({ id: 'a1', firstName: 'Ann', lastName: 'Lee' }),
        accountRow({ id: 'a2', firstName: 'Bob', lastName: null, username: null }),
        accountRow({ id: 'a3', firstName: 'Cid', lastName: null, workflowId: 'w1' }),
      ].map((account, index) =>
        index < 2 ? { ...account, workflowId: 'w1' } : account,
      ),
    });

    const rows = await h.service.list('u1');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'w1',
      name: 'Support',
      n8nWorkflowId: 'n8n-1',
      n8nWorkflowName: 'Support bot',
      enabled: true,
      isDraft: false,
    });
    expect(rows[0].accounts).toEqual([
      { id: 'a1', title: 'Ann Lee', username: 'ann' },
      { id: 'a2', title: 'Bob', username: null },
      { id: 'a3', title: 'Cid', username: 'ann' },
    ]);
  });

  it('creates a pointer after checking the n8n workflow exists', async () => {
    const h = harness({ workflows: [] });

    const view = await h.service.create('u1', {
      name: '  Support ',
      n8nWorkflowId: 'n8n-2',
      n8nWorkflowName: ' Sales ',
      isDraft: true,
    });

    expect(view).toMatchObject({
      name: 'Support',
      n8nWorkflowId: 'n8n-2',
      n8nWorkflowName: 'Sales',
      enabled: true,
      isDraft: true,
      accounts: [],
    });
    expect(h.workflows()[0]).toMatchObject({
      userId: 'u1',
      n8nWorkflowId: 'n8n-2',
    });
  });

  it('rejects an unknown n8n workflow with N8N_WORKFLOW_NOT_FOUND', async () => {
    const h = harness({ workflows: [] });

    const error = await apiErrorOf(
      h.service.create('u1', { name: 'Ghost', n8nWorkflowId: 'missing' }),
    );

    expect(error).toEqual({ status: 404, code: 'N8N_WORKFLOW_NOT_FOUND' });
    expect(h.prisma.workflow.create).not.toHaveBeenCalled();
  });

  it('creates the pointer when n8n is unreachable', async () => {
    const h = harness({
      workflows: [],
      n8n: { ok: false, workflows: [], error: 'ECONNREFUSED' },
    });

    const view = await h.service.create('u1', {
      name: 'Offline',
      n8nWorkflowId: 'any-id',
    });

    expect(view.n8nWorkflowId).toBe('any-id');
  });

  it('renames, drafts and re-points a workflow', async () => {
    const h = harness();

    const view = await h.service.update('u1', 'w1', {
      name: 'Renamed',
      n8nWorkflowId: 'n8n-2',
      n8nWorkflowName: 'Sales',
      isDraft: true,
      enabled: false,
    });

    expect(view).toMatchObject({
      name: 'Renamed',
      n8nWorkflowId: 'n8n-2',
      n8nWorkflowName: 'Sales',
      isDraft: true,
      enabled: false,
    });
  });

  it('rejects updates to another user workflow', async () => {
    const h = harness({ workflows: [workflowRow({ userId: 'u2' })] });

    const error = await apiErrorOf(
      h.service.update('u1', 'w1', { name: 'Mine now' }),
    );

    expect(error).toEqual({ status: 404, code: 'WORKFLOW_NOT_FOUND' });
  });

  it('clears workflowId on the accounts when the workflow is deleted', async () => {
    const h = harness({
      workflows: [workflowRow()],
      accounts: [
        accountRow({ id: 'a1', workflowId: 'w1' }),
        accountRow({ id: 'a2', workflowId: 'w1' }),
        accountRow({ id: 'a3', workflowId: 'w2' }),
      ],
    });

    const result = await h.service.remove('u1', 'w1');

    expect(result).toEqual({ removed: true });
    expect(h.workflows()).toHaveLength(0);
    expect(h.accounts.map((account) => account.workflowId)).toEqual([
      null,
      null,
      'w2',
    ]);
  });
});

describe('WorkflowsService account assignment', () => {
  it('assigns two accounts to one workflow', async () => {
    const h = harness({
      workflows: [workflowRow()],
      accounts: [accountRow({ id: 'a1' }), accountRow({ id: 'a2' })],
    });

    const view = await h.service.assignAccounts('u1', 'w1', {
      accountIds: ['a1', 'a2'],
    });

    expect(view.accounts.map((account) => account.id)).toEqual(['a1', 'a2']);
    expect(h.accounts.map((account) => account.workflowId)).toEqual([
      'w1',
      'w1',
    ]);
  });

  it('unassigns accounts that are no longer listed', async () => {
    const h = harness({
      workflows: [workflowRow()],
      accounts: [
        accountRow({ id: 'a1', workflowId: 'w1' }),
        accountRow({ id: 'a2', workflowId: 'w1' }),
      ],
    });

    const view = await h.service.assignAccounts('u1', 'w1', {
      accountIds: ['a1'],
    });

    expect(view.accounts.map((account) => account.id)).toEqual(['a1']);
    expect(h.accounts.map((account) => account.workflowId)).toEqual([
      'w1',
      null,
    ]);
  });

  it('moves an account away from another workflow', async () => {
    const h = harness({
      workflows: [workflowRow(), workflowRow({ id: 'w2', name: 'Sales' })],
      accounts: [
        accountRow({ id: 'a1', workflowId: 'w1' }),
        accountRow({ id: 'a2', workflowId: 'w2' }),
      ],
    });

    await h.service.assignAccounts('u1', 'w1', {
      accountIds: ['a1', 'a2'],
    });

    expect(h.accounts.map((account) => account.workflowId)).toEqual([
      'w1',
      'w1',
    ]);
  });

  it('clears every assignment with an empty list', async () => {
    const h = harness({
      workflows: [workflowRow()],
      accounts: [accountRow({ id: 'a1', workflowId: 'w1' })],
    });

    const view = await h.service.assignAccounts('u1', 'w1', {
      accountIds: [],
    });

    expect(view.accounts).toEqual([]);
    expect(h.accounts[0].workflowId).toBeNull();
  });

  it('rejects an account owned by another user', async () => {
    const h = harness({
      workflows: [workflowRow()],
      accounts: [accountRow({ id: 'a9', userId: 'u2', workflowId: 'w2' })],
    });

    const error = await apiErrorOf(
      h.service.assignAccounts('u1', 'w1', { accountIds: ['a9'] }),
    );

    expect(error).toEqual({ status: 404, code: 'ACCOUNT_NOT_FOUND' });
    expect(h.accounts[0].workflowId).toBe('w2');
  });

  it('rejects assignment to another user workflow', async () => {
    const h = harness({
      workflows: [workflowRow({ userId: 'u2' })],
      accounts: [accountRow({ id: 'a1' })],
    });

    const error = await apiErrorOf(
      h.service.assignAccounts('u1', 'w1', { accountIds: ['a1'] }),
    );

    expect(error).toEqual({ status: 404, code: 'WORKFLOW_NOT_FOUND' });
  });

  it('validates the accountIds payload', async () => {
    const h = harness();

    const error = await apiErrorOf(
      h.service.assignAccounts('u1', 'w1', { accountIds: 'a1' }),
    );

    expect(error).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
  });
});

describe('WorkflowsService account AI mode', () => {
  it('reports the workflow when the account is assigned', async () => {
    vi.stubEnv('AI_WORKFLOW_STRICT', '0');
    const h = harness({
      workflows: [workflowRow()],
      accounts: [accountRow({ id: 'a1', workflowId: 'w1' })],
    });

    const view = await h.service.accountWorkflow('u1', 'a1');

    expect(view.aiMode).toBe('workflow');
    expect(view.workflow?.id).toBe('w1');
    expect(view.workflow?.accounts.map((account) => account.id)).toEqual([
      'a1',
    ]);
  });

  it('falls back to legacy when nothing is assigned and strict is off', async () => {
    vi.stubEnv('AI_WORKFLOW_STRICT', 'false');
    const h = harness({ accounts: [accountRow({ id: 'a1' })] });

    const view = await h.service.accountWorkflow('u1', 'a1');

    expect(view).toEqual({ workflow: null, aiMode: 'legacy' });
  });

  it('turns AI off when nothing is assigned and strict is on', async () => {
    vi.stubEnv('AI_WORKFLOW_STRICT', '1');
    const h = harness({ accounts: [accountRow({ id: 'a1' })] });

    const view = await h.service.accountWorkflow('u1', 'a1');

    expect(view).toEqual({ workflow: null, aiMode: 'disabled' });
  });

  it('treats a dangling assignment as no workflow', async () => {
    vi.stubEnv('AI_WORKFLOW_STRICT', 'true');
    const h = harness({
      workflows: [],
      accounts: [accountRow({ id: 'a1', workflowId: 'deleted' })],
    });

    const view = await h.service.accountWorkflow('u1', 'a1');

    expect(view).toEqual({ workflow: null, aiMode: 'disabled' });
  });

  it('rejects the workflow of another user account', async () => {
    const h = harness({ accounts: [accountRow({ id: 'a1', userId: 'u2' })] });

    const error = await apiErrorOf(h.service.accountWorkflow('u1', 'a1'));

    expect(error).toEqual({ status: 404, code: 'ACCOUNT_NOT_FOUND' });
  });
});
