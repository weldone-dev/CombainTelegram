import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  EveTurnService,
  parseTurnInput,
  type EveTurnInput,
  type EveTurnMoodDelta,
} from './eve-turn.service.js';
import type { EveService } from './eve.service.js';

const PERSONA = 'persona-1';
const ACCOUNT = 'account-1';
const CHAT = 1830539716;
const NOW = new Date('2026-11-27T10:00:00.000Z');
const NOW_MS = NOW.getTime();
const HOUR_MS = 3_600_000;

interface HarnessOptions {
  stage?: string;
  score?: Partial<{
    interest: number;
    trust: number;
    attraction: number;
    annoyance: number;
    cringe: number;
  }>;
  conflict?: Partial<{
    level: number;
    coldUntil: Date | null;
    reason: string | null;
    history: string;
  }>;
  /** `EveSessionState.state` JSON; `null` means "no row yet". */
  state?: string | null;
}

function harness(options: HarnessOptions = {}) {
  const relationship = {
    id: 'rel-1',
    personaId: PERSONA,
    scopeKey: `account:${ACCOUNT}:chat:${CHAT}`,
    stage: options.stage ?? 'tg-given-warming',
    interest: 0,
    trust: 0,
    attraction: 0,
    annoyance: 0,
    cringe: 0,
    notes: '',
    createdAt: NOW,
    updatedAt: NOW,
    ...options.score,
  };
  const conflictRow = {
    id: 'conf-1',
    relationshipId: relationship.id,
    level: 0,
    coldUntil: null as Date | null,
    reason: null as string | null,
    history: '[]',
    createdAt: NOW,
    updatedAt: NOW,
    ...options.conflict,
  };

  // Mutable on purpose: `upsert` stores the new counters, so a second
  // `applyTurn` in the same test reads the state the first one wrote.
  let stateJson: string | null = options.state ?? null;

  const prisma = {
    evePersona: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === PERSONA ? { id: PERSONA, timezone: 'UTC' } : null,
      ),
    },
    eveRelationship: {
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({ ...relationship, ...data, id: where.id, updatedAt: NOW }),
      ),
    },
    eveRelationshipEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    eveConflict: {
      upsert: vi.fn(async () => conflictRow),
      findUnique: vi.fn(async () => conflictRow),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => ({ ...conflictRow, ...data, id: where.id, updatedAt: NOW }),
      ),
    },
    eveConflictEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
    },
    eveSessionState: {
      findUnique: vi.fn(async () =>
        stateJson === null ? null : { state: stateJson },
      ),
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          // A real row is read back by the next apply: keep the fake stateful,
          // otherwise an idempotency test would read the pre-turn counters.
          stateJson = String(update.state ?? create.state);
          return { ...create, ...update };
        },
      ),
    },
    eveSessionLog: {
      createMany: vi.fn(
        async ({ data }: { data: unknown[] }) => ({ count: data.length }),
      ),
    },
    eveAgendaItem: {
      updateMany: vi.fn(async () => ({ count: 2 })),
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => ({})),
    },
  };

  const eve = {
    scope: vi.fn(
      async (personaId: string, accountId: string, chatId: unknown) => ({
        personaId,
        accountId,
        chatId: BigInt(String(chatId)),
        threadId: 0,
        mode: 'isolated' as const,
        scopeKey: `account:${accountId}:chat:${String(chatId)}`,
      }),
    ),
    relationshipFor: vi.fn(async () => relationship),
    requireAllowed: vi.fn(async () => undefined),
  };

  const service = new EveTurnService(
    prisma as unknown as PrismaService,
    eve as unknown as EveService,
  );
  return { service, prisma, eve, relationship, conflictRow };
}

function turn(overrides: Partial<EveTurnInput> = {}): EveTurnInput {
  return {
    personaId: PERSONA,
    accountId: ACCOUNT,
    chatId: CHAT,
    threadId: 0,
    messageId: 101,
    text: 'привет, как ты?',
    reply: 'нормально, ты?)',
    now: NOW_MS,
    rand: () => 0,
    decision: {
      intent: 'reply',
      shouldReply: true,
      shouldRead: true,
      moodDelta: { interest: 2 },
      bubbles: 1,
    },
    ...overrides,
  };
}

function withMood(
  moodDelta: EveTurnMoodDelta,
  overrides: Partial<EveTurnInput> = {},
): EveTurnInput {
  return turn({
    ...overrides,
    decision: { ...turn().decision, moodDelta, ...overrides.decision },
  });
}

