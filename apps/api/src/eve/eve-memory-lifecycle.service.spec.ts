import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MEMORY_MIN_LOG_CHARS,
  EveMemoryLifecycleService,
  analyzeLog,
  classifyHall,
  drawerIdFor,
  extractFacts,
  extractKeywords,
  feelingOf,
  minePalace,
  queryTokens,
  renderDailyMarkdown,
  scoreText,
  splitChunks,
} from './eve-memory-lifecycle.service.js';

const PERSONA = 'persona-1';
const ACCOUNT = 'account-1';
const CHAT = 1830539716;
const DAY = '2026-11-27';
const NOW = new Date('2026-11-27T10:00:00.000Z');

const LOG = [
  'user: привет, как прошёл день?',
  'assistant: нормально, сходила в зал, потом готовила пасту',
  'user: меня зовут Саша, я живу в Москве',
  'assistant: круто, я люблю пасту с грибами',
  'user: обещаю скинуть фото соревнований завтра',
  'assistant: да, немного обидно было',
];

interface RelationshipRow {
  id: string;
  personaId: string;
  scopeKey: string;
  stage: string;
  interest: number;
  trust: number;
  attraction: number;
  annoyance: number;
  cringe: number;
  notes: string;
  createdAt: Date;
  updatedAt: Date;
}

interface HarnessOptions {
  lines?: string[];
  /** Total session-log rows for `reflect` (defaults to `lines.length`). */
  logCount?: number;
  facts?: string[];
  palace?: Array<Record<string, unknown>>;
  daily?: Array<Record<string, unknown>>;
  episodes?: Array<Record<string, unknown>>;
  cross?: Array<Record<string, unknown>>;
  relationship?: RelationshipRow | null;
  relationships?: Array<{ id: string; notes: string }>;
  conflicts?: Array<{ id: string }>;
  timeItem?: { id: string } | null;
  timeItems?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  /** Fake embeddings endpoint; omit to exercise the lexical-only path. */
  embed?: (texts: string[]) => Promise<number[][] | null>;
  counts?: Partial<
    Record<
      | 'logs'
      | 'facts'
      | 'agenda'
      | 'conflictEvents'
      | 'relationshipEvents'
      | 'conflicts',
      number
    >
  >;
}

