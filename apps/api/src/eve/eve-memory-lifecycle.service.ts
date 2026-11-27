import { createHash } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { apiError, notFound } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseChatId } from './eve-access.js';
import { EveLlmService } from './eve-llm.service.js';
import {
  type MemoryEmbeddingIndex,
  type MemoryRankOptions,
  embedMemoryQuery,
  embeddingTexts,
  rankByRelevance,
  selectRankCandidates,
} from './eve-memory-rank.js';

/**
 * Deterministic memory lifecycle for a girl-agent persona.
 *
 * Everything here works without an LLM: a day log is summarised with keyword
 * and sentence heuristics, palace drawers are classified by marker words, and
 * retrieval is keyword scoring. When the provider exposes an embeddings
 * endpoint the same lexical candidates are re-ranked semantically (see
 * `eve-memory-rank.ts`); without one the keyword ordering is unchanged.
 *
 * The same pure algorithms exist in `apps/eve/agent/lib/memory/lifecycle.ts`
 * for the local agent fallback. The two apps cannot import each other, so the
 * helper functions below are duplicated on purpose: keep both files in sync
 * and keep the shared fixtures in the specs identical.
 */

/** Below this many characters a day is not worth summarising. */
export const MEMORY_MIN_LOG_CHARS = 50;
/** Palace mining reads the log in chunks of this size. */
export const PALACE_CHUNK_CHARS = 12_000;
/** Upper bound of drawers extracted from one chunk. */
export const PALACE_MAX_SENTENCES = 80;
/** Reflection runs on every Nth session log row. */
export const REFLECT_EVERY_TURNS = 6;

const MAX_TOPICS = 6;
const MAX_FACTS_PER_DAY = 8;
const MAX_KEYWORDS = 5;
const MAX_REFLECT_FACTS = 3;
const REFLECT_HISTORY = 12;
const REFLECT_NOTES_LIMIT = 2000;
const DAILY_EXCERPT_CHARS = 240;
const MAX_SENTENCE_CHARS = 400;
const DAILY_MARKER = 'daily-memory-closed';

/**
 * Old captures stored model reasoning and engine frames next to real turns.
 * They are not memories: drop those lines before ranking, excerpting and
 * rendering, so a recall can never quote "Now the deleted text was…".
 */
const MEMORY_NOISE_LINE =
  /^(?:the user|i should|i need|let me|content:|good\s*[—-]|okay,|hmm,|maybe:|now the deleted|the deleted text was|keep it short|avoid lists|no period)/i;
const MEMORY_SERVICE_LINE = /\[internal:|reasoning_content/i;
/** Reasoning glued to the end of a stored line: cut it, keep the real text. */
const MEMORY_INLINE_NOISE =
  /\s*(?:Good\s*[—-]|The user says|Now the deleted text|The deleted text was|Content:).*$/i;

/** An old deletion hint, not a durable fact about him. */
const MEMORY_DELETION_HINT = /(?:удалил|deleted)/i;

export function stripMemoryNoise(value: string): string {
  return value
    .split('\n')
    .map((line) =>
      line
        .replace(MEMORY_INLINE_NOISE, '')
        // `---` separates Telegram bubbles, never facts. It also looks like a
        // markdown rule and leaked into memories from old assistant replies.
        .replace(/\s*---\s*/g, ' ')
        .trim(),
    )
    .filter((line) => {
      if (line.length === 0) return false;
      if (MEMORY_NOISE_LINE.test(line) || MEMORY_SERVICE_LINE.test(line)) {
        return false;
      }
      // Keep a real "он удалил" statement only when it is a plain sentence;
      // transcript-looking deletion hints are leftovers from old reasoning.
      return !(
        MEMORY_DELETION_HINT.test(line) &&
        /---|«|"|`/.test(line)
      );
    })
    .join('\n');
}

export type PalaceHall =
  'facts' | 'events' | 'preferences' | 'promises' | 'open_loops' | 'feelings';

export interface DailyAnalysis {
  feeling: string;
  topics: string[];
  facts: string[];
  conflict: string;
  highlight: string;
}

export interface PalaceDraft {
  drawerId: string;
  wing: string;
  hall: PalaceHall;
  room: string;
  content: string;
  keywords: string[];
  salience: number;
}

export interface CloseDayResult {
  personaId: string;
  day: string;
  skipped: boolean;
  reason?: 'no-log' | 'too-short' | 'already-closed';
  chars: number;
  feeling: string;
  topics: string[];
  facts: number;
  drawers: number;
  episodes: number;
  timeItems: number;
  complete: boolean;
}

export interface RetrievedMemory {
  id: string;
  kind:
    | 'fact'
    | 'daily'
    | 'palace'
    | 'episode'
    | 'cross-chat'
    | 'time-item'
    | 'relationship-event';
  text: string;
  score: number;
  date?: string;
  /** Palace hall, or the time-item kind (`promise` / `open-loop`). */
  hall?: string;
  salience?: number;
  keywords?: string[];
}

export interface RelationshipView {
  id: string;
  scopeKey: string;
  stage: string;
  interest: number;
  trust: number;
  attraction: number;
  annoyance: number;
  cringe: number;
  notes: string;
}

export interface MemoryRetrieval {
  summary: string;
  relationship: RelationshipView | null;
  facts: RetrievedMemory[];
  daily: RetrievedMemory[];
  palace: RetrievedMemory[];
  episodes: RetrievedMemory[];
  crossChat: RetrievedMemory[];
  /** Open promises and open loops (`EveTimeItem`). */
  timeItems: RetrievedMemory[];
  /** Relationship milestones, newest first (`EveRelationshipEvent`). */
  events: RetrievedMemory[];
}

export interface RetrievalLimits {
  facts?: number;
  daily?: number;
  palace?: number;
  episodes?: number;
  crossChat?: number;
  timeItems?: number;
  events?: number;
}

export interface ReflectResult {
  reflected: boolean;
  turns: number;
  factsAdded: number;
  feeling: string;
  scopeKey?: string;
}

export interface AmnesiaResult {
  minutes: number;
  since: string;
  logs: number;
  facts: number;
  conflicts: number;
  conflictEvents: number;
  relationshipEvents: number;
  notes: number;
  agenda: number;
}

export interface ResetResult {
  personaId: string;
  removed: {
    sessionLogs: number;
    daily: number;
    facts: number;
    episodes: number;
    palace: number;
    timeItems: number;
    crossChat: number;
    conflictEvents: number;
    conflicts: number;
    relationshipEvents: number;
    relationships: number;
    agenda: number;
    proactive: number;
    sessionState: number;
    total: number;
  };
}

// ---------------------------------------------------------------------------
// Tokens and keywords
// ---------------------------------------------------------------------------

const TOKEN_SPLIT = /[^a-zа-яё0-9]+/;
const ROLE_PREFIX =
  /^(?:->\s*)?(?:\[[^\]]+\]\s*)?(?:user|assistant|agent|system|он|она|proactive)(?:\([^)]*\))?\s*:\s*/i;
