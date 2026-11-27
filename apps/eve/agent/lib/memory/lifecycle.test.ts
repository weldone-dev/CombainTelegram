import { describe, expect, test } from 'bun:test';
import {
  MEMORY_MIN_LOG_CHARS,
  classifyHall,
  drawerIdFor,
  minePalace,
  rankByKeywords,
  renderDailyMarkdown,
  selectReflectionFacts,
  summarizeDay,
  toMemoryContext,
} from './lifecycle';

/**
 * Same fixture as `apps/api/src/eve/eve-memory-lifecycle.service.spec.ts`.
 * If one side changes the heuristics, both tests fail — that is the parity
 * check between Nest and the local agent fallback.
 */
const LOG = [
  'user: привет, как прошёл день?',
  'assistant: нормально, сходила в зал, потом готовила пасту',
  'user: меня зовут Саша, я живу в Москве',
  'assistant: круто, я люблю пасту с грибами',
  'user: обещаю скинуть фото соревнований завтра',
  'assistant: да, немного обидно было',
];

const DAY = '2026-11-27';

describe('summarizeDay', () => {
  test('returns null below the minimum log length', () => {
    expect(summarizeDay(['user: привет'], DAY)).toBeNull();
    expect(MEMORY_MIN_LOG_CHARS).toBe(50);
  });

  test('builds feeling, topics, facts and conflict from the day log', () => {
    const summary = summarizeDay(LOG, DAY);

    expect(summary).not.toBeNull();
    expect(summary!.day).toBe(DAY);
    expect(summary!.feeling).toBe('напряжённо');
    expect(summary!.conflict).toContain('обидно');
    expect(summary!.facts).toHaveLength(2);
    expect(summary!.facts.join(' ')).toContain('Саша');
    expect(summary!.topics.length).toBeGreaterThan(0);
    expect(summary!.highlight.length).toBeGreaterThan(0);
  });

  test('renders markdown with fixed sections', () => {
    const markdown = renderDailyMarkdown(summarizeDay(LOG, DAY)!);

    for (const heading of [
      '## Ощущение',
      '## О чём говорили',
      '## Новое о нём',
      '## Момент дня',
      '## Конфликт',
    ]) {
      expect(markdown).toContain(heading);
    }
  });
});

describe('palace halls', () => {
  test('classifies by marker words', () => {
    expect(classifyHall('я обещаю скинуть фото завтра')).toBe('promises');
    expect(classifyHall('я люблю кофе с корицей')).toBe('preferences');
    expect(classifyHall('мне очень обидно, что ты не ответил')).toBe('feelings');
    expect(
      classifyHall('не знаю, получится ли приехать позже?'),
    ).toBe('open_loops');
    expect(classifyHall('вчера был на соревнованиях по плаванию')).toBe('events');
    expect(classifyHall('меня зовут Саша, я живу в Москве')).toBe('facts');
  });

  test('drawer id is stable and persona-scoped', () => {
    const id = drawerIdFor('persona-1', 'он был на соревнованиях');

    expect(id).toMatch(/^[0-9a-f]{16}$/);
    expect(drawerIdFor('persona-1', 'он был на соревнованиях')).toBe(id);
    expect(drawerIdFor('persona-2', 'он был на соревнованиях')).not.toBe(id);
  });

  test('mines deduped drawers and skips small talk questions', () => {
    const drafts = minePalace('persona-1', [
      'user: привет, как прошёл день?',
      'user: он был на соревнованиях по плаванию',
      'user: он был на соревнованиях по плаванию',
      'user: обещаю скинуть фото завтра',
    ], { wing: 'primary-1' });

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      hall: 'events',
      wing: 'primary-1',
      room: 'плаванию',
    });
    expect(drafts[1]!.hall).toBe('promises');
    for (const draft of drafts) {
      expect(draft.salience).toBeGreaterThanOrEqual(1);
      expect(draft.salience).toBeLessThanOrEqual(10);
    }
  });
});

describe('retrieval ranking', () => {
  test('keyword match beats a more salient unrelated card', () => {
    const items = [
      { id: 'high', text: 'он любит кофе по утрам', salience: 9 },
      { id: 'query', text: 'он был на соревнованиях по плаванию', salience: 5 },
    ];

    const ranked = rankByKeywords(items, 'плавание', {
      text: (item) => item.text,
      base: (item) => item.salience / 10,
      limit: 2,
    });

    expect(ranked[0]!.item.id).toBe('query');
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  test('respects the limit and keeps order without a query', () => {
    const items = [
      { id: 'a', text: 'первое' },
      { id: 'b', text: 'второе' },
    ];

    const ranked = rankByKeywords(items, '', {
      text: (item) => item.text,
      limit: 1,
    });

    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.item.id).toBe('a');
  });
});

describe('reflection and prompt context', () => {
  test('selects at most three unseen facts', () => {
    const picked = selectReflectionFacts(LOG, [
      'меня зовут Саша, я живу в Москве',
    ]);

    expect(picked).toEqual(['круто, я люблю пасту с грибами']);
    expect(selectReflectionFacts(LOG, [], 1)).toHaveLength(1);
  });

  test('maps a retrieval snapshot to prompt strings', () => {
    const context = toMemoryContext({
      summary: 'стадия tg-given-warming',
      relationship: {
        stage: 'tg-given-warming',
        interest: 10,
        trust: 5,
        attraction: 0,
        annoyance: 0,
        cringe: 0,
        notes: 'ревнивая',
      },
      facts: [{ id: 'f1', kind: 'fact', text: 'он живёт в москве', score: 1 }],
      daily: [{ id: 'd1', kind: 'daily', text: 'вчера говорили про плавание', score: 1 }],
      palace: [
        { id: 'p1', kind: 'palace', hall: 'events', text: 'был на соревнованиях', score: 1 },
        { id: 'p2', kind: 'palace', hall: 'promises', text: 'скинуть фото', score: 1 },
        { id: 'p3', kind: 'palace', hall: 'open_loops', text: 'не решил про поездку', score: 1 },
      ],
      episodes: [{ id: 'e1', kind: 'episode', text: 'тяжёлый день', score: 1 }],
      crossChat: [{ id: 'c1', kind: 'cross-chat', text: 'другой чат', score: 1 }],
    });

    expect(context.facts).toContain('москве');
    expect(context.palace).toBe('был на соревнованиях');
    expect(context.promises).toBe('скинуть фото');
    expect(context.openLoops).toBe('не решил про поездку');
    expect(context.attachment).toBe('ревнивая');
    expect(context.crossChat).toBe('другой чат');
    expect(context.dailySummaries).toContain('плавание');
  });
});