function stateWith(counters: Record<string, unknown>): string {
  return JSON.stringify(counters);
}

describe('EveTurnService mood', () => {
  it('clamps deltas to ±20 and scores to −100..100', async () => {
    const { service, prisma } = harness({
      score: { interest: 95, annoyance: 20 },
    });

    const result = await service.applyTurn(
      withMood({ interest: 50, annoyance: -50 }),
    );

    expect(prisma.eveRelationship.update).toHaveBeenCalledTimes(1);
    const data = prisma.eveRelationship.update.mock.calls[0]![0].data;
    expect(data).toMatchObject({ interest: 100, annoyance: 0 });
    expect(result.relationship.interest).toBe(100);
    expect(result.relationship.annoyance).toBe(0);
  });

  it('never drops a counter below −100', async () => {
    const { service, prisma } = harness({
      score: { trust: -95, cringe: -90 },
    });

    const result = await service.applyTurn(withMood({ trust: -20, cringe: -5 }));

    expect(result.relationship.trust).toBe(-100);
    expect(result.relationship.cringe).toBe(-95);
    expect(prisma.eveRelationship.update.mock.calls[0]![0].data).toMatchObject({
      trust: -100,
      cringe: -95,
    });
  });

  it('does not touch the relationship on an empty delta', async () => {
    const { service, prisma } = harness();

    const result = await service.applyTurn(withMood({}));

    expect(prisma.eveRelationship.update).not.toHaveBeenCalled();
    expect(result.relationship.interest).toBe(0);
  });
});

describe('EveTurnService conflict', () => {
  it('escalates to level 2 on trigger 20 and records an event', async () => {
    const { service, prisma } = harness();

    const result = await service.applyTurn(
      withMood({ annoyance: 10, cringe: 10 }),
    );

    expect(result.conflict.level).toBe(2);
    expect(result.conflict.coldUntil).toEqual(
      new Date(NOW_MS + 4 * HOUR_MS),
    );
    expect(prisma.eveConflictEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.eveConflictEvent.create.mock.calls[0]![0].data).toMatchObject({
      level: 2,
    });
    const history = JSON.parse(result.conflict.history) as unknown[];
    expect(history).toHaveLength(1);
  });

  it('jumps straight to level 3 on a strong negative message', async () => {
    const { service } = harness();

    const result = await service.applyTurn(
      withMood({ annoyance: 10, cringe: 10, interest: -10 }),
    );

    expect(result.conflict.level).toBe(3);
    expect(result.conflict.coldUntil).toEqual(
      new Date(NOW_MS + 24 * HOUR_MS),
    );
  });

  it('reconciles pending agenda only inside the current account/chat', async () => {
    const { service, prisma } = harness();

    await service.applyTurn(withMood({ annoyance: 10, cringe: 10 }));

    expect(prisma.eveAgendaItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          personaId: PERSONA,
          accountId: ACCOUNT,
          chatId: BigInt(CHAT),
          state: 'pending',
        }),
      }),
    );
  });

  it('softens one level and halves the cold period', async () => {
    const { service } = harness({
      conflict: {
        level: 3,
        coldUntil: new Date(NOW_MS + 4 * HOUR_MS),
        reason: 'обижена',
      },
    });

    const result = await service.applyTurn(
      withMood({ attraction: 5, trust: 5, interest: 5 }),
    );

    expect(result.conflict.level).toBe(2);
    expect(result.conflict.coldUntil).toEqual(
      new Date(NOW_MS + 2 * HOUR_MS),
    );
    expect(result.conflict.reason).toBe('обижена');
  });

  it('stays cold below the softening threshold', async () => {
    const { service, prisma } = harness({
      conflict: {
        level: 2,
        coldUntil: new Date(NOW_MS + 6 * HOUR_MS),
        reason: 'обижена',
      },
    });

    const result = await service.applyTurn(
      withMood({ attraction: 4, trust: 4, interest: 3 }),
    );

    expect(result.conflict.level).toBe(2);
    expect(prisma.eveConflict.update).not.toHaveBeenCalled();
  });
});

