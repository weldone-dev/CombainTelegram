import { cosineSimilarity } from './eve-llm.service.js';

/**
 * Semantic re-ranking for Eve memory recall.
 *
 * The lexical score stays the base: when the provider has no embeddings (or
 * the call fails) `rankByRelevance` returns exactly the old ordering. When
 * vectors are available the top lexical candidates are re-scored as
 * `0.6 * cosine + 0.4 * lexicalNormalized`, so a semantically closer memory can
 * beat a keyword match without losing the lexical signal.
 *
 * Everything here is pure and per-recall: nothing is persisted, no schema
 * changes, and the whole rerank costs at most one embedding request.
 */

/** Only this many lexical candidates are ever embedded per bucket. */
export const MEMORY_RERANK_MAX_CANDIDATES = 40;
/** Shorter candidates are too ambiguous to embed; they keep their lexical score. */
export const MEMORY_RERANK_MIN_EMBED_CHARS = 20;
/** Truncation for embedding input; long daily notes must not blow up the request. */
export const MEMORY_RERANK_MAX_EMBED_CHARS = 1_000;
/** Hard cap on texts in the single embedding request of one recall. */
export const MEMORY_RERANK_MAX_EMBED_TEXTS = 200;
export const MEMORY_RERANK_COSINE_WEIGHT = 0.6;
export const MEMORY_RERANK_LEXICAL_WEIGHT = 0.4;
/** Latency budget for the one embedding call; on timeout recall stays lexical. */
export const MEMORY_RERANK_TIMEOUT_MS = 4_000;

/** The subset of `EveLlmService` the ranker needs; keeps tests network-free. */
export interface MemoryEmbedder {
  embed(texts: string[], signal?: AbortSignal): Promise<number[][] | null>;
}

export interface MemoryEmbeddingIndex {
  queryVector: number[] | null;
  /** Candidate text (already trimmed/truncated) to its embedding. */
  vectors: ReadonlyMap<string, number[]>;
}

export interface MemoryRankCandidate<T> {
  item: T;
  id: string;
  /** Prepared text used both as the embedding key and the embedded content. */
  text: string;
  /** `scoreText` + base score; the pre-existing lexical ranking key. */
  lexical: number;
  /** Original position, used as the stable tie-break. */
  index: number;
}

export interface MemoryRankOptions<T> {
  text: (item: T) => string;
  id: (item: T) => string;
  base?: (item: T, index: number) => number;
  /** Lexical scorer already bound to the query's needles. */
  lexical: (text: string) => number;
  /** Empty needles mean "nothing to compare": no embedding, lexical only. */
  needles: readonly string[];
  limit: number;
  /** Text sent to the provider when it differs from the scored text. */
  embedText?: (item: T) => string;
  /** Optional one-shot embedder. Ignored when `queryVector` + `vectors` are set. */
  embed?: MemoryEmbedder;
  signal?: AbortSignal;
  queryVector?: number[] | null;
  vectors?: ReadonlyMap<string, number[]>;
}

export interface MemoryRankResult<T> {
  item: T;
  score: number;
}

function prepareText(value: string): string {
  return value.trim().slice(0, MEMORY_RERANK_MAX_EMBED_CHARS);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function lexicalCandidates<T>(
  items: T[],
  options: MemoryRankOptions<T>,
): MemoryRankCandidate<T>[] {
  const scored = items.map((item, index) => ({
    item,
    id: options.id(item),
    text: prepareText((options.embedText ?? options.text)(item)),
    lexical:
      options.lexical(options.text(item)) +
      (options.base?.(item, index) ?? 0),
    index,
  }));
  // Highest lexical score first; ties keep the DB order, then id.
  scored.sort(
    (a, b) =>
      b.lexical - a.lexical ||
      a.index - b.index ||
      compareIds(a.id, b.id),
  );
  return scored;
}

/** Top lexical candidates for one bucket, capped before any embedding call. */
export function selectRankCandidates<T>(
  items: T[],
  options: MemoryRankOptions<T>,
  cap = MEMORY_RERANK_MAX_CANDIDATES,
): MemoryRankCandidate<T>[] {
  const limit = Math.max(0, Math.floor(cap));
  return lexicalCandidates(items, options).slice(0, limit);
}

/** Texts worth embedding: unique, long enough, capped for a single request. */
export function embeddingTexts(
  candidates: readonly MemoryRankCandidate<unknown>[],
): string[] {
  const seen = new Set<string>();
  const texts: string[] = [];
  for (const candidate of candidates) {
    if (candidate.text.length < MEMORY_RERANK_MIN_EMBED_CHARS) continue;
    if (seen.has(candidate.text)) continue;
    seen.add(candidate.text);
    texts.push(candidate.text);
    if (texts.length >= MEMORY_RERANK_MAX_EMBED_TEXTS) break;
  }
  return texts;
}

function validVector(vector: unknown): vector is number[] {
  return (
    Array.isArray(vector) &&
    vector.length > 0 &&
    vector.every(
      (value) => typeof value === 'number' && Number.isFinite(value),
    )
  );
}

function embeddingSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(MEMORY_RERANK_TIMEOUT_MS);
  if (!signal) return timeout;
  return typeof AbortSignal.any === 'function'
    ? AbortSignal.any([signal, timeout])
    : timeout;
}

