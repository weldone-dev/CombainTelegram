import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { resetEveDryRunState } from './eve-dry-run.js';
import { EveContextService } from './eve-context.service.js';

const NOW = new Date('2026-11-27T10:00:00.000Z');
const PERSONA = 'persona-1';
const ACCOUNT = 'account-1';
const CHAT = 1830539716n;

interface Row {
  id: string;
  personaId: string;
  accountId: string;
  chatId: bigint;
  threadId: number;
  kind: string;
  model: string;
  turnId: string | null;
  tokensJson: string;
  systemJson: string;
  messagesJson: string;
  metaJson: string;
  dryRun: boolean;
  createdAt: Date;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    id: 'snap-1',
    personaId: PERSONA,
    accountId: ACCOUNT,
    chatId: CHAT,
    threadId: 0,
    kind: 'inbound',
    model: 'combain/deepseek-v4.1-flash',
    turnId: 'session-1:turn_0',
    tokensJson: '{"input":10,"output":2,"total":12}',
    systemJson: JSON.stringify([{ name: 'Персона', text: '# Персона\nАня' }]),
    messagesJson: JSON.stringify([
      { role: 'user', kind: 'incoming', text: 'привет' },
    ]),
    metaJson: '{"sessionId":"session-1"}',
    dryRun: false,
    createdAt: NOW,
    ...overrides,
  };
}

function harness() {
  const prisma = {
    eveContextSnapshot: {
      findFirst: vi.fn(async () => null as Row | null),
      findMany: vi.fn(async () => [] as Row[]),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) =>
        row({
          ...(data as Partial<Row>),
          id: 'snap-new',
          createdAt: NOW,
        }),
      ),
      findUnique: vi.fn(async () => row() as Row | null),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
  };
  const service = new EveContextService(prisma as unknown as PrismaService);
  return { service, prisma };
}

afterEach(() => {
  vi.unstubAllEnvs();
  resetEveDryRunState();
});

describe('EveContextService.ingest', () => {
  it('computes chars on the server and keeps the contract shape', async () => {
    const { service } = harness();
    const result = await service.ingest({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: String(CHAT),
      threadId: 0,
      kind: 'inbound',
      model: 'combain/deepseek-v4.1-flash',
      turnId: 'session-1:turn_0',
      tokens: { input: 10, output: 2, total: 12 },
      system: [{ name: 'Персона', text: '# Персона\nАня' }],
      messages: [
        { role: 'user', kind: 'incoming', text: 'привет' },
        { role: 'bogus', text: 'drop me' },
        { role: 'assistant', text: '' },
      ],
      meta: { sessionId: 'session-1' },
    });

    expect(result.duplicate).toBe(false);
    expect(result.snapshot.chatId).toBe(String(CHAT));
    expect(result.snapshot.system[0]).toMatchObject({
      name: 'Персона',
      chars: 13,
    });
    expect(result.snapshot.messages).toHaveLength(1);
    expect(result.snapshot.messages[0]).toMatchObject({
      role: 'user',
      kind: 'incoming',
      chars: 6,
    });
    expect(result.snapshot.tokens).toEqual({ input: 10, output: 2, total: 12 });
  });

  it('is idempotent by turnId and does not write a duplicate', async () => {
    const { service, prisma } = harness();
    prisma.eveContextSnapshot.findFirst.mockResolvedValueOnce(row());

    const result = await service.ingest({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: String(CHAT),
      turnId: 'session-1:turn_0',
    });

    expect(result.duplicate).toBe(true);
    expect(result.snapshot.id).toBe('snap-1');
    expect(prisma.eveContextSnapshot.create).not.toHaveBeenCalled();
  });

  it('marks a snapshot with the dryRun flag of its turn', async () => {
    const { service } = harness();

    const result = await service.ingest({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: String(CHAT),
      turnId: 'session-1:turn_1',
      dryRun: true,
    });

    expect(result.snapshot.dryRun).toBe(true);
    expect(result.snapshot.meta?.dryRun).toBe(true);
  });

  it('does not mark a live turn as dry-run', async () => {
    const { service } = harness();

    const result = await service.ingest({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: String(CHAT),
      turnId: 'session-1:turn_2',
    });

    expect(result.snapshot.dryRun).toBe(false);
  });

  it('a global kill-switch marks every snapshot as dry-run', async () => {
    vi.stubEnv('EVE_DRY_RUN', 'true');
    const { service } = harness();

    const result = await service.ingest({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: String(CHAT),
      turnId: 'session-1:turn_3',
    });

    expect(result.snapshot.dryRun).toBe(true);
    expect(result.snapshot.meta?.dryRun).toBe(true);
  });

  it('prunes older snapshots after the write', async () => {
    const { service, prisma } = harness();
    prisma.eveContextSnapshot.findMany.mockImplementation(
      async (args: { skip?: number }) => {
        if (args?.skip === 50) return [{ id: 'old-1' }, { id: 'old-2' }];
        return [];
      },
    );

    await service.ingest({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: String(CHAT),
      turnId: 'session-1:turn_2',
    });

    await vi.waitFor(() => {
      expect(prisma.eveContextSnapshot.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['old-1', 'old-2'] } },
      });
    });
  });
});

describe('EveContextService reads', () => {
  it('lists newest first with a capped limit and a string chatId', async () => {
    const { service, prisma } = harness();
    prisma.eveContextSnapshot.findMany.mockResolvedValueOnce([row()]);

    const snapshots = await service.list({
      personaId: PERSONA,
      chatId: String(CHAT),
      limit: '1000',
    });

    expect(snapshots[0]).toMatchObject({
      id: 'snap-1',
      chatId: String(CHAT),
      createdAt: NOW.toISOString(),
      model: 'combain/deepseek-v4.1-flash',
    });
    expect(prisma.eveContextSnapshot.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { personaId: PERSONA, chatId: CHAT },
        take: 100,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  });

  it('returns the single snapshot', async () => {
    const { service } = harness();
    const snapshot = await service.get('snap-1');
    expect(snapshot.id).toBe('snap-1');
    expect(snapshot.messages[0]?.chars).toBe(6);
  });
});
