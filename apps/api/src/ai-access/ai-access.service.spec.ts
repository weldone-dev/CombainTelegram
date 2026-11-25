import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AiChatAccessModel,
  AiChatBlockModel,
  AiChatEventModel,
} from '@repo/database';
import { AiAccessService } from './ai-access.service.js';
import { AiChatEventsService } from './ai-chat-events.service.js';

const USER_ID = 'local';
const OTHER_USER = 'someone-else';
const ACCOUNT_ID = 'account-1';
const SOUL_ID = 'soul-1';
const CHAT_ID = 1830539716;
const TOPIC_ID = 42;
const NOW = new Date('2026-11-24T10:00:00.000Z');

function mapKey(accountId: string, chatId: bigint, threadId: number): string {
  return `${accountId}:${chatId.toString()}:${threadId}`;
}

interface AccessUpsertArgs {
  where: {
    accountId_chatId_threadId: {
      accountId: string;
      chatId: bigint;
      threadId: number;
    };
  };
  create: {
    userId: string;
    accountId: string;
    chatId: bigint;
    threadId: number;
    enabled?: boolean;
    soulId?: string | null;
    note?: string | null;
  };
  update: Record<string, unknown>;
}

interface BlockUpsertArgs {
  where: {
    accountId_chatId_threadId: {
      accountId: string;
      chatId: bigint;
      threadId: number;
    };
  };
  create: {
    userId: string;
    accountId: string;
    chatId: bigint;
    threadId: number;
    reason?: string | null;
    warnings?: number;
    blockedBy?: string;
  };
  update: Record<string, unknown>;
}

