import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEveDryRunState, takeEveDryRunOutbound } from './eve-dry-run.js';
import {
  EveDelayedService,
  MAX_DELAYED_ATTEMPTS,
  MAX_TURN_DELAY_SEC,
  clampDelaySec,
  delayedDueAt,
} from './eve-delayed.service.js';

const PERSONA = 'persona-1';
const ACCOUNT = 'account-1';
const CHAT = 1000n;
const NOW = new Date('2026-11-27T10:00:00.000Z');

interface ActionRow {
  id: string;
  personaId: string;
  accountId: string;
  chatId: bigint;
  threadId: number;
  kind: string;
  reason: string;
  key: string | null;
  payload: string;
  dueAt: Date | null;
  state: string;
  attempts: number;
  lastError: string | null;
  firedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function actionRow(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    id: 'action-1',
    personaId: PERSONA,
    accountId: ACCOUNT,
    chatId: CHAT,
    threadId: 0,
    kind: 'react',
    reason: 'delay',
    key: null,
    payload: '{}',
    dueAt: NOW,
    state: 'pending',
    attempts: 0,
    lastError: null,
    firedAt: null,
    createdAt: new Date(NOW.getTime() - 60_000),
    updatedAt: NOW,
    ...overrides,
  };
}

interface HarnessOptions {
  due?: ActionRow[];
  waiting?: ActionRow[];
  existing?: ActionRow | null;
  linked?: boolean;
  allowed?: boolean;
  timezone?: string;
  sleepFrom?: number;
  sleepTo?: number;
  /** Pending `turn` rows that a new turn is about to supersede. */
  pending?: ActionRow[];
  /** `EveSessionState.lastHisMessageId` at dispatch time. */
  appliedMessageId?: number;
}

