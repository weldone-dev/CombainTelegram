import { describe, expect, it, vi } from 'vitest';
import type {
  SoulMemoryModel,
  SoulSummaryModel,
  SoulTurnModel,
} from '@repo/database';
import { MemoryService } from './memory.service.js';

const BASE = new Date('2026-11-24T09:00:00.000Z').getTime();

function at(seconds: number): Date {
  return new Date(BASE + seconds * 1000);
}

function turnRow(overrides: Partial<SoulTurnModel>): SoulTurnModel {
  return {
    id: 'turn-1',
    accountId: 'account-1',
    chatId: BigInt(42),
    role: 'user',
    content: 'hello',
    messageId: null,
    runId: null,
    createdAt: at(0),
    ...overrides,
  } as SoulTurnModel;
}

function factRow(overrides: Partial<SoulMemoryModel>): SoulMemoryModel {
  return {
    id: 'fact-1',
    accountId: 'account-1',
    chatId: BigInt(42),
    kind: 'fact',
    content: 'Lives in Berlin',
    importance: 2,
    source: 'agent',
    createdAt: at(0),
    lastUsedAt: null,
    ...overrides,
  } as SoulMemoryModel;
}

function summaryRow(
  overrides: Partial<SoulSummaryModel> = {},
): SoulSummaryModel {
  return {
    id: 'summary-1',
    accountId: 'account-1',
    chatId: BigInt(42),
    summary: 'Existing summary',
    facts: '[]',
    turnsThrough: null,
    updatedAt: at(0),
    ...overrides,
  } as SoulSummaryModel;
}

interface MemoryWhere {
  accountId?: string;
  chatId?: bigint | null;
  OR?: Array<{ chatId: bigint | null }>;
  createdAt?: { lt?: Date };
  id?: string;
}

function matchesMemory(where: MemoryWhere, fact: SoulMemoryModel): boolean {
  if (where.accountId && fact.accountId !== where.accountId) return false;
  if (where.id !== undefined) return fact.id === where.id;
  if (where.chatId === null) return fact.chatId === null;
  if (where.chatId !== undefined) {
    return fact.chatId !== null && fact.chatId === where.chatId;
  }
  if (Array.isArray(where.OR)) {
    return where.OR.some((clause) =>
      clause.chatId === null
        ? fact.chatId === null
        : fact.chatId !== null && fact.chatId === clause.chatId,
    );
  }
  return true;
}