describe('EveTurnService auto-dump', () => {
  it('dumps the relationship and cancels pending agenda', async () => {
    const { service, prisma } = harness({
      stage: 'convinced',
      score: { annoyance: 75, interest: -35 },
      state: stateWith({
        hisMsgs: 3,
        herMsgs: 4,
        ignoresInStage: 1,
        msgsSinceStageCheck: 3,
      }),
    });

    const result = await service.applyTurn(
      turn({
        reply: null,
        decision: {
          intent: 'ignore',
          shouldReply: false,
          shouldRead: false,
          ignoreReason: 'dumped',
          moodDelta: { annoyance: 10 },
          bubbles: 1,
        },
      }),
    );

    expect(result.stage).toBe('dumped');
    expect(result.stageChanged).toMatchObject({
      from: 'convinced',
      to: 'dumped',
      direction: 'down',
    });
    expect(prisma.eveRelationship.update.mock.calls[0]![0].data).toMatchObject({
      stage: 'dumped',
      annoyance: 85,
    });
    expect(prisma.eveAgendaItem.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          personaId: PERSONA,
          accountId: ACCOUNT,
          chatId: BigInt(CHAT),
          state: 'pending',
        }),
        data: { state: 'cancelled' },
      }),
    );
    expect(prisma.eveRelationshipEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ kind: 'stage' }),
      }),
    );
    // A new stage starts with clean counters; the ignore of this turn is the
    // only thing counted after the reset.
    expect(result.counters).toMatchObject({
      hisMsgs: 0,
      msgsSinceStageCheck: 0,
      ignoresInStage: 1,
      stage: 'dumped',
    });
  });

  it('keeps the relationship when only one dump condition holds', async () => {
    const { service } = harness({
      score: { annoyance: 75, interest: 10 },
    });

    const result = await service.applyTurn(withMood({ annoyance: 10 }));

    expect(result.stage).not.toBe('dumped');
  });
});

describe('EveTurnService stage transitions', () => {
  it('upgrades one step on the fifth incoming message', async () => {
    const { service, prisma } = harness({
      stage: 'tg-given-warming',
      score: { interest: 45, trust: 30, attraction: 35 },
      state: stateWith({
        hisMsgs: 4,
        herMsgs: 6,
        ignoresInStage: 0,
        msgsSinceStageCheck: 4,
      }),
    });

    const result = await service.applyTurn(withMood({}));

    expect(result.stage).toBe('convinced');
    expect(result.stageChanged).toMatchObject({
      from: 'tg-given-warming',
      to: 'convinced',
      direction: 'up',
    });
    expect(prisma.eveRelationship.update.mock.calls[0]![0].data.stage).toBe(
      'convinced',
    );
    // Counters reset, then the reply of this turn is counted.
    expect(result.counters).toMatchObject({
      hisMsgs: 0,
      herMsgs: 1,
      ignoresInStage: 0,
      msgsSinceStageCheck: 0,
      stage: 'convinced',
    });
  });

  it('downgrades on D1 even with a conflict-free score', async () => {
    const { service } = harness({
      stage: 'tg-given-warming',
      score: { annoyance: 60, interest: -10, trust: 5 },
      state: stateWith({
        hisMsgs: 4,
        herMsgs: 8,
        ignoresInStage: 0,
        msgsSinceStageCheck: 4,
      }),
    });

    const result = await service.applyTurn(withMood({}));

    expect(result.stage).toBe('tg-given-cold');
    expect(result.stageChanged).toMatchObject({ direction: 'down' });
  });

  it('blocks an upgrade while a conflict is active', async () => {
    const { service } = harness({
      stage: 'tg-given-warming',
      score: { interest: 45, trust: 30, attraction: 35 },
      conflict: { level: 2, coldUntil: new Date(NOW_MS + HOUR_MS) },
      state: stateWith({
        hisMsgs: 4,
        herMsgs: 6,
        ignoresInStage: 0,
        msgsSinceStageCheck: 4,
      }),
    });

    const result = await service.applyTurn(withMood({}));

    expect(result.stage).toBe('tg-given-warming');
    expect(result.stageChanged).toBeUndefined();
  });

  it('does not check the stage before the fifth incoming message', async () => {
    const { service } = harness({
      stage: 'tg-given-warming',
      score: { interest: 45, trust: 30, attraction: 35 },
      state: stateWith({
        hisMsgs: 2,
        herMsgs: 6,
        ignoresInStage: 0,
        msgsSinceStageCheck: 2,
      }),
    });

    const result = await service.applyTurn(withMood({}));

    expect(result.stage).toBe('tg-given-warming');
    expect(result.counters.msgsSinceStageCheck).toBe(3);
  });
});