const COMMENT = /<!--[\s\S]*?-->/g;

/** Russian and English function words that never make a good memory keyword. */
const STOPWORDS = new Set([
  'а',
  'без',
  'более',
  'больше',
  'будет',
  'будто',
  'бы',
  'был',
  'была',
  'были',
  'было',
  'быть',
  'в',
  'вам',
  'вас',
  'ведь',
  'весь',
  'вот',
  'впрочем',
  'все',
  'всё',
  'всегда',
  'всего',
  'всех',
  'всю',
  'вы',
  'где',
  'да',
  'даже',
  'два',
  'для',
  'до',
  'другой',
  'его',
  'ее',
  'её',
  'ей',
  'ему',
  'если',
  'есть',
  'еще',
  'ещё',
  'же',
  'за',
  'зачем',
  'здесь',
  'и',
  'из',
  'или',
  'им',
  'иногда',
  'их',
  'к',
  'как',
  'какая',
  'какой',
  'когда',
  'конечно',
  'кто',
  'куда',
  'ли',
  'лучше',
  'между',
  'меня',
  'мне',
  'много',
  'мой',
  'моя',
  'мы',
  'на',
  'над',
  'надо',
  'наконец',
  'нас',
  'не',
  'него',
  'нее',
  'неё',
  'нельзя',
  'нет',
  'ни',
  'нибудь',
  'никогда',
  'ним',
  'них',
  'ничего',
  'но',
  'ну',
  'о',
  'об',
  'один',
  'он',
  'она',
  'они',
  'опять',
  'от',
  'перед',
  'по',
  'под',
  'позже',
  'потом',
  'потому',
  'почти',
  'при',
  'про',
  'раз',
  'разве',
  'сам',
  'себе',
  'себя',
  'сейчас',
  'со',
  'совсем',
  'так',
  'там',
  'тебя',
  'тем',
  'теперь',
  'то',
  'тогда',
  'того',
  'тоже',
  'только',
  'том',
  'тот',
  'тут',
  'ты',
  'у',
  'уж',
  'уже',
  'хоть',
  'чего',
  'чем',
  'через',
  'что',
  'чтоб',
  'чтобы',
  'чуть',
  'эта',
  'эти',
  'это',
  'этого',
  'этой',
  'этом',
  'этот',
  'эту',
  'я',
]);

const PERSONAL_WORDS = new Set([
  'я',
  'мне',
  'меня',
  'мной',
  'мною',
  'мой',
  'моя',
  'моё',
  'мое',
  'мои',
  'моих',
  'моим',
  'моей',
  'мою',
]);

/** Capitalised words that are not names even mid-sentence. */
const NOT_NAMES = new Set([
  'ага',
  'да',
  'завтра',
  'конечно',
  'нет',
  'нормально',
  'ну',
  'он',
  'она',
  'они',
  'привет',
  'сегодня',
  'спасибо',
  'хорошо',
  'это',
  'я',
]);

const PROMISE_MARKERS = [
  'обещ',
  'договор',
  'позвон',
  'напиш',
  'скину',
  'приду',
  'приеду',
  'сделаю',
  'обязательно',
  'встрет',
];

const PREFERENCE_MARKERS = [
  'любл',
  'люблю',
  'нравит',
  'ненавиж',
  'обожа',
  'предпочита',
  'не люблю',
];

const FEELING_MARKERS = [
  'чувств',
  'скучн',
  'скуча',
  'обид',
  'злит',
  'бесит',
  'раздража',
  'нрав',
  'рад',
  'страшн',
  'тревог',
  'устал',
  'груст',
  'приятн',
  'тепло',
  'холодн',
];