function harness(
  options: {
    turns?: SoulTurnModel[];
    facts?: SoulMemoryModel[];
    summary?: SoulSummaryModel | null;
  } = {},
) {
  const turns = [...(options.turns ?? [])];
  const facts = [...(options.facts ?? [])];
  let summary = options.summary ?? null;
  let counter = 0;

  const matchingTurns = (where: MemoryWhere) =>
    turns.filter(
      (turn) =>
        (!where.accountId || turn.accountId === where.accountId) &&
        (where.chatId === undefined ||
          (turn.chatId !== null && turn.chatId === where.chatId)) &&
        (!where.createdAt?.lt || turn.createdAt < where.createdAt.lt),
    );

  const prisma = {
    soulTurn: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        counter += 1;
        const created = turnRow({
          id: `turn-${counter}`,
          ...(data as Partial<SoulTurnModel>),
          createdAt: at(counter),
        });
        turns.push(created);
        return created;
      }),
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          take,
        }: {
          where: MemoryWhere;
          orderBy?: { createdAt?: 'asc' | 'desc' };
          take?: number;
        }) => {
          const rows = matchingTurns(where).sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
          );
          if (orderBy?.createdAt === 'desc') rows.reverse();
          return take ? rows.slice(0, take) : rows;
        },
      ),
      count: vi.fn(async ({ where }: { where: MemoryWhere }) => {
        return matchingTurns(where).length;
      }),
      deleteMany: vi.fn(async ({ where }: { where: MemoryWhere }) => {
        const doomed = new Set(matchingTurns(where));
        let removed = 0;
        for (let index = turns.length - 1; index >= 0; index -= 1) {
          if (doomed.has(turns[index] as SoulTurnModel)) {
            turns.splice(index, 1);
            removed += 1;
          }
        }
        return { count: removed };
      }),
    },
    soulSummary: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { accountId_chatId: { accountId: string; chatId: bigint } };
        }) => {
          if (!summary) return null;
          const key = where.accountId_chatId;
          return summary.accountId === key.accountId &&
            summary.chatId === key.chatId
            ? summary
            : null;
        },
      ),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Partial<SoulSummaryModel>;
          update: Partial<SoulSummaryModel>;
        }) => {
          summary = summary
            ? ({ ...summary, ...update } as SoulSummaryModel)
            : (summaryRow(create) as SoulSummaryModel);
          return summary;
        },
      ),
      deleteMany: vi.fn(async () => {
        summary = null;
        return { count: summary ? 1 : 0 };
      }),
    },
    soulMemory: {
      findMany: vi.fn(
        async ({
          where,
          orderBy,
          take,
          select,
        }: {
          where: MemoryWhere;
          orderBy?: Array<{ importance?: 'asc' | 'desc'; createdAt?: 'asc' | 'desc' }>;
          take?: number;
          select?: Record<string, boolean>;
        }) => {
          let rows = facts.filter((fact) => matchesMemory(where, fact));
          if (orderBy) {
            rows = [...rows].sort((a, b) => {
              for (const order of orderBy) {
                if (order.importance) {
                  const diff = a.importance - b.importance;
                  if (diff !== 0) return order.importance === 'desc' ? -diff : diff;
                }
                if (order.createdAt) {
                  const diff = a.createdAt.getTime() - b.createdAt.getTime();
                  if (diff !== 0) return order.createdAt === 'desc' ? -diff : diff;
                }
              }
              return 0;
            });
          }
          const sliced = take ? rows.slice(0, take) : rows;
          return select
            ? sliced.map((fact) => ({ id: fact.id, content: fact.content }))
            : sliced;
        },
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        counter += 1;
        const created = factRow({
          id: `fact-${counter}`,
          createdAt: at(counter),
          ...(data as Partial<SoulMemoryModel>),
        });
        facts.push(created);
        return created;
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<SoulMemoryModel>;
        }) => {
          const fact = facts.find((candidate) => candidate.id === where.id);
          if (!fact) throw new Error('fact not found');
          Object.assign(fact, data);
          return fact;
        },
      ),
      deleteMany: vi.fn(async ({ where }: { where: MemoryWhere }) => {
        const doomed = facts.filter((fact) => matchesMemory(where, fact));
        for (const fact of doomed) {
          const index = facts.indexOf(fact);
          if (index >= 0) facts.splice(index, 1);
        }
        return { count: doomed.length };
      }),
      count: vi.fn(async ({ where }: { where: MemoryWhere }) => {
        return facts.filter((fact) => matchesMemory(where, fact)).length;
      }),
    },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    ),
  };

  const config = {
    resolved: vi.fn(async () => ({
      provider: 'openai-compatible',
      baseUrl: 'https://llm.test/v1',
      model: 'main-model',
      fastModel: 'fast-model',
      apiKey: 'sk-test',
      temperature: 0.7,
      maxSteps: 6,
      dryRun: true,
      source: 'database',
    })),
  };
  const llm = {
    complete: vi.fn(
      async (): Promise<string> => '{"summary":"updated","facts":[]}',
    ),
  };

  const service = new MemoryService(
    prisma as never,
    config as never,
    llm as never,
  );

  return { service, prisma, config, llm, turns, facts, summary: () => summary };
}

