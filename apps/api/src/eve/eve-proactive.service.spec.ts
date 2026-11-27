import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTONOMOUS_HORIZON_MS,
  AUTONOMOUS_MIN_GAP_MS,
  DEFAULT_EVE_PROACTIVE_URL,
  EveProactiveService,
  createRng,
  eveProactiveUrl,
  generateDailyLife,
  hashSeed,
  localDateKey,
  maxAutonomousItems,
  parseLlmDailyLife,
} from './eve-proactive.service.js';

const PERSONA = 'persona-1';
const ACCOUNT = 'account-1';
const CHAT = 1830539716n;
const NOW = new Date('2026-11-27T10:00:00.000Z');

interface PersonaRow {
  id: string;
  name: string;
  age: number;
  timezone: string;
  stage: string;
  sleepFrom: number;
  sleepTo: number;
  nightWakeChance: number;
  ignoreTendency: number;
  communication: string;
  vibe: string | null;
  nationality: string;
  mode: string;
}

interface AgendaRow {
  id: string;
  personaId: string;
  accountId: string;
  chatId: bigint;
  about: string;
  reason: string;
  kind: string;
  state: string;
  importance: number;
  pingAt: Date;
  attempts: number;
  history: string;
  createdAt: Date;
  updatedAt: Date;
}

interface HarnessOptions {
  persona?: Partial<PersonaRow> | null;
  due?: AgendaRow | null;
  bindingEnabled?: boolean;
  chatAllowed?: boolean;
  recentLog?: boolean;
  pendingSoon?: number;
  markerExists?: boolean;
  chats?: Array<{ accountId: string; chatId: bigint }>;
  configured?: boolean;
  reply?: string | null;
  chatError?: Error;
}

const BASE_PERSONA: PersonaRow = {
  id: PERSONA,
  name: 'Ника',
  age: 23,
  timezone: 'UTC',
  stage: 'convinced',
  sleepFrom: 23,
  sleepTo: 8,
  nightWakeChance: 0.05,
  ignoreTendency: 35,
  communication: '{}',
  vibe: null,
  nationality: 'RU',
  mode: 'auto',
};

function dueItem(overrides: Partial<AgendaRow> = {}): AgendaRow {
  return {
    id: 'agenda-1',
    personaId: PERSONA,
    accountId: ACCOUNT,
    chatId: CHAT,
    about: 'спросить, как прошёл день',
    reason: 'самой захотелось написать',
    kind: 'proactive-life',
    state: 'pending',
    importance: 2,
    pingAt: new Date(NOW.getTime() - 60_000),
    attempts: 0,
    history: '[]',
    createdAt: new Date(NOW.getTime() - 3_600_000),
    updatedAt: NOW,
    ...overrides,
  };
}