describe('EveTurnService counters and log', () => {
  it('counts an ignore and writes an ignored log line', async () => {
    const { service, prisma } = harness({
      state: stateWith({
        hisMsgs: 1,
        herMsgs: 2,
        ignoresInStage: 3,
        msgsSinceStageCheck: 1,
      }),
    });

    const result = await service.applyTurn(
      turn({
        reply: null,
        decision: {
          intent: 'ignore',
          shouldReply: false,
          shouldRead: true,
          ignoreReason: 'busy',
          moodDelta: {},
          bubbles: 1,
        },
      }),
    );

    expect(result.counters).toMatchObject({
      hisMsgs: 2,
      herMsgs: 2,
      ignoresInStage: 4,
      msgsSinceStageCheck: 2,
    });
    const lines = prisma.eveSessionLog.createMany.mock.calls[0]![0].data.map(
      (row) => (row as { line: string }).line,
    );
    expect(lines).toEqual([
      '[2026-11-27T10:00:00.000Z] он(101): привет, как ты?',
      '  -> ignored (busy)',
    ]);
  });

  it('appends the incoming and outgoing lines of a reply turn', async () => {
    const { service, prisma } = harness();

    await service.applyTurn(turn());

    const rows = prisma.eveSessionLog.createMany.mock.calls[0]![0].data as {
      line: string;
      day: string;
      chatId: bigint;
      personaId: string;
      accountId: string;
    }[];
    expect(rows.map((row) => row.line)).toEqual([
      '[2026-11-27T10:00:00.000Z] он(101): привет, как ты?',
      '  -> она: нормально, ты?)',
    ]);
    expect(rows[0]).toMatchObject({
      day: '2026-11-27',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: BigInt(CHAT),
    });
    expect(prisma.eveSessionState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          personaId_accountId_chatId: {
            personaId: PERSONA,
            accountId: ACCOUNT,
            chatId: BigInt(CHAT),
          },
        },
      }),
    );
  });

  it('falls back to the `user:` prefix without a message id', async () => {
    const { service, prisma } = harness();

    await service.applyTurn(turn({ messageId: null }));

    const lines = prisma.eveSessionLog.createMany.mock.calls[0]![0].data.map(
      (row) => (row as { line: string }).line,
    );
    expect(lines[0]).toBe('[2026-11-27T10:00:00.000Z] user: привет, как ты?');
  });

  it('counts and logs every message of a burst once', async () => {
    const { service, prisma } = harness({
      state: stateWith({
        hisMsgs: 4,
        herMsgs: 5,
        ignoresInStage: 0,
        msgsSinceStageCheck: 4,
        lastHisMessageId: 10,
      }),
    });

    const result = await service.applyTurn(
      turn({
        messageId: 12,
        messageIds: [11, 12],
        messages: [
          { id: 11, text: 'первое' },
          { id: 12, text: 'второе' },
        ],
        decision: {
          intent: 'reply',
          shouldReply: true,
          shouldRead: true,
          moodDelta: { interest: 2 },
          bubbles: 1,
        },
      }),
    );

    expect(result.counters).toMatchObject({
      hisMsgs: 6,
      msgsSinceStageCheck: 6,
      lastHisMessageId: 12,
    });
    // Mood is applied once per turn, not once per message.
    expect(result.relationship.interest).toBe(2);
    const lines = prisma.eveSessionLog.createMany.mock.calls[0]![0].data.map(
      (row) => (row as { line: string }).line,
    );
    expect(lines).toEqual([
      '[2026-11-27T10:00:00.000Z] он(11): первое',
      '[2026-11-27T10:00:00.000Z] он(12): второе',
      '  -> она: нормально, ты?)',
    ]);
  });

  it('does not count a message that a previous turn already applied', async () => {
    const { service, prisma } = harness({
      state: stateWith({
        hisMsgs: 1,
        herMsgs: 1,
        ignoresInStage: 1,
        msgsSinceStageCheck: 1,
        // The ignored message already moved the counters.
        lastHisMessageId: 11,
      }),
    });

    const result = await service.applyTurn(
      turn({
        messageId: 12,
        messageIds: [11, 12],
        messages: [
          { id: 11, text: 'проигнорированное' },
          { id: 12, text: 'новое' },
        ],
      }),
    );

    expect(result.counters).toMatchObject({
      hisMsgs: 2,
      msgsSinceStageCheck: 2,
      lastHisMessageId: 12,
    });
    const lines = prisma.eveSessionLog.createMany.mock.calls[0]![0].data.map(
      (row) => (row as { line: string }).line,
    );
    expect(lines).toEqual([
      '[2026-11-27T10:00:00.000Z] он(12): новое',
      '  -> она: нормально, ты?)',
    ]);
  });

  it('runs the stage check when a burst jumps over the fifth message', async () => {
    const { service, prisma } = harness({
      stage: 'tg-given-warming',
      score: { interest: 50, trust: 30, attraction: 40 },
      state: stateWith({
        hisMsgs: 9,
        herMsgs: 9,
        ignoresInStage: 0,
        msgsSinceStageCheck: 4,
        lastHisMessageId: 20,
      }),
    });

    const result = await service.applyTurn(
      turn({
        messageId: 22,
        messageIds: [21, 22],
        messages: [
          { id: 21, text: 'раз' },
          { id: 22, text: 'два' },
        ],
      }),
    );

    // 4 + 2 crosses the 5-message boundary even though it never equals 5.
    expect(result.stage).toBe('convinced');
    expect(prisma.eveRelationship.update).toHaveBeenCalled();
  });

  it('a replay of the same series changes nothing', async () => {
    const { service, prisma } = harness({
      score: { interest: 40 },
      state: stateWith({
        hisMsgs: 1,
        herMsgs: 1,
        ignoresInStage: 0,
        msgsSinceStageCheck: 1,
        lastHisMessageId: 10,
      }),
    });
    const series = turn({
      messageId: 12,
      messageIds: [11, 12],
      messages: [
        { id: 11, text: 'первое' },
        { id: 12, text: 'второе' },
      ],
    });

    const first = await service.applyTurn(series);
    expect(first.counters).toMatchObject({ hisMsgs: 3, lastHisMessageId: 12 });
    expect(first.counters.herMsgs).toBe(2);
    expect(prisma.eveRelationship.update).toHaveBeenCalledTimes(1);
    expect(prisma.eveSessionLog.createMany).toHaveBeenCalledTimes(1);
    const lines = prisma.eveSessionLog.createMany.mock.calls[0]![0].data.map(
      (row) => (row as { line: string }).line,
    );
    expect(lines).toEqual([
      '[2026-11-27T10:00:00.000Z] он(11): первое',
      '[2026-11-27T10:00:00.000Z] он(12): второе',
      '  -> она: нормально, ты?)',
    ]);

    // Eve hands the same turn to `turn/apply` twice: nothing may move.
    const replay = await service.applyTurn(series);
    expect(replay.replayed).toBe(true);
    expect(replay.counters).toEqual(first.counters);
    expect(prisma.eveRelationship.update).toHaveBeenCalledTimes(1);
    expect(prisma.eveConflict.update).not.toHaveBeenCalled();
    expect(prisma.eveConflictEvent.create).not.toHaveBeenCalled();
    expect(prisma.eveRelationshipEvent.create).not.toHaveBeenCalled();
    expect(prisma.eveSessionLog.createMany).toHaveBeenCalledTimes(1);
  });

  it('applies a series that carries one new id after a replay', async () => {
    const { service, prisma } = harness({
      score: { interest: 40 },
      state: stateWith({
        hisMsgs: 0,
        herMsgs: 0,
        ignoresInStage: 0,
        msgsSinceStageCheck: 0,
        lastHisMessageId: 10,
      }),
    });
    await service.applyTurn(
      turn({
        messageId: 12,
        messageIds: [11, 12],
        messages: [
          { id: 11, text: 'первое' },
          { id: 12, text: 'второе' },
        ],
      }),
    );

    const next = await service.applyTurn(
      turn({
        messageId: 13,
        messageIds: [11, 12, 13],
        messages: [
          { id: 11, text: 'первое' },
          { id: 12, text: 'второе' },
          { id: 13, text: 'третье' },
        ],
      }),
    );

    expect(next.replayed).toBeUndefined();
    expect(next.counters).toMatchObject({ hisMsgs: 3, lastHisMessageId: 13 });
    expect(next.counters.herMsgs).toBe(2);
    expect(prisma.eveRelationship.update).toHaveBeenCalledTimes(2);
    const last = prisma.eveSessionLog.createMany.mock.calls[1]![0].data.map(
      (row) => (row as { line: string }).line,
    );
    // Only the fresh id is logged: 11 and 12 were applied by the first call.
    expect(last).toEqual([
      '[2026-11-27T10:00:00.000Z] он(13): третье',
      '  -> она: нормально, ты?)',
    ]);
  });

  it('counts a late reply once after an ignore applied its series', async () => {
    const { service, prisma } = harness();

    // Turn A is already generating when B arrives. The deterministic ignore
    // applies the whole unanswered series [A, B].
    const ignored = await service.applyTurn(
      turn({
        messageId: 102,
        messageIds: [101, 102],
        messages: [
          { id: 101, text: 'первое' },
          { id: 102, text: 'второе' },
        ],
        reply: null,
        turnKey: 'inbound:event-b',
        decision: {
          intent: 'ignore',
          shouldReply: false,
          shouldRead: true,
          moodDelta: {},
          bubbles: 1,
          ignoreReason: 'left-on-read',
        },
      }),
    );
    expect(ignored.counters).toMatchObject({
      hisMsgs: 2,
      herMsgs: 0,
      ignoresInStage: 1,
      lastHisMessageId: 102,
    });
    expect(
      prisma.eveSessionLog.createMany.mock.calls[0]![0].data.map(
        (row) => (row as { line: string }).line,
      ),
    ).toEqual([
      '[2026-11-27T10:00:00.000Z] он(101): первое',
      '[2026-11-27T10:00:00.000Z] он(102): второе',
      '  -> ignored (left-on-read)',
    ]);

    // A finishes after that. Its series is already counted, but its own
    // outcome was never written: herMsgs and `-> она` must appear exactly once.
    const late = await service.applyTurn(
      turn({
        messageId: 101,
        messageIds: [101],
        messages: [{ id: 101, text: 'первое' }],
        reply: 'ответ на первое',
        turnKey: 'deferred:action-a',
      }),
    );
    expect(late.replayed).toBeUndefined();
    expect(late.counters).toMatchObject({
      hisMsgs: 2,
      herMsgs: 1,
      ignoresInStage: 1,
      lastHisMessageId: 102,
      lastAppliedTurnKey: 'deferred:action-a',
    });
    expect(
      prisma.eveSessionLog.createMany.mock.calls[1]![0].data.map(
        (row) => (row as { line: string }).line,
      ),
    ).toEqual(['  -> она: ответ на первое']);

    // A retried writeback of the same turn changes nothing.
    const retry = await service.applyTurn(
      turn({
        messageId: 101,
        messageIds: [101],
        messages: [{ id: 101, text: 'первое' }],
        reply: 'ответ на первое',
        turnKey: 'deferred:action-a',
      }),
    );
    expect(retry.replayed).toBe(true);
    expect(retry.counters).toEqual(late.counters);
    expect(prisma.eveSessionLog.createMany).toHaveBeenCalledTimes(2);
  });

  it('counts a reaction-only turn as an ignore, once', async () => {
    const { service, prisma } = harness();
    const reactionOnly = turn({
      messageId: 77,
      messageIds: [77],
      messages: [{ id: 77, text: 'просто смайлик' }],
      reply: null,
      turnKey: 'inbound:event-react',
      decision: {
        intent: 'reaction-only',
        shouldReply: false,
        shouldRead: true,
        moodDelta: {},
        bubbles: 1,
        reaction: '❤',
        ignoreReason: 'reaction-only',
      },
    });

    const first = await service.applyTurn(reactionOnly);
    expect(first.counters).toMatchObject({
      hisMsgs: 1,
      herMsgs: 0,
      ignoresInStage: 1,
      lastHisMessageId: 77,
    });
    expect(
      prisma.eveSessionLog.createMany.mock.calls[0]![0].data.map(
        (row) => (row as { line: string }).line,
      ),
    ).toEqual([
      '[2026-11-27T10:00:00.000Z] он(77): просто смайлик',
      '  -> ignored (reaction-only)',
    ]);

    // Eve may hand the same turn to `turn/apply` twice.
    const retry = await service.applyTurn(reactionOnly);
    expect(retry.replayed).toBe(true);
    expect(retry.counters).toEqual(first.counters);
    expect(prisma.eveSessionLog.createMany).toHaveBeenCalledTimes(1);
  });

  it('writes the counters as JSON for the chat', async () => {    const { service, prisma } = harness({
      state: stateWith({
        hisMsgs: 3,
        herMsgs: 5,
        ignoresInStage: 2,
        msgsSinceStageCheck: 3,
      }),
    });

    const result = await service.applyTurn(withMood({}));

    const upsert = prisma.eveSessionState.upsert.mock.calls[0]![0];
    expect(JSON.parse(upsert.update.state as string)).toEqual({
      hisMsgs: 4,
      herMsgs: 6,
      ignoresInStage: 2,
      msgsSinceStageCheck: 4,
      lastHisMessageId: 101,
      stage: 'tg-given-warming',
    });
    expect(result.counters.stage).toBe('tg-given-warming');
  });
});

