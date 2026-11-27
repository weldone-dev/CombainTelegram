/**
 * Deterministic memory lifecycle primitives for the Eve agent.
 *
 * Nest owns the database; this module is the model-free fallback the agent can
 * run locally (and the reference implementation the Nest mirror is tested
 * against). It must stay in sync with
 * `apps/api/src/eve/eve-memory-lifecycle.service.ts` — the two apps cannot
 * import each other, so both files carry the same marker lists and the same
 * fixtures in their tests.
 *
 * Nothing here does I/O: strings in, plain data out.
 */

import { createHash } from 'node:crypto';
import type { MemoryContext } from '../persona/types';

/** Below this many characters a day is not worth summarising. */
export const MEMORY_MIN_LOG_CHARS = 50;
/** Palace mining reads the log in chunks of this size. */
export const PALACE_CHUNK_CHARS = 12_000;
/** Upper bound of drawers extracted from one chunk. */
export const PALACE_MAX_SENTENCES = 80;

const MAX_TOPICS = 6;
const MAX_FACTS_PER_DAY = 8;
const MAX_KEYWORDS = 5;
const MAX_SENTENCE_CHARS = 400;
const DAILY_EXCERPT_CHARS = 240;

export type PalaceHall =
  | 'facts'
  | 'events'
  | 'preferences'
  | 'promises'
  | 'open_loops'
  | 'feelings';

export interface DailySummary {
  day: string;
  chars: number;
  feeling: string;
  topics: string[];
  facts: string[];
  conflict: string;
  highlight: string;
}

export interface PalaceDrawerDraft {
  /** Stable id: `sha1(personaId + "\n" + quote)[:16]`. */
  id: string;
  hall: PalaceHall;
  wing: string;
  room: string;
  content: string;
  keywords: string[];
  /** 1..10. */
  salience: number;
}

export interface RetrievedMemoryItem {
  id: string;
  kind: 'fact' | 'daily' | 'palace' | 'episode' | 'cross-chat' | string;
  text: string;
  score: number;
  date?: string;
  hall?: string;
  salience?: number;
  keywords?: string[];
}

export interface RelationshipSnapshot {
  stage: string;
  interest: number;
  trust: number;
  attraction: number;
  annoyance: number;
  cringe: number;
  notes: string;
}

/** Shape returned by Nest `POST /internal/eve/memory/retrieve`. */
export interface MemoryRetrievalSnapshot {
  summary: string;
  relationship: RelationshipSnapshot | null;
  facts: RetrievedMemoryItem[];
  daily: RetrievedMemoryItem[];
  palace: RetrievedMemoryItem[];
  episodes: RetrievedMemoryItem[];
  crossChat: RetrievedMemoryItem[];
}

// ---------------------------------------------------------------------------
// Tokens and keywords
// ---------------------------------------------------------------------------

const TOKEN_SPLIT = /[^a-zа-яё0-9]+/;
const ROLE_PREFIX =
  /^(?:->\s*)?(?:\[[^\]]+\]\s*)?(?:user|assistant|agent|system|он|она|proactive)(?:\([^)]*\))?\s*:\s*/i;
const COMMENT = /<!--[\s\S]*?-->/g;

const STOPWORDS = new Set([
  'а', 'без', 'более', 'больше', 'будет', 'будто', 'бы', 'был', 'была', 'были',
  'было', 'быть', 'в', 'вам', 'вас', 'ведь', 'весь', 'вот', 'впрочем', 'все',
  'всё', 'всегда', 'всего', 'всех', 'всю', 'вы', 'где', 'да', 'даже', 'два',
  'для', 'до', 'другой', 'его', 'ее', 'её', 'ей', 'ему', 'если', 'есть', 'еще',
  'ещё', 'же', 'за', 'зачем', 'здесь', 'и', 'из', 'или', 'им', 'иногда', 'их',
  'к', 'как', 'какая', 'какой', 'когда', 'конечно', 'кто', 'куда', 'ли',
  'лучше', 'между', 'меня', 'мне', 'много', 'мой', 'моя', 'мы', 'на', 'над',
  'надо', 'наконец', 'нас', 'не', 'него', 'нее', 'неё', 'нельзя', 'нет', 'ни',
  'нибудь', 'никогда', 'ним', 'них', 'ничего', 'но', 'ну', 'о', 'об', 'один',
  'он', 'она', 'они', 'опять', 'от', 'перед', 'по', 'под', 'позже', 'потом',
  'потому', 'почти', 'при', 'про', 'раз', 'разве', 'сам', 'себе', 'себя',
  'сейчас', 'со', 'совсем', 'так', 'там', 'тебя', 'тем', 'теперь', 'то',
  'тогда', 'того', 'тоже', 'только', 'том', 'тот', 'тут', 'ты', 'у', 'уж',
  'уже', 'хоть', 'чего', 'чем', 'через', 'что', 'чтоб', 'чтобы', 'чуть', 'эта',
  'эти', 'это', 'этого', 'этой', 'этом', 'этот', 'эту', 'я',
]);