function harness() {
  const accesses = new Map<string, AiChatAccessModel>();
  const blocks = new Map<string, AiChatBlockModel>();
  const events: AiChatEventModel[] = [];
  let sequence = 0;
  const nextId = (prefix: string): string => `${prefix}-${++sequence}`;

  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === ACCOUNT_ID && where.userId === USER_ID
            ? { id: ACCOUNT_ID }
            : null,
      ),
      findUnique: vi.fn(async () => ({ userId: USER_ID })),
    },
    soul: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; accountId: string } }) =>
          where.id === SOUL_ID && where.accountId === ACCOUNT_ID
            ? { id: SOUL_ID }
            : null,
      ),
    },
    aiChatAccess: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { accountId_chatId_threadId: { accountId: string; chatId: bigint; threadId: number } };
        }) => {
          const key = where.accountId_chatId_threadId;
          return accesses.get(mapKey(key.accountId, key.chatId, key.threadId)) ?? null;
        },
      ),
      upsert: vi.fn(async ({ where, create, update }: AccessUpsertArgs) => {
        const key = where.accountId_chatId_threadId;
        const mapKeyValue = mapKey(key.accountId, key.chatId, key.threadId);
        const existing = accesses.get(mapKeyValue);
        if (existing) {
          const row = {
            ...existing,
            ...update,
            updatedAt: NOW,
          } as AiChatAccessModel;
          accesses.set(mapKeyValue, row);
          return row;
        }
        const row: AiChatAccessModel = {
          id: nextId('access'),
          userId: create.userId,
          accountId: create.accountId,
          chatId: create.chatId,
          threadId: create.threadId,
          soulId: create.soulId ?? null,
          enabled: create.enabled ?? true,
          note: create.note ?? null,
          createdAt: NOW,
          updatedAt: NOW,
        };
        accesses.set(mapKeyValue, row);
        return row;
      }),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { accountId: string; chatId: bigint; threadId: number };
        }) => {
          const removed = accesses.delete(
            mapKey(where.accountId, where.chatId, where.threadId),
          );
          return { count: removed ? 1 : 0 };
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { accountId: string; userId: string };
        }) =>
          [...accesses.values()].filter(
            (row) =>
              row.accountId === where.accountId && row.userId === where.userId,
          ),
      ),
    },
    aiChatBlock: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { accountId_chatId_threadId: { accountId: string; chatId: bigint; threadId: number } };
        }) => {
          const key = where.accountId_chatId_threadId;
          return blocks.get(mapKey(key.accountId, key.chatId, key.threadId)) ?? null;
        },
      ),
      upsert: vi.fn(async ({ where, create, update }: BlockUpsertArgs) => {
        const key = where.accountId_chatId_threadId;
        const mapKeyValue = mapKey(key.accountId, key.chatId, key.threadId);
        const existing = blocks.get(mapKeyValue);
        if (existing) {
          const row = { ...existing, ...update, updatedAt: NOW } as AiChatBlockModel;
          blocks.set(mapKeyValue, row);
          return row;
        }
        const row: AiChatBlockModel = {
          id: nextId('block'),
          userId: create.userId,
          accountId: create.accountId,
          chatId: create.chatId,
          threadId: create.threadId,
          reason: create.reason ?? null,
          warnings: create.warnings ?? 0,
          blockedBy: create.blockedBy ?? 'user',
          createdAt: NOW,
          updatedAt: NOW,
        };
        blocks.set(mapKeyValue, row);
        return row;
      }),
      create: vi.fn(
        async ({
          data,
        }: {
          data: BlockUpsertArgs['create'];
        }): Promise<AiChatBlockModel> => {
          const row: AiChatBlockModel = {
            id: nextId('block'),
            userId: data.userId,
            accountId: data.accountId,
            chatId: data.chatId,
            threadId: data.threadId,
            reason: data.reason ?? null,
            warnings: data.warnings ?? 0,
            blockedBy: data.blockedBy ?? 'user',
            createdAt: NOW,
            updatedAt: NOW,
          };
          blocks.set(mapKey(row.accountId, row.chatId, row.threadId), row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const entry = [...blocks.entries()].find(
            ([, row]) => row.id === where.id,
          );
          if (!entry) return null;
          const [key, row] = entry;
          const next = { ...row, ...data, updatedAt: NOW } as AiChatBlockModel;
          blocks.set(key, next);
          return next;
        },
      ),
      deleteMany: vi.fn(
        async ({
          where,
        }: {
          where: { accountId: string; chatId: bigint; threadId: number };
        }) => {
          const removed = blocks.delete(
            mapKey(where.accountId, where.chatId, where.threadId),
          );
          return { count: removed ? 1 : 0 };
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { accountId: string; userId: string };
        }) =>
          [...blocks.values()].filter(
            (row) =>
              row.accountId === where.accountId && row.userId === where.userId,
          ),
      ),
    },
    aiChatEvent: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            accountId: string;
            chatId: bigint;
            threadId?: number;
            kind: string;
            reason?: string | null;
            warnings?: number;
            actor?: string;
          };
        }): Promise<AiChatEventModel> => {
          const row: AiChatEventModel = {
            id: nextId('event'),
            accountId: data.accountId,
            chatId: data.chatId,
            threadId: data.threadId ?? 0,
            kind: data.kind,
            reason: data.reason ?? null,
            warnings: data.warnings ?? 0,
            actor: data.actor ?? 'user',
            createdAt: NOW,
          };
          events.push(row);
          return row;
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { accountId: string; chatId: bigint; threadId: number };
        }) =>
          events
            .filter(
              (row) =>
                row.accountId === where.accountId &&
                row.chatId === where.chatId &&
                row.threadId === where.threadId,
            )
            // All fixture rows share `NOW`; newest-first = last inserted.
            .reverse(),
      ),
    },
  };

  const eventsService = new AiChatEventsService(
    prisma as never,
    { emitToUser: vi.fn() } as never,
  );
  const service = new AiAccessService(prisma as never, eventsService);
  return { service, eventsService, prisma, accesses, blocks, events };
}

