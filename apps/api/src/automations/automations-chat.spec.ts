import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AutomationModel, AutomationRunModel } from '@repo/database';
import { AutomationsService, nextRunFor } from './automations.service.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const YEKATINERBURG_0900 = '2026-11-25T04:00:00.000Z';

function automationRow(
  overrides: Partial<AutomationModel> = {},
): AutomationModel {
  return {
    id: 'auto-1',
    accountId: 'acc-1',
    chatId: null,
    threadId: 0,
    soulId: null,
    createdBy: 'user',
    timezone: null,
    selfPausedAt: null,
    selfPauseReason: null,
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
    input: '{}',
    output: 'done',
    error: null,
    startedAt: NOW,
    finishedAt: null,
    ...overrides,
  };
}

interface FindManyArgs {
  where?: Record<string, unknown>;
  orderBy?: Record<string, 'asc' | 'desc'>;
  take?: number;
}

function matches(row: AutomationModel, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === 'OR') {
      const clauses = value as Array<{ accountId: string | null }>;
      const allowed = clauses.some((clause) =>
        clause.accountId === null
          ? row.accountId === null
          : row.accountId === clause.accountId,
      );
      if (!allowed) return false;
      continue;
    }
    if (key === 'id') {
      const ids = (value as { in?: string[] }).in ?? [value as string];
      if (!ids.includes(row.id)) return false;
      continue;
    }
    if (key === 'nextRunAt') {
      const lte = (value as { lte?: Date }).lte;
      if (lte && (!row.nextRunAt || row.nextRunAt.getTime() > lte.getTime())) {
        return false;
      }
      continue;
    }
    if (key in row) {
      if (row[key as keyof AutomationModel] !== value) return false;
    }
  }
  return true;
}

