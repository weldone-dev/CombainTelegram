import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogsService } from './logs.service.js';

const ACCOUNT_ID = 'account-1';
const CHAT_ID = 1830539716;

function harness() {
  const prisma = {
    logEntry: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => []),
      create: vi.fn(),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    proxy: {
      findUnique: vi.fn(async () => null),
    },
  };
  const realtime = { emitToUser: vi.fn() };
  const service = new LogsService(prisma as never, realtime as never);
  return { service, prisma, realtime };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

describe('LogsService chat filters', () => {
  it('filters a log page by account and chat', async () => {
    const { service, prisma } = harness();
    cleanups.push(() => service.onModuleDestroy());

    await service.query({ accountId: ACCOUNT_ID, chatId: CHAT_ID });

    expect(prisma.logEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: ACCOUNT_ID, chatId: CHAT_ID },
      }),
    );
  });

  it('leaves the where clause empty without filters', async () => {
    const { service, prisma } = harness();
    cleanups.push(() => service.onModuleDestroy());

    await service.query();

    expect(prisma.logEntry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });

  it('passes the chat filters through to stats', async () => {
    const { service, prisma } = harness();
    cleanups.push(() => service.onModuleDestroy());

    await service.stats({ accountId: ACCOUNT_ID, chatId: CHAT_ID });

    const grouped = prisma.logEntry.groupBy.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(grouped.where).toEqual({ accountId: ACCOUNT_ID, chatId: CHAT_ID });
    expect(prisma.logEntry.count).toHaveBeenCalledWith({
      where: { accountId: ACCOUNT_ID, chatId: CHAT_ID },
    });
    expect(prisma.logEntry.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId: ACCOUNT_ID, chatId: CHAT_ID },
      }),
    );
  });

  it('combines a chat filter with a level and a search term', async () => {
    const { service, prisma } = harness();
    cleanups.push(() => service.onModuleDestroy());

    await service.exportJsonl({
      level: 'error',
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      q: 'FLOOD_WAIT',
    });

    const args = prisma.logEntry.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(args.where.level).toBe('error');
    expect(args.where.accountId).toBe(ACCOUNT_ID);
    expect(args.where.chatId).toBe(CHAT_ID);
    expect(args.where.OR).toEqual(
      expect.arrayContaining([{ message: { contains: 'FLOOD_WAIT' } }]),
    );
  });
});