function accessRow(
  overrides: Partial<AiChatAccessModel> = {},
): AiChatAccessModel {
  return {
    id: 'access-seed',
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    chatId: BigInt(CHAT_ID),
    threadId: 0,
    soulId: null,
    enabled: true,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function blockRow(overrides: Partial<AiChatBlockModel> = {}): AiChatBlockModel {
  return {
    id: 'block-seed',
    userId: USER_ID,
    accountId: ACCOUNT_ID,
    chatId: BigInt(CHAT_ID),
    threadId: 0,
    reason: 'spam',
    warnings: 0,
    blockedBy: 'user',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  delete process.env.AI_BLOCK_AFTER_WARNINGS;
});

describe('AiAccessService.accessFor', () => {
  it('lets an enabled access row through', async () => {
    const { service, accesses } = harness();
    accesses.set(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0), accessRow());

    const decision = await service.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(decision.allowed).toBe(true);
    expect(decision.access?.enabled).toBe(true);
    expect(decision.block).toBeNull();
  });

  it('denies a chat with no access row', async () => {
    const { service } = harness();

    const decision = await service.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(decision.allowed).toBe(false);
    expect(decision.access).toBeNull();
  });

  it('lets a block win over an enabled access row', async () => {
    const { service, accesses, blocks } = harness();
    accesses.set(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0), accessRow());
    blocks.set(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0), blockRow());

    const decision = await service.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(decision.allowed).toBe(false);
    expect(decision.block?.reason).toBe('spam');
    expect(decision.access?.enabled).toBe(true);
  });

  it('applies a whole-chat block to a thread and prefers the thread row', async () => {
    const { service, accesses, blocks } = harness();
    accesses.set(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0), accessRow());
    accesses.set(
      mapKey(ACCOUNT_ID, BigInt(CHAT_ID), TOPIC_ID),
      accessRow({ id: 'access-topic', threadId: TOPIC_ID, enabled: false }),
    );
    blocks.set(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0), blockRow());

    const topic = await service.accessFor(
      USER_ID,
      ACCOUNT_ID,
      CHAT_ID,
      TOPIC_ID,
    );
    expect(topic.allowed).toBe(false);
    expect(topic.block?.threadId).toBe(0);
    expect(topic.access?.threadId).toBe(TOPIC_ID);

    // A thread-level block only closes that topic.
    const { service: second, accesses: access2, blocks: block2 } = harness();
    access2.set(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0), accessRow());
    block2.set(
      mapKey(ACCOUNT_ID, BigInt(CHAT_ID), TOPIC_ID),
      blockRow({ id: 'block-topic', threadId: TOPIC_ID }),
    );
    expect(
      (await second.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID, TOPIC_ID)).allowed,
    ).toBe(false);
    expect((await second.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID)).allowed).toBe(
      true,
    );
  });
});

describe('AiAccessService.setAccess', () => {
  it('upserts access by (accountId, chatId, threadId)', async () => {
    const { service, prisma, accesses } = harness();

    await service.setAccess({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      threadId: TOPIC_ID,
      soulId: SOUL_ID,
      note: 'only work questions',
    });
    await service.setAccess({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      threadId: TOPIC_ID,
      enabled: false,
    });

    expect(accesses.size).toBe(1);
    const row = accesses.get(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), TOPIC_ID));
    expect(row?.enabled).toBe(false);
    expect(row?.soulId).toBe(SOUL_ID);
    expect(row?.threadId).toBe(TOPIC_ID);

    const calls = prisma.aiChatAccess.upsert.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0].where.accountId_chatId_threadId).toEqual({
      accountId: ACCOUNT_ID,
      chatId: BigInt(CHAT_ID),
      threadId: TOPIC_ID,
    });
  });

  it('rejects a soul that belongs to another account', async () => {
    const { service, prisma } = harness();

    await expect(
      service.setAccess({
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        chatId: CHAT_ID,
        soulId: 'foreign-soul',
      }),
    ).rejects.toMatchObject({ response: { code: 'SOUL_NOT_FOUND' } });
    expect(prisma.aiChatAccess.upsert).not.toHaveBeenCalled();
  });
});