function harness(options: HarnessOptions = {}) {
  const calls: {
    create: Array<Record<string, unknown>>;
    update: Array<{ where: { id: string }; data: Record<string, unknown> }>;
  } = { create: [], update: [] };

  const prisma = {
    eveDelayedAction: {
      findMany: vi.fn(
        async ({ where }: { where: Record<string, unknown> }) => {
          if (where.dueAt === null) return options.waiting ?? [];
          // A supersede lookup asks for the pending turns of one chat.
          if (where.kind === 'turn' && where.state === 'pending') {
            return options.pending ?? [];
          }
          return options.due ?? [];
        },
      ),
      findFirst: vi.fn(async () => options.existing ?? null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        calls.create.push(data);
        return {
          ...actionRow(),
          ...data,
          id: 'action-new',
          createdAt: NOW,
          updatedAt: NOW,
        };
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          calls.update.push({ where, data });
          return { ...actionRow(), id: where.id, ...data };
        },
      ),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    evePersonaAccount: {
      findUnique: vi.fn(async () => ({ enabled: options.linked !== false })),
    },
    eveChatBinding: {
      findUnique: vi.fn(async () =>
        options.allowed === false ? null : { allowed: true },
      ),
    },
    evePersona: {
      findMany: vi.fn(async () => [
        {
          id: PERSONA,
          timezone: options.timezone ?? 'UTC',
          sleepFrom: options.sleepFrom ?? 23,
          sleepTo: options.sleepTo ?? 8,
        },
      ]),
    },
  };

  const messaging = {
    sendMessage: vi.fn(async () => ({ id: '1' })),
    editMessage: vi.fn(async () => ({ id: '1' })),
    deleteMessage: vi.fn(async () => ({ deleted: true })),
    sendReaction: vi.fn(async () => ({})),
    markRead: vi.fn(async () => ({ read: true })),
  };
  const users = { get: vi.fn(async () => ({ id: 'user-1' })) };
  const eve = {
    resolveWriteAddress: vi.fn(async () => ({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
    })),
  };
  const turns = {
    lastAppliedMessageId: vi.fn(async () => options.appliedMessageId ?? 0),
  };

  const service = new EveDelayedService(
    prisma as never,
    messaging as never,
    users as never,
    eve as never,
    turns as never,
  );
  return { service, prisma, messaging, users, eve, turns, calls };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubEnv('EVE_WEBHOOK_URL', 'http://eve.test/eve/v1/nest/events');
  vi.stubEnv('EVE_TURN_URL', 'http://eve.test/eve/v1/nest/turn');
  vi.stubEnv('EVE_TOKEN', 'secret');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('delay math', () => {
  it('caps a normal turn at one hour', () => {
    expect(clampDelaySec('turn', 14_400)).toBe(MAX_TURN_DELAY_SEC);
    expect(clampDelaySec('turn', -5)).toBe(0);
    expect(clampDelaySec('turn', 'abc')).toBe(0);
  });

  it('keeps 24 hours for non-turn actions', () => {
    expect(clampDelaySec('react', 90_000)).toBe(86_400);
  });

  it('parks a sleeping turn with no clock and releases everything else', () => {
    expect(delayedDueAt('turn', 'sleep', 0, NOW)).toBeNull();
    expect(delayedDueAt('turn', 'busy', 0, NOW)).toBeNull();
    expect(delayedDueAt('turn', 'delay', 0, NOW)).toEqual(NOW);
    expect(delayedDueAt('react', 'delay', 30, NOW)).toEqual(
      new Date(NOW.getTime() + 30_000),
    );
    // Only a turn waits for presence; an action still needs a clock.
    expect(delayedDueAt('react', 'busy', 0, NOW)).toEqual(NOW);
  });
});

describe('enqueue', () => {
  it('stores the row with a dueAt computed from delaySec', async () => {
    const { service, calls, eve } = harness();
    const view = await service.enqueue({
      kind: 'turn',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '1000',
      delaySec: 42,
      reason: 'delay',
      key: 'turn:evt-1',
      payload: { incoming: 'привет' },
    });

    expect(eve.resolveWriteAddress).toHaveBeenCalledTimes(1);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0]?.dueAt).toEqual(new Date(NOW.getTime() + 42_000));
    expect(calls.create[0]?.state).toBeUndefined(); // default comes from Prisma
    expect(view.id).toBe('action-new');
    expect(view.chatId).toBe('1000');
  });

  it('parks a sleeping turn until presence releases it', async () => {
    const { service, calls } = harness();
    await service.enqueue({
      kind: 'turn',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '1000',
      delaySec: 0,
      reason: 'sleep',
    });
    expect(calls.create[0]?.dueAt).toBeNull();
  });

  it('deduplicates a replayed event by key', async () => {
    const existing = actionRow({ id: 'action-existing' });
    const { service, calls } = harness({ existing });
    const view = await service.enqueue({
      kind: 'turn',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '1000',
      key: 'turn:evt-1',
    });
    expect(calls.create).toHaveLength(0);
    expect(view.id).toBe('action-existing');
  });

  it('a new deferred turn supersedes the older pending one', async () => {
    const { service, prisma } = harness();
    await service.enqueue({
      kind: 'turn',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '1000',
      delaySec: 600,
      reason: 'busy',
    });

    expect(prisma.eveDelayedAction.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        personaId: PERSONA,
        accountId: ACCOUNT,
        chatId: CHAT,
        kind: 'turn',
        state: 'pending',
      }),
      data: { state: 'dropped', lastError: 'superseded' },
    });
  });

  it('a reaction/read action does not cancel a queued reply', async () => {
    const { service, prisma } = harness();
    await service.enqueue({
      kind: 'react',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '1000',
      payload: { messageId: 5, emoji: '❤' },
    });
    expect(prisma.eveDelayedAction.updateMany).not.toHaveBeenCalled();
  });

  it('carries the texts of a superseded turn into the new payload', async () => {
    const pending = actionRow({
      id: 'action-old',
      kind: 'turn',
      payload: JSON.stringify({
        incoming: 'первое сообщение',
        messageId: 11,
        burst: [{ id: 11, text: 'первое сообщение' }],
      }),
    });
    const { service, calls, prisma } = harness({ pending: [pending] });

    await service.enqueue({
      kind: 'turn',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '1000',
      delaySec: 30,
      reason: 'delay',
      payload: {
        incoming: 'второе сообщение',
        messageId: 12,
        // The channel could not read the history: only the current message.
        burst: [{ id: 12, text: 'второе сообщение' }],
      },
    });

    expect(prisma.eveDelayedAction.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ kind: 'turn', state: 'pending' }),
      data: { state: 'dropped', lastError: 'superseded' },
    });
    const payload = JSON.parse(
      calls.create[0]?.payload as string,
    ) as Record<string, unknown>;
    expect(payload.burst).toEqual([
      { id: 11, text: 'первое сообщение' },
      { id: 12, text: 'второе сообщение' },
    ]);
    expect(payload.incoming).toBe('второе сообщение');
  });

  it('keeps one pending turn but merges the whole series into it', async () => {
    // Two deferred inbounds in a row: the second payload must answer both.
    const first = actionRow({
      id: 'action-a',
      kind: 'turn',
      payload: JSON.stringify({ incoming: 'а', messageId: 7 }),
    });
    const { service, calls } = harness({ pending: [first] });

    await service.enqueue({
      kind: 'turn',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '1000',
      delaySec: 10,
      reason: 'delay',
      payload: { incoming: 'б', messageId: 8 },
    });

    const payload = JSON.parse(
      calls.create[0]?.payload as string,
    ) as Record<string, unknown>;
    expect(payload.burst).toEqual([
      { id: 7, text: 'а' },
      { id: 8, text: 'б' },
    ]);
  });

  it('rejects an unknown kind before touching the address', async () => {
    const { service, eve } = harness();
    await expect(service.enqueue({ kind: 'explode' })).rejects.toThrow(
      /kind must be one of/,
    );
    expect(eve.resolveWriteAddress).not.toHaveBeenCalled();
  });
});