const CONFLICT_MARKERS = [
  'обид',
  'ссор',
  'поруга',
  'игнор',
  'не пиши',
  'достал',
  'бесит',
  'раздража',
  'кринж',
  'извин',
  'наорал',
  'хамств',
];

const HESITATION_MARKERS = [
  'не знаю',
  'не решил',
  'не решила',
  'надо решить',
  'может',
  'хз',
  'как-нибудь',
  'придётся',
  'придется',
  'получится',
];

const EVENT_MARKERS = [
  'сходил',
  'сходила',
  'ходил',
  'ходила',
  'был',
  'была',
  'ездил',
  'ездила',
  'поехал',
  'поехала',
  'поед',
  'приехал',
  'приехала',
  'приех',
  'встрет',
  'соревнова',
  'тренировк',
  'работ',
  'учёб',
  'учеб',
  'экзамен',
  'день рожд',
  'вчера',
  'сегодня',
  'завтра',
];

const POSITIVE_MARKERS = [
  'хорош',
  'рад',
  'нрав',
  'любл',
  'приятн',
  'смешн',
  'ахах',
  'пхпх',
  'класс',
  'супер',
  'обня',
  'скуча',
  'мил',
  'тепло',
];

const NEGATIVE_MARKERS = [
  'плох',
  'обид',
  'зл',
  'бесит',
  'достал',
  'устал',
  'груст',
  'скучн',
  'ссор',
  'игнор',
  'кринж',
  'не пиши',
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

export function splitChunks(
  value: string,
  size = PALACE_CHUNK_CHARS,
): string[] {
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
  if (isQuestion && includesMarker(value, HESITATION_MARKERS))
    return 'open_loops';
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
 * A question survives only when it carries a personal statement, an emotion,
 * a preference, a plan or a conflict.
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

export function minePalace(
  personaId: string,
  wing: string,
  value: string,
  maxPerChunk = PALACE_MAX_SENTENCES,
): PalaceDraft[] {
  const drafts: PalaceDraft[] = [];
  const seen = new Set<string>();
  const text = value
    .split('\n')
    .map((line) => stripMemoryNoise(normalizeLine(line)))
    .filter(Boolean)
    .join('\n');
  for (const chunk of splitChunks(text)) {
    for (const sentence of extractSentences(chunk, maxPerChunk)) {
      const content = sentence.slice(0, MAX_SENTENCE_CHARS);
      if (isNoiseQuestion(content)) continue;
      const drawerId = drawerIdFor(personaId, content);
      if (seen.has(drawerId)) continue;
      seen.add(drawerId);
      const hall = classifyHall(content);
      const keywords = extractKeywords(content, MAX_KEYWORDS);
      drafts.push({
        drawerId,
        wing,
        hall,
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
    // Old captures may still contain model reasoning. Clean before splitting:
    // `normalizeLine` only removes the `user:`/`assistant:` prefix.
    const normalized = stripMemoryNoise(normalizeLine(line));
    if (!normalized) continue;
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

export function analyzeLog(lines: string[]): DailyAnalysis {
  const text = lines
    .map((line) => stripMemoryNoise(normalizeLine(line)))
    .filter(Boolean)
    .join('\n')
    .trim();
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
    feeling: feelingOf(text, conflict),
    topics: extractKeywords(text, MAX_TOPICS),
    facts: extractFacts(lines),
    conflict,
    highlight: highlight.slice(0, 240),
  };
}

export function renderDailyMarkdown(
  analysis: DailyAnalysis,
  day: string,
): string {
  const list = (items: string[]): string =>
    items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '—';
  return [
    `# Дневник — ${day}`,
    '',
    '## Ощущение',
    analysis.feeling,
    '',
    '## О чём говорили',
    list(analysis.topics),
    '',
    '## Новое о нём',
    list(analysis.facts),
    '',
    '## Момент дня',
    analysis.highlight || '—',
    '',
    '## Конфликт',
    analysis.conflict || 'нет',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Ranking
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

function excerpt(
  value: string,
  needles: string[],
  max = DAILY_EXCERPT_CHARS,
): string {
  const text = stripMemoryNoise(value).trim();
  if (!text) return '';
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

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, 50)
    : fallback;
}

function normalizeDay(value: string | undefined): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw apiError('EVE_DAY_INVALID', 'day must be YYYY-MM-DD');
  }
  return trimmed;
}

function toChatId(value: bigint | number | string): bigint {
  if (typeof value === 'bigint') {
    if (value === 0n) {
      throw apiError(
        'EVE_CHAT_ID_INVALID',
        'chatId must be a non-zero integer',
      );
    }
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value === 0) {
      throw apiError(
        'EVE_CHAT_ID_INVALID',
        'chatId must be a non-zero integer',
      );
    }
    return BigInt(value);
  }
  return parseChatId(value);
}

function parseKeywords(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function appendNote(current: string, line: string): string {
  const next = `${current.trim()}\n${line}`.trim();
  return next.length > REFLECT_NOTES_LIMIT
    ? next.slice(-REFLECT_NOTES_LIMIT)
    : next;
}

function stripRecentReflectNotes(notes: string, since: Date): string {
  const sinceDay = since.toISOString().slice(0, 10);
  return notes
    .split('\n')
    .filter((line) => {
      const match = /^\[reflect (\d{4}-\d{2}-\d{2})\]/.exec(line.trim());
      return !match || (match[1] ?? '') < sinceDay;
    })
    .join('\n')
    .trim();
}

/**
 * Owns the write side of persona memory: daily close, palace mining,
 * reflection and amnesia. Reads are exposed through {@link retrieve} so the
 * Eve channel can build a prompt block without touching Prisma.
 *
 * Deliberately **not** registered in `EveModule` yet: importing this file is
 * side-effect free. See `docs/eve/handoff-memory-lifecycle.md` for the exact
 * routes that wire it in.
 */
@Injectable()
export class EveMemoryLifecycleService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(EveMemoryLifecycleService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    // Optional so recall still works when no AI provider is registered; the
    // module wires `EveLlmService` in, and `embed()` itself no-ops without one.
    @Optional() private readonly llm?: EveLlmService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.closeStaleDays();
    }, 30 * 60_000);
    this.timer.unref?.();
    void this.closeStaleDays();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * Closes every previous day that still has session rows. A grown day is
   * re-closed by `closeDay`, so evening messages are not lost after a restart.
   */
  async closeStaleDays(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let closed = 0;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const rows = await this.prisma.eveSessionLog.findMany({
        where: { day: { not: today } },
        select: {
          personaId: true,
          accountId: true,
          chatId: true,
          day: true,
        },
        distinct: ['personaId', 'accountId', 'chatId', 'day'],
        orderBy: { day: 'asc' },
        take: 100,
      });
      for (const row of rows) {
        try {
          const result = await this.closeDay(
            row.personaId,
            row.accountId,
            row.chatId,
            row.day,
          );
          if (!result.skipped) closed += 1;
        } catch (error) {
          this.logger.warn(
            `closeDay ${row.personaId}/${row.day} failed: ${(error as Error).message}`,
          );
        }
      }
    } catch (error) {
      this.logger.warn(`closeStaleDays failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
    return closed;
  }

  private async assertPersona(personaId: string): Promise<void> {
    const persona = await this.prisma.evePersona.findUnique({
      where: { id: personaId },
      select: { id: true },
    });
    if (!persona) {
      throw notFound('EVE_PERSONA_NOT_FOUND', 'Eve persona not found');
    }
  }

  // -------------------------------------------------------------------------
  // Day closing
  // -------------------------------------------------------------------------

  /**
   * Summarises one session day, mines the palace and mirrors the durable
   * layers (facts, episodes, promises/open loops). Idempotent: the daily row is
   * keyed by `(personaId, day)`, drawers by `(personaId, drawerId)` and facts by
   * normalised content.
   */
  async closeDay(
    personaId: string,
    accountId: string,
    chatId: bigint | number | string,
    day?: string,
  ): Promise<CloseDayResult> {
    const persona = personaId.trim();
    if (!persona) {
      throw apiError('EVE_PERSONA_REQUIRED', 'personaId is required');
    }
    await this.assertPersona(persona);
    const account = accountId.trim();
    if (!account) {
      throw apiError('EVE_ACCOUNT_REQUIRED', 'accountId is required');
    }
    const chat = toChatId(chatId);
    const date = normalizeDay(day);

    const logs = await this.prisma.eveSessionLog.findMany({
      where: {
        personaId: persona,
        accountId: account,
        chatId: chat,
        day: date,
      },
      orderBy: { createdAt: 'asc' },
      select: { line: true },
    });
    const lines = logs.map((row) => row.line);
    const chars = lines.join('\n').trim().length;
    const empty: CloseDayResult = {
      personaId: persona,
      day: date,
      skipped: true,
      chars,
      feeling: '',
      topics: [],
      facts: 0,
      drawers: 0,
      episodes: 0,
      timeItems: 0,
      complete: false,
    };
    if (logs.length === 0) return { ...empty, reason: 'no-log' };
    if (chars < MEMORY_MIN_LOG_CHARS) {
      return { ...empty, reason: 'too-short' };
    }

    const analysis = analyzeLog(lines);
    const markdown = renderDailyMarkdown(analysis, date);
    const json = JSON.stringify({
      day: date,
      feeling: analysis.feeling,
      topics: analysis.topics,
      facts: analysis.facts,
      conflict: analysis.conflict,
      highlight: analysis.highlight,
      chars,
    });

    const existing = await this.prisma.eveMemoryDaily.findUnique({
      where: { personaId_date: { personaId: persona, date } },
      select: { complete: true, json: true },
    });
    if (existing?.complete === true && existing.json === json) {
      return {
        ...empty,
        complete: true,
        feeling: analysis.feeling,
        topics: analysis.topics,
        reason: 'already-closed',
      };
    }

    await this.prisma.eveMemoryDaily.upsert({
      where: { personaId_date: { personaId: persona, date } },
      create: { personaId: persona, date, markdown, json },
      update: { markdown, json },
    });

    const drafts = minePalace(
      persona,
      `primary-${chat.toString()}`,
      lines.join('\n'),
    );
    for (const draft of drafts) {
      await this.prisma.evePalaceDrawer.upsert({
        where: {
          personaId_drawerId: { personaId: persona, drawerId: draft.drawerId },
        },
        create: {
          personaId: persona,
          drawerId: draft.drawerId,
          wing: draft.wing,
          hall: draft.hall,
          room: draft.room,
          content: draft.content,
          keywords: JSON.stringify(draft.keywords),
          salience: draft.salience,
          source: 'daily-mine',
          hash: draft.drawerId,
        },
        update: {
          wing: draft.wing,
          hall: draft.hall,
          room: draft.room,
          content: draft.content,
          keywords: JSON.stringify(draft.keywords),
          salience: draft.salience,
        },
      });
    }

    const factDrafts = drafts.filter(
      (draft) => draft.hall === 'facts' || draft.hall === 'preferences',
    );
    const knownFacts = await this.prisma.eveMemoryFact.findMany({
      where: { personaId: persona },
      select: { content: true },
    });
    const seenFacts = new Set(
      knownFacts.map((row) => row.content.toLowerCase()),
    );
    let facts = 0;
    for (const draft of factDrafts) {
      const key = draft.content.toLowerCase();
      if (seenFacts.has(key)) continue;
      seenFacts.add(key);
      await this.prisma.eveMemoryFact.create({
        data: {
          personaId: persona,
          kind: draft.hall === 'preferences' ? 'preference' : 'fact',
          content: draft.content,
          importance: Math.min(5, Math.max(1, Math.ceil(draft.salience / 2))),
          source: 'daily-mine',
        },
      });
      facts += 1;
    }

    const episodeLines = drafts
      .filter((draft) => draft.hall === 'events' || draft.hall === 'feelings')
      .slice(0, 6)
      .map((draft) => `- ${draft.content}`);
    let episodes = 0;
    if (episodeLines.length > 0) {
      const content = episodeLines.join('\n');
      await this.prisma.eveEpisode.upsert({
        where: { personaId_date: { personaId: persona, date } },
        create: { personaId: persona, date, content },
        update: { content },
      });
      episodes = 1;
    }

    let timeItems = 0;
    for (const draft of drafts) {
      if (draft.hall !== 'promises' && draft.hall !== 'open_loops') continue;
      const kind = draft.hall === 'promises' ? 'promise' : 'open-loop';
      const duplicate = await this.prisma.eveTimeItem.findFirst({
        where: {
          personaId: persona,
          kind,
          content: draft.content,
          status: 'open',
        },
        select: { id: true },
      });
      if (duplicate) continue;
      await this.prisma.eveTimeItem.create({
        data: {
          personaId: persona,
          kind,
          content: draft.content,
          status: 'open',
        },
      });
      timeItems += 1;
    }

    await this.prisma.eveMemoryDaily.update({
      where: { personaId_date: { personaId: persona, date } },
      data: { complete: true },
    });
    await this.prisma.eveProactiveState.upsert({
      where: {
        personaId_date_marker: {
          personaId: persona,
          date,
          marker: DAILY_MARKER,
        },
      },
      create: { personaId: persona, date, marker: DAILY_MARKER },
      update: {},
    });
    this.logger.log(
      `Closed day ${date} for ${persona}: ${facts} facts, ${drafts.length} drawers, ${timeItems} time items`,
    );

    return {
      personaId: persona,
      day: date,
      skipped: false,
      chars,
      feeling: analysis.feeling,
      topics: analysis.topics,
      facts,
      drawers: drafts.length,
      episodes,
      timeItems,
      complete: true,
    };
  }

  // -------------------------------------------------------------------------
  // Retrieval
  // -------------------------------------------------------------------------

  /**
   * Recall for the prompt: `summary` + `relationship` are always returned, the
   * rest is truncated to the requested limits. Ordering is lexical, optionally
   * re-ranked by embeddings when the provider exposes them.
   */
  async retrieve(
    personaId: string,
    scopeKey: string,
    query: string,
    limits: RetrievalLimits = {},
  ): Promise<MemoryRetrieval> {
    const persona = personaId.trim();
    if (!persona) {
      throw apiError('EVE_PERSONA_REQUIRED', 'personaId is required');
    }
    await this.assertPersona(persona);
    const needles = queryTokens(query);
    const scope = scopeKey.trim();
    const relationship = scope
      ? await this.prisma.eveRelationship.findUnique({
          where: {
            personaId_scopeKey: { personaId: persona, scopeKey: scope },
          },
        })
      : null;

    const relationshipId = relationship?.id;
    const [
      factRows,
      dailyRows,
      palaceRows,
      episodeRows,
      crossRows,
      timeRows,
      eventRows,
    ] = await Promise.all([
      this.prisma.eveMemoryFact.findMany({
        where: {
          personaId: persona,
          OR: [
            { relationshipId: relationshipId ?? '__none__' },
            { relationshipId: null },
          ],
        },
        orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      }),
      this.prisma.eveMemoryDaily.findMany({
        where: { personaId: persona },
        orderBy: { date: 'desc' },
        take: 30,
      }),
      this.prisma.evePalaceDrawer.findMany({
        where: { personaId: persona },
        orderBy: [{ salience: 'desc' }, { createdAt: 'desc' }],
        take: 200,
      }),
      this.prisma.eveEpisode.findMany({
        where: { personaId: persona },
        orderBy: { date: 'desc' },
        take: 30,
      }),
      this.prisma.eveCrossChatMemory.findMany({
        where: { personaId: persona },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      // Promises and open loops are persona-wide until a relationship exists;
      // then they follow the same scope as facts.
      this.prisma.eveTimeItem.findMany({
        where: {
          personaId: persona,
          status: 'open',
          ...(relationshipId
            ? {
                OR: [
                  { relationshipId },
                  { relationshipId: null },
                ],
              }
            : {}),
        },
        orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
        take: 40,
      }),
      relationshipId
        ? this.prisma.eveRelationshipEvent.findMany({
            where: { relationshipId },
            orderBy: { createdAt: 'desc' },
            take: 30,
          })
        : Promise.resolve([]),
    ]);

    const lexical = (text: string): number => scoreText(text, needles);
    const factOptions: MemoryRankOptions<(typeof factRows)[number]> = {
      text: (row) => row.content,
      id: (row) => row.id,
      base: (row) => row.importance / 5,
      lexical,
      needles,
      limit: normalizeLimit(limits.facts, 8),
    };
    const dailyOptions: MemoryRankOptions<(typeof dailyRows)[number]> = {
      text: (row) => row.markdown,
      id: (row) => row.id,
      base: (_row, index) => 1 / (index + 1),
      lexical,
      needles,
      limit: normalizeLimit(limits.daily, 3),
    };
    const palaceOptions: MemoryRankOptions<(typeof palaceRows)[number]> = {
      text: (row) => `${row.content} ${row.keywords}`,
      // Keywords are a lexical hint, not something to embed.
      embedText: (row) => row.content,
      id: (row) => row.id,
      base: (row) => row.salience / 10,
      lexical,
      needles,
      limit: normalizeLimit(limits.palace, 10),
    };
    const episodeOptions: MemoryRankOptions<(typeof episodeRows)[number]> = {
      text: (row) => row.content,
      id: (row) => row.id,
      base: (_row, index) => 1 / (index + 1),
      lexical,
      needles,
      limit: normalizeLimit(limits.episodes, 3),
    };
    const crossOptions: MemoryRankOptions<(typeof crossRows)[number]> = {
      text: (row) => row.content,
      id: (row) => row.id,
      base: (_row, index) => 1 / (index + 1),
      lexical,
      needles,
      limit: normalizeLimit(limits.crossChat, 3),
    };

    // A single embedding request covers the query and every capped candidate;
    // without a provider (or a query without needles) recall stays lexical.
    let index: MemoryEmbeddingIndex = {
      queryVector: null,
      vectors: new Map<string, number[]>(),
    };
    if (needles.length > 0 && this.llm) {
      index = await embedMemoryQuery(
        query,
        [
          ...embeddingTexts(selectRankCandidates(factRows, factOptions)),
          ...embeddingTexts(selectRankCandidates(dailyRows, dailyOptions)),
          ...embeddingTexts(selectRankCandidates(palaceRows, palaceOptions)),
          ...embeddingTexts(selectRankCandidates(episodeRows, episodeOptions)),
          ...embeddingTexts(selectRankCandidates(crossRows, crossOptions)),
        ],
        this.llm,
      );
    }

    const [factRank, dailyRank, palaceRank, episodeRank, crossRank] =
      await Promise.all([
        rankByRelevance(query, factRows, { ...factOptions, ...index }),
        rankByRelevance(query, dailyRows, { ...dailyOptions, ...index }),
        rankByRelevance(query, palaceRows, { ...palaceOptions, ...index }),
        rankByRelevance(query, episodeRows, { ...episodeOptions, ...index }),
        rankByRelevance(query, crossRows, { ...crossOptions, ...index }),
      ]);

    const facts = factRank
      .map<RetrievedMemory>(({ item, score }) => ({
        id: item.id,
        kind: 'fact',
        text: stripMemoryNoise(item.content),
        score,
      }))
      .filter((row) => row.text.length > 0);

    const daily = dailyRank.map<RetrievedMemory>(({ item, score }) => ({
      id: item.id,
      kind: 'daily',
      text: excerpt(item.markdown, needles),
      score,
      date: item.date,
    }));

    const palace = palaceRank
      .map<RetrievedMemory>(({ item, score }) => ({
        id: item.id,
        kind: 'palace',
        text: stripMemoryNoise(item.content),
        score,
        hall: item.hall,
        salience: item.salience,
        keywords: parseKeywords(item.keywords),
      }))
      .filter((row) => row.text.length > 0);

    const episodes = episodeRank.map<RetrievedMemory>(({ item, score }) => ({
      id: item.id,
      kind: 'episode',
      text: excerpt(item.content, needles),
      score,
      date: item.date,
    }));

    const crossChat = crossRank
      .map<RetrievedMemory>(({ item, score }) => ({
        id: item.id,
        kind: 'cross-chat',
        text: stripMemoryNoise(item.content),
        score,
      }))
      .filter((row) => row.text.length > 0);

    // Promises/open loops keep their due order; the newest relationship
    // milestones come first. Both are already capped by the query.
    const timeItems = timeRows
      .map<RetrievedMemory>((item) => ({
        id: item.id,
        kind: 'time-item',
        text: stripMemoryNoise(item.content),
        score: 1,
        hall: item.kind,
        date: item.dueAt?.toISOString(),
      }))
      .filter((row) => row.text.length > 0)
      .slice(0, normalizeLimit(limits.timeItems, 6));

    const events = eventRows
      .map<RetrievedMemory>((item) => ({
        id: item.id,
        kind: 'relationship-event',
        text: stripMemoryNoise(item.text),
        score: 1,
        date: item.createdAt.toISOString(),
      }))
      .filter((row) => row.text.length > 0)
      .slice(0, normalizeLimit(limits.events, 5));

    const summaryParts: string[] = [];
    if (relationship) summaryParts.push(`стадия ${relationship.stage}`);
    const latest = dailyRows[0];
    if (latest) {
      const parsed = this.dailyJson(latest.json);
      summaryParts.push(
        `${latest.date}: ${parsed.feeling || excerpt(latest.markdown, needles, 160)}`,
      );
    }
    if (facts.length > 0) summaryParts.push(`фактов ${facts.length}`);
    if (palace.length > 0) summaryParts.push(`карточек ${palace.length}`);

    return {
      summary: summaryParts.join('; '),
      relationship: relationship
        ? {
            id: relationship.id,
            scopeKey: relationship.scopeKey,
            stage: relationship.stage,
            interest: relationship.interest,
            trust: relationship.trust,
            attraction: relationship.attraction,
            annoyance: relationship.annoyance,
            cringe: relationship.cringe,
            notes: relationship.notes,
          }
        : null,
      facts,
      daily,
      palace,
      episodes,
      crossChat,
      timeItems,
      events,
    };
  }

  private dailyJson(raw: string): { feeling?: string } {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as { feeling?: string })
        : {};
    } catch {
      return {};
    }
  }

  // -------------------------------------------------------------------------
  // Reflection
  // -------------------------------------------------------------------------

  /**
   * Every 6th session log row adds up to 3 new facts and one feeling note to
   * the scope relationship. Nothing here changes the stage: only an explicit
   * stage transition does that.
   */
  async reflect(
    personaId: string,
    accountId: string,
    chatId: bigint | number | string,
  ): Promise<ReflectResult> {
    const persona = personaId.trim();
    if (!persona) {
      throw apiError('EVE_PERSONA_REQUIRED', 'personaId is required');
    }
    await this.assertPersona(persona);
    const account = accountId.trim();
    if (!account) {
      throw apiError('EVE_ACCOUNT_REQUIRED', 'accountId is required');
    }
    const chat = toChatId(chatId);

    const turns = await this.prisma.eveSessionLog.count({
      where: { personaId: persona, accountId: account, chatId: chat },
    });
    if (turns === 0 || turns % REFLECT_EVERY_TURNS !== 0) {
      return { reflected: false, turns, factsAdded: 0, feeling: '' };
    }

    const recent = await this.prisma.eveSessionLog.findMany({
      where: { personaId: persona, accountId: account, chatId: chat },
      orderBy: { createdAt: 'desc' },
      take: REFLECT_HISTORY,
      select: { line: true },
    });
    const lines = recent.map((row) => row.line).reverse();
    const analysis = analyzeLog(lines);

    const known = await this.prisma.eveMemoryFact.findMany({
      where: { personaId: persona },
      select: { content: true },
    });
    const seen = new Set(known.map((row) => row.content.toLowerCase()));
    let factsAdded = 0;
    for (const candidate of analysis.facts) {
      if (factsAdded >= MAX_REFLECT_FACTS) break;
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      await this.prisma.eveMemoryFact.create({
        data: {
          personaId: persona,
          kind: 'fact',
          content: candidate,
          importance: 3,
          source: 'reflection',
        },
      });
      factsAdded += 1;
    }

    const link = await this.prisma.evePersonaAccount.findUnique({
      where: {
        personaId_accountId: { personaId: persona, accountId: account },
      },
      select: { relationshipMode: true },
    });
    const scopeKey =
      link?.relationshipMode === 'shared'
        ? `peer:${chat.toString()}`
        : `account:${account}:chat:${chat.toString()}`;
    const note = `[reflect ${new Date().toISOString().slice(0, 10)}] ${analysis.feeling}`;
    const current = await this.prisma.eveRelationship.findUnique({
      where: { personaId_scopeKey: { personaId: persona, scopeKey } },
      select: { id: true, notes: true },
    });
    if (current) {
      await this.prisma.eveRelationship.update({
        where: { id: current.id },
        data: { notes: appendNote(current.notes, note) },
      });
    } else {
      await this.prisma.eveRelationship.create({
        data: { personaId: persona, scopeKey, notes: note },
      });
    }

    return {
      reflected: true,
      turns,
      factsAdded,
      feeling: analysis.feeling,
      scopeKey,
    };
  }

  // -------------------------------------------------------------------------
  // Amnesia
  // -------------------------------------------------------------------------

  /**
   * Forgets everything written in the last `minutes`: session log rows, facts,
   * conflict/relationship notes and agenda items. The relationship row itself
   * survives (the peer identity must not vanish), only its recent state resets.
   */
  async amnesia(personaId: string, minutes: number): Promise<AmnesiaResult> {
    const persona = personaId.trim();
    if (!persona) {
      throw apiError('EVE_PERSONA_REQUIRED', 'personaId is required');
    }
    await this.assertPersona(persona);
    const window = Math.max(0, Math.floor(Number(minutes)));
    if (!Number.isFinite(window)) {
      throw apiError('EVE_MINUTES_INVALID', 'minutes must be a number');
    }
    const since = new Date(Date.now() - window * 60_000);

    const logs = await this.prisma.eveSessionLog.deleteMany({
      where: { personaId: persona, createdAt: { gte: since } },
    });
    const facts = await this.prisma.eveMemoryFact.deleteMany({
      where: { personaId: persona, createdAt: { gte: since } },
    });
    const agenda = await this.prisma.eveAgendaItem.deleteMany({
      where: { personaId: persona, createdAt: { gte: since } },
    });

    const relationships = await this.prisma.eveRelationship.findMany({
      where: { personaId: persona },
      select: { id: true, notes: true },
    });
    const relationshipIds = relationships.map((row) => row.id);
    const conflicts = relationshipIds.length
      ? await this.prisma.eveConflict.findMany({
          where: { relationshipId: { in: relationshipIds } },
          select: { id: true },
        })
      : [];
    const conflictIds = conflicts.map((row) => row.id);

    const conflictEvents = conflictIds.length
      ? await this.prisma.eveConflictEvent.deleteMany({
          where: { conflictId: { in: conflictIds }, createdAt: { gte: since } },
        })
      : { count: 0 };
    const relationshipEvents = relationshipIds.length
      ? await this.prisma.eveRelationshipEvent.deleteMany({
          where: {
            relationshipId: { in: relationshipIds },
            createdAt: { gte: since },
          },
        })
      : { count: 0 };
    const conflictReset = relationshipIds.length
      ? await this.prisma.eveConflict.updateMany({
          where: {
            relationshipId: { in: relationshipIds },
            updatedAt: { gte: since },
          },
          data: { level: 0, coldUntil: null, reason: null, history: '[]' },
        })
      : { count: 0 };

    let notes = 0;
    for (const relationship of relationships) {
      const next = stripRecentReflectNotes(relationship.notes, since);
      if (next === relationship.notes.trim()) continue;
      await this.prisma.eveRelationship.update({
        where: { id: relationship.id },
        data: { notes: next },
      });
      notes += 1;
    }

    return {
      minutes: window,
      since: since.toISOString(),
      logs: logs.count,
      facts: facts.count,
      conflicts: conflictReset.count,
      conflictEvents: conflictEvents.count,
      relationshipEvents: relationshipEvents.count,
      notes,
      agenda: agenda.count,
    };
  }

  /**
   * Full memory wipe for a persona. Telegram state, personas, allowlist and
   * session state bindings stay; everything learned by the agent goes.
   */
  async reset(personaId: string): Promise<ResetResult> {
    const persona = personaId.trim();
    if (!persona) {
      throw apiError('EVE_PERSONA_REQUIRED', 'personaId is required');
    }
    await this.assertPersona(persona);

    const relationships = await this.prisma.eveRelationship.findMany({
      where: { personaId: persona },
      select: { id: true },
    });
    const relationshipIds = relationships.map((row) => row.id);
    const conflicts = relationshipIds.length
      ? await this.prisma.eveConflict.findMany({
          where: { relationshipId: { in: relationshipIds } },
          select: { id: true },
        })
      : [];
    const conflictIds = conflicts.map((row) => row.id);

    const counts = await this.prisma.$transaction([
      this.prisma.eveSessionLog.deleteMany({ where: { personaId: persona } }),
      this.prisma.eveMemoryDaily.deleteMany({ where: { personaId: persona } }),
      this.prisma.eveMemoryFact.deleteMany({ where: { personaId: persona } }),
      this.prisma.eveEpisode.deleteMany({ where: { personaId: persona } }),
      this.prisma.evePalaceDrawer.deleteMany({ where: { personaId: persona } }),
      this.prisma.eveTimeItem.deleteMany({ where: { personaId: persona } }),
      this.prisma.eveCrossChatMemory.deleteMany({
        where: { personaId: persona },
      }),
      this.prisma.eveConflictEvent.deleteMany({
        where: { conflictId: { in: conflictIds } },
      }),
      this.prisma.eveConflict.deleteMany({
        where: { relationshipId: { in: relationshipIds } },
      }),
      this.prisma.eveRelationshipEvent.deleteMany({
        where: { relationshipId: { in: relationshipIds } },
      }),
      this.prisma.eveRelationship.deleteMany({ where: { personaId: persona } }),
      this.prisma.eveAgendaItem.deleteMany({ where: { personaId: persona } }),
      this.prisma.eveProactiveState.deleteMany({
        where: { personaId: persona },
      }),
      this.prisma.eveSessionState.deleteMany({ where: { personaId: persona } }),
    ]);

    const [
      sessionLogs,
      daily,
      facts,
      episodes,
      palace,
      timeItems,
      crossChat,
      conflictEvents,
      conflictsRemoved,
      relationshipEvents,
      relationshipsRemoved,
      agenda,
      proactive,
      sessionState,
    ] = counts.map((entry) => entry.count);

    const removed = {
      sessionLogs: sessionLogs ?? 0,
      daily: daily ?? 0,
      facts: facts ?? 0,
      episodes: episodes ?? 0,
      palace: palace ?? 0,
      timeItems: timeItems ?? 0,
      crossChat: crossChat ?? 0,
      conflictEvents: conflictEvents ?? 0,
      conflicts: conflictsRemoved ?? 0,
      relationshipEvents: relationshipEvents ?? 0,
      relationships: relationshipsRemoved ?? 0,
      agenda: agenda ?? 0,
      proactive: proactive ?? 0,
      sessionState: sessionState ?? 0,
    };
    const total = Object.values(removed).reduce((sum, value) => sum + value, 0);
    this.logger.log(`Reset memory for ${persona}: ${total} rows removed`);
    return { personaId: persona, removed: { ...removed, total } };
  }
}