describe('AiAccessService warnings', () => {
  it('escalates warnings into a block at AI_BLOCK_AFTER_WARNINGS', async () => {
    process.env.AI_BLOCK_AFTER_WARNINGS = '2';
    const { service } = harness();

    const first = await service.bumpWarning({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
    });
    expect(first).toEqual({ warnings: 1, blocked: false });
    // A warning counter is not a block; access still follows the access row.
    expect(
      (await service.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID)).block,
    ).toBeNull();

    const second = await service.bumpWarning({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      reason: 'insulted the user',
    });
    expect(second).toEqual({ warnings: 2, blocked: true });

    const decision = await service.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID);
    expect(decision.allowed).toBe(false);
    expect(decision.block?.reason).toBe('insulted the user');
    expect(decision.block?.warnings).toBe(2);
  });

  it('does not count warnings once the chat is blocked', async () => {
    process.env.AI_BLOCK_AFTER_WARNINGS = '1';
    const { service } = harness();

    expect(
      await service.bumpWarning({
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        chatId: CHAT_ID,
      }),
    ).toEqual({ warnings: 1, blocked: true });

    expect(
      await service.bumpWarning({
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        chatId: CHAT_ID,
      }),
    ).toEqual({ warnings: 1, blocked: true });
  });

  it('unblock resets the warning counter', async () => {
    process.env.AI_BLOCK_AFTER_WARNINGS = '2';
    const { service, blocks } = harness();

    await service.bumpWarning({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
    });
    await service.bumpWarning({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
    });
    expect(blocks.size).toBe(1);

    const unblocked = await service.unblock(USER_ID, ACCOUNT_ID, CHAT_ID);
    expect(unblocked).toEqual({ removed: true, warnings: 0, blocked: false });
    expect(blocks.size).toBe(0);

    expect(
      await service.bumpWarning({
        userId: USER_ID,
        accountId: ACCOUNT_ID,
        chatId: CHAT_ID,
      }),
    ).toEqual({ warnings: 1, blocked: false });
    expect(
      (await service.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID)).block,
    ).toBeNull();
  });
});

describe('AiAccessService ownership', () => {
  it('rejects an account owned by another user on every read/write', async () => {
    const { service, prisma } = harness();

    await expect(
      service.accessFor(OTHER_USER, ACCOUNT_ID, CHAT_ID),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });
    await expect(service.list(OTHER_USER, ACCOUNT_ID)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_NOT_FOUND' },
    });
    await expect(
      service.setAccess({
        userId: OTHER_USER,
        accountId: ACCOUNT_ID,
        chatId: CHAT_ID,
      }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });
    await expect(
      service.block({
        userId: OTHER_USER,
        accountId: ACCOUNT_ID,
        chatId: CHAT_ID,
      }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });

    expect(prisma.aiChatAccess.upsert).not.toHaveBeenCalled();
    expect(prisma.aiChatBlock.upsert).not.toHaveBeenCalled();
  });
});

describe('AiAccessService.list', () => {
  it('returns accesses and only active blocks', async () => {
    const { service, accesses, blocks } = harness();
    accesses.set(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0), accessRow());
    blocks.set(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0), blockRow());
    blocks.set(
      mapKey(ACCOUNT_ID, BigInt(CHAT_ID + 1), 0),
      blockRow({
        id: 'block-warning',
        chatId: BigInt(CHAT_ID + 1),
        warnings: 2,
        blockedBy: 'warning',
        reason: null,
      }),
    );

    const result = await service.list(USER_ID, ACCOUNT_ID);

    expect(result.accesses).toHaveLength(1);
    expect(result.accesses[0]?.chatId).toBe(CHAT_ID);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.id).toBe('block-seed');
    expect(result.blocks[0]?.chatId).toBe(CHAT_ID);
  });
});