function createHarness(
  rows: AutomationModel[] = [],
  runs: AutomationRunModel[] = [],
) {
  const automations = rows.slice();
  const accounts = [{ id: 'acc-1' }, { id: 'acc-2' }];
  const souls = [
    { id: 'soul-1', accountId: 'acc-1' },
    { id: 'soul-2', accountId: 'acc-2' },
  ];
  let sequence = 0;

  const apply = (row: AutomationModel, data: Record<string, unknown>): void => {
    const { runCount, ...rest } = data;
    Object.assign(row, rest, { updatedAt: new Date() });
    if (runCount && typeof runCount === 'object' && 'increment' in runCount) {
      row.runCount += Number((runCount as { increment: number }).increment);
    }
  };

  const prisma = {
    automation: {
      findMany: vi.fn(async (args: FindManyArgs = {}) => {
        let list = automations.filter((row) => matches(row, args.where ?? {}));
        const order = args.orderBy ?? {};
        const key = Object.keys(order)[0] as keyof AutomationModel | undefined;
        if (key) {
          const direction = order[key as string] === 'desc' ? -1 : 1;
          list = list.slice().sort((a, b) => {
            const left = a[key];
            const right = b[key];
            const diff =
              left instanceof Date && right instanceof Date
                ? left.getTime() - right.getTime()
                : String(left).localeCompare(String(right));
            return direction * diff;
          });
        }
        return args.take ? list.slice(0, args.take) : list;
      }),
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        automations.find((row) => row.id === args.where.id) ?? null,
      ),
      create: vi.fn(async (args: { data: Partial<AutomationModel> }) => {
        sequence += 1;
        const row = automationRow({
          ...args.data,
          id: `auto-${sequence}`,
          description: args.data.description ?? '',
          nextRunAt: args.data.nextRunAt ?? null,
          createdAt: new Date(NOW.getTime() + sequence),
          updatedAt: new Date(NOW.getTime() + sequence),
        });
        automations.push(row);
        return row;
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = automations.find(
            (candidate) => candidate.id === args.where.id,
          );
          if (!row) throw new Error('automation not found');
          apply(row, args.data);
          return row;
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          const matched = automations.filter((row) =>
            matches(row, args.where),
          );
          for (const row of matched) apply(row, args.data);
          return { count: matched.length };
        },
      ),
      deleteMany: vi.fn(async (args: { where: { id: string } }) => {
        const index = automations.findIndex((row) => row.id === args.where.id);
        if (index >= 0) automations.splice(index, 1);
        return { count: index >= 0 ? 1 : 0 };
      }),
    },
    automationRun: {
      findMany: vi.fn(
        async (args: {
          where: { automationId: string | { in: string[] } };
          orderBy: { startedAt: 'asc' | 'desc' };
          take?: number;
        }) => {
          const filter = args.where.automationId;
          const ids = typeof filter === 'string' ? [filter] : filter.in;
          const list = runs
            .filter((run) => ids.includes(run.automationId))
            .sort(
              (a, b) =>
                (args.orderBy.startedAt === 'desc' ? -1 : 1) *
                (a.startedAt.getTime() - b.startedAt.getTime()),
            );
          return args.take ? list.slice(0, args.take) : list;
        },
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
    soul: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        souls.find((soul) => soul.id === args.where.id) ?? null,
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

describe('timezone-aware schedules', () => {
  it('resolves 09:00 Asia/Yekaterinburg to 04:00 UTC', () => {
    const from = new Date('2026-11-24T00:00:00.000Z'); // 05:00 in the zone

    const next = nextRunFor(
      { kind: 'daily', at: '09:00' },
      from,
      'Asia/Yekaterinburg',
    );

    expect(next?.toISOString()).toBe('2026-11-24T04:00:00.000Z');
  });

  it('rolls to the next local day once the zone clock passed', () => {
    const from = new Date('2026-11-24T10:00:00.000Z'); // 15:00 in the zone

    const next = nextRunFor(
      { kind: 'daily', at: '09:00' },
      from,
      'Asia/Yekaterinburg',
    );

    expect(next?.toISOString()).toBe(YEKATINERBURG_0900);
  });

  it('follows the zone DST offset instead of the server one', () => {
    const from = new Date('2026-07-01T00:00:00.000Z'); // 02:00 CEST

    const next = nextRunFor({ kind: 'daily', at: '09:00' }, from, 'Europe/Berlin');

    expect(next?.toISOString()).toBe('2026-07-01T07:00:00.000Z');
  });

  it('keeps intervals absolute in any zone', () => {
    const from = new Date('2026-11-24T00:00:00.000Z');

    const next = nextRunFor(
      { kind: 'every', minutes: 15 },
      from,
      'Asia/Yekaterinburg',
    );

    expect(next?.toISOString()).toBe('2026-11-24T00:15:00.000Z');
  });
});

describe('AutomationsService chat binding', () => {
  it('persists the chat binding and computes the due time in the zone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness();

    const view = await harness.service.create({
      accountId: 'acc-1',
      chatId: 777,
      threadId: 12,
      soulId: 'soul-1',
      createdBy: 'soul',
      timezone: 'Asia/Yekaterinburg',
      name: 'Morning report',
      enabled: true,
      trigger: { kind: 'daily', at: '09:00' },
      action: { type: 'agent', prompt: 'Report' },
    });

    expect(view).toMatchObject({
      accountId: 'acc-1',
      chatId: 777,
      threadId: 12,
      soulId: 'soul-1',
      createdBy: 'soul',
      timezone: 'Asia/Yekaterinburg',
    });
    expect(view.nextDueAt).toBe(YEKATINERBURG_0900);
    const stored = harness.automations[0];
    expect(stored.chatId).toBe(777n);
    expect(stored.threadId).toBe(12);
  });

  it('requires an account for a chat-bound automation', async () => {
    const harness = createHarness();

    const error = await harness.service
      .create({
        name: 'No account',
        chatId: 777,
        trigger: { kind: 'manual' },
        action: { type: 'agent' },
      })
      .catch((caught: unknown) => caught);

    expect(httpBody(error).code).toBe('INVALID_CHAT');
  });

  it('rejects an unknown soul, a foreign soul and a bad createdBy', async () => {
    const harness = createHarness();

    const missing = await harness.service
      .create({
        name: 'Missing soul',
        soulId: 'soul-missing',
        trigger: { kind: 'manual' },
        action: { type: 'agent' },
      })
      .catch((caught: unknown) => caught);
    expect(httpBody(missing).code).toBe('SOUL_NOT_FOUND');

    const foreign = await harness.service
      .create({
        name: 'Foreign soul',
        accountId: 'acc-1',
        soulId: 'soul-2',
        trigger: { kind: 'manual' },
        action: { type: 'agent' },
      })
      .catch((caught: unknown) => caught);
    expect(httpBody(foreign).code).toBe('SOUL_ACCOUNT_MISMATCH');

    const createdBy = await harness.service
      .create({
        name: 'Bad creator',
        createdBy: 'robot',
        trigger: { kind: 'manual' },
        action: { type: 'agent' },
      })
      .catch((caught: unknown) => caught);
    expect(httpBody(createdBy).code).toBe('INVALID_CREATED_BY');
  });

  it('rejects an unknown IANA timezone', async () => {
    const harness = createHarness();

    const error = await harness.service
      .create({
        name: 'Mars',
        timezone: 'Mars/Olympus_Mons',
        trigger: { kind: 'daily', at: '09:00' },
        action: { type: 'agent' },
      })
      .catch((caught: unknown) => caught);

    expect(httpBody(error).code).toBe('INVALID_TIMEZONE');
  });

  it('filters the list by account, chat and thread', async () => {
    const harness = createHarness([
      automationRow({ id: 'chat-777', chatId: 777n }),
      automationRow({ id: 'chat-888', chatId: 888n }),
      automationRow({ id: 'other-account', accountId: 'acc-2', chatId: 777n }),
      automationRow({ id: 'thread-5', chatId: 777n, threadId: 5 }),
      automationRow({ id: 'unbound', chatId: null }),
    ]);

    const chat = await harness.service.list('acc-1', { chatId: 777 });
    expect(chat.map((view) => view.id)).toEqual(['chat-777', 'thread-5']);

    const thread = await harness.service.list('acc-1', {
      chatId: 777,
      threadId: 5,
    });
    expect(thread.map((view) => view.id)).toEqual(['thread-5']);
  });

  it('recomputes the due time when the timezone changes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness([
      automationRow({
        id: 'auto-1',
        trigger: JSON.stringify({ kind: 'daily', at: '09:00' }),
      }),
    ]);

    const view = await harness.service.update('auto-1', {
      timezone: 'Asia/Yekaterinburg',
    });

    expect(view.nextDueAt).toBe(YEKATINERBURG_0900);

    const cleared = await harness.service.update('auto-1', { timezone: null });
    expect(cleared.timezone).toBeNull();
    expect(cleared.nextDueAt).not.toBeNull();
  });
});

