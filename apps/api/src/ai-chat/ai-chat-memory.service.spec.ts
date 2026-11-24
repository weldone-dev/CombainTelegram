import { describe, expect, it, vi } from 'vitest';
import type {
  SoulMemoryModel,
  SoulSummaryModel,
  SoulTurnModel,
} from '@repo/database';
import { AiChatMemoryService } from './ai-chat-memory.service.js';

const USER_ID = 'local';
const OTHER_USER = 'someone-else';
const ACCOUNT_ID = 'account-1';
const OTHER_ACCOUNT = 'account-2';
const CHAT_ID = 1830539716;
const NOW = new Date('2026-11-24T10:00:00.000Z');

function turn(
  overrides: Partial<SoulTurnModel> = {},
): SoulTurnModel {
  return {
    id: 'turn-1',
    accountId: ACCOUNT_ID,
    chatId: BigInt(CHAT_ID),
    role: 'user',
    content: 'привет',
    messageId: BigInt(11),
    runId: null,
    createdAt: NOW,
    ...overrides,
  };
}

function fact(overrides: Partial<SoulMemoryModel> = {}): SoulMemoryModel {
  return {
    id: 'fact-1',
    accountId: ACCOUNT_ID,
    chatId: BigInt(CHAT_ID),
    kind: 'preference',
    content: 'любит кофе',
    importance: 3,
    source: 'agent',
    createdAt: NOW,
    lastUsedAt: null,
    ...overrides,
  };
}

function summary(overrides: Partial<SoulSummaryModel> = {}): SoulSummaryModel {
  return {
    id: 'summary-1',
    accountId: ACCOUNT_ID,
    chatId: BigInt(CHAT_ID),
    summary: 'Говорили о работе.',
    facts: '[]',
    turnsThrough: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(
  options: {
    turns?: SoulTurnModel[];
    facts?: SoulMemoryModel[];
    summary?: SoulSummaryModel | null;
  } = {},
) {
  const turns = options.turns ?? [];
  const facts = options.facts ?? [];
  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === ACCOUNT_ID && where.userId === USER_ID
            ? { id: ACCOUNT_ID }
            : null,
      ),
    },
    soulTurn: {
      findMany: vi.fn(
        async ({ where, take }: { where: { chatId: bigint }; take: number }) =>
          turns
            .filter((row) => row.chatId === where.chatId)
            .slice(0, take),
      ),
    },
    soulSummary: {
      findUnique: vi.fn(
        async ({ where }: { where: { accountId_chatId: { chatId: bigint } } }) =>
          options.summary
            ? options.summary.chatId === where.accountId_chatId.chatId
              ? options.summary
              : null
            : null,
      ),
    },
    soulMemory: {
      findMany: vi.fn(
        async ({ where, take }: { where: { chatId: bigint }; take: number }) =>
          facts.filter((row) => row.chatId === where.chatId).slice(0, take),
      ),
    },
  };
  return { service: new AiChatMemoryService(prisma as never), prisma };
}

describe('AiChatMemoryService', () => {
  it('returns the short-term turns and long-term summary/facts', async () => {
    const { service } = harness({
      turns: [turn()],
      facts: [fact()],
      summary: summary(),
    });

    const view = await service.view(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(view.accountId).toBe(ACCOUNT_ID);
    expect(view.chatId).toBe(CHAT_ID);
    expect(view.shortTerm).toEqual([
      { role: 'user', content: 'привет', createdAt: NOW.toISOString() },
    ]);
    expect(view.longTerm.summary).toBe('Говорили о работе.');
    expect(view.longTerm.facts).toEqual([
      {
        kind: 'preference',
        content: 'любит кофе',
        importance: 3,
        createdAt: NOW.toISOString(),
      },
    ]);
  });

  it('returns an empty summary and no facts when nothing is stored', async () => {
    const { service } = harness();

    const view = await service.view(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(view.shortTerm).toEqual([]);
    expect(view.longTerm).toEqual({ summary: '', facts: [] });
  });

  it('passes the limit to the turn and fact queries', async () => {
    const { service, prisma } = harness();

    await service.view(USER_ID, ACCOUNT_ID, CHAT_ID, 5);

    expect(prisma.soulTurn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
    expect(prisma.soulMemory.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 5 }),
    );
  });

  it('clamps a huge limit to 200', async () => {
    const { service, prisma } = harness();

    await service.view(USER_ID, ACCOUNT_ID, CHAT_ID, 5000);

    expect(prisma.soulTurn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });

  it('rejects an account owned by another user', async () => {
    const { service, prisma } = harness();

    await expect(
      service.view(OTHER_USER, ACCOUNT_ID, CHAT_ID),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });
    expect(prisma.soulTurn.findMany).not.toHaveBeenCalled();
  });

  it('scopes by account as well as chat', async () => {
    const { service, prisma } = harness({
      turns: [turn(), turn({ id: 'turn-2', accountId: OTHER_ACCOUNT })],
      facts: [fact()],
      summary: summary(),
    });

    await service.view(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(prisma.soulTurn.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: ACCOUNT_ID, chatId: BigInt(CHAT_ID) },
      }),
    );
    expect(prisma.soulSummary.findUnique).toHaveBeenCalledWith({
      where: { accountId_chatId: { accountId: ACCOUNT_ID, chatId: BigInt(CHAT_ID) } },
    });
  });
});