describe('AiAccessService event recording', () => {
  it('records an explicit block with its reason, counter and actor', async () => {
    const { service, events } = harness();

    await service.block({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      reason: 'spam',
      blockedBy: 'soul',
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'block',
      reason: 'spam',
      warnings: 0,
      actor: 'soul',
      chatId: BigInt(CHAT_ID),
      threadId: 0,
    });
  });

  it('records a warning and a second block event on escalation', async () => {
    process.env.AI_BLOCK_AFTER_WARNINGS = '2';
    const { service, events } = harness();

    await service.bumpWarning({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      reason: 'first',
      blockedBy: 'soul',
    });
    expect(events.map((event) => event.kind)).toEqual(['warning']);
    expect(events[0]).toMatchObject({ warnings: 1, actor: 'soul', reason: 'first' });

    await service.bumpWarning({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      reason: 'second',
      blockedBy: 'soul',
    });
    expect(events.map((event) => event.kind)).toEqual([
      'warning',
      'warning',
      'block',
    ]);
    expect(events[2]).toMatchObject({
      kind: 'block',
      warnings: 2,
      reason: 'second',
      actor: 'soul',
    });
  });

  it('records unblock with the lifted reason and a zero counter', async () => {
    const { service, events } = harness();
    await service.block({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      reason: 'spam',
    });

    await service.unblock(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(events.map((event) => event.kind)).toEqual(['block', 'unblock']);
    expect(events[1]).toMatchObject({ reason: 'spam', warnings: 0, actor: 'user' });
  });

  it('records access changes and removals', async () => {
    const { service, events } = harness();

    await service.setAccess({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      enabled: false,
      note: 'work only',
    });
    await service.removeAccess(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(events.map((event) => event.kind)).toEqual(['access', 'access']);
    expect(events[0]).toMatchObject({ reason: 'work only', actor: 'user' });
    expect(events[1]).toMatchObject({ reason: 'removed' });
  });

  it('clears the counter without unblocking an existing block', async () => {
    process.env.AI_BLOCK_AFTER_WARNINGS = '1';
    const { service, eventsService, events, blocks } = harness();
    await service.bumpWarning({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      reason: 'insult',
    });
    expect(
      (await service.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID)).block,
    ).not.toBeNull();

    const cleared = await eventsService.clearWarnings(
      USER_ID,
      ACCOUNT_ID,
      CHAT_ID,
    );

    expect(cleared).toEqual({ removed: true, warnings: 0, blocked: true });
    expect(blocks.get(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0))?.warnings).toBe(0);
    // The row is still a real block, so access stays denied after the clear.
    expect(
      (await service.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID)).block,
    ).not.toBeNull();
    expect(events.at(-1)).toMatchObject({
      kind: 'clear',
      warnings: 0,
      actor: 'user',
    });
  });

  it('clears a warning-only counter without creating a block', async () => {
    process.env.AI_BLOCK_AFTER_WARNINGS = '3';
    const { service, eventsService, blocks } = harness();
    await service.bumpWarning({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
    });

    const cleared = await eventsService.clearWarnings(
      USER_ID,
      ACCOUNT_ID,
      CHAT_ID,
    );

    expect(cleared).toEqual({ removed: true, warnings: 0, blocked: false });
    expect(blocks.get(mapKey(ACCOUNT_ID, BigInt(CHAT_ID), 0))?.warnings).toBe(0);
    expect(
      (await service.accessFor(USER_ID, ACCOUNT_ID, CHAT_ID)).block,
    ).toBeNull();
  });

  it('lists the events of a chat newest first', async () => {
    const { service, eventsService } = harness();
    await service.block({
      userId: USER_ID,
      accountId: ACCOUNT_ID,
      chatId: CHAT_ID,
      reason: 'spam',
    });
    await service.unblock(USER_ID, ACCOUNT_ID, CHAT_ID);

    const list = await eventsService.list(USER_ID, ACCOUNT_ID, CHAT_ID);

    expect(list.map((event) => event.kind)).toEqual(['unblock', 'block']);
    expect(list[0]).toMatchObject({
      chatId: CHAT_ID,
      accountId: ACCOUNT_ID,
      kind: 'unblock',
    });
  });
});