describe('MemoryService turns', () => {
  it('appends a turn and maps database types back to plain values', async () => {
    const h = harness();

    const turn = await h.service.append('account-1', 42, 'user', 'hello', {
      messageId: 7,
      runId: 'run-1',
    });

    expect(h.prisma.soulTurn.create).toHaveBeenCalledWith({
      data: {
        accountId: 'account-1',
        chatId: BigInt(42),
        role: 'user',
        content: 'hello',
        messageId: BigInt(7),
        runId: 'run-1',
      },
    });
    expect(turn).toMatchObject({
      role: 'user',
      content: 'hello',
      messageId: 7,
      createdAt: expect.any(String),
    });
  });

  it('caps the stored content and keeps null message ids', async () => {
    const h = harness();

    await h.service.append('account-1', 42, 'assistant', 'x'.repeat(9000));

    const data = h.prisma.soulTurn.create.mock.calls[0]?.[0].data as {
      content: string;
      messageId: unknown;
      runId: unknown;
    };
    expect(data.content).toHaveLength(8000);
    expect(data.messageId).toBeNull();
    expect(data.runId).toBeNull();
  });

  it('returns the newest turns in chronological order', async () => {
    const h = harness({
      turns: [0, 1, 2, 3].map((index) =>
        turnRow({ id: `t${index}`, content: `msg ${index}`, createdAt: at(index) }),
      ),
    });

    const recent = await h.service.recentTurns('account-1', 42, 3);

    expect(recent.map((turn) => turn.id)).toEqual(['t1', 't2', 't3']);
    expect(h.prisma.soulTurn.findMany).toHaveBeenCalledWith({
      where: { accountId: 'account-1', chatId: BigInt(42) },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
  });
});

describe('MemoryService context and facts', () => {
  it('builds context from the summary, ranked facts and recent turns', async () => {
    const h = harness({
      summary: summaryRow({ summary: 'Peer lives in Berlin' }),
      facts: [
        factRow({ id: 'f1', content: 'Works at Acme', importance: 5 }),
        factRow({ id: 'f2', content: 'Likes coffee', importance: 1 }),
      ],
      turns: [turnRow({ id: 't1', content: 'hi', createdAt: at(1) })],
    });

    const context = await h.service.context('account-1', 42, 'Berlin');

    expect(context.summary).toBe('Peer lives in Berlin');
    expect(context.facts.map((fact) => fact.content)).toEqual([
      'Works at Acme',
      'Likes coffee',
    ]);
    expect(context.turns.map((turn) => turn.content)).toEqual(['hi']);
    expect(h.prisma.soulMemory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId: 'account-1',
          OR: [{ chatId: BigInt(42) }, { chatId: null }],
        },
      }),
    );
  });

  it('deduplicates facts case-insensitively instead of creating a copy', async () => {
    const h = harness({
      facts: [factRow({ id: 'fact-1', content: 'Lives in Berlin' })],
    });

    const fact = await h.service.addFact(
      'account-1',
      42,
      '  lives   in  BERLIN ',
      { importance: 4 },
    );

    expect(fact.id).toBe('fact-1');
    expect(h.prisma.soulMemory.create).not.toHaveBeenCalled();
    expect(h.prisma.soulMemory.update).toHaveBeenCalledWith({
      where: { id: 'fact-1' },
      data: { importance: 4 },
    });
  });

  it('normalizes and clamps a new fact', async () => {
    const h = harness();

    const fact = await h.service.addFact(
      'account-1',
      null,
      '  Works   at   Acme  ',
      { kind: 'profile', importance: 9 },
    );

    expect(h.prisma.soulMemory.create).toHaveBeenCalledWith({
      data: {
        accountId: 'account-1',
        chatId: null,
        kind: 'profile',
        content: 'Works at Acme',
        importance: 5,
        source: 'agent',
      },
    });
    expect(fact).toMatchObject({
      chatId: null,
      content: 'Works at Acme',
      importance: 5,
    });
  });

  it('rejects an empty fact', async () => {
    const h = harness();
    await expect(h.service.addFact('account-1', 42, '   ')).rejects.toThrow(
      /must not be empty/,
    );
  });

  it('deletes one fact and clears a whole chat', async () => {
    const h = harness({
      facts: [factRow({ id: 'fact-1' })],
      turns: [turnRow({ id: 't1' })],
    });

    expect(await h.service.deleteFact('fact-1')).toEqual({ removed: true });
    expect(h.prisma.soulMemory.deleteMany).toHaveBeenCalledWith({
      where: { id: 'fact-1' },
    });

    await h.service.clearChat('account-1', 42);

    expect(h.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(h.prisma.soulTurn.deleteMany).toHaveBeenCalledWith({
      where: { accountId: 'account-1', chatId: BigInt(42) },
    });
    expect(h.prisma.soulSummary.deleteMany).toHaveBeenCalledWith({
      where: { accountId: 'account-1', chatId: BigInt(42) },
    });
    expect(h.prisma.soulMemory.deleteMany).toHaveBeenCalledWith({
      where: { accountId: 'account-1', chatId: BigInt(42) },
    });
  });

  it('renders a compact prompt block, skipping empty parts', async () => {
    const h = harness();

    expect(
      h.service.formatContext({ summary: '', facts: [], turns: [] }),
    ).toBe('');
    expect(
      h.service.formatContext({
        summary: 'Old story',
        facts: [factRow({ content: 'Lives in Berlin' })],
        turns: [],
      }),
    ).toBe('Долгосрочная сводка: Old story\nФакты: Lives in Berlin');
  });
});