describe('AutomationsService.chat', () => {
  it('returns one chat with last-run status, due time and summary', async () => {
    const harness = createHarness(
      [
        automationRow({
          id: 'live',
          chatId: 777n,
          timezone: 'Asia/Yekaterinburg',
          trigger: JSON.stringify({ kind: 'daily', at: '09:00' }),
          nextRunAt: new Date(YEKATINERBURG_0900),
          lastRunAt: new Date('2026-11-24T04:00:00.000Z'),
        }),
        automationRow({
          id: 'resting',
          chatId: 777n,
          selfPausedAt: new Date('2026-11-24T09:00:00.000Z'),
          selfPauseReason: 'Resting',
          nextRunAt: null,
        }),
        automationRow({ id: 'other-chat', chatId: 888n }),
      ],
      [
        runRow({ id: 'run-old', automationId: 'live', status: 'ok', startedAt: NOW }),
        runRow({
          id: 'run-new',
          automationId: 'live',
          status: 'failed',
          error: 'LLM down',
          startedAt: new Date(NOW.getTime() + 60_000),
        }),
      ],
    );

    const view = await harness.service.chat('acc-1', 777);

    expect(view.automations.map((item) => item.id)).toEqual([
      'live',
      'resting',
    ]);
    expect(view.automations[0]).toMatchObject({
      lastRunStatus: 'failed',
      lastRunError: 'LLM down',
      nextDueAt: YEKATINERBURG_0900,
    });
    expect(view.automations[1]).toMatchObject({
      lastRunStatus: null,
      selfPaused: true,
      nextDueAt: null,
    });
    expect(view.summary).toEqual({
      total: 2,
      active: 1,
      paused: 1,
      nextDueAt: YEKATINERBURG_0900,
      lastRunAt: '2026-11-24T04:00:00.000Z',
    });
    expect(view.threadId).toBeNull();
  });

  it('scopes the card to a thread when asked', async () => {
    const harness = createHarness([
      automationRow({ id: 'whole', chatId: 777n }),
      automationRow({ id: 'topic', chatId: 777n, threadId: 5 }),
    ]);

    const view = await harness.service.chat('acc-1', 777, { threadId: 5 });

    expect(view.automations.map((item) => item.id)).toEqual(['topic']);
    expect(view.threadId).toBe(5);
  });
});