function harness(options: HarnessOptions = {}) {
  const lines = options.lines ?? LOG;
  const counts = options.counts ?? {};
  const daily = new Map<string, Record<string, unknown>>();
  let dailySeq = 0;

  const timestamp = (index: number): Date =>
    new Date(NOW.getTime() + index * 1000);

  const prisma = {
    evePersona: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === PERSONA ? { id: PERSONA } : null,
      ),
    },
    eveSessionLog: {
      findMany: vi.fn(async () =>
        lines.map((line, index) => ({ line, createdAt: timestamp(index) })),
      ),
      count: vi.fn(async () => options.logCount ?? lines.length),
      deleteMany: vi.fn(async () => ({ count: counts.logs ?? 2 })),
    },
    eveMemoryDaily: {
      findUnique: vi.fn(
        async ({ where }: { where: { personaId_date: { date: string } } }) =>
          daily.get(where.personaId_date.date) ?? null,
      ),
      findMany: vi.fn(async () => options.daily ?? []),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { personaId_date: { date: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const key = where.personaId_date.date;
          const current = daily.get(key);
          const row = current
            ? { ...current, ...update }
            : {
                id: `daily-${++dailySeq}`,
                complete: false,
                createdAt: NOW,
                updatedAt: NOW,
                ...create,
              };
          daily.set(key, row);
          return row;
        },
      ),
      update: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { personaId_date: { date: string } };
          data: Record<string, unknown>;
        }) => {
          const key = where.personaId_date.date;
          const row = { ...(daily.get(key) ?? { id: 'daily-x' }), ...data };
          daily.set(key, row);
          return row;
        },
      ),
      deleteMany: vi.fn(async () => ({ count: daily.size })),
    },
    evePalaceDrawer: {
      findMany: vi.fn(async () => options.palace ?? []),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { personaId_drawerId: { drawerId: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => ({
          id: `drawer-${where.personaId_drawerId.drawerId}`,
          ...create,
          ...update,
        }),
      ),
      deleteMany: vi.fn(async () => ({ count: 4 })),
    },
    eveMemoryFact: {
      findMany: vi.fn(async () =>
        (options.facts ?? []).map((content, index) => ({
          id: `fact-${index}`,
          content,
          importance: 3,
          createdAt: NOW,
          updatedAt: NOW,
        })),
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: `fact-new-${Math.random().toString(16).slice(2, 8)}`,
        createdAt: NOW,
        updatedAt: NOW,
        ...data,
      })),
      deleteMany: vi.fn(async () => ({ count: counts.facts ?? 3 })),
    },
    eveEpisode: {
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => ({
          id: 'episode-1',
          ...create,
          ...update,
        }),
      ),
      findMany: vi.fn(async () => options.episodes ?? []),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    eveTimeItem: {
      findFirst: vi.fn(async () => options.timeItem ?? null),
      findMany: vi.fn(async () => options.timeItems ?? []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'time-1',
        ...data,
      })),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
    eveProactiveState: {
      upsert: vi.fn(async () => ({ id: 'proactive-1' })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    eveRelationship: {
      findUnique: vi.fn(async () => options.relationship ?? null),
      findMany: vi.fn(async () => options.relationships ?? []),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 'rel-new',
        ...data,
      })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: options.relationship?.id ?? 'rel-1',
        ...data,
      })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    eveRelationshipEvent: {
      findMany: vi.fn(async () => options.events ?? []),
      deleteMany: vi.fn(async () => ({
        count: counts.relationshipEvents ?? 5,
      })),
    },
    eveConflict: {
      findMany: vi.fn(async () => options.conflicts ?? [{ id: 'conflict-1' }]),
      updateMany: vi.fn(async () => ({ count: counts.conflicts ?? 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    eveConflictEvent: {
      deleteMany: vi.fn(async () => ({ count: counts.conflictEvents ?? 4 })),
    },
    eveAgendaItem: {
      deleteMany: vi.fn(async () => ({ count: counts.agenda ?? 6 })),
    },
    eveCrossChatMemory: {
      findMany: vi.fn(async () => options.cross ?? []),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
    eveSessionState: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
    evePersonaAccount: {
      findUnique: vi.fn(async () => ({ relationshipMode: 'isolated' })),
    },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    ),
  };

  const service = new EveMemoryLifecycleService(
    prisma as never,
    options.embed
      ? ({ embed: vi.fn(options.embed) } as never)
      : undefined,
  );
  return { service, prisma, daily };
}

function relationship(
  overrides: Partial<RelationshipRow> = {},
): RelationshipRow {
  return {
    id: 'rel-1',
    personaId: PERSONA,
    scopeKey: `account:${ACCOUNT}:chat:${CHAT}`,
    stage: 'tg-given-warming',
    interest: 10,
    trust: 5,
    attraction: 0,
    annoyance: 0,
    cringe: 0,
    notes: '[reflect 2026-11-27] тепло',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('memory extraction helpers', () => {
  it('classifies palace halls by marker words', () => {
    expect(classifyHall('я обещаю скинуть фото завтра')).toBe('promises');
    expect(classifyHall('я люблю кофе с корицей')).toBe('preferences');
    expect(classifyHall('мне очень обидно, что ты не ответил')).toBe(
      'feelings',
    );
    expect(classifyHall('не знаю, получится ли приехать позже?')).toBe(
      'open_loops',
    );
    expect(classifyHall('вчера был на соревнованиях по плаванию')).toBe(
      'events',
    );
    expect(classifyHall('меня зовут Саша, я живу в Москве')).toBe('facts');
  });

  it('builds a stable drawer id from the persona and the quote', () => {
    const first = drawerIdFor(PERSONA, 'он был на соревнованиях');

    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(drawerIdFor(PERSONA, 'он был на соревнованиях')).toBe(first);
    expect(drawerIdFor('persona-2', 'он был на соревнованиях')).not.toBe(first);
  });

  it('dedupes repeated sentences inside a mined day', () => {
    const drafts = minePalace(
      PERSONA,
      'primary-1',
      'он был на соревнованиях по плаванию. он был на соревнованиях по плаванию.',
    );

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      hall: 'events',
      wing: 'primary-1',
      salience: expect.any(Number),
    });
    expect(drafts[0]!.salience).toBeGreaterThanOrEqual(1);
    expect(drafts[0]!.salience).toBeLessThanOrEqual(10);
  });

  it('splits long logs into chunks on sentence and line boundaries', () => {
    const text = `${'а'.repeat(900)}. ${'б'.repeat(900)}.`;
    const chunks = splitChunks(text, 1000);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toContain('б');
  });

  it('ignores short and function words in keywords', () => {
    expect(queryTokens('как ты плавал? плавание, плавание!')).toEqual([
      'плавал',
      'плавание',
    ]);
    expect(extractKeywords('плавание плавание соревнования', 2)).toEqual([
      'плавание',
      'соревнования',
    ]);
    expect(scoreText('он был на рыбалке', ['плавание'])).toBe(0);
    expect(scoreText('он был на плавании', ['плавание'])).toBeGreaterThan(0);
    expect(scoreText('он любит плавание', ['плавание'])).toBeGreaterThan(
      scoreText('он был на плавании', ['плавание']),
    );
  });

  it('renders a day summary with a deterministic feeling and conflict', () => {
    const analysis = analyzeLog(LOG);
    const markdown = renderDailyMarkdown(analysis, DAY);

    expect(analysis.conflict).toContain('обидно');
    expect(analysis.feeling).toBe('напряжённо');
    expect(analysis.facts.join(' ')).toContain('Саша');
    expect(markdown).toContain('## Ощущение');
    expect(markdown).toContain('## Новое о нём');
    expect(markdown).toContain('напряжённо');
    expect(feelingOf('хорошо, спасибо, ахах', '')).toBe('тепло и живо');
  });

  it('never turns old reasoning or bubble separators into facts', () => {
    const facts = extractFacts([
      'assistant: Now the deleted text was "Люблю тебя" — that\'s a big deal at warming stage, trust 0',
      'assistant: "«люблю тебя» и сразу удалил" --- "ну ты даёшь" Good — подкол, без театра',
      'assistant: я спать --- шучу, я в кадрах',
      'user: меня зовут Саша, я живу в Москве',
    ]);

    const all = facts.join(' ');
    expect(all).toContain('Саша');
    expect(all).not.toMatch(/Now the deleted|Good|удалил|Люблю тебя/);
    expect(all).not.toContain('---');
  });
});

describe('EveMemoryLifecycleService.closeDay', () => {
  it('skips a day without a session log', async () => {
    const { service, prisma } = harness({ lines: [] });

    const result = await service.closeDay(PERSONA, ACCOUNT, CHAT, DAY);

    expect(result).toMatchObject({
      skipped: true,
      reason: 'no-log',
      complete: false,
    });
    expect(prisma.eveMemoryDaily.upsert).not.toHaveBeenCalled();
  });

  it(`skips a log shorter than ${MEMORY_MIN_LOG_CHARS} chars`, async () => {
    const { service, prisma } = harness({ lines: ['user: привет'] });

    const result = await service.closeDay(PERSONA, ACCOUNT, CHAT, DAY);

    expect(result).toMatchObject({ skipped: true, reason: 'too-short' });
    expect(prisma.evePalaceDrawer.upsert).not.toHaveBeenCalled();
  });

  it('writes the daily summary, palace, facts, episodes and time items', async () => {
    const { service, prisma } = harness({ lines: LOG });

    const result = await service.closeDay(PERSONA, ACCOUNT, BigInt(CHAT), DAY);

    expect(result).toMatchObject({
      day: DAY,
      skipped: false,
      complete: true,
      facts: 2,
      episodes: 1,
      timeItems: 1,
    });
    expect(result.drawers).toBeGreaterThanOrEqual(5);

    const create = prisma.eveMemoryDaily.upsert.mock.calls[0]![0].create;
    expect(create.markdown).toContain('## Момент дня');
    expect(JSON.parse(create.json as string)).toMatchObject({
      day: DAY,
      feeling: 'напряжённо',
    });

    expect(prisma.eveMemoryDaily.update).toHaveBeenCalledWith({
      where: { personaId_date: { personaId: PERSONA, date: DAY } },
      data: { complete: true },
    });
    expect(prisma.eveProactiveState.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: {
          personaId: PERSONA,
          date: DAY,
          marker: 'daily-memory-closed',
        },
      }),
    );
    expect(prisma.evePalaceDrawer.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          personaId_drawerId: {
            personaId: PERSONA,
            drawerId: expect.stringMatching(/^[0-9a-f]{16}$/),
          },
        },
        create: expect.objectContaining({
          personaId: PERSONA,
          wing: `primary-${CHAT}`,
          hall: expect.any(String),
          source: 'daily-mine',
        }),
      }),
    );
    expect(prisma.eveTimeItem.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        personaId: PERSONA,
        kind: 'promise',
        status: 'open',
      }),
    });
  });

  it('does not duplicate facts that already exist for the persona', async () => {
    const { service, prisma } = harness({
      lines: LOG,
      facts: ['меня зовут Саша, я живу в Москве'],
    });

    const result = await service.closeDay(PERSONA, ACCOUNT, CHAT, DAY);

    expect(result.facts).toBe(1);
    expect(prisma.eveMemoryFact.create).toHaveBeenCalledTimes(1);
    expect(prisma.eveMemoryFact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        content: 'круто, я люблю пасту с грибами',
        kind: 'preference',
      }),
    });
  });

  it('is idempotent: closing the same day twice adds nothing', async () => {
    const { service, prisma } = harness({ lines: LOG });

    await service.closeDay(PERSONA, ACCOUNT, CHAT, DAY);
    const drawers = prisma.evePalaceDrawer.upsert.mock.calls.length;
    const facts = prisma.eveMemoryFact.create.mock.calls.length;
    const second = await service.closeDay(PERSONA, ACCOUNT, CHAT, DAY);

    expect(second).toMatchObject({ skipped: true, reason: 'already-closed' });
    expect(prisma.evePalaceDrawer.upsert.mock.calls.length).toBe(drawers);
    expect(prisma.eveMemoryFact.create.mock.calls.length).toBe(facts);
  });

  it('rejects an unknown persona and a malformed day', async () => {
    const { service, prisma } = harness();

    await expect(
      service.closeDay('missing', ACCOUNT, CHAT, DAY),
    ).rejects.toMatchObject({ response: { code: 'EVE_PERSONA_NOT_FOUND' } });
    await expect(
      service.closeDay(PERSONA, ACCOUNT, CHAT, '27.11.2026'),
    ).rejects.toMatchObject({ response: { code: 'EVE_DAY_INVALID' } });
    expect(prisma.eveSessionLog.findMany).not.toHaveBeenCalled();
  });
});