const PERSONAL_WORDS = new Set([
  'я', 'мне', 'меня', 'мной', 'мною', 'мой', 'моя', 'моё', 'мое', 'мои',
  'моих', 'моим', 'моей', 'мою',
]);

const NOT_NAMES = new Set([
  'ага', 'да', 'завтра', 'конечно', 'нет', 'нормально', 'ну', 'он', 'она',
  'они', 'привет', 'сегодня', 'спасибо', 'хорошо', 'это', 'я',
]);

const PROMISE_MARKERS = [
  'обещ', 'договор', 'позвон', 'напиш', 'скину', 'приду', 'приеду', 'сделаю',
  'обязательно', 'встрет',
];

const PREFERENCE_MARKERS = [
  'любл', 'люблю', 'нравит', 'ненавиж', 'обожа', 'предпочита', 'не люблю',
];

const FEELING_MARKERS = [
  'чувств', 'скучн', 'скуча', 'обид', 'злит', 'бесит', 'раздража', 'нрав',
  'рад', 'страшн', 'тревог', 'устал', 'груст', 'приятн', 'тепло', 'холодн',
];

const CONFLICT_MARKERS = [
  'обид', 'ссор', 'поруга', 'игнор', 'не пиши', 'достал', 'бесит', 'раздража',
  'кринж', 'извин', 'наорал', 'хамств',
];

const HESITATION_MARKERS = [
  'не знаю', 'не решил', 'не решила', 'надо решить', 'может', 'хз',
  'как-нибудь', 'придётся', 'придется', 'получится',
];

const EVENT_MARKERS = [
  'сходил', 'сходила', 'ходил', 'ходила', 'был', 'была', 'ездил', 'ездила',
  'поехал', 'поехала', 'поед', 'приехал', 'приехала', 'приех', 'встрет',
  'соревнова', 'тренировк', 'работ', 'учёб', 'учеб', 'экзамен', 'день рожд',
  'вчера', 'сегодня', 'завтра',
];

const POSITIVE_MARKERS = [
  'хорош', 'рад', 'нрав', 'любл', 'приятн', 'смешн', 'ахах', 'пхпх', 'класс',
  'супер', 'обня', 'скуча', 'мил', 'тепло',
];

const NEGATIVE_MARKERS = [
  'плох', 'обид', 'зл', 'бесит', 'достал', 'устал', 'груст', 'скучн', 'ссор',
  'игнор', 'кринж', 'не пиши',
];

export function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(TOKEN_SPLIT)
    .filter((token) => token.length > 0);
}

export function queryTokens(query: string): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens(query)) {
    if (token.length < 3) continue;
    if (STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    unique.push(token);
  }
  return unique;
}