describe('tick: actions without a model', () => {
  it('sends a reaction straight through the transport', async () => {
    const row = actionRow({
      payload: JSON.stringify({ messageId: 5, emoji: '👍' }),
    });
    const { service, messaging, calls } = harness({ due: [row] });
    const result = await service.tick(NOW);

    expect(messaging.sendReaction).toHaveBeenCalledWith(
      'user-1',
      ACCOUNT,
      '1000',
      '5',
      { emoji: '👍' },
    );
    expect(result.sent).toBe(1);
    expect(calls.update.at(-1)?.data.state).toBe('sent');
  });

  it('edits a message by id', async () => {
    const row = actionRow({
      kind: 'edit',
      payload: JSON.stringify({ messageId: 7, text: 'новый текст' }),
    });
    const { service, messaging } = harness({ due: [row] });
    await service.tick(NOW);
    expect(messaging.editMessage).toHaveBeenCalledWith(
      'user-1',
      ACCOUNT,
      '1000',
      '7',
      { text: 'новый текст' },
    );
  });

  it('drops a message that left the allowlist', async () => {
    const row = actionRow({
      payload: JSON.stringify({ messageId: 5, emoji: '👍' }),
    });
    const { service, messaging, calls } = harness({
      due: [row],
      allowed: false,
    });
    const result = await service.tick(NOW);
    expect(messaging.sendReaction).not.toHaveBeenCalled();
    expect(result.dropped).toBe(1);
    expect(calls.update.at(-1)?.data.lastError).toBe('address-not-allowed');
  });

  it('drops a payload without a message id instead of retrying forever', async () => {
    const row = actionRow({ payload: '{}' });
    const { service, calls } = harness({ due: [row] });
    const result = await service.tick(NOW);
    expect(result.dropped).toBe(1);
    expect(calls.update.at(-1)?.data.lastError).toBe('missing-message-id');
  });

  it('retries a transport error and fails after the cap', async () => {
    const row = actionRow({
      payload: JSON.stringify({ messageId: 5 }),
      attempts: MAX_DELAYED_ATTEMPTS - 1,
    });
    const { service, messaging, calls } = harness({ due: [row] });
    messaging.sendReaction.mockRejectedValueOnce(new Error('flood wait'));

    const result = await service.tick(NOW);
    expect(result.failed).toBe(1);
    expect(calls.update.at(-1)?.data).toMatchObject({
      attempts: MAX_DELAYED_ATTEMPTS,
      state: 'failed',
      lastError: 'flood wait',
    });
  });
});

