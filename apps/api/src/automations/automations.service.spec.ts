import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationModel, AutomationRunModel } from '@repo/database';
import {
  AutomationsService,
  nextRunFor,
  triggerTypeFor,
} from './automations.service.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');

function automationRow(
  overrides: Partial<AutomationModel> = {},
): AutomationModel {
  return {
    id: 'auto-1',
    accountId: null,
    name: 'Digest',
    description: '',
    enabled: true,
    triggerType: 'schedule',
    trigger: JSON.stringify({ kind: 'every', minutes: 10 }),
    actionType: 'agent',
    action: JSON.stringify({ type: 'agent', prompt: 'Report' }),
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function runRow(overrides: Partial<AutomationRunModel> = {}): AutomationRunModel {
  return {
    id: 'run-1',
    automationId: 'auto-1',
    status: 'ok',
    input: JSON.stringify({ source: 'test' }),
    output: 'done',
    error: null,
    startedAt: NOW,
    finishedAt: new Date(NOW.getTime() + 1000),
    ...overrides,
  };
}

function createHarness(rows: AutomationModel[] = []) {
  const automations = rows.slice();
  const runs: AutomationRunModel[] = [runRow()];
  const accounts = [{ id: 'acc-1' }];
  let sequence = 0;

  const matchesWhere = (
    row: AutomationModel,
    where: Record<string, unknown>,
  ): boolean => {
    if (typeof where.accountId === 'string' && row.accountId !== where.accountId) {
      return false;
    }
    if (where.enabled !== undefined && row.enabled !== where.enabled) {
      return false;
    }
    if (
      typeof where.triggerType === 'string' &&
      row.triggerType !== where.triggerType
    ) {
      return false;
    }
    const nextRun = where.nextRunAt as { lte?: Date } | undefined;
    if (nextRun?.lte) {
      if (!row.nextRunAt || row.nextRunAt.getTime() > nextRun.lte.getTime()) {
        return false;
      }
    }
    const or = where.OR as Array<{ accountId?: string | null }> | undefined;
    if (or) {
      const allowed = or.some((clause) =>
        clause.accountId === null
          ? row.accountId === null
          : row.accountId === clause.accountId,
      );
      if (!allowed) return false;
    }
    return true;
  };

  const prisma = {
    automation: {
      findMany: vi.fn(
        async (args: {
          where?: Record<string, unknown>;
          orderBy?: Record<string, 'asc' | 'desc'>;
          take?: number;
        } = {}) => {
          let list = automations.filter((row) =>
            matchesWhere(row, args.where ?? {}),
          );
          const order = args.orderBy ?? {};
          list = list.slice().sort((a, b) => {
            const key = Object.keys(order)[0] as keyof AutomationModel | undefined;
            if (!key) return 0;
            const left = a[key];
            const right = b[key];
            const diff =
              left instanceof Date && right instanceof Date
                ? left.getTime() - right.getTime()
                : String(left).localeCompare(String(right));
            return order[key] === 'desc' ? -diff : diff;
          });
          return args.take ? list.slice(0, args.take) : list;
        },
      ),
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        automations.find((row) => row.id === args.where.id) ?? null,
      ),
      create: vi.fn(
        async (args: { data: Partial<AutomationModel> }) => {
          sequence += 1;
          const row = automationRow({
            ...args.data,
            id: `auto-${sequence}`,
            description: args.data.description ?? '',
            runCount: 0,
            createdAt: new Date(NOW.getTime() + sequence),
            updatedAt: new Date(NOW.getTime() + sequence),
          });
          automations.push(row);
          return row;
        },
      ),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = automations.find(
            (candidate) => candidate.id === args.where.id,
          );
          if (!row) throw new Error('automation not found');
          const { runCount, ...rest } = args.data;
          Object.assign(row, rest, { updatedAt: new Date() });
          if (
            runCount &&
            typeof runCount === 'object' &&
            'increment' in runCount
          ) {
            row.runCount += Number(
              (runCount as { increment: number }).increment,
            );
          }
          return row;
        },
      ),
      deleteMany: vi.fn(async (args: { where: { id: string } }) => {
        const index = automations.findIndex(
          (row) => row.id === args.where.id,
        );
        if (index >= 0) automations.splice(index, 1);
        return { count: index >= 0 ? 1 : 0 };
      }),
    },
    automationRun: {
      findMany: vi.fn(
        async (args: {
          where: { automationId: string };
          orderBy: { startedAt: 'asc' | 'desc' };
          take: number;
        }) =>
          runs
            .filter((run) => run.automationId === args.where.automationId)
            .sort(
              (a, b) =>
                (args.orderBy.startedAt === 'desc' ? -1 : 1) *
                (a.startedAt.getTime() - b.startedAt.getTime()),
            )
            .slice(0, args.take),
      ),
      create: vi.fn(async (args: { data: Partial<AutomationRunModel> }) => {
        const row = runRow({
          ...args.data,
          id: `run-${runs.length + 1}`,
          input: args.data.input ?? '{}',
          startedAt: new Date(),
        });
        runs.push(row);
        return row;
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Partial<AutomationRunModel>;
        }) => {
          const row = runs.find((candidate) => candidate.id === args.where.id);
          if (!row) throw new Error('run not found');
          Object.assign(row, args.data);
          return row;
        },
      ),
    },
    telegramAccount: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        accounts.find((account) => account.id === args.where.id) ?? null,
      ),
    },
  };

  const service = new AutomationsService(prisma as never);
  return { service, prisma, automations, runs };
}