/**
 * One embedding request for a whole recall: the query plus the candidate texts.
 * Any failure (no provider, HTTP error, timeout, malformed response) resolves
 * to an empty index, and the caller stays on the lexical ranking.
 */
export async function embedMemoryQuery(
  query: string,
  texts: readonly string[],
  embedder: MemoryEmbedder | null | undefined,
  signal?: AbortSignal,
): Promise<MemoryEmbeddingIndex> {
  const empty: MemoryEmbeddingIndex = {
    queryVector: null,
    vectors: new Map<string, number[]>(),
  };
  const trimmedQuery = prepareText(query);
  if (!embedder || !trimmedQuery) return empty;

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (text.length < MEMORY_RERANK_MIN_EMBED_CHARS) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    unique.push(text);
    if (unique.length >= MEMORY_RERANK_MAX_EMBED_TEXTS) break;
  }
  if (unique.length === 0) return empty;

  let raw: number[][] | null;
  try {
    raw = await embedder.embed(
      [trimmedQuery, ...unique],
      embeddingSignal(signal),
    );
  } catch {
    // Recall must never fail because the provider failed.
    return empty;
  }
  if (!Array.isArray(raw) || raw.length !== unique.length + 1) return empty;
  const queryVector = raw[0];
  if (!validVector(queryVector)) return empty;

  const vectors = new Map<string, number[]>();
  unique.forEach((text, index) => {
    const vector = raw?.[index + 1];
    if (validVector(vector)) vectors.set(text, vector);
  });
  if (vectors.size === 0) return empty;
  return { queryVector, vectors };
}

/**
 * Lexical base plus optional semantic blend.
 *
 * Rerank applies only when the query produced needles and vectors exist. The
 * embedded candidates get `0.6 * cosine + 0.4 * lexical/maxLexical`; shorter
 * candidates that were deliberately not embedded keep `lexical/maxLexical`, so
 * they are neither boosted nor punished for having no vector.
 */
export async function rankByRelevance<T>(
  query: string,
  items: T[],
  options: MemoryRankOptions<T>,
): Promise<MemoryRankResult<T>[]> {
  const limit = Math.floor(Number(options.limit));
  if (!Number.isFinite(limit) || limit <= 0 || items.length === 0) return [];

  const lexical = lexicalCandidates(items, options);
  let queryVector = options.queryVector ?? null;
  let vectors = options.vectors ?? null;

  if (
    options.needles.length > 0 &&
    (!queryVector || !vectors || vectors.size === 0) &&
    options.embed
  ) {
    const index = await embedMemoryQuery(
      query,
      embeddingTexts(lexical.slice(0, MEMORY_RERANK_MAX_CANDIDATES)),
      options.embed,
      options.signal,
    );
    queryVector = index.queryVector;
    vectors = index.vectors;
  }

  if (options.needles.length === 0 || !queryVector || !vectors || vectors.size === 0) {
    return lexical
      .slice(0, limit)
      .map((candidate) => ({ item: candidate.item, score: candidate.lexical }));
  }

  const pool = lexical.slice(0, MEMORY_RERANK_MAX_CANDIDATES);
  const maxLexical = pool.reduce(
    (max, candidate) => Math.max(max, candidate.lexical),
    0,
  );
  const normalize = (score: number): number =>
    maxLexical > 0 ? clamp01(score / maxLexical) : 0;

  const reranked = pool.map((candidate) => {
    const lexicalNormalized = normalize(candidate.lexical);
    const vector = vectors.get(candidate.text);
    if (!vector) return { ...candidate, score: lexicalNormalized };
    const cosine = clamp01(cosineSimilarity(queryVector, vector));
    return {
      ...candidate,
      score:
        MEMORY_RERANK_COSINE_WEIGHT * cosine +
        MEMORY_RERANK_LEXICAL_WEIGHT * lexicalNormalized,
    };
  });
  // Blended score first, then lexical quality, then the stable DB order/id.
  reranked.sort(
    (a, b) =>
      b.score - a.score ||
      b.lexical - a.lexical ||
      a.index - b.index ||
      compareIds(a.id, b.id),
  );

  const results: MemoryRankResult<T>[] = reranked
    .slice(0, limit)
    .map(({ item, score }) => ({ item, score }));

  // Callers may ask for more than the rerank cap (limits are capped at 50).
  // Fill the tail in lexical order; those items were never embedded.
  if (results.length < limit) {
    for (const candidate of lexical.slice(pool.length)) {
      if (results.length >= limit) break;
      results.push({ item: candidate.item, score: normalize(candidate.lexical) });
    }
  }
  return results;
}