describe('tick: deferred turn', () => {
  it('posts the stored behavior to the Eve turn route', async () => {
    const row = actionRow({
      kind: 'turn',
      payload: JSON.stringify({
        incoming: 'как ты?',
        behavior: { intent: 'reply', bubbles: 1, typing: true },
        hint: 'она свободна',
        idempotencyKey: 'evt-1',
      }),
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const { service, calls } = harness({ due: [row] });
    const result = await service.tick(NOW);

    expect(result.sent).toBe(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { headers: Record<string, string>; body: string },
    ];
    expect(url).toBe('http://eve.test/eve/v1/nest/turn');
    expect(init.headers['x-eve-token']).toBe('secret');
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      actionId: 'action-1',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: '1000',
      incoming: 'как ты?',
      hint: 'она свободна',
      idempotencyKey: 'evt-1',
    });
    expect(calls.update.at(-1)?.data.state).toBe('sent');
  });

  it('sends the applied message id so the channel drops already answered texts', async () => {
    const row = actionRow({
      kind: 'turn',
      payload: JSON.stringify({
        incoming: 'первое',
        messageId: 11,
        burst: [
          { id: 11, text: 'первое' },
          { id: 12, text: 'второе' },
        ],
        behavior: { intent: 'reply', bubbles: 1 },
      }),
    });
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    const { service, turns } = harness({ due: [row], appliedMessageId: 11 });
    const result = await service.tick(NOW);

    expect(result.sent).toBe(1);
    expect(turns.lastAppliedMessageId).toHaveBeenCalledWith(
      PERSONA,
      ACCOUNT,
      '1000',
    );
    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    const body = JSON.parse(init.body) as Record<string, unknown>;
    // Read at dispatch time, not frozen into the payload at enqueue time.
    expect(body.lastHisMessageId).toBe(11);
    expect(body.burst).toEqual([
      { id: 11, text: 'первое' },
      { id: 12, text: 'второе' },
    ]);
  });

  it('keeps the row pending when Eve is down', async () => {
    const row = actionRow({ kind: 'turn', payload: '{"incoming":"привет"}' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502 })),
    );
    const { service, calls } = harness({ due: [row] });
    const result = await service.tick(NOW);

    expect(result.retried).toBe(1);
    expect(calls.update.at(-1)?.data).toMatchObject({
      attempts: 1,
      state: 'pending',
      lastError: 'HTTP 502',
    });
  });

  it('retries when the turn endpoint is disabled', async () => {
    vi.stubEnv('EVE_TURN_URL', '');
    const row = actionRow({ kind: 'turn', payload: '{"incoming":"привет"}' });
    const { service, calls } = harness({ due: [row] });
    await service.tick(NOW);
    expect(calls.update.at(-1)?.data.lastError).toBe('turn-endpoint-disabled');
  });
});

describe('tick: presence release', () => {
  it('makes a parked turn due once she is awake', async () => {
    const row = actionRow({ kind: 'turn', dueAt: null });
    const { service, calls } = harness({ waiting: [row] });
    const result = await service.tick(NOW);

    expect(result.released).toBe(1);
    expect(calls.update[0]?.data.dueAt).toEqual(NOW);
  });

  it('keeps it parked while she sleeps', async () => {
    const row = actionRow({ kind: 'turn', dueAt: null });
    const { service, calls } = harness({
      waiting: [row],
      sleepFrom: 0,
      sleepTo: 23,
    });
    const result = await service.tick(NOW);
    expect(result.released).toBe(0);
    expect(calls.update).toHaveLength(0);
  });

  it('drops a turn that waited longer than the busy cap', async () => {
    const row = actionRow({
      kind: 'turn',
      dueAt: null,
      createdAt: new Date(NOW.getTime() - 25 * 3_600_000),
    });
    const { service, calls } = harness({ waiting: [row] });
    await service.tick(NOW);
    expect(calls.update[0]?.data).toMatchObject({
      state: 'dropped',
      lastError: 'expired',
    });
  });
});

