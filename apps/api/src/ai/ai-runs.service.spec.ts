import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunModel } from '@repo/database';
import { AiController } from './ai.controller.js';
import {
  AiRunsService,
  RUNS_DEFAULT_LIMIT,
  RUNS_MAX_LIMIT,
  parseMessageIds,
  runsLimit,
} from './ai-runs.service.js';

const NOW = new Date('2026-11-24T12:00:00.000Z');

function runRow(overrides: Partial<AgentRunModel> = {}): AgentRunModel {
  return {
    id: 'run-1',
    accountId: 'account-1',
    soulId: 'soul-1',
    chatId: BigInt(42),
    source: 'dm',
    status: 'ok',
    prompt: 'Hi there',
    output: 'Hello back',
    reasoning: 'SECRET THOUGHTS',
    model: 'main-model',
    steps: 1,
    trace: '[]',
    messageIds: JSON.stringify([2002, 2003]),
    inputTokens: 1,
    outputTokens: 1,
    error: null,
    createdAt: NOW,
    finishedAt: NOW,
    ...overrides,
  } as unknown as AgentRunModel;
}

function harness() {
  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(async () => ({ id: 'account-1' }) as { id: string } | null),
    },
    agentRun: {
      findMany: vi.fn(async () => [] as AgentRunModel[]),
      findUnique: vi.fn(async () => null as AgentRunModel | null),
      update: vi.fn(async () => ({})),
    },
  };
  const service = new AiRunsService(prisma as never);
  return { prisma, service };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AiRunsService.list', () => {
  it('filters by account and chat and applies the default limit', async () => {
    const h = harness();
    h.prisma.agentRun.findMany.mockResolvedValueOnce([runRow()]);

    const rows = await h.service.list({
      userId: 'user-1',
      accountId: 'account-1',
      chatId: 42,
    });

    expect(rows).toEqual([runRow()]);
    expect(h.prisma.telegramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: 'account-1', userId: 'user-1' },
      select: { id: true },
    });
    expect(h.prisma.agentRun.findMany).toHaveBeenCalledWith({
      where: { accountId: 'account-1', chatId: BigInt(42) },
      orderBy: { createdAt: 'desc' },
      take: RUNS_DEFAULT_LIMIT,
    });
    expect(RUNS_DEFAULT_LIMIT).toBe(20);
  });

  it('clamps the limit to 100 and never below one', async () => {
    const h = harness();

    await h.service.list({ userId: 'user-1', limit: 500 });
    expect(h.prisma.agentRun.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: RUNS_MAX_LIMIT }),
    );

    await h.service.list({ userId: 'user-1', limit: 0 });
    expect(h.prisma.agentRun.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
    expect(RUNS_MAX_LIMIT).toBe(100);
  });

  it('rejects an account that belongs to someone else', async () => {
    const h = harness();
    h.prisma.telegramAccount.findFirst.mockResolvedValueOnce(null);

    await expect(
      h.service.list({ userId: 'user-1', accountId: 'account-1' }),
    ).rejects.toMatchObject({
      response: { code: 'ACCOUNT_NOT_FOUND' },
    });
    expect(h.prisma.agentRun.findMany).not.toHaveBeenCalled();
  });
});

describe('AiRunsService.get', () => {
  it('returns one run and checks account ownership', async () => {
    const h = harness();
    h.prisma.agentRun.findUnique.mockResolvedValueOnce(runRow());

    const run = await h.service.get('user-1', 'run-1');

    expect(run.id).toBe('run-1');
    expect(h.prisma.telegramAccount.findFirst).toHaveBeenCalledWith({
      where: { id: 'account-1', userId: 'user-1' },
      select: { id: true },
    });
  });

  it('returns 404 for an unknown run', async () => {
    const h = harness();

    await expect(h.service.get('user-1', 'missing')).rejects.toMatchObject({
      response: { code: 'RUN_NOT_FOUND' },
    });
  });

  it('does not expose a run of an account owned by someone else', async () => {
    const h = harness();
    h.prisma.agentRun.findUnique.mockResolvedValueOnce(runRow());
    h.prisma.telegramAccount.findFirst.mockResolvedValueOnce(null);

    await expect(h.service.get('user-1', 'run-1')).rejects.toBeInstanceOf(
      HttpException,
    );
  });
});

describe('AiRunsService.attachMessages', () => {
  it('stores the sent bubble ids as a JSON array', async () => {
    const h = harness();

    await h.service.attachMessages('run-1', [2002, 2003]);

    expect(h.prisma.agentRun.update).toHaveBeenCalledWith({
      where: { id: 'run-1' },
      data: { messageIds: JSON.stringify([2002, 2003]) },
    });
  });
});

describe('run view helpers', () => {
  it('parses message ids defensively', () => {
    expect(parseMessageIds('[2002,2003]')).toEqual([2002, 2003]);
    expect(parseMessageIds('[2002,"x",0,3.5]')).toEqual([2002]);
    expect(parseMessageIds('not json')).toEqual([]);
    expect(parseMessageIds('{}')).toEqual([]);
    expect(parseMessageIds(null)).toEqual([]);
  });

  it('clamps page sizes', () => {
    expect(runsLimit(undefined)).toBe(20);
    expect(runsLimit(Number.NaN)).toBe(20);
    expect(runsLimit(5.9)).toBe(5);
    expect(runsLimit(10_000)).toBe(100);
  });
});

describe('AiController runs endpoints', () => {
  function controller() {
    const h = harness();
    const ctrl = new AiController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      h.service,
    );
    return { ...h, ctrl };
  }

  it('lists runs for one chat with reasoning and parsed message ids', async () => {
    const h = controller();
    h.prisma.agentRun.findMany.mockResolvedValueOnce([runRow()]);

    const result = await h.ctrl.runs(
      { id: 'user-1' } as never,
      'account-1',
      '42',
      undefined,
      '5',
    );

    expect(h.prisma.agentRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: 'account-1', chatId: BigInt(42) },
        take: 5,
      }),
    );
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      id: 'run-1',
      source: 'dm',
      output: 'Hello back',
      reasoning: 'SECRET THOUGHTS',
      messageIds: [2002, 2003],
      createdAt: NOW.toISOString(),
    });
  });

  it('returns one run by id', async () => {
    const h = controller();
    h.prisma.agentRun.findUnique.mockResolvedValueOnce(runRow());

    const run = await h.ctrl.run({ id: 'user-1' } as never, 'run-1');

    expect(run).toMatchObject({
      id: 'run-1',
      reasoning: 'SECRET THOUGHTS',
      messageIds: [2002, 2003],
    });
  });
});