function httpBody(error: unknown): { code: string; message: string } {
  return (
    error as { getResponse(): { code: string; message: string } }
  ).getResponse();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('nextRunFor', () => {
  it('adds the interval for every-minute triggers', () => {
    const from = new Date(2026, 10, 24, 23, 45, 0);

    const next = nextRunFor({ kind: 'every', minutes: 30 }, from);

    expect(next?.getTime()).toBe(from.getTime() + 30 * 60_000);
    expect(next?.getDate()).toBe(25);
    expect(next?.getHours()).toBe(0);
    expect(next?.getMinutes()).toBe(15);
  });

  it('rejects missing, negative and zero intervals', () => {
    const from = new Date(2026, 10, 24, 8, 0, 0);

    expect(nextRunFor({ kind: 'every' }, from)).toBeNull();
    expect(nextRunFor({ kind: 'every', minutes: 0 }, from)).toBeNull();
    expect(nextRunFor({ kind: 'every', minutes: -5 }, from)).toBeNull();
    expect(nextRunFor({ kind: 'every', minutes: 'nope' }, from)).toBeNull();
  });

  it('keeps a daily trigger later the same day', () => {
    const from = new Date(2026, 10, 24, 8, 0, 0);

    const next = nextRunFor({ kind: 'daily', at: '09:30' }, from);

    expect(next?.getFullYear()).toBe(2026);
    expect(next?.getMonth()).toBe(10);
    expect(next?.getDate()).toBe(24);
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(30);
  });

  it('rolls a daily trigger to tomorrow when the time has passed', () => {
    const from = new Date(2026, 10, 24, 10, 0, 0);

    const next = nextRunFor({ kind: 'daily', at: '09:00' }, from);

    expect(next?.getDate()).toBe(25);
    expect(next?.getHours()).toBe(9);
  });

  it('rolls over when the time is exactly now', () => {
    const from = new Date(2026, 10, 24, 9, 0, 0);

    const next = nextRunFor({ kind: 'daily', at: '09:00' }, from);

    expect(next?.getDate()).toBe(25);
    expect(next?.getHours()).toBe(9);
  });

  it('returns null for unsupported or malformed triggers', () => {
    expect(nextRunFor({ kind: 'manual' })).toBeNull();
    expect(nextRunFor({ kind: 'incoming_message' })).toBeNull();
    expect(nextRunFor({ kind: 'daily', at: 'nine' })).toBeNull();
  });
});

describe('triggerTypeFor', () => {
  it('maps trigger kinds to stored trigger types', () => {
    expect(triggerTypeFor({ kind: 'incoming_message' })).toBe(
      'incoming_message',
    );
    expect(triggerTypeFor({ kind: 'manual' })).toBe('manual');
    expect(triggerTypeFor({ kind: 'every', minutes: 5 })).toBe('schedule');
    expect(triggerTypeFor({ kind: 'daily', at: '09:00' })).toBe('schedule');
    expect(triggerTypeFor({})).toBe('schedule');
  });
});

describe('AutomationsService CRUD', () => {
  it('computes nextRunAt on create only when the automation is enabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 8, 0, 0));
    const harness = createHarness();

    const enabled = await harness.service.create({
      name: 'Every 10',
      enabled: true,
      trigger: { kind: 'every', minutes: 10 },
      action: { type: 'agent', prompt: 'Do it' },
    });
    const disabled = await harness.service.create({
      name: 'Paused',
      enabled: false,
      trigger: { kind: 'daily', at: '09:00' },
      action: { type: 'agent', prompt: 'Do it' },
    });

    expect(enabled.nextRunAt).not.toBeNull();
    expect(new Date(enabled.nextRunAt as string).getTime()).toBe(
      new Date(2026, 10, 24, 8, 10, 0).getTime(),
    );
    expect(enabled.triggerType).toBe('schedule');
    expect(disabled.nextRunAt).toBeNull();
  });

  it('requeries and validates inputs on create', async () => {
    const harness = createHarness();

    const nameError = await harness.service
      .create({ trigger: {}, action: { type: 'agent' } })
      .catch((caught: unknown) => caught);
    expect(httpBody(nameError).code).toBe('INVALID_NAME');

    const actionError = await harness.service
      .create({
        name: 'Bad',
        action: { type: 'teleport' },
        trigger: { kind: 'manual' },
      })
      .catch((caught: unknown) => caught);
    expect(httpBody(actionError).code).toBe('INVALID_ACTION');

    const accountError = await harness.service
      .create({
        name: 'Unknown account',
        accountId: 'missing',
        action: { type: 'agent' },
        trigger: { kind: 'manual' },
      })
      .catch((caught: unknown) => caught);
    expect(httpBody(accountError).code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('recomputes nextRunAt when enabled or the trigger changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 24, 8, 0, 0));
    const harness = createHarness([
      automationRow({ id: 'auto-1', enabled: false, nextRunAt: null }),
    ]);

    const enabled = await harness.service.update('auto-1', {
      enabled: true,
      trigger: { kind: 'daily', at: '09:00' },
    });
    expect(enabled.enabled).toBe(true);
    expect(enabled.nextRunAt).toBe(
      new Date(2026, 10, 24, 9, 0, 0).toISOString(),
    );

    const paused = await harness.service.update('auto-1', { enabled: false });
    expect(paused.nextRunAt).toBeNull();

    const incoming = await harness.service.update('auto-1', {
      enabled: true,
      trigger: { kind: 'incoming_message', keywords: ['hi'] },
    });
    expect(incoming.triggerType).toBe('incoming_message');
    expect(incoming.nextRunAt).toBeNull();
  });

  it('rejects an unknown action type on update', async () => {
    const harness = createHarness([automationRow()]);

    const error = await harness.service
      .update('auto-1', { action: { type: 'teleport' } })
      .catch((caught: unknown) => caught);

    expect(httpBody(error).code).toBe('INVALID_ACTION');
  });

  it('marks an automation due for the next tick on requestRun', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness([
      automationRow({ id: 'auto-1', nextRunAt: null }),
    ]);

    const view = await harness.service.requestRun('auto-1');

    expect(view.nextRunAt).toBe(NOW.toISOString());

    const missing = await harness.service
      .requestRun('missing')
      .catch((caught: unknown) => caught);
    expect(httpBody(missing).code).toBe('AUTOMATION_NOT_FOUND');
  });

  it('returns only due, enabled automations', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness([
      automationRow({
        id: 'due',
        nextRunAt: new Date(NOW.getTime() - 60_000),
      }),
      automationRow({
        id: 'future',
        nextRunAt: new Date(NOW.getTime() + 60_000),
      }),
      automationRow({
        id: 'disabled',
        enabled: false,
        nextRunAt: new Date(NOW.getTime() - 60_000),
      }),
    ]);

    const due = await harness.service.due();

    expect(due.map((row) => row.id)).toEqual(['due']);
  });

  it('completes a run by stamping the clock, the count and the next date', async () => {
    const harness = createHarness([automationRow({ id: 'auto-1' })]);

    await harness.service.complete('auto-1', {
      kind: 'every',
      minutes: 15,
    });

    const row = harness.automations[0];
    expect(row.runCount).toBe(1);
    expect(row.lastRunAt).toBeInstanceOf(Date);
    expect(row.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('AutomationsService.matchingIncoming', () => {
  const rows = [
    automationRow({
      id: 'keyed',
      accountId: 'acc-1',
      triggerType: 'incoming_message',
      trigger: JSON.stringify({
        kind: 'incoming_message',
        keywords: ['Hello'],
        chatIds: [5],
      }),
    }),
    automationRow({
      id: 'any',
      accountId: null,
      triggerType: 'incoming_message',
      trigger: JSON.stringify({ kind: 'incoming_message' }),
    }),
    automationRow({
      id: 'disabled',
      enabled: false,
      triggerType: 'incoming_message',
      trigger: JSON.stringify({ kind: 'incoming_message' }),
    }),
    automationRow({
      id: 'manual',
      triggerType: 'manual',
      trigger: JSON.stringify({ kind: 'manual' }),
    }),
    automationRow({
      id: 'other-chat',
      accountId: 'acc-1',
      triggerType: 'incoming_message',
      trigger: JSON.stringify({
        kind: 'incoming_message',
        keywords: ['bye'],
        chatIds: [6],
      }),
    }),
  ];

  it('matches keywords, chat ids and the account scope', async () => {
    const harness = createHarness(rows);

    const hello = await harness.service.matchingIncoming(
      'acc-1',
      5,
      'well HELLO there',
    );
    expect(hello.map((item) => item.id)).toEqual(['keyed', 'any']);

    const wrongChat = await harness.service.matchingIncoming(
      'acc-1',
      6,
      'hello',
    );
    expect(wrongChat.map((item) => item.id)).toEqual(['any']);

    const wrongKeyword = await harness.service.matchingIncoming(
      'acc-1',
      5,
      'nothing to see',
    );
    expect(wrongKeyword.map((item) => item.id)).toEqual(['any']);
  });

  it('does not match automations of another account', async () => {
    const harness = createHarness(rows);

    const matches = await harness.service.matchingIncoming(
      'acc-2',
      5,
      'hello',
    );

    expect(matches.map((item) => item.id)).toEqual(['any']);
  });

  it('ignores malformed chatIds and keyword lists', async () => {
    const harness = createHarness([
      automationRow({
        id: 'broken',
        accountId: null,
        triggerType: 'incoming_message',
        trigger: JSON.stringify({
          kind: 'incoming_message',
          keywords: 'hello',
          chatIds: ['5', null],
        }),
      }),
    ]);

    const matches = await harness.service.matchingIncoming(
      'acc-1',
      5,
      'hello',
    );

    expect(matches.map((item) => item.id)).toEqual(['broken']);
  });
});

describe('AutomationsService.runs', () => {
  it('maps run rows and clamps the requested limit', async () => {
    const harness = createHarness([automationRow()]);
    harness.runs.push(
      runRow({
        id: 'run-2',
        startedAt: new Date(NOW.getTime() + 5000),
        finishedAt: new Date(NOW.getTime() + 7000),
      }),
    );

    const runs = await harness.service.runs('auto-1', 1000);

    expect(runs.map((run) => run.id)).toEqual(['run-2', 'run-1']);
    expect(runs[0].input).toEqual({ source: 'test' });
    expect(runs[0].finishedAt).toBe(
      new Date(NOW.getTime() + 7000).toISOString(),
    );
    expect(harness.prisma.automationRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
  });
});