describe('EveTurnService getState', () => {
  it('reports the applied message id without writing anything', async () => {
    const { service, prisma } = harness({
      state: stateWith({ hisMsgs: 4, lastHisMessageId: 42 }),
    });

    expect(
      await service.lastAppliedMessageId(PERSONA, ACCOUNT, String(CHAT)),
    ).toBe(42);
    expect(prisma.eveSessionState.upsert).not.toHaveBeenCalled();
    expect(prisma.eveConflict.upsert).not.toHaveBeenCalled();
    expect(prisma.eveRelationship.update).not.toHaveBeenCalled();
  });

  it('returns the stored counters and the relationship stage', async () => {
    const { service } = harness({
      stage: 'convinced',
      score: { interest: 51, trust: 36 },
      state: stateWith({
        hisMsgs: 7,
        herMsgs: 9,
        ignoresInStage: 1,
        msgsSinceStageCheck: 2,
        stage: 'tg-given-warming',
      }),
    });

    const state = await service.getState(PERSONA, ACCOUNT, String(CHAT));

    expect(state.stage).toBe('convinced');
    expect(state.relationship.interest).toBe(51);
    expect(state.counters).toEqual({
      hisMsgs: 7,
      herMsgs: 9,
      ignoresInStage: 1,
      msgsSinceStageCheck: 2,
      lastHisMessageId: 0,
      stage: 'convinced',
    });
  });

  it('rejects an unknown persona with a 404 shape', async () => {
    const { service } = harness();

    await expect(
      service.getState('missing', ACCOUNT, String(CHAT)),
    ).rejects.toThrow('Eve persona not found');
  });
});