/** Plain frequency ranking with a stable alphabetical tie-break. */
export function extractKeywords(value: string, max = MAX_KEYWORDS): string[] {
  const counts = new Map<string, number>();
  for (const token of tokens(value)) {
    if (token.length < 3) continue;
    if (STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => {
      const byCount = b[1] - a[1];
      if (byCount !== 0) return byCount;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    })
    .slice(0, max)
    .map(([word]) => word);
}

// ---------------------------------------------------------------------------
// Sentences and classification
// ---------------------------------------------------------------------------

/** Strips log formatting (`user:`, `-> она:`, `[proactive]`, HTML comments). */
export function normalizeLine(line: string): string {
  return line
    .replace(COMMENT, ' ')
    .replace(ROLE_PREFIX, '')
    .replace(/^\s*\[[^\]]+\]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitChunks(value: string, size = PALACE_CHUNK_CHARS): string[] {
  const text = value.trim();
  if (!text) return [];
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const cut = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf('? '),
      window.lastIndexOf('! '),
    );
    const end = cut > size / 2 ? cut + 1 : size;
    const chunk = rest.slice(0, end).trim();
    if (chunk) chunks.push(chunk);
    rest = rest.slice(end).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function extractSentences(
  value: string,
  max = PALACE_MAX_SENTENCES,
): string[] {
  const parts = value
    .replace(/\r/g, '')
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((part) => part.replace(/^\s*[-—•]\s*/, '').trim())
    .filter((part) => part.length >= 8);
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const key = part.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(part.slice(0, MAX_SENTENCE_CHARS));
    if (unique.length >= max) break;
  }
  return unique;
}

function includesMarker(value: string, markers: string[]): boolean {
  const lower = value.toLowerCase();
  return markers.some((marker) => lower.includes(marker));
}

/**
 * Hall priority is deliberate: an explicit promise beats a preference, a
 * preference beats an emotion, and a plain question only becomes an open loop
 * when it also carries hesitation/planning words.
 */
export function classifyHall(value: string): PalaceHall {
  if (includesMarker(value, PROMISE_MARKERS)) return 'promises';
  if (includesMarker(value, PREFERENCE_MARKERS)) return 'preferences';
  if (includesMarker(value, FEELING_MARKERS)) return 'feelings';
  const isQuestion = value.includes('?');
  if (isQuestion && includesMarker(value, HESITATION_MARKERS)) return 'open_loops';
  if (includesMarker(value, EVENT_MARKERS)) return 'events';
  if (includesMarker(value, HESITATION_MARKERS)) return 'open_loops';
  return 'facts';
}

export function hasConflictMarker(value: string): boolean {
  return includesMarker(value, CONFLICT_MARKERS);
}

function looksPersonal(value: string): boolean {
  return tokens(value).some((token) => PERSONAL_WORDS.has(token));
}

function looksLikeName(value: string): boolean {
  const words = value
    .replace(/[«»"'().,;:!?—–]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  return words.some(
    (word, index) =>
      index > 0 &&
      /^[А-ЯЁA-Z][а-яёa-z]{2,14}$/.test(word) &&
      !NOT_NAMES.has(word.toLowerCase()),
  );
}

function isFactSentence(value: string): boolean {
  if (value.trim().endsWith('?')) return false;
  return looksPersonal(value) || looksLikeName(value);
}

/**
 * Greetings and small talk questions ("как прошёл день?") are not memories.
 */
function isNoiseQuestion(value: string): boolean {
  if (!value.trim().endsWith('?')) return false;
  if (looksPersonal(value) || looksLikeName(value)) return false;
  if (hasConflictMarker(value)) return false;
  if (includesMarker(value, FEELING_MARKERS)) return false;
  if (includesMarker(value, PREFERENCE_MARKERS)) return false;
  if (includesMarker(value, HESITATION_MARKERS)) return false;
  return true;
}

/** Salience 1..10: promises and personal statements stick, filler does not. */
export function scoreSalience(value: string, hall: PalaceHall): number {
  let score = 3;
  if (hall === 'promises') score += 3;
  if (hall === 'open_loops') score += 2;
  if (hall === 'feelings' || hall === 'events') score += 1;
  if (hall === 'preferences') score += 1;
  if (looksPersonal(value)) score += 2;
  if (looksLikeName(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (value.length > 120) score += 1;
  if (hasConflictMarker(value)) score += 1;
  return Math.max(1, Math.min(10, score));
}

/** Stable drawer id: `sha1(personaId + "\n" + quote)` truncated to 16 chars. */
export function drawerIdFor(personaId: string, quote: string): string {
  return createHash('sha1')
    .update(`${personaId}\n${quote}`)
    .digest('hex')
    .slice(0, 16);
}

export interface MineOptions {
  /** `primary-<chatId>`; defaults to `primary-unknown`. */
  wing?: string;
  /** Cards per 12k chunk, default {@link PALACE_MAX_SENTENCES}. */
  maxPerChunk?: number;
}

export function minePalace(
  personaId: string,
  lines: string[],
  options: MineOptions = {},
): PalaceDrawerDraft[] {
  const wing = options.wing ?? 'primary-unknown';
  const maxPerChunk = options.maxPerChunk ?? PALACE_MAX_SENTENCES;
  const text = lines
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .join('\n');
  const drafts: PalaceDrawerDraft[] = [];
  const seen = new Set<string>();
  for (const chunk of splitChunks(text)) {
    for (const sentence of extractSentences(chunk, maxPerChunk)) {
      const content = sentence.slice(0, MAX_SENTENCE_CHARS);
      if (isNoiseQuestion(content)) continue;
      const id = drawerIdFor(personaId, content);
      if (seen.has(id)) continue;
      seen.add(id);
      const hall = classifyHall(content);
      const keywords = extractKeywords(content, MAX_KEYWORDS);
      drafts.push({
        id,
        hall,
        wing,
        room: (keywords[0] ?? hall).slice(0, 32),
        content,
        keywords,
        salience: scoreSalience(content, hall),
      });
    }
  }
  return drafts;
}

// ---------------------------------------------------------------------------
// Daily summary
// ---------------------------------------------------------------------------

function countMarker(value: string, term: string): number {
  const lower = value.toLowerCase();
  let count = 0;
  let index = lower.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = lower.indexOf(term, index + term.length);
  }
  return count;
}

function totalMarkers(value: string, markers: string[]): number {
  return markers.reduce((sum, marker) => sum + countMarker(value, marker), 0);
}

export function extractFacts(
  lines: string[],
  max = MAX_FACTS_PER_DAY,
): string[] {
  const facts: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = normalizeLine(line);
    for (const sentence of extractSentences(normalized, 200)) {
      if (!isFactSentence(sentence)) continue;
      const fact = sentence
        .replace(/\s+/g, ' ')
        .replace(/[;.,]+$/, '')
        .trim();
      if (fact.length < 8) continue;
      const key = fact.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(fact.slice(0, 300));
      if (facts.length >= max) return facts;
    }
  }
  return facts;
}

/** Short conflict note: the first sentence that carries a conflict marker. */
export function conflictNote(lines: string[]): string {
  for (const line of lines) {
    const normalized = normalizeLine(line);
    for (const sentence of extractSentences(normalized, 50)) {
      if (hasConflictMarker(sentence)) return sentence.slice(0, 200);
    }
  }
  return '';
}

export function feelingOf(value: string, conflict: string): string {
  if (conflict) return 'напряжённо';
  const positive = totalMarkers(value, POSITIVE_MARKERS);
  const negative = totalMarkers(value, NEGATIVE_MARKERS);
  if (positive > negative + 1) return 'тепло и живо';
  if (negative > positive + 1) return 'тяжеловато';
  return 'ровно';
}

/**
 * Summarises one session day. Returns `null` when the log is below
 * {@link MEMORY_MIN_LOG_CHARS}, which is the same gate Nest applies.
 */
export function summarizeDay(
  lines: string[],
  day: string,
): DailySummary | null {
  const text = lines
    .map((line) => normalizeLine(line))
    .filter(Boolean)
    .join('\n')
    .trim();
  const chars = text.length;
  if (chars < MEMORY_MIN_LOG_CHARS) return null;
  const sentences = extractSentences(text, 400);
  const conflict = conflictNote(lines);
  let highlight = '';
  let best = -1;
  for (const sentence of sentences) {
    const score =
      scoreSalience(sentence, classifyHall(sentence)) +
      Math.min(3, Math.floor(sentence.length / 80));
    if (score > best) {
      best = score;
      highlight = sentence;
    }
  }
  return {
    day,
    chars,
    feeling: feelingOf(text, conflict),
    topics: extractKeywords(text, MAX_TOPICS),
    facts: extractFacts(lines),
    conflict,
    highlight: highlight.slice(0, 240),
  };
}

export function renderDailyMarkdown(summary: DailySummary): string {
  const list = (items: string[]): string =>
    items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '—';
  return [
    `# Дневник — ${summary.day}`,
    '',
    '## Ощущение',
    summary.feeling,
    '',
    '## О чём говорили',
    list(summary.topics),
    '',
    '## Новое о нём',
    list(summary.facts),
    '',
    '## Момент дня',
    summary.highlight || '—',
    '',
    '## Конфликт',
    summary.conflict || 'нет',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export function scoreText(content: string, needles: string[]): number {
  if (needles.length === 0) return 0;
  const lower = content.toLowerCase();
  const words = new Set(tokens(content));
  const stems = new Set<string>();
  for (const word of words) {
    if (word.length >= 5) stems.add(word.slice(0, 5));
  }
  let score = 0;
  for (const needle of needles) {
    if (words.has(needle)) score += 5;
    else if (lower.includes(needle)) score += 3;
    // Russian inflection: "плавание" and "плаванию" share the first five
    // characters, which is enough for a deterministic fuzzy hit.
    else if (needle.length >= 5 && stems.has(needle.slice(0, 5))) score += 2;
  }
  return score;
}

export function excerpt(
  value: string,
  needles: string[],
  max = DAILY_EXCERPT_CHARS,
): string {
  const text = value.trim();
  if (text.length <= max) return text;
  const lower = text.toLowerCase();
  let at = -1;
  for (const needle of needles) {
    const index = lower.indexOf(needle);
    if (index !== -1 && (at === -1 || index < at)) at = index;
  }
  if (at === -1) return `${text.slice(0, max)}…`;
  const start = Math.max(0, at - 80);
  return `${start > 0 ? '…' : ''}${text.slice(start, start + max)}…`;
}

export interface RankOptions<T> {
  text: (item: T) => string;
  base?: (item: T, index: number) => number;
  limit: number;
}

/** Sorts by keyword score, then by the incoming (recency) order. */
export function rankByKeywords<T>(
  items: T[],
  query: string,
  options: RankOptions<T>,
): Array<{ item: T; score: number }> {
  const needles = queryTokens(query);
  const scored = items.map((item, index) => ({
    item,
    index,
    score: scoreText(options.text(item), needles) + (options.base?.(item, index) ?? 0),
  }));
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored
    .slice(0, Math.max(0, options.limit))
    .map(({ item, score }) => ({ item, score }));
}

/**
 * Local fallback when Nest has already sent the retrieval payload: turns it
 * into the strings `buildSystemPrompt` expects.
 */
export function toMemoryContext(
  snapshot: MemoryRetrievalSnapshot,
): MemoryContext {
  const join = (items: RetrievedMemoryItem[]): string =>
    items.map((item) => item.text).filter(Boolean).join('\n');
  const palaceItems = snapshot.palace.filter(
    (item) => item.hall !== 'promises' && item.hall !== 'open_loops',
  );
  const promises = snapshot.palace.filter((item) => item.hall === 'promises');
  const openLoops = snapshot.palace.filter((item) => item.hall === 'open_loops');
  const relationship = snapshot.relationship;
  const context: MemoryContext = {};
  const facts = join(snapshot.facts);
  if (facts) context.facts = facts;
  const episodes = join(snapshot.episodes);
  if (episodes) context.episodes = episodes;
  if (relationship) {
    context.timeline = `стадия ${relationship.stage}; доверие ${relationship.trust}; интерес ${relationship.interest}`;
    if (relationship.notes.trim()) context.attachment = relationship.notes.trim();
  }
  const palace = join(palaceItems);
  if (palace) context.palace = palace;
  const daily = join(snapshot.daily);
  if (daily) context.dailySummaries = daily;
  const cross = join(snapshot.crossChat);
  if (cross) context.crossChat = cross;
  const promiseText = join(promises);
  if (promiseText) context.promises = promiseText;
  const loopText = join(openLoops);
  if (loopText) context.openLoops = loopText;
  return context;
}

/** Facts worth storing after every sixth turn, deduped against known ones. */
export function selectReflectionFacts(
  lines: string[],
  existing: string[],
  limit = 3,
): string[] {
  const seen = new Set(existing.map((content) => content.toLowerCase()));
  const picked: string[] = [];
  for (const candidate of extractFacts(lines)) {
    const key = candidate.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(candidate);
    if (picked.length >= limit) break;
  }
  return picked;
}