describe('list', () => {
  it('filters by persona and state', async () => {
    const { service, prisma } = harness({ due: [actionRow()] });
    const result = await service.list({
      personaId: PERSONA,
      state: 'pending',
      limit: '10',
    });
    expect(result.actions).toHaveLength(1);
    expect(prisma.eveDelayedAction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { personaId: PERSONA, state: 'pending' },
        take: 10,
      }),
    );
  });
});


describe('tick: dry-run', () => {
  it('suppresses a delayed send when its payload carries dryRun', async () => {
    resetEveDryRunState();
    const row = actionRow({
      kind: 'send',
      payload: JSON.stringify({ text: 'отложенное', dryRun: true }),
    });
    const { service, messaging, calls } = harness({ due: [row] });
    const result = await service.tick(NOW);

    expect(messaging.sendMessage).not.toHaveBeenCalled();
    expect(result.sent).toBe(1);
    expect(calls.update.at(-1)?.data.state).toBe('sent');
    expect(takeEveDryRunOutbound(ACCOUNT, CHAT, PERSONA)).toEqual([
      expect.objectContaining({ kind: 'send' }),
    ]);
  });

  it('suppresses a delayed reaction when its payload carries dryRun', async () => {
    resetEveDryRunState();
    const row = actionRow({
      payload: JSON.stringify({ messageId: 5, emoji: '❤', dryRun: true }),
    });
    const { service, messaging } = harness({ due: [row] });
    await service.tick(NOW);

    expect(messaging.sendReaction).not.toHaveBeenCalled();
    expect(takeEveDryRunOutbound(ACCOUNT, CHAT, PERSONA)).toEqual([
      expect.objectContaining({ kind: 'react' }),
    ]);
  });

  it('sends an old pending row without a flag live', async () => {
    resetEveDryRunState();
    const row = actionRow({
      kind: 'send',
      payload: JSON.stringify({ text: 'старое отложенное' }),
    });
    const { service, messaging } = harness({ due: [row] });
    await service.tick(NOW);

    expect(messaging.sendMessage).toHaveBeenCalledTimes(1);
    expect(takeEveDryRunOutbound(ACCOUNT, CHAT, PERSONA)).toEqual([]);
  });

  it('forwards dryRun from a delayed turn payload to /eve/v1/nest/turn', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const row = actionRow({
      kind: 'turn',
      payload: JSON.stringify({ incoming: 'привет', dryRun: true }),
    });
    const { service } = harness({ due: [row] });
    await service.tick(NOW);

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(JSON.parse(init.body)).toMatchObject({ dryRun: true });
  });

  it('dispatches an old pending turn left live (no flag)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 202 }));
    vi.stubGlobal('fetch', fetchMock);
    const row = actionRow({
      kind: 'turn',
      payload: JSON.stringify({ incoming: 'привет' }),
    });
    const { service } = harness({ due: [row] });
    await service.tick(NOW);

    const [, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(JSON.parse(init.body)).toMatchObject({ dryRun: false });
  });

  it('global EVE_DRY_RUN still suppresses a delayed action', async () => {
    vi.stubEnv('EVE_DRY_RUN', 'true');
    resetEveDryRunState();
    const row = actionRow({
      kind: 'send',
      payload: JSON.stringify({ text: 'kill switch' }),
    });
    const { service, messaging } = harness({ due: [row] });
    await service.tick(NOW);

    expect(messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('persists an explicit dryRun into the queued payload', async () => {
    const { service, calls } = harness();
    await service.enqueue({
      kind: 'send',
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      dryRun: true,
      payload: { text: 'позже' },
    });

    const payload = JSON.parse(String(calls.create[0]?.payload)) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({ text: 'позже', dryRun: true });
  });
});