function harness(options: HarnessOptions = {}) {
  const persona =
    options.persona === null
      ? null
      : { ...BASE_PERSONA, ...options.persona };
  const state = {
    agenda: [] as Array<Record<string, unknown>>,
    markers: new Set<string>(),
    daily: null as Record<string, unknown> | null,
    updates: [] as Array<{ where: { id: string }; data: Record<string, unknown> }>,
  };
  if (options.markerExists) {
    state.markers.add(`${PERSONA}:${localDateKey(NOW.getTime(), 'UTC')}`);
  }

  const prisma = {
    evePersona: {
      findUnique: vi.fn(async () => persona),
      findMany: vi.fn(async () => (persona ? [{ id: PERSONA }] : [])),
    },
    evePersonaAccount: {
      findUnique: vi.fn(async () =>
        options.bindingEnabled === false
          ? { enabled: false }
          : { enabled: true },
      ),
      findMany: vi.fn(async () =>
        options.bindingEnabled === false ? [] : [{ accountId: ACCOUNT }],
      ),
    },
    eveChatBinding: {
      findUnique: vi.fn(async () =>
        options.chatAllowed === false ? null : { allowed: true },
      ),
      findMany: vi.fn(async () =>
        options.chatAllowed === false
          ? []
          : (options.chats ?? [{ accountId: ACCOUNT, chatId: CHAT }]),
      ),
    },
    eveSessionLog: {
      findFirst: vi.fn(async () =>
        options.recentLog ? { id: 'log-1' } : null,
      ),
    },
    eveAgendaItem: {
      findFirst: vi.fn(
        async () => (options.due === undefined ? dueItem() : options.due),
      ),
      count: vi.fn(async () => options.pendingSoon ?? 0),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        state.agenda.push(data);
        return { id: `agenda-${state.agenda.length}`, ...data };
      }),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          state.updates.push({ where, data });
          return { id: where.id, ...data };
        },
      ),
    },
    eveProactiveState: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { personaId_date_marker: { personaId: string; date: string } };
        }) =>
          state.markers.has(
            `${where.personaId_date_marker.personaId}:${where.personaId_date_marker.date}`,
          )
            ? { id: 'marker-1' }
            : null,
      ),
      upsert: vi.fn(
        async ({
          where,
        }: {
          where: { personaId_date_marker: { personaId: string; date: string } };
        }) => {
          state.markers.add(
            `${where.personaId_date_marker.personaId}:${where.personaId_date_marker.date}`,
          );
          return { id: 'marker-1' };
        },
      ),
    },
    eveDailyLife: {
      findUnique: vi.fn(async () =>
        state.daily
          ? { id: 'day-1', ...state.daily }
          : null,
      ),
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: Record<string, unknown>;
        }) => {
          state.daily = create;
          return { id: 'day-1', ...create };
        },
      ),
    },
  };

  const llm = {
    isConfigured: vi.fn(() => options.configured ?? false),
    chat: vi.fn(async () => {
      if (options.chatError) throw options.chatError;
      return options.reply ?? null;
    }),
  };

  const service = new EveProactiveService(prisma as never, llm as never);
  return { service, prisma, state, llm };
}

interface LlmDayOverrides {
  weather?: unknown;
  vibe?: unknown;
  blocks?: unknown;
  events?: unknown;
  wants?: unknown;
}

function llmDayObject(overrides: LlmDayOverrides = {}): Record<string, unknown> {
  return {
    weather: 'дождь',
    vibe: 'суетливый день',
    blocks: [
      {
        fromHour: 20,
        toHour: 23,
        activity: 'сериал дома',
        mood: 'спокойно',
        social: 'alone',
        phoneAvailable: true,
      },
      {
        fromHour: 8,
        toHour: 12,
        activity: 'пары',
        mood: 'сонно',
        social: 'with-coworkers',
        phoneAvailable: false,
      },
      {
        fromHour: 12,
        toHour: 15,
        activity: 'кофе с подругой',
        social: 'with-friends',
        phoneAvailable: true,
      },
      {
        fromHour: 15,
        toHour: 20,
        activity: 'дорога домой',
        social: 'in-transit',
        phoneAvailable: true,
      },
    ],
    events: ['зачёт через неделю', 'нашла кафе рядом'],
    wants: ['поспать', 'кофе'],
    ...overrides,
  };
}

function llmDay(overrides: LlmDayOverrides = {}): string {
  return JSON.stringify(llmDayObject(overrides));
}

function stubFetch(status = 200) {
  const mock = vi.fn(async () =>
    new Response(status === 202 ? '' : '{}', { status }),
  );
  vi.stubGlobal('fetch', mock);
  return mock;
}

beforeEach(() => {
  delete process.env.EVE_PROACTIVE_URL;
  delete process.env.EVE_WEBHOOK_URL;
  delete process.env.EVE_ENABLED;
  delete process.env.EVE_TOKEN;
  process.env.EVE_ENABLED = 'true';
});

afterEach(() => {
  delete process.env.EVE_PROACTIVE_URL;
  delete process.env.EVE_WEBHOOK_URL;
  delete process.env.EVE_ENABLED;
  delete process.env.EVE_TOKEN;
  vi.unstubAllGlobals();
});

describe('eveProactiveUrl', () => {
  it('derives the sibling of EVE_WEBHOOK_URL', () => {
    process.env.EVE_WEBHOOK_URL = 'http://127.0.0.1:4020/eve/v1/nest/events';
    expect(eveProactiveUrl()).toBe(
      'http://127.0.0.1:4020/eve/v1/nest/proactive',
    );
  });

  it('uses the local default when only EVE_ENABLED is set', () => {
    expect(eveProactiveUrl()).toBe(DEFAULT_EVE_PROACTIVE_URL);
  });

  it('treats an explicit empty EVE_PROACTIVE_URL as disabled', () => {
    process.env.EVE_PROACTIVE_URL = '';
    expect(eveProactiveUrl()).toBeNull();
  });
});

