import { describe, expect, it, vi } from 'vitest';
import {
  MEMORY_RERANK_MAX_CANDIDATES,
  embedMemoryQuery,
  embeddingTexts,
  rankByRelevance,
  selectRankCandidates,
} from './eve-memory-rank.js';
import type { MemoryRankOptions } from './eve-memory-rank.js';

interface Item {
  id: string;
  text: string;
}

function options(
  needles: string[],
  limit = 5,
  overrides: Partial<MemoryRankOptions<Item>> = {},
): MemoryRankOptions<Item> {
  return {
    text: (item) => item.text,
    id: (item) => item.id,
    lexical: (text) =>
      needles.reduce(
        (sum, needle) => (text.toLowerCase().includes(needle) ? sum + 5 : sum),
        0,
      ),
    needles,
    limit,
    ...overrides,
  };
}

const LEXICAL_ITEM: Item = {
  id: 'lexical',
  text: 'плавание было в субботу, он занял второе место',
};
const SEMANTIC_ITEM: Item = {
  id: 'semantic',
  text: 'он каждый вторник ходит в бассейн и плавает',
};

describe('rankByRelevance', () => {
  it('keeps the lexical order when embeddings return null', async () => {
    const embed = vi.fn(async () => null);

    const ranked = await rankByRelevance(
      'плавание',
      [SEMANTIC_ITEM, LEXICAL_ITEM],
      { ...options(['плавание']), embed: { embed } },
    );

    expect(ranked.map((entry) => entry.item.id)).toEqual([
      'lexical',
      'semantic',
    ]);
    expect(embed).toHaveBeenCalledTimes(1);
  });

  it('lets a semantically closer item beat a better lexical match', async () => {
    const vectors: Record<string, number[]> = {
      плавание: [1, 0],
      [LEXICAL_ITEM.text]: [0, 1],
      [SEMANTIC_ITEM.text]: [1, 0],
    };
    const embed = vi.fn(async (texts: string[]) =>
      texts.map((text) => vectors[text] ?? [0, 1]),
    );

    const ranked = await rankByRelevance(
      'плавание',
      [LEXICAL_ITEM, SEMANTIC_ITEM],
      { ...options(['плавание']), embed: { embed } },
    );

    expect(ranked.map((entry) => entry.item.id)).toEqual([
      'semantic',
      'lexical',
    ]);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
    expect(ranked[0]!.score).toBeLessThanOrEqual(1);
  });

  it('falls back to lexical order when the embedder throws', async () => {
    const embed = vi.fn(async () => {
      throw new Error('provider down');
    });

    const ranked = await rankByRelevance(
      'плавание',
      [SEMANTIC_ITEM, LEXICAL_ITEM],
      { ...options(['плавание']), embed: { embed } },
    );

    expect(ranked.map((entry) => entry.item.id)).toEqual([
      'lexical',
      'semantic',
    ]);
  });

  it('caps embedded candidates at 40 and never promotes the tail', async () => {
    const items: Item[] = Array.from({ length: 45 }, (_, index) => ({
      id: `item-${index}`,
      text: `вариант ${index}: ${'подробное описание события '.repeat(2)}`,
    }));
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]));
    const lexical = (text: string): number =>
      Number(/вариант (\d+)/.exec(text)?.[1] ?? 0);

    const ranked = await rankByRelevance('вариант', items, {
      ...options(['вариант'], 5),
      lexical,
      embed: { embed },
    });

    expect(embed).toHaveBeenCalledTimes(1);
    const input = embed.mock.calls[0]![0] as string[];
    expect(input).toHaveLength(MEMORY_RERANK_MAX_CANDIDATES + 1);
    expect(input[0]).toBe('вариант');
    // The 41st lexical candidate (item-4 and below) was never embedded.
    expect(input).not.toContain(items[4]!.text);
    expect(ranked.map((entry) => entry.item.id)).not.toContain('item-4');
    expect(ranked.map((entry) => entry.item.id)).toEqual([
      'item-44',
      'item-43',
      'item-42',
      'item-41',
      'item-40',
    ]);
  });

  it('does not embed candidates shorter than 20 characters', async () => {
    const short: Item = { id: 'short', text: 'чай' };
    const long: Item = {
      id: 'long',
      text: 'он любит кофе по утрам и всегда варит свежий',
    };
    const embed = vi.fn(async (texts: string[]) =>
      texts.map((text) => (text === long.text ? [1, 0] : [0, 1])),
    );

    const ranked = await rankByRelevance('кофе', [short, long], {
      ...options(['кофе']),
      embed: { embed },
    });

    expect(embed.mock.calls[0]![0]).toEqual(['кофе', long.text]);
    expect(ranked.map((entry) => entry.item.id)).toEqual(['long', 'short']);
  });

  it('skips the embedding call when every candidate is short', async () => {
    const embed = vi.fn(async () => [[1, 0], [1, 0]]);

    await rankByRelevance(
      'кофе',
      [
        { id: 'a', text: 'кофе' },
        { id: 'b', text: 'чай' },
      ],
      { ...options(['кофе']), embed: { embed } },
    );

    expect(embed).not.toHaveBeenCalled();
  });

  it('skips the embedding call when the query has no needles', async () => {
    const embed = vi.fn(async () => [[1, 0], [1, 0]]);

    await rankByRelevance('', [LEXICAL_ITEM, SEMANTIC_ITEM], {
      ...options([]),
      embed: { embed },
    });

    expect(embed).not.toHaveBeenCalled();
  });

  it('keeps the original order on blended ties', async () => {
    const items: Item[] = [
      { id: 'b', text: 'общий текст про плавание и бассейн' },
      { id: 'a', text: 'общий текст про плавание и бассейн' },
    ];
    const embed = vi.fn(async (texts: string[]) =>
      texts.map(() => [1, 0]),
    );

    const ranked = await rankByRelevance('плавание', items, {
      ...options(['плавание']),
      embed: { embed },
    });

    expect(ranked.map((entry) => entry.item.id)).toEqual(['b', 'a']);
  });
});