describe('EveMemoryLifecycleService.retrieve', () => {
  const palace = [
    {
      id: 'p-high',
      drawerId: 'd-high',
      hall: 'feelings',
      wing: 'primary-1',
      room: 'кофе',
      content: 'он любит кофе по утрам',
      keywords: '["кофе"]',
      salience: 9,
      source: 'daily-mine',
      hash: 'd-high',
      createdAt: NOW,
      updatedAt: NOW,
    },
    {
      id: 'p-query',
      drawerId: 'd-query',
      hall: 'events',
      wing: 'primary-1',
      room: 'плавание',
      content: 'он был на соревнованиях по плаванию в субботу',
      keywords: '["соревнования","плавание"]',
      salience: 5,
      source: 'daily-mine',
      hash: 'd-query',
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];

  const daily = [
    {
      id: 'd-1',
      personaId: PERSONA,
      date: '2026-11-26',
      markdown: `# Дневник — 2026-11-26\n\n## О чём говорили\n- плавание\n\nдолго обсуждали соревнования по плаванию и тренировки`,
      json: '{"feeling":"тепло и живо"}',
      complete: true,
      createdAt: NOW,
      updatedAt: NOW,
    },
  ];

  it('ranks palace drawers and facts by keyword score', async () => {
    const { service } = harness({
      palace,
      daily,
      facts: ['у него есть кот', 'он живёт в москве'],
      relationship: relationship(),
    });

    const result = await service.retrieve(
      PERSONA,
      relationship().scopeKey,
      'плавание',
    );

    expect(result.palace[0]).toMatchObject({
      id: 'p-query',
      kind: 'palace',
      hall: 'events',
      keywords: ['соревнования', 'плавание'],
    });
    expect(result.palace[0]!.score).toBeGreaterThan(result.palace[1]!.score);
    expect(result.daily[0]!.text).toContain('плавание');
    expect(result.daily[0]!.text.length).toBeLessThanOrEqual(242);
    expect(result.summary).toContain('стадия tg-given-warming');
    expect(result.relationship?.notes).toBe('[reflect 2026-11-27] тепло');
  });

  it('applies limits and returns every retrieval bucket', async () => {
    const { service } = harness({
      palace,
      daily,
      facts: ['у него есть кот', 'он живёт в москве'],
      episodes: [
        {
          id: 'e-1',
          personaId: PERSONA,
          date: '2026-11-26',
          content: 'был тяжёлый день',
          createdAt: NOW,
        },
      ],
      cross: [
        {
          id: 'c-1',
          personaId: PERSONA,
          peerId: 'other',
          content: 'в другом чате говорили про плавание',
          createdAt: NOW,
        },
      ],
      relationship: relationship(),
    });

    const result = await service.retrieve(
      PERSONA,
      relationship().scopeKey,
      'плавание',
      {
        facts: 1,
        daily: 1,
        palace: 1,
        episodes: 1,
        crossChat: 1,
      },
    );

    expect(Object.keys(result).sort()).toEqual(
      [
        'crossChat',
        'daily',
        'episodes',
        'events',
        'facts',
        'palace',
        'relationship',
        'summary',
        'timeItems',
      ].sort(),
    );
    expect(result.facts).toHaveLength(1);
    expect(result.daily).toHaveLength(1);
    expect(result.palace).toHaveLength(1);
    expect(result.episodes).toHaveLength(1);
    expect(result.crossChat[0]).toMatchObject({ kind: 'cross-chat' });
  });

  it('returns open promises and the relationship timeline', async () => {
    const { service } = harness({
      relationship: relationship(),
      timeItems: [
        {
          id: 't-1',
          personaId: PERSONA,
          relationshipId: relationship().id,
          kind: 'promise',
          content: 'обещал скинуть фото соревнований',
          status: 'open',
          dueAt: new Date('2026-11-28T10:00:00.000Z'),
          createdAt: NOW,
        },
      ],
      events: [
        {
          id: 'ev-1',
          relationshipId: relationship().id,
          kind: 'note',
          text: 'первое свидание',
          createdAt: NOW,
        },
      ],
    });

    const result = await service.retrieve(
      PERSONA,
      relationship().scopeKey,
      '',
    );

    expect(result.timeItems).toHaveLength(1);
    expect(result.timeItems[0]).toMatchObject({
      kind: 'time-item',
      hall: 'promise',
      text: 'обещал скинуть фото соревнований',
    });
    expect(result.events[0]).toMatchObject({
      kind: 'relationship-event',
      text: 'первое свидание',
    });
  });

  it('drops reasoning fragments from retrieved memories', async () => {
    const { service } = harness({
      facts: [
        'The user says it is a test\nон любит кофе',
        'Now the deleted text was "люблю тебя"',
      ],
      relationship: null,
    });

    const result = await service.retrieve(PERSONA, '', '');

    expect(result.facts.map((fact) => fact.text)).toEqual(['он любит кофе']);
  });

  it('falls back to importance when the query has no keywords', async () => {
    const { service } = harness({
      facts: ['у него есть кот', 'он живёт в москве'],
      relationship: null,
    });

    const result = await service.retrieve(PERSONA, '', '');

    expect(result.facts.map((fact) => fact.id)).toEqual(['fact-0', 'fact-1']);
    expect(result.relationship).toBeNull();
  });

  const LEXICAL_FACT = 'плавание было в субботу, он занял второе место';
  const SEMANTIC_FACT = 'он каждый вторник ходит в бассейн и плавает';
  const vectors: Record<string, number[]> = {
    плавание: [1, 0],
    [LEXICAL_FACT]: [0, 1],
    [SEMANTIC_FACT]: [1, 0],
  };

  it('keeps the lexical order when embeddings are unavailable', async () => {
    const embed = vi.fn(async () => null);
    const { service } = harness({
      facts: [LEXICAL_FACT, SEMANTIC_FACT],
      embed,
    });

    const result = await service.retrieve(PERSONA, '', 'плавание');

    expect(result.facts.map((fact) => fact.id)).toEqual(['fact-0', 'fact-1']);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('reranks a semantically closer fact above a better lexical match', async () => {
    const embed = vi.fn(async (texts: string[]) =>
      texts.map((text) => vectors[text] ?? [0, 1]),
    );
    const { service } = harness({
      facts: [LEXICAL_FACT, SEMANTIC_FACT],
      embed,
    });

    const result = await service.retrieve(PERSONA, '', 'плавание');

    expect(result.facts.map((fact) => fact.id)).toEqual(['fact-1', 'fact-0']);
    expect(embed).toHaveBeenCalledTimes(1);
    expect(embed.mock.calls[0]![0]).toEqual([
      'плавание',
      LEXICAL_FACT,
      SEMANTIC_FACT,
    ]);
  });

  it('falls back to lexical order when the embedding call throws', async () => {
    const embed = vi.fn(async () => {
      throw new Error('provider down');
    });
    const { service } = harness({
      facts: [LEXICAL_FACT, SEMANTIC_FACT],
      embed,
    });

    const result = await service.retrieve(PERSONA, '', 'плавание');

    expect(result.facts.map((fact) => fact.id)).toEqual(['fact-0', 'fact-1']);
  });

  it('does not embed too-short memories', async () => {
    const long = 'он любит кофе по утрам и всегда варит свежий';
    const embed = vi.fn(async (texts: string[]) =>
      texts.map((text) => (text === long ? [1, 0] : [0, 1])),
    );
    const { service } = harness({ facts: ['кот', long], embed });

    const result = await service.retrieve(PERSONA, '', 'кофе');

    expect(embed.mock.calls[0]![0]).toEqual(['кофе', long]);
    expect(result.facts.map((fact) => fact.id)).toEqual(['fact-1', 'fact-0']);
  });
});

describe('EveMemoryLifecycleService.reflect', () => {
  it('skips a chat below the six-turn boundary', async () => {
    const { service, prisma } = harness({ logCount: 5 });

    const result = await service.reflect(PERSONA, ACCOUNT, CHAT);

    expect(result).toEqual({
      reflected: false,
      turns: 5,
      factsAdded: 0,
      feeling: '',
    });
    expect(prisma.eveMemoryFact.create).not.toHaveBeenCalled();
  });

  it('adds at most three facts and one feeling note on every sixth turn', async () => {
    const { service, prisma } = harness({
      logCount: 12,
      relationship: relationship({ notes: '' }),
    });

    const result = await service.reflect(PERSONA, ACCOUNT, CHAT);

    expect(result.reflected).toBe(true);
    expect(result.factsAdded).toBeGreaterThan(0);
    expect(result.factsAdded).toBeLessThanOrEqual(3);
    expect(result.scopeKey).toBe(`account:${ACCOUNT}:chat:${CHAT}`);
    const notes = prisma.eveRelationship.update.mock.calls[0]![0].data
      .notes as string;
    expect(notes).toContain('[reflect');
    expect(notes).toContain(result.feeling);
  });
});

describe('EveMemoryLifecycleService.amnesia', () => {
  it('deletes only rows inside the requested window and resets recent state', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { service, prisma } = harness({
      relationships: [
        { id: 'rel-1', notes: '[reflect 2026-11-27] тепло\nстарая заметка' },
      ],
      conflicts: [{ id: 'conflict-1' }],
      counts: {
        logs: 7,
        facts: 3,
        agenda: 2,
        conflictEvents: 4,
        relationshipEvents: 5,
        conflicts: 1,
      },
    });

    const result = await service.amnesia(PERSONA, 60);

    expect(result).toMatchObject({
      minutes: 60,
      since: '2026-11-27T09:00:00.000Z',
      logs: 7,
      facts: 3,
      conflicts: 1,
      conflictEvents: 4,
      relationshipEvents: 5,
      notes: 1,
      agenda: 2,
    });
    const since = new Date('2026-11-27T09:00:00.000Z');
    expect(prisma.eveSessionLog.deleteMany).toHaveBeenCalledWith({
      where: { personaId: PERSONA, createdAt: { gte: since } },
    });
    expect(prisma.eveMemoryFact.deleteMany).toHaveBeenCalledWith({
      where: { personaId: PERSONA, createdAt: { gte: since } },
    });
    expect(prisma.eveConflict.updateMany).toHaveBeenCalledWith({
      where: { relationshipId: { in: ['rel-1'] }, updatedAt: { gte: since } },
      data: { level: 0, coldUntil: null, reason: null, history: '[]' },
    });
    expect(prisma.eveRelationship.update).toHaveBeenCalledWith({
      where: { id: 'rel-1' },
      data: { notes: 'старая заметка' },
    });
  });
});

describe('EveMemoryLifecycleService.reset', () => {
  it('removes every learned row in one transaction', async () => {
    const { service, prisma } = harness({
      relationships: [{ id: 'rel-1', notes: '' }],
      conflicts: [{ id: 'conflict-1' }],
    });

    const result = await service.reset(PERSONA);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction.mock.calls[0]![0]).toHaveLength(14);
    expect(result.removed).toMatchObject({
      sessionLogs: 2,
      facts: 3,
      palace: 4,
      agenda: 6,
      relationships: 1,
    });
    expect(result.removed.total).toBeGreaterThan(0);
  });
});