describe('EveProactiveService tick', () => {
  it('fires the earliest due item and marks it fired with attempts+1', async () => {
    const { service, prisma, state } = harness();
    const fetchMock = stubFetch(202);

    const result = await service.tick(NOW);

    expect(result).toMatchObject({ fired: true, reason: 'fired', itemId: 'agenda-1' });
    expect(prisma.eveAgendaItem.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { state: 'pending', pingAt: { lte: NOW } },
        orderBy: [{ pingAt: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { body: string },
    ];
    expect(url).toBe(DEFAULT_EVE_PROACTIVE_URL);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT.toString(),
      threadId: 0,
      id: 'agenda-1',
      about: 'спросить, как прошёл день',
    });
    expect(body.item).toMatchObject({
      id: 'agenda-1',
      about: 'спросить, как прошёл день',
      state: 'pending',
    });
    expect(state.updates.at(-1)?.data).toMatchObject({
      state: 'fired',
      attempts: { increment: 1 },
    });
  });

  it('returns no-due when nothing is pending', async () => {
    const { service } = harness({ due: null });
    const fetchMock = stubFetch();

    const result = await service.tick(NOW);

    expect(result).toEqual({ fired: false, reason: 'no-due' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('cancels an item whose chat is not on the allowlist', async () => {
    const { service, state } = harness({ chatAllowed: false });
    const fetchMock = stubFetch();

    const result = await service.tick(NOW);

    expect(result.reason).toBe('chat-not-allowed');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.updates.at(-1)?.data).toMatchObject({ state: 'cancelled' });
  });

  it('cancels an item whose persona/account binding is disabled', async () => {
    const { service, state } = harness({ bindingEnabled: false });
    const fetchMock = stubFetch();

    const result = await service.tick(NOW);

    expect(result.reason).toBe('not-bound');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.updates.at(-1)?.data).toMatchObject({ state: 'cancelled' });
  });

  it('waits when a session-log reply happened within 10 minutes', async () => {
    const { service, state } = harness({ recentLog: true });
    const fetchMock = stubFetch();

    const result = await service.tick(NOW);

    expect(result.reason).toBe('dialog-cooldown');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.updates).toHaveLength(0);
  });

  it('leaves the item pending when the Eve push fails', async () => {
    const { service, state } = harness();
    stubFetch(500);

    const result = await service.tick(NOW);

    expect(result).toMatchObject({ fired: false, reason: 'push-failed', status: 500 });
    expect(state.updates).toHaveLength(0);
  });

  it('is disabled when Eve has no proactive URL', async () => {
    process.env.EVE_PROACTIVE_URL = '';
    const { service, prisma } = harness();
    const fetchMock = stubFetch();

    const result = await service.tick(NOW);

    expect(result).toEqual({ fired: false, reason: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.eveAgendaItem.findFirst).not.toHaveBeenCalled();
  });
});

describe('autonomous limit table', () => {
  it('matches TEXTBOOK §8 base values with the initiative shift', () => {
    expect(maxAutonomousItems('tg-given-cold', 'medium')).toBe(0);
    expect(maxAutonomousItems('met-irl-got-tg', 'low')).toBe(0);
    expect(maxAutonomousItems('met-irl-got-tg', 'high')).toBe(2);
    expect(maxAutonomousItems('tg-given-warming', 'medium')).toBe(1);
    expect(maxAutonomousItems('convinced', 'medium')).toBe(2);
    expect(maxAutonomousItems('first-date-done', 'medium')).toBe(2);
    expect(maxAutonomousItems('dating-early', 'medium')).toBe(3);
    expect(maxAutonomousItems('dating-stable', 'medium')).toBe(4);
    expect(maxAutonomousItems('dating-stable', 'high')).toBe(5);
    expect(maxAutonomousItems('long-term', 'low')).toBe(3);
    expect(maxAutonomousItems('dumped', 'high')).toBe(0);
  });
});

describe('EveProactiveService ensureAutonomous', () => {
  it('creates up to the stage limit within 18 h with 45 min spacing', async () => {
    const { service, state } = harness({
      persona: { communication: JSON.stringify({ initiative: 'high' }) },
    });

    const result = await service.ensureAutonomous(PERSONA, NOW);

    expect(result).toMatchObject({
      limit: 3,
      generated: 3,
      reason: 'generated',
    });
    expect(state.agenda).toHaveLength(3);
    const times = state.agenda.map((row) =>
      ((row.pingAt as Date).getTime()),
    );
    for (const at of times) {
      expect(at).toBeGreaterThan(NOW.getTime());
      expect(at).toBeLessThanOrEqual(NOW.getTime() + AUTONOMOUS_HORIZON_MS);
    }
    for (let index = 1; index < times.length; index++) {
      expect(times[index]! - times[index - 1]!).toBeGreaterThanOrEqual(
        AUTONOMOUS_MIN_GAP_MS,
      );
    }
    expect(state.agenda[0]).toMatchObject({
      personaId: PERSONA,
      accountId: ACCOUNT,
      chatId: CHAT,
      kind: 'proactive-life',
      state: 'pending',
    });
    expect(JSON.parse(state.agenda[0]!.history as string)).toEqual([
      `autonomous:${localDateKey(NOW.getTime(), 'UTC')}`,
    ]);
    expect(prismaMarker(state)).toBe(true);
  });

  it('is idempotent for one local day', async () => {
    const { service } = harness();
    const first = await service.ensureAutonomous(PERSONA, NOW);
    const second = await service.ensureAutonomous(PERSONA, NOW);

    expect(first.generated).toBeGreaterThan(0);
    expect(second).toEqual({
      personaId: PERSONA,
      date: '2026-11-27',
      limit: 0,
      generated: 0,
      reason: 'already-generated',
    });
  });

  it('records the marker even when the stage allows no pings', async () => {
    const { service, state } = harness({
      persona: { stage: 'dumped' },
    });

    const result = await service.ensureAutonomous(PERSONA, NOW);

    expect(result).toMatchObject({ limit: 0, generated: 0, reason: 'dumped' });
    expect(state.agenda).toHaveLength(0);
    expect(prismaMarker(state)).toBe(true);
  });

  it('subtracts pings already pending inside the horizon', async () => {
    const { service, state } = harness({ pendingSoon: 2 });

    const result = await service.ensureAutonomous(PERSONA, NOW);

    expect(result).toMatchObject({ limit: 2, generated: 0, reason: 'limit' });
    expect(state.agenda).toHaveLength(0);
  });

  it('does not mark the day when there is no allowed chat yet', async () => {
    const { service, state } = harness({ chats: [] });

    const result = await service.ensureAutonomous(PERSONA, NOW);

    expect(result).toMatchObject({ generated: 0, reason: 'no-chat' });
    expect(prismaMarker(state)).toBe(false);
  });
});

describe('daily life', () => {
  it('generates 6–9 blocks deterministically', () => {
    const first = generateDailyLife({
      personaId: PERSONA,
      dateLocal: '2026-11-27',
      sleepFrom: 23,
      sleepTo: 8,
      communication: { lifeSharing: 'medium' },
    });
    const second = generateDailyLife({
      personaId: PERSONA,
      dateLocal: '2026-11-27',
      sleepFrom: 23,
      sleepTo: 8,
      communication: { lifeSharing: 'medium' },
    });

    expect(second).toEqual(first);
    expect(first.blocks.length).toBeGreaterThanOrEqual(6);
    expect(first.blocks.length).toBeLessThanOrEqual(9);
    expect(first.blocks[0]?.fromHour).toBe(8);
    expect(first.blocks.at(-1)?.toHour).toBe(23);
    expect(first.blocks.some((block) => !block.phoneAvailable)).toBe(true);
    expect(first.events.length).toBeGreaterThanOrEqual(2);
    expect(first.wants.length).toBeGreaterThanOrEqual(2);
  });

  it('differs for another persona or date', () => {
    const base = {
      dateLocal: '2026-11-27',
      sleepFrom: 23,
      sleepTo: 8,
    };
    const first = generateDailyLife({ ...base, personaId: PERSONA });
    const otherPersona = generateDailyLife({ ...base, personaId: 'persona-2' });
    const otherDate = generateDailyLife({
      ...base,
      personaId: PERSONA,
      dateLocal: '2026-11-28',
    });

    expect(otherPersona).not.toEqual(first);
    expect(otherDate).not.toEqual(first);
  });

  it('stores the day once and reuses the cache', async () => {
    const { service, prisma } = harness();

    const first = await service.dailyLife(PERSONA, '2026-11-27', NOW);
    const second = await service.dailyLife(PERSONA, '2026-11-27', NOW);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.day).toEqual(first.day);
    expect(prisma.eveDailyLife.upsert).toHaveBeenCalledTimes(1);
  });

  it('uses the LLM day plan when it is configured and valid', async () => {
    const { service, state, llm } = harness({
      configured: true,
      reply: llmDay(),
    });

    const result = await service.dailyLife(PERSONA, '2026-11-27', NOW);

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(result.created).toBe(true);
    expect(result.day.weather).toBe('дождь');
    expect(result.day.vibe).toBe('суетливый день');
    expect(result.day.blocks).toHaveLength(4);
    expect(result.day.blocks[0]).toMatchObject({
      fromHour: 8,
      activity: 'пары',
      social: 'with-coworkers',
      phoneAvailable: false,
    });
    expect(state.daily?.json).toContain('дождь');
    expect(state.daily?.markdown).toContain('пары');
  });

  it('keeps the LLM day after the first generation', async () => {
    const { service } = harness({ configured: true, reply: llmDay() });

    const first = await service.dailyLife(PERSONA, '2026-11-27', NOW);
    const second = await service.dailyLife(PERSONA, '2026-11-27', NOW);

    expect(second.created).toBe(false);
    expect(second.day).toEqual(first.day);
  });

  it('falls back to the deterministic day when the provider returns null', async () => {
    const { service, llm } = harness({ configured: true, reply: null });

    const result = await service.dailyLife(PERSONA, '2026-11-27', NOW);
    const expected = generateDailyLife({
      personaId: PERSONA,
      dateLocal: '2026-11-27',
      sleepFrom: 23,
      sleepTo: 8,
      vibe: null,
      communication: {},
    });

    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(result.day).toEqual(expected);
  });

  it('falls back to the deterministic day on invalid JSON', async () => {
    const { service } = harness({
      configured: true,
      reply: 'сегодня будет хороший день',
    });

    const result = await service.dailyLife(PERSONA, '2026-11-27', NOW);

    expect(result.day.blocks.length).toBeGreaterThanOrEqual(6);
    expect(result.day.weather).not.toBe('дождь');
  });

  it('is stable on the fallback for the same persona and date', async () => {
    const { service } = harness({ configured: true, reply: null });

    const first = await service.dailyLife(PERSONA, '2026-11-27', NOW);
    const second = await service.dailyLife(PERSONA, '2026-11-27', NOW);

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.day).toEqual(first.day);
  });

  it('sends a persona-aware JSON prompt with LLM sampling options', async () => {
    const { service, llm } = harness({ configured: true, reply: llmDay() });
    await service.dailyLife(PERSONA, '2026-11-27', NOW);

    const [messages, options] = llm.chat.mock.calls[0] as unknown as [
      Array<{ role: string; content: string }>,
      { temperature: number; maxTokens: number; json: boolean },
    ];
    const prompt = messages.map((message) => message.content).join('\n');

    expect(prompt).toContain('Ника');
    expect(prompt).toContain('23');
    expect(prompt).toContain('Россия');
    expect(prompt).toContain('2026-11-27');
    expect(prompt).toContain('alone, with-friends');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('ассистент');
    expect(options).toMatchObject({ temperature: 0.9, json: true });
    expect(options.maxTokens).toBeGreaterThanOrEqual(2_000);
    expect(options.maxTokens).toBeLessThanOrEqual(3_000);
  });

  it('rejects an unknown persona', async () => {
    const { service } = harness({ persona: null });

    await expect(service.dailyLife('missing', '2026-11-27', NOW)).rejects.toThrow(
      /Eve persona not found/,
    );
  });
});