describe('AutomationsService.pauseForChat', () => {
  it('pauses only the automations of that chat', async () => {
    const harness = createHarness([
      automationRow({
        id: 'target',
        chatId: 777n,
        nextRunAt: new Date(YEKATINERBURG_0900),
      }),
      automationRow({
        id: 'other-chat',
        chatId: 888n,
        nextRunAt: new Date(YEKATINERBURG_0900),
      }),
      automationRow({
        id: 'other-account',
        accountId: 'acc-2',
        chatId: 777n,
        nextRunAt: new Date(YEKATINERBURG_0900),
      }),
    ]);

    const paused = await harness.service.pauseForChat({
      accountId: 'acc-1',
      chatId: 777,
      reason: 'Resting',
    });

    expect(paused.map((view) => view.id)).toEqual(['target']);
    expect(paused[0]).toMatchObject({
      selfPaused: true,
      selfPauseReason: 'Resting',
      nextDueAt: null,
    });
    expect(harness.automations[0].selfPausedAt).toBeInstanceOf(Date);
    expect(harness.automations[1].selfPausedAt).toBeNull();
    expect(harness.automations[2].selfPausedAt).toBeNull();
    expect(harness.automations[1].nextRunAt).not.toBeNull();
  });

  it('narrows to one soul and one thread within the chat', async () => {
    const harness = createHarness([
      automationRow({ id: 'soul-1', chatId: 777n, soulId: 'soul-1' }),
      automationRow({ id: 'soul-2', chatId: 777n, soulId: 'soul-2' }),
      automationRow({
        id: 'soul-1-topic',
        chatId: 777n,
        soulId: 'soul-1',
        threadId: 5,
      }),
    ]);

    const paused = await harness.service.pauseForChat({
      accountId: 'acc-1',
      chatId: 777,
      soulId: 'soul-1',
      threadId: 5,
      reason: 'Back later',
    });

    expect(paused.map((view) => view.id)).toEqual(['soul-1-topic']);
    expect(
      harness.automations.filter((row) => row.selfPausedAt !== null).map((row) => row.id),
    ).toEqual(['soul-1-topic']);
  });

  it('refuses the manual run button while self-paused', async () => {
    const harness = createHarness([
      automationRow({
        id: 'resting',
        selfPausedAt: new Date(NOW),
        selfPauseReason: 'Resting',
      }),
    ]);

    const error = await harness.service
      .requestRun('resting')
      .catch((caught: unknown) => caught);

    expect(httpBody(error).code).toBe('AUTOMATION_PAUSED');
  });
});

describe('AutomationsService.resume', () => {
  it('resumes one chat and recomputes the zone-aware due time', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness([
      automationRow({
        id: 'resting',
        chatId: 777n,
        timezone: 'Asia/Yekaterinburg',
        trigger: JSON.stringify({ kind: 'daily', at: '09:00' }),
        selfPausedAt: new Date(NOW),
        selfPauseReason: 'Resting',
        nextRunAt: null,
      }),
      automationRow({ id: 'elsewhere', chatId: 888n }),
    ]);

    const resumed = await harness.service.resume({
      accountId: 'acc-1',
      chatId: 777,
    });

    expect(resumed.map((view) => view.id)).toEqual(['resting']);
    expect(resumed[0]).toMatchObject({
      selfPaused: false,
      selfPauseReason: null,
      nextDueAt: YEKATINERBURG_0900,
    });
    expect(harness.automations[1].selfPausedAt).toBeNull();
  });

  it('resumes a single automation by id', async () => {
    const harness = createHarness([
      automationRow({ id: 'auto-1', selfPausedAt: new Date(NOW) }),
    ]);

    const resumed = await harness.service.resume('auto-1');

    expect(resumed).toHaveLength(1);
    expect(resumed[0].selfPaused).toBe(false);
    expect(harness.automations[0].selfPausedAt).toBeNull();
  });

  it('throws for an unknown automation id', async () => {
    const harness = createHarness();

    const error = await harness.service
      .resume('missing')
      .catch((caught: unknown) => caught);

    expect(httpBody(error).code).toBe('AUTOMATION_NOT_FOUND');
  });
});

describe('AutomationsService self-pause scheduling', () => {
  it('excludes self-paused rows from due()', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const harness = createHarness([
      automationRow({
        id: 'due',
        nextRunAt: new Date(NOW.getTime() - 60_000),
      }),
      automationRow({
        id: 'resting',
        selfPausedAt: new Date(NOW),
        nextRunAt: new Date(NOW.getTime() - 60_000),
      }),
    ]);

    const due = await harness.service.due();

    expect(due.map((row) => row.id)).toEqual(['due']);
  });

  it('keeps a chat-bound incoming automation inside its chat', async () => {
    const harness = createHarness([
      automationRow({
        id: 'bound',
        chatId: 777n,
        triggerType: 'incoming_message',
        trigger: JSON.stringify({ kind: 'incoming_message' }),
      }),
      automationRow({
        id: 'resting',
        chatId: 777n,
        selfPausedAt: new Date(NOW),
        triggerType: 'incoming_message',
        trigger: JSON.stringify({ kind: 'incoming_message' }),
      }),
    ]);

    const otherChat = await harness.service.matchingIncoming('acc-1', 888, 'hi');
    expect(otherChat).toHaveLength(0);

    const ownChat = await harness.service.matchingIncoming('acc-1', 777, 'hi');
    expect(ownChat.map((view) => view.id)).toEqual(['bound']);
  });
});