describe('selectRankCandidates', () => {
  it('sorts lexically and applies the default cap', () => {
    const items: Item[] = Array.from({ length: 50 }, (_, index) => ({
      id: `item-${index}`,
      text: `запись ${index} про плавание в бассейне`,
    }));
    const optionsWithScores = {
      ...options(['плавание']),
      lexical: (text: string): number => Number(/запись (\d+)/.exec(text)?.[1] ?? 0),
    };

    const candidates = selectRankCandidates(items, optionsWithScores);

    expect(candidates).toHaveLength(MEMORY_RERANK_MAX_CANDIDATES);
    expect(candidates[0]!.item.id).toBe('item-49');
    expect(embeddingTexts(candidates)).toHaveLength(
      MEMORY_RERANK_MAX_CANDIDATES,
    );
  });
});

describe('embedMemoryQuery', () => {
  const text = 'достаточно длинный текст для эмбеддинга';

  it('builds a query vector and a text-indexed vector map', async () => {
    const index = await embedMemoryQuery('запрос', [text], {
      embed: async () => [
        [1, 0],
        [0, 1],
      ],
    });

    expect(index.queryVector).toEqual([1, 0]);
    expect(index.vectors.get(text)).toEqual([0, 1]);
  });

  it('returns an empty index on a malformed provider response', async () => {
    const index = await embedMemoryQuery('запрос', [text], {
      embed: async () => [[1, 0]],
    });

    expect(index.queryVector).toBeNull();
    expect(index.vectors.size).toBe(0);
  });

  it('returns an empty index when the candidate vector is empty', async () => {
    const index = await embedMemoryQuery('запрос', [text], {
      embed: async () => [[1, 0], []],
    });

    expect(index.queryVector).toBeNull();
    expect(index.vectors.size).toBe(0);
  });

  it('returns an empty index when the provider is missing', async () => {
    const index = await embedMemoryQuery('запрос', [text], undefined);

    expect(index.queryVector).toBeNull();
    expect(index.vectors.size).toBe(0);
  });
});