describe('parseLlmDailyLife', () => {
  const SEED = {
    personaId: PERSONA,
    dateLocal: '2026-11-27',
    sleepFrom: 23,
    sleepTo: 8,
  };

  it('clamps hours into 0–23 and sorts the blocks', () => {
    const day = parseLlmDailyLife(
      llmDay({
        blocks: [
          {
            fromHour: 26,
            toHour: 21,
            activity: 'ночь',
            social: 'alone',
            phoneAvailable: 'false',
          },
          {
            fromHour: 10,
            toHour: 14,
            activity: 'учёба',
            social: 'with-coworkers',
            phoneAvailable: true,
          },
          {
            fromHour: 14,
            toHour: 18,
            activity: 'работа',
            social: 'with-coworkers',
            phoneAvailable: true,
          },
          {
            fromHour: -5,
            toHour: 10,
            activity: 'сон',
            social: 'alone',
            phoneAvailable: true,
          },
        ],
      }),
      SEED,
    );

    expect(day).not.toBeNull();
    expect(day?.blocks.map((block) => block.fromHour)).toEqual([0, 10, 14, 23]);
    expect(day?.blocks[0]).toMatchObject({ fromHour: 0, toHour: 10 });
    expect(day?.blocks.at(-1)).toMatchObject({
      fromHour: 23,
      toHour: 21,
      phoneAvailable: false,
    });
  });

  it('rejects an unknown social value', () => {
    const value = llmDayObject();
    const blocks = value.blocks as Array<Record<string, unknown>>;
    blocks[0]!.social = 'with-aliens';

    expect(parseLlmDailyLife(JSON.stringify(value), SEED)).toBeNull();
  });

  it('requires at least four blocks', () => {
    const value = llmDayObject();
    const blocks = value.blocks as unknown[];

    expect(
      parseLlmDailyLife(JSON.stringify({ ...value, blocks: blocks.slice(0, 3) }), SEED),
    ).toBeNull();
  });

  it('requires blocks, events and wants arrays', () => {
    const value = llmDayObject();

    expect(
      parseLlmDailyLife(JSON.stringify({ ...value, events: undefined }), SEED),
    ).toBeNull();
    expect(
      parseLlmDailyLife(JSON.stringify({ ...value, wants: undefined }), SEED),
    ).toBeNull();
    expect(
      parseLlmDailyLife(JSON.stringify({ ...value, blocks: undefined }), SEED),
    ).toBeNull();
    expect(parseLlmDailyLife('не json', SEED)).toBeNull();
  });

  it('drops blocks with non-numeric hours', () => {
    const value = llmDayObject();
    const blocks = value.blocks as Array<Record<string, unknown>>;
    blocks[0]!.fromHour = 'вечером';
    blocks[0]!.toHour = 'поздно';

    expect(parseLlmDailyLife(JSON.stringify(value), SEED)).toBeNull();
  });

  it('forces one phone-free block when the model marks every block available', () => {
    const value = llmDayObject();
    const blocks = value.blocks as Array<Record<string, unknown>>;
    for (const block of blocks) block.phoneAvailable = true;

    const day = parseLlmDailyLife(JSON.stringify(value), SEED);

    expect(day?.blocks.some((block) => !block.phoneAvailable)).toBe(true);
  });

  it('keeps the rest of a valid plan and defaults the vibe', () => {
    const value = llmDayObject();
    delete value.vibe;

    const day = parseLlmDailyLife(JSON.stringify(value), {
      ...SEED,
      vibe: 'тихий день',
    });

    expect(day?.vibe).toBe('тихий день');
    expect(day?.events).toEqual(['зачёт через неделю', 'нашла кафе рядом']);
    expect(day?.wants).toEqual(['поспать', 'кофе']);
    expect(day?.dateLocal).toBe('2026-11-27');
  });
});

describe('deterministic rng', () => {
  it('produces the same sequence for the same seed', () => {
    const a = createRng(hashSeed('persona:date'));
    const b = createRng(hashSeed('persona:date'));
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});

function prismaMarker(state: {
  markers: Set<string>;
}): boolean {
  return state.markers.has(`${PERSONA}:2026-11-27`);
}