describe('MemoryService summarization', () => {
  it('upserts the summary, extracts facts and prunes old turns', async () => {
    const turns = Array.from({ length: 40 }, (_, index) =>
      turnRow({
        id: `t${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `msg ${index}`,
        createdAt: at(index),
      }),
    );
    const h = harness({ turns });
    h.llm.complete.mockResolvedValue(
      [
        '```json',
        JSON.stringify({
          summary: 'Peer lives in Berlin.',
          facts: [
            { kind: 'profile', content: 'Lives in Berlin', importance: 3 },
            { content: '' },
            { kind: 'event', content: 'Meeting on Friday', importance: 9 },
          ],
        }),
        '```',
      ].join('\n'),
    );

    const result = await h.service.summarize('account-1', 42);

    expect(result).toEqual({
      summary: 'Peer lives in Berlin.',
      factsAdded: 2,
      turnsUsed: 40,
    });
    expect(h.llm.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://llm.test/v1',
        apiKey: 'sk-test',
        model: 'fast-model',
        temperature: 0.2,
      }),
    );
    const prompt = h.llm.complete.mock.calls[0]?.[0].messages[0]?.content;
    expect(prompt).toContain('msg 0');
    expect(prompt).toContain('msg 39');

    expect(h.prisma.soulSummary.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          accountId_chatId: { accountId: 'account-1', chatId: BigInt(42) },
        },
        create: expect.objectContaining({
          summary: 'Peer lives in Berlin.',
          turnsThrough: turns[39]?.createdAt,
        }),
        update: expect.objectContaining({
          summary: 'Peer lives in Berlin.',
          turnsThrough: turns[39]?.createdAt,
        }),
      }),
    );
    expect(h.facts.map((fact) => fact.content)).toEqual([
      'Lives in Berlin',
      'Meeting on Friday',
    ]);
    expect(h.facts.map((fact) => fact.source)).toEqual(['summary', 'summary']);
    expect(h.prisma.soulTurn.deleteMany).toHaveBeenCalledWith({
      where: {
        accountId: 'account-1',
        chatId: BigInt(42),
        createdAt: { lt: turns[28]?.createdAt },
      },
    });
    // The last 12 turns stay in the short-term buffer.
    expect(h.turns).toHaveLength(12);
    expect(h.turns[0]?.content).toBe('msg 28');
  });

  it('keeps the previous summary when the model answers without JSON', async () => {
    const h = harness({
      summary: summaryRow({ summary: 'Existing summary' }),
      turns: Array.from({ length: 5 }, (_, index) =>
        turnRow({ id: `t${index}`, createdAt: at(index) }),
      ),
    });
    h.llm.complete.mockResolvedValue('sorry, no json today');

    const result = await h.service.summarize('account-1', 42);

    expect(result.summary).toBe('Existing summary');
    expect(result.factsAdded).toBe(0);
    expect(h.prisma.soulSummary.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ summary: 'Existing summary' }),
      }),
    );
    expect(h.prisma.soulTurn.deleteMany).not.toHaveBeenCalled();
  });

  it('skips summarization for a short buffer unless forced', async () => {
    const h = harness({
      turns: Array.from({ length: 3 }, (_, index) =>
        turnRow({ id: `t${index}`, createdAt: at(index) }),
      ),
    });

    const result = await h.service.summarize('account-1', 42);

    expect(result).toEqual({ summary: '', factsAdded: 0, turnsUsed: 0 });
    expect(h.llm.complete).not.toHaveBeenCalled();
    expect(h.prisma.soulSummary.upsert).not.toHaveBeenCalled();
  });

  it('refuses to summarize without a configured provider', async () => {
    const h = harness();
    h.config.resolved.mockResolvedValue({
      provider: 'openai-compatible',
      baseUrl: '',
      model: '',
      fastModel: '',
      apiKey: null,
      temperature: 0.7,
      maxSteps: 6,
      dryRun: true,
      source: 'env',
    });

    await expect(h.service.summarize('account-1', 42)).rejects.toThrow(
      /LLM is not configured/,
    );
  });
});

describe('MemoryService.maybeCompact', () => {
  it('does nothing below the threshold', async () => {
    const h = harness({
      turns: Array.from({ length: 29 }, (_, index) =>
        turnRow({ id: `t${index}`, createdAt: at(index) }),
      ),
    });
    const summarize = vi.spyOn(h.service, 'summarize');

    expect(await h.service.maybeCompact('account-1', 42)).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });

  it('compacts once the buffer reaches the threshold', async () => {
    const h = harness({
      turns: Array.from({ length: 30 }, (_, index) =>
        turnRow({ id: `t${index}`, createdAt: at(index) }),
      ),
    });
    const summarize = vi
      .spyOn(h.service, 'summarize')
      .mockResolvedValue({ summary: 'done', factsAdded: 0, turnsUsed: 30 });

    expect(await h.service.maybeCompact('account-1', 42)).toBe(true);
    expect(summarize).toHaveBeenCalledWith('account-1', 42, { force: true });
  });

  it('swallows a summarization failure and reports no compaction', async () => {
    const h = harness({
      turns: Array.from({ length: 30 }, (_, index) =>
        turnRow({ id: `t${index}`, createdAt: at(index) }),
      ),
    });
    vi.spyOn(h.service, 'summarize').mockRejectedValue(
      new Error('LLM exploded'),
    );

    expect(await h.service.maybeCompact('account-1', 42)).toBe(false);
  });
});