describe('parseTurnInput', () => {
  it('reads a nested decision and clamps the mood delta', () => {
    const input = parseTurnInput({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: String(CHAT),
      threadId: '2',
      messageId: 55,
      text: 'ты где?',
      decision: {
        intent: 'left-on-read',
        shouldReply: false,
        shouldRead: false,
        ignoreReason: 'busy',
        moodDelta: { annoyance: 40, interest: -3 },
        bubbles: 9,
        reaction: '👍',
      },
    });

    expect(input).toMatchObject({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: BigInt(CHAT),
      threadId: 2,
      messageId: 55,
      text: 'ты где?',
      decision: {
        intent: 'left-on-read',
        shouldReply: false,
        shouldRead: false,
        ignoreReason: 'busy',
        bubbles: 6,
        reaction: '👍',
      },
    });
    expect(input.decision.moodDelta).toEqual({ annoyance: 20, interest: -3 });
  });

  it('accepts a flattened body and defaults a missing decision', () => {
    const input = parseTurnInput({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      moodDelta: { interest: 3 },
    });

    expect(input.decision).toMatchObject({
      intent: 'reply',
      shouldReply: true,
      shouldRead: true,
      moodDelta: { interest: 3 },
    });
    expect(input.messageId).toBeNull();
  });

  it('rejects a missing persona and a non-numeric chat id', () => {
    expect(() =>
      parseTurnInput({ accountId: ACCOUNT, chatId: CHAT }),
    ).toThrow();
    expect(() =>
      parseTurnInput({ personaId: PERSONA, accountId: ACCOUNT, chatId: 'x' }),
    ).toThrow();
  });
});


describe('EveTurnService dry-run log', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('marks the outgoing session log line', async () => {
    vi.stubEnv('EVE_DRY_RUN', 'true');
    const { service, prisma } = harness();

    await service.applyTurn(turn());

    const lines = prisma.eveSessionLog.createMany.mock.calls[0]![0].data.map(
      (row) => (row as { line: string }).line,
    );
    expect(lines).toEqual([
      '[2026-11-27T10:00:00.000Z] он(101): привет, как ты?',
      '  -> она (dry-run): нормально, ты?)',
    ]);
  });
});
