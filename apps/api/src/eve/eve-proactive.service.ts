import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { apiError, notFound } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { eveId, parseChatId } from './eve-access.js';
import { EveLlmService } from './eve-llm.service.js';
import { buildDailyLifeMessages, parseLlmJson } from './eve-persona-llm.js';
import {
  buildAgendaExtractMessages,
  buildAutonomousAgendaMessages,
  normalizeLlmAgendaItems,
  parseAgendaActions,
  parseAgendaItems,
} from './eve-agenda-llm.js';
import { eveWebhookUrl } from './eve-push.js';

/**
 * Proactive engine for Eve.
 *
 * Nest owns the SQLite agenda (`EveAgendaItem`), the daily-life cache and the
 * 10-minute dialog cooldown (`EveSessionLog`). Every minute this service picks
 * at most one due item and asks the local Eve process to compose the first
 * message (`POST /eve/v1/nest/proactive`). The model never runs here: Nest only
 * decides *when* to ping, Eve decides *what* to say.
 *
 * Autonomous items are built from deterministic templates derived from the
 * persona's daily life. The day plan itself is LLM-backed when the dashboard
 * provider is configured (`EveLlmService`), with the deterministic
 * `generateDailyLife` as the fallback: the same persona/date always produces
 * the same day once the plan is stored in `EveDailyLife`.
 */

export const PROACTIVE_TICK_MS = 60_000;
export const DIALOG_COOLDOWN_MS = 10 * 60_000;
export const AUTONOMOUS_HORIZON_MS = 18 * 3_600_000;
export const AUTONOMOUS_MIN_LEAD_MS = 5 * 60_000;
export const AUTONOMOUS_MIN_GAP_MS = 45 * 60_000;
export const DEFAULT_EVE_PROACTIVE_URL =
  'http://127.0.0.1:4020/eve/v1/nest/proactive';
export const PROACTIVE_PUSH_TIMEOUT_MS = 10_000;

/** `TEXTBOOK §8` daily autonomous limit, before the initiative adjustment. */
export const AUTONOMOUS_BASE: Record<string, number> = {
  'tg-given-cold': 0,
  'met-irl-got-tg': 1,
  'tg-given-warming': 1,
  convinced: 2,
  'first-date-done': 2,
  'dating-early': 3,
  'dating-stable': 4,
  'long-term': 4,
  dumped: 0,
};

/** Stages where she is allowed to text first at all. */
const WARM_STAGES = new Set([
  'convinced',
  'first-date-done',
  'dating-early',
  'dating-stable',
  'long-term',
]);

export type EveInitiative = 'low' | 'medium' | 'high';

const INITIATIVE_VALUES: readonly EveInitiative[] = ['low', 'medium', 'high'];

const SOCIAL_VALUES = [
  'alone',
  'with-friends',
  'with-family',
  'with-coworkers',
  'in-transit',
] as const;

export type EveSocial = (typeof SOCIAL_VALUES)[number];

export interface CommunicationLike {
  notifications?: string;
  messageStyle?: string;
  initiative?: string;
  lifeSharing?: string;
}

export interface EveDailyLifeBlock {
  fromHour: number;
  toHour: number;
  activity: string;
  mood?: string;
  social: EveSocial;
  phoneAvailable: boolean;
}

export interface EveDailyLife {
  dateLocal: string;
  weather?: string;
  vibe: string;
  blocks: EveDailyLifeBlock[];
  events: string[];
  wants: string[];
}

export interface EveTickResult {
  fired: boolean;
  reason:
    | 'fired'
    | 'disabled'
    | 'no-due'
    | 'not-bound'
    | 'chat-not-allowed'
    | 'dialog-cooldown'
    | 'push-failed';
  itemId?: string;
  personaId?: string;
  accountId?: string;
  chatId?: string;
  status?: number;
  error?: string;
}

export interface EveAutonomousResult {
  personaId: string;
  date: string;
  limit: number;
  generated: number;
  reason:
    | 'generated'
    | 'already-generated'
    | 'no-chat'
    | 'limit'
    | 'dumped'
    | 'not-found';
}

export interface EveDailyLifeResult {
  personaId: string;
  date: string;
  created: boolean;
  day: EveDailyLife;
}

export interface EveAgendaExtractResult {
  created: number;
  updated: number;
  cancelled: number;
  responded?: string;
  skipped?: 'no-provider' | 'no-persona' | 'no-chat' | 'invalid' | 'nothing';
}

export interface EveDailyLifeSeed {
  personaId: string;
  dateLocal: string;
  sleepFrom?: number;
  sleepTo?: number;
  vibe?: string | null;
  communication?: CommunicationLike;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported so the specs exercise the same code as production)
// ---------------------------------------------------------------------------

function mod(value: number, base: number): number {
  return ((value % base) + base) % base;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : fallback;
}

export function normalizeHour(value: unknown, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return mod(Math.trunc(fallback), 24);
  return mod(Math.trunc(parsed), 24);
}

export function normalizeInitiative(value: unknown): EveInitiative {
  return typeof value === 'string' &&
    (INITIATIVE_VALUES as readonly string[]).includes(value)
    ? (value as EveInitiative)
    : 'medium';
}

export function communicationOf(raw: unknown): CommunicationLike {
  return record(raw) as CommunicationLike;
}

/** FNV-1a 32-bit: stable across processes and platforms. */
export function hashSeed(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** xorshift32 PRNG. Deterministic for a given seed; no Math.random anywhere. */
export function createRng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

/** YYYY-MM-DD for an instant in an IANA timezone (host clock on bad zones). */
export function localDateKey(nowMs: number, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date(nowMs));
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value ?? '';
    const key = `${get('year')}-${get('month')}-${get('day')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  } catch {
    // fall through to the host date
  }
  const date = new Date(nowMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate(),
  ).padStart(2, '0')}`;
}

export function localHour(nowMs: number, timezone: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone || 'UTC',
      hour: '2-digit',
      hour12: false,
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '');
    if (Number.isFinite(hour)) return mod(hour, 24);
  } catch {
    // fall through to the host clock
  }
  return new Date(nowMs).getHours();
}

export function isSleepingHour(
  hour: number,
  sleepFrom: unknown,
  sleepTo: unknown,
): boolean {
  const from = normalizeHour(sleepFrom, 23);
  const to = normalizeHour(sleepTo, 8);
  if (from === to) return false;
  const value = mod(Math.trunc(hour), 24);
  return from < to ? value >= from && value < to : value >= from || value < to;
}

/** Daily autonomous limit: stage table ±1 for initiative. */
export function maxAutonomousItems(
  stage: string,
  initiative: EveInitiative,
): number {
  if (stage === 'dumped') return 0;
  const base = AUTONOMOUS_BASE[stage] ?? 0;
  const adjusted =
    initiative === 'low' ? base - 1 : initiative === 'high' ? base + 1 : base;
  return Math.max(0, adjusted);
}

const ACTIVITY_POOLS: Record<EveSocial, string[]> = {
  alone: [
    'читаю книгу',
    'разбираю домашние дела',
    'смотрю сериал',
    'гуляю одна',
    'сижу в телефоне',
    'делаю уроки',
  ],
  'with-friends': [
    'кофе с подругой',
    'гуляю с друзьями',
    'созвон с друзьями',
    'сидим в кафе',
  ],
  'with-family': [
    'дома с семьёй',
    'обед с родителями',
    'помогаю по дому',
    'смотрю кино с семьёй',
  ],
  'with-coworkers': [
    'на парах',
    'на работе',
    'созвон по учёбе',
    'встреча с коллегами',
  ],
  'in-transit': ['в дороге', 'в метро', 'еду по делам', 'иду пешком'],
};

const MOODS = [
  'спокойно',
  'собранно',
  'немного уставшая',
  'в хорошем настроении',
  'рассеянно',
  'бодро',
];

const VIBES = [
  'обычный день',
  'немного суетливый день',
  'ленивый день',
  'день, когда всё по плану',
  'день с приятной мелочью',
  'чуть тревожный день',
];

const WEATHERS = ['пасмурно', 'солнечно', 'дождь', 'облачно', 'морозно'];

const EVENTS = [
  'созвон с подругой вечером',
  'зачёт через неделю',
  'купила билеты на выходные',
  'долгая очередь в поликлинике',
  'нашла хорошее кафе рядом',
  'разговор с мамой о планах',
  'тренировка',
];

const WANTS = [
  'кофе',
  'пройтись по улице',
  'поспать',
  'поговорить с ним',
  'посмотреть фильм',
  'ничего не делать',
  'съесть что-нибудь вкусное',
];

function pick<T>(rng: () => number, pool: readonly T[]): T {
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))]!;
}

function pickSocial(
  rng: () => number,
  lifeSharing: string,
): EveSocial {
  const roll = rng();
  if (lifeSharing === 'high') {
    if (roll < 0.45) return 'with-friends';
    if (roll < 0.7) return 'with-family';
    if (roll < 0.9) return 'with-coworkers';
    return 'in-transit';
  }
  if (lifeSharing === 'low') {
    if (roll < 0.6) return 'alone';
    if (roll < 0.85) return 'with-coworkers';
    return 'in-transit';
  }
  if (roll < 0.4) return 'alone';
  if (roll < 0.65) return 'with-friends';
  if (roll < 0.85) return 'with-coworkers';
  return 'in-transit';
}

function shuffle<T>(rng: () => number, input: readonly T[]): T[] {
  const copy = [...input];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(rng() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap]!, copy[index]!];
  }
  return copy;
}

/**
 * Deterministic 6–9 block day covering waking hours (`sleepTo` → `sleepFrom`).
 * Same persona + date → byte-identical JSON, which is what the cache and the
 * autonomous agenda rely on.
 */
export function generateDailyLife(seed: EveDailyLifeSeed): EveDailyLife {
  const rng = createRng(hashSeed(`${seed.personaId}:${seed.dateLocal}:daily-life`));
  const sleepFrom = normalizeHour(seed.sleepFrom, 23);
  const sleepTo = normalizeHour(seed.sleepTo, 8);
  const wakingHours = sleepFrom === sleepTo ? 24 : mod(sleepFrom - sleepTo, 24) || 24;
  const communication = seed.communication ?? {};
  const lifeSharing = text(communication.lifeSharing, 'medium');

  const blockCount = Math.max(
    1,
    Math.min(6 + Math.floor(rng() * 4), wakingHours),
  );
  const base = Math.floor(wakingHours / blockCount);
  const extra = wakingHours % blockCount;

  const blocks: EveDailyLifeBlock[] = [];
  let cursor = sleepTo;
  for (let index = 0; index < blockCount; index++) {
    const length = Math.max(1, base + (index < extra ? 1 : 0));
    const toHour = mod(cursor + length, 24);
    const social = pickSocial(rng, lifeSharing);
    blocks.push({
      fromHour: cursor,
      toHour,
      activity: pick(rng, ACTIVITY_POOLS[social]),
      mood: pick(rng, MOODS),
      social,
      phoneAvailable: rng() >= 0.18,
    });
    cursor = toHour;
  }

  // Every day has at least one phone-unavailable block: agenda must learn to
  // skip it instead of pinging during a lecture or a workout.
  if (blocks.length > 0 && blocks.every((block) => block.phoneAvailable)) {
    const quiet = blocks[Math.min(blocks.length - 1, Math.floor(blocks.length / 2))]!;
    quiet.phoneAvailable = false;
  }

  const eventCount = lifeSharing === 'low' ? 2 : 2 + Math.floor(rng() * 3);
  const wantCount = lifeSharing === 'high' ? 4 : 2 + Math.floor(rng() * 3);

  return {
    dateLocal: seed.dateLocal,
    weather: pick(rng, WEATHERS),
    vibe: text(seed.vibe) || pick(rng, VIBES),
    blocks,
    events: shuffle(rng, EVENTS).slice(0, Math.min(eventCount, 6)),
    wants: shuffle(rng, WANTS).slice(0, Math.min(wantCount, 6)),
  };
}

const SOCIAL_SET = new Set<string>(SOCIAL_VALUES);

/** Clamp an LLM hour into 0–23; `null` when it is not a number at all. */
function clampHour(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return null;
  return clampInt(parsed, 0, 23);
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    const item = text(entry).slice(0, 140);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function phoneAvailable(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'false' || normalized === 'no' || normalized === '0') {
      return false;
    }
  }
  return true;
}

/**
 * Validates the LLM day plan: hours are clamped to 0–23, blocks sorted by
 * `fromHour`, `social` must be one of the five known values (an unknown value
 * rejects the whole day), and at least four usable blocks are required.
 * Returns `null` for anything malformed so the deterministic day can be used.
 */
export function parseLlmDailyLife(
  raw: string,
  seed: EveDailyLifeSeed,
): EveDailyLife | null {
  const value = parseLlmJson(raw);
  if (!value) return null;
  if (!Array.isArray(value.blocks)) return null;
  if (!Array.isArray(value.events) || !Array.isArray(value.wants)) return null;

  const blocks: EveDailyLifeBlock[] = [];
  for (const entry of value.blocks.slice(0, 16)) {
    const row = record(entry);
    const social = typeof row.social === 'string' ? row.social.trim() : '';
    if (!SOCIAL_SET.has(social)) return null;
    const activity = text(row.activity).slice(0, 140);
    if (!activity) continue;
    const fromHour = clampHour(row.fromHour);
    const toHour = clampHour(row.toHour);
    if (fromHour === null || toHour === null || fromHour === toHour) continue;
    const mood = text(row.mood).slice(0, 40);
    blocks.push({
      fromHour,
      toHour,
      activity,
      ...(mood ? { mood } : {}),
      social: social as EveSocial,
      phoneAvailable: phoneAvailable(row.phoneAvailable),
    });
  }
  if (blocks.length < 4) return null;
  blocks.sort(
    (left, right) =>
      left.fromHour - right.fromHour || left.toHour - right.toHour,
  );

  // Same invariant as the deterministic generator: the agenda needs at least
  // one block where a ping would be wrong.
  if (blocks.every((block) => block.phoneAvailable)) {
    const quiet = blocks[Math.floor(blocks.length / 2)]!;
    quiet.phoneAvailable = false;
  }

  const weather = text(value.weather).slice(0, 60);
  return {
    dateLocal: seed.dateLocal,
    ...(weather ? { weather } : {}),
    vibe:
      text(value.vibe).slice(0, 120) ||
      text(seed.vibe) ||
      'обычный день',
    blocks,
    events: stringList(value.events, 6),
    wants: stringList(value.wants, 6),
  };
}

export function renderDailyLifeMarkdown(day: EveDailyLife): string {
  const format = (hour: number) =>
    `${String(mod(hour, 24)).padStart(2, '0')}:00`;
  const socialRu: Record<EveSocial, string> = {
    alone: 'одна',
    'with-friends': 'с друзьями',
    'with-family': 'с семьёй',
    'with-coworkers': 'с коллегами',
    'in-transit': 'в дороге',
  };
  const lines = [`# День ${day.dateLocal}`];
  if (day.weather) lines.push(`погода: ${day.weather}`);
  lines.push(`настрой дня: ${day.vibe}`, '', '## Расписание');
  if (day.blocks.length === 0) lines.push('- (расписание не задано)');
  for (const block of day.blocks) {
    const phone = block.phoneAvailable ? '' : ', без телефона';
    const mood = block.mood ? ` (${block.mood})` : '';
    lines.push(
      `- ${format(block.fromHour)}–${format(block.toHour)} — ${block.activity} [${socialRu[block.social]}${phone}]${mood}`,
    );
  }
  lines.push('', '## События дня');
  if (day.events.length === 0) lines.push('- (ничего заметного)');
  else for (const event of day.events) lines.push(`- ${event}`);
  lines.push('', '## Чего хочется');
  if (day.wants.length === 0) lines.push('- (ничего конкретного)');
  else for (const want of day.wants) lines.push(`- ${want}`);
  return lines.join('\n');
}

/**
 * Resolves the Eve proactive endpoint.
 *
 * `EVE_PROACTIVE_URL` wins. Otherwise the target is the sibling of
 * `EVE_WEBHOOK_URL` (`.../nest/events` → `.../nest/proactive`), so one env var
 * configures both directions; the default local Eve URL is used when Eve is
 * enabled but no webhook override exists. An empty explicit value disables the
 * tick. `EVE_NEST_URL` deliberately never appears here: it points at Nest, not
 * Eve.
 */
export function eveProactiveUrl(): string | null {
  const explicit = process.env.EVE_PROACTIVE_URL;
  if (explicit !== undefined) return explicit.trim() || null;

  const webhook = eveWebhookUrl();
  if (!webhook) return null;
  try {
    const url = new URL(webhook);
    if (/\/events\/?$/.test(url.pathname)) {
      url.pathname = url.pathname.replace(/\/events\/?$/, '/proactive');
    } else {
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/proactive`;
    }
    return url.toString();
  } catch {
    return DEFAULT_EVE_PROACTIVE_URL;
  }
}

function parseHistory(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

/** History column → string list for append-only updates. */
function safeHistory(raw: string): string[] {
  return parseHistory(raw).slice(-30);
}

function autonomousIdeas(day: EveDailyLife): string[] {
  const ideas = [
    ...day.wants.map((want) => `рассказать, что хочется ${want}`),
    ...day.events.slice(0, 2).map((event) => `поделиться: ${event}`),
    'скинуть мем без повода',
    'спросить, как прошёл его день',
    'написать первой просто так',
    'позвать созвониться вечером',
    'рассказать, как прошёл день',
  ];
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const idea of ideas) {
    const clipped = idea.slice(0, 120);
    if (clipped.length < 3 || seen.has(clipped)) continue;
    seen.add(clipped);
    unique.push(clipped);
  }
  return unique;
}

function importanceFor(stage: string, index: number): number {
  const base = WARM_STAGES.has(stage) ? 2 : 1;
  return clampInt(base + (index % 2), 1, 3);
}

@Injectable()
export class EveProactiveService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EveProactiveService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: EveLlmService,
  ) {}

  onModuleInit(): void {
    // Single in-process proactive scheduler. `unref` keeps the API process from
    // being held open by this timer.
    this.timer = setInterval(() => {
      void this.runTick();
    }, PROACTIVE_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async runTick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.tick(new Date());
      if (result.fired) {
        this.logger.log(
          `Eve proactive fired ${result.itemId ?? '?'} (${result.personaId ?? '?'}/${result.chatId ?? '?'})`,
        );
      } else if (result.reason === 'push-failed') {
        this.logger.warn(
          `Eve proactive push failed for ${result.itemId ?? '?'}: ${
            result.error ?? `HTTP ${result.status ?? 'unknown'}`
          }`,
        );
      }
    } catch (error) {
      this.logger.warn(`Eve proactive tick failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  // ---------------------------------------------------------------------
  // HTTP entry points (called by EveProactiveController)
  // ---------------------------------------------------------------------

  /** `POST /internal/eve/proactive/tick`. */
  async tickRequest(body: unknown): Promise<EveTickResult> {
    const raw = record(body).now;
    const now =
      typeof raw === 'string' || typeof raw === 'number'
        ? new Date(raw)
        : new Date();
    if (!Number.isFinite(now.getTime())) {
      throw apiError('EVE_NOW_INVALID', 'now must be a valid ISO date');
    }
    return this.tick(now);
  }

  /** `POST /internal/eve/daily-life/ensure`. */
  async ensureDailyLifeRequest(body: unknown): Promise<EveDailyLifeResult> {
    const value = record(body);
    const personaId = eveId(
      value.personaId,
      'EVE_PERSONA_REQUIRED',
      'personaId is required',
    );
    const rawDate = value.date;
    let date: string | undefined;
    if (rawDate !== undefined && rawDate !== null && rawDate !== '') {
      date = text(rawDate);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw apiError('EVE_DATE_INVALID', 'date must be YYYY-MM-DD');
      }
    }
    return this.dailyLife(personaId, date);
  }

  /**
   * `POST /internal/eve/agenda/extract`: events he mentions, corrections and
   * his answer to a recent ping. Pure LLM, but every item goes through local
   * validation (quiet hours, duplicates, future window) before Prisma.
   */
  async extractAgendaUpdates(raw: unknown): Promise<EveAgendaExtractResult> {
    const body = record(raw);
    const personaId = eveId(
      body.personaId,
      'EVE_PERSONA_REQUIRED',
      'personaId is required',
    );
    const accountId = eveId(
      body.accountId,
      'EVE_ACCOUNT_REQUIRED',
      'accountId is required',
    );
    const chatId = parseChatId(body.chatId);
    const threadId = Number(body.threadId ?? 0) || 0;
    const incoming = text(body.incoming).slice(0, 2_000);
    const empty = { created: 0, updated: 0, cancelled: 0 };

    const persona = await this.prisma.evePersona.findUnique({
      where: { id: personaId },
      include: { docs: true },
    });
    if (!persona) return { ...empty, skipped: 'no-persona' };
    const binding = await this.prisma.eveChatBinding.findUnique({
      where: {
        personaId_accountId_chatId_threadId: {
          personaId,
          accountId,
          chatId,
          threadId,
        },
      },
      select: { allowed: true },
    });
    if (binding?.allowed !== true) return { ...empty, skipped: 'no-chat' };
    if (!incoming) return { ...empty, skipped: 'nothing' };
    if (!this.llm.isConfigured()) return { ...empty, skipped: 'no-provider' };

    const now = new Date();
    const relationship = await this.prisma.eveRelationship.findUnique({
      where: {
        personaId_scopeKey: {
          personaId,
          scopeKey: `account:${accountId}:chat:${chatId.toString()}`,
        },
      },
    });
    const items = await this.prisma.eveAgendaItem.findMany({
      where: { personaId, accountId, chatId },
      orderBy: { pingAt: 'desc' },
      take: 40,
    });
    const recentProactive =
      items.find(
        (item) =>
          item.state === 'fired' &&
          now.getTime() - item.pingAt.getTime() < 30 * 60_000,
      ) ?? null;
    const logs = await this.prisma.eveSessionLog.findMany({
      where: { personaId, accountId, chatId },
      orderBy: { createdAt: 'desc' },
      take: 8,
      select: { line: true },
    });
    const history = logs
      .map((row) => row.line)
      .reverse()
      .map((line) => {
        const assistant = line.startsWith('assistant:');
        return {
          role: assistant ? 'assistant' : 'user',
          content: line.replace(/^(assistant|user):\s*/, ''),
        };
      });
    const personaDoc = persona.docs.find((doc) => doc.kind === 'persona');
    const communication = record(parseJson(persona.communication));

    let actionsRaw: unknown = null;
    try {
      const response = await this.llm.chat(
        buildAgendaExtractMessages({
          personaName: persona.name,
          stage: relationship?.stage ?? persona.stage,
          stageDescription: '',
          communication: JSON.stringify(communication),
          history,
          incoming,
          existing: items.map((item) => ({
            id: item.id,
            about: item.about,
            pingAt: item.pingAt.toISOString(),
            state: item.state,
          })),
          recentProactive: recentProactive
            ? {
                id: recentProactive.id,
                about: recentProactive.about,
                sentAt: recentProactive.pingAt.toISOString(),
              }
            : null,
          now: now.toISOString(),
          timezone: persona.timezone,
        }),
        { temperature: 0.4, maxTokens: 1_800, json: true },
      );
      actionsRaw = parseLlmJson(response ?? '');
    } catch (error) {
      this.logger.warn(
        `Eve agenda extract failed for ${personaId}/${chatId}: ${(error as Error).message}`,
      );
      return { ...empty, skipped: 'invalid' };
    }
    if (!actionsRaw) return { ...empty, skipped: 'invalid' };

    const actions = parseAgendaActions(actionsRaw);
    const byId = new Map(items.map((item) => [item.id, item]));
    const existingAbout = items.map((item) => item.about);
    const blocks = await this.dayBlocks(persona.id, now);
    const normalize = (entry: Record<string, unknown>, limit: number) =>
      normalizeLlmAgendaItems([entry], {
        now: now.getTime(),
        timezone: persona.timezone,
        sleepFrom: persona.sleepFrom,
        sleepTo: persona.sleepTo,
        blocks,
        existing: existingAbout,
        limit,
        horizonMs: 14 * 24 * 3_600_000,
      }).items[0];

    let created = 0;
    let updated = 0;
    let cancelled = 0;
    const handled = new Set<string>();
    for (const rawAction of actions) {
      const action = record(rawAction);
      const kind = text(action.action);
      const id = text(action.id);
      if (kind === 'create') {
        const item = normalize(action, 2);
        if (!item) continue;
        await this.prisma.eveAgendaItem.create({
          data: {
            personaId,
            accountId,
            chatId,
            about: item.about,
            reason: item.reason,
            kind: 'user-event',
            state: 'pending',
            importance: item.importance,
            pingAt: new Date(item.pingAt),
            history: JSON.stringify([
              `created from his message at ${now.toISOString()}`,
            ]),
          },
        });
        existingAbout.push(item.about);
        created += 1;
        continue;
      }
      if (!id) continue;
      const current = byId.get(id);
      if (
        !current ||
        current.personaId !== personaId ||
        current.accountId !== accountId ||
        current.chatId !== chatId
      ) {
        continue;
      }
      handled.add(id);
      if (kind === 'cancel') {
        if (current.state === 'pending') {
          await this.prisma.eveAgendaItem.update({
            where: { id },
            data: {
              state: 'cancelled',
              history: JSON.stringify([
                ...safeHistory(current.history),
                `cancelled by his message at ${now.toISOString()}`,
              ]),
            },
          });
          cancelled += 1;
        }
        continue;
      }
      if (kind === 'update') {
        const data: Record<string, unknown> = {};
        if (text(action.about)) data.about = text(action.about).slice(0, 120);
        if (action.pingAt !== undefined) {
          const pingAt = new Date(String(action.pingAt)).getTime();
          if (
            Number.isFinite(pingAt) &&
            pingAt > now.getTime() + 5 * 60_000 &&
            pingAt < now.getTime() + 14 * 24 * 3_600_000
          ) {
            data.pingAt = new Date(pingAt);
          }
        }
        if (text(action.reason)) {
          data.reason = text(action.reason).slice(0, 160);
        }
        if (action.importance !== undefined) {
          data.importance = clampInt(Number(action.importance), 1, 3);
        }
        if (Object.keys(data).length > 0) {
          await this.prisma.eveAgendaItem.update({
            where: { id },
            data: {
              ...data,
              history: JSON.stringify([
                ...safeHistory(current.history),
                `updated from his message at ${now.toISOString()}`,
              ]),
            },
          });
          updated += 1;
        }
      }
    }

    // His answer to a recent ping is itself an agenda signal even when the LLM
    // chose noop: mark it as answered so the response window closes.
    if (recentProactive && !handled.has(recentProactive.id)) {
      await this.prisma.eveAgendaItem.update({
        where: { id: recentProactive.id },
        data: {
          history: JSON.stringify([
            ...safeHistory(recentProactive.history),
            `answered at ${now.toISOString()}: ${incoming.slice(0, 120)}`,
          ]),
        },
      });
      return {
        created,
        updated,
        cancelled,
        responded: recentProactive.id,
      };
    }

    return {
      created,
      updated,
      cancelled,
      ...(recentProactive && handled.has(recentProactive.id)
        ? { responded: recentProactive.id }
        : {}),
    };
  }

  /** Day blocks for quiet-hour validation; a missing day means no blocks. */
  private async dayBlocks(
    personaId: string,
    now: Date,
  ): Promise<Array<{ fromHour: number; toHour: number; phoneAvailable: boolean }>> {
    const persona = await this.prisma.evePersona.findUnique({
      where: { id: personaId },
      select: { timezone: true },
    });
    if (!persona) return [];
    const date = localDateKey(now.getTime(), persona.timezone);
    const row = await this.prisma.eveDailyLife.findUnique({
      where: { personaId_date: { personaId, date } },
      select: { json: true },
    });
    if (!row) return [];
    const day = parseJson(row.json);
    const blocks = Array.isArray(day.blocks) ? day.blocks : [];
    return blocks.flatMap((entry) => {
      const block = record(entry);
      const fromHour = Number(block.fromHour);
      const toHour = Number(block.toHour);
      if (!Number.isInteger(fromHour) || !Number.isInteger(toHour)) return [];
      return [
        {
          fromHour,
          toHour,
          phoneAvailable: block.phoneAvailable !== false,
        },
      ];
    });
  }

  // ---------------------------------------------------------------------
  // Tick
  // ---------------------------------------------------------------------

  /**
   * One tick: top up today's autonomous agenda for every active persona, then
   * select the single earliest due item and either fire it or leave it for the
   * next tick.
   */
  async tick(now: Date = new Date()): Promise<EveTickResult> {
    const url = eveProactiveUrl();
    if (!url) return { fired: false, reason: 'disabled' };

    await this.ensureActivePersonas(now);

    const item = await this.prisma.eveAgendaItem.findFirst({
      where: { state: 'pending', pingAt: { lte: now } },
      orderBy: [{ pingAt: 'asc' }, { id: 'asc' }],
    });
    if (!item) return { fired: false, reason: 'no-due' };

    const base = {
      itemId: item.id,
      personaId: item.personaId,
      accountId: item.accountId,
      chatId: item.chatId.toString(),
    };

    // The binding can be disabled or the chat removed from the allowlist after
    // the item was queued. Cancel it: keeping it pending would block the head of
    // the queue forever (`due[0]` bottleneck).
    const link = await this.prisma.evePersonaAccount.findUnique({
      where: {
        personaId_accountId: {
          personaId: item.personaId,
          accountId: item.accountId,
        },
      },
      select: { enabled: true },
    });
    if (link?.enabled !== true) {
      await this.cancelItem(item, 'persona/account binding disabled', now);
      return { ...base, fired: false, reason: 'not-bound' };
    }

    // `EveAgendaItem` has no thread column, so autonomous and manual items are
    // always addressed to the whole chat (`threadId = 0`).
    const binding = await this.prisma.eveChatBinding.findUnique({
      where: {
        personaId_accountId_chatId_threadId: {
          personaId: item.personaId,
          accountId: item.accountId,
          chatId: item.chatId,
          threadId: 0,
        },
      },
      select: { allowed: true },
    });
    if (binding?.allowed !== true) {
      await this.cancelItem(item, 'chat is no longer on the Eve allowlist', now);
      return { ...base, fired: false, reason: 'chat-not-allowed' };
    }

    // "A reply happened recently" — any session-log row in this chat counts,
    // regardless of who wrote it. Nest writes logs for both directions.
    const recent = await this.prisma.eveSessionLog.findFirst({
      where: {
        accountId: item.accountId,
        chatId: item.chatId,
        createdAt: { gte: new Date(now.getTime() - DIALOG_COOLDOWN_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (recent) {
      return { ...base, fired: false, reason: 'dialog-cooldown' };
    }

    const payload = {
      personaId: item.personaId,
      accountId: item.accountId,
      chatId: item.chatId.toString(),
      threadId: 0,
      item: {
        id: item.id,
        about: item.about,
        reason: item.reason,
        kind: item.kind,
        importance: item.importance,
        state: item.state,
        attempts: item.attempts,
        pingAt: item.pingAt.toISOString(),
        createdAt: item.createdAt.toISOString(),
        history: parseHistory(item.history),
      },
      // Flattened aliases for the Phase-0 channel route, which reads
      // `about`/`reason`/`id` at the top level. The canonical contract is
      // `item`; see docs/eve/T9-proactive-handoff.md.
      id: item.id,
      about: item.about,
      reason: item.reason,
    };

    const result = await this.push(url, payload);
    if (!result.ok) {
      // Leave the item pending: the next tick retries. attempts only counts
      // successful fires, matching the agenda contract.
      return {
        ...base,
        fired: false,
        reason: 'push-failed',
        status: result.status,
        error: result.error,
      };
    }

    const history = parseHistory(item.history);
    history.push(`fired at ${now.toISOString()}`);
    await this.prisma.eveAgendaItem.update({
      where: { id: item.id },
      data: {
        state: 'fired',
        attempts: { increment: 1 },
        history: JSON.stringify(history.slice(-30)),
      },
    });
    return { ...base, fired: true, reason: 'fired', status: result.status };
  }

  private async cancelItem(
    item: { id: string; history: string },
    note: string,
    now: Date,
  ): Promise<void> {
    const history = parseHistory(item.history);
    history.push(`cancelled at ${now.toISOString()}: ${note}`);
    await this.prisma.eveAgendaItem.update({
      where: { id: item.id },
      data: {
        state: 'cancelled',
        history: JSON.stringify(history.slice(-30)),
      },
    });
  }

  private async push(
    url: string,
    payload: unknown,
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PROACTIVE_PUSH_TIMEOUT_MS),
      });
      if (response.ok) return { ok: true, status: response.status };
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}`,
      };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  private async ensureActivePersonas(now: Date): Promise<void> {
    let personas: Array<{ id: string }>;
    try {
      personas = await this.prisma.evePersona.findMany({
        where: { accounts: { some: { enabled: true } } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
        take: 50,
      });
    } catch (error) {
      this.logger.warn(
        `Eve proactive persona scan failed: ${(error as Error).message}`,
      );
      return;
    }
    for (const persona of personas) {
      try {
        await this.ensureAutonomous(persona.id, now);
      } catch (error) {
        this.logger.warn(
          `Eve autonomous agenda failed for ${persona.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  // ---------------------------------------------------------------------
  // Autonomous agenda
  // ---------------------------------------------------------------------

  /**
   * Creates today's autonomous items once per local day.
   *
   * Guards, in order: known persona → local-day marker → stage limit →
   * enabled account binding → allowed whole-chat binding. The marker is written
   * even when the limit is 0, so a cold/dumped stage is not recomputed every
   * minute; it is not written when there is no chat yet, so adding the first
   * allowlist row later the same day still works.
   */
  async ensureAutonomous(
    personaId: string,
    now: Date = new Date(),
  ): Promise<EveAutonomousResult> {
    const persona = await this.prisma.evePersona.findUnique({
      where: { id: personaId },
      include: { docs: true },
    });
    if (!persona) {
      return {
        personaId,
        date: '',
        limit: 0,
        generated: 0,
        reason: 'not-found',
      };
    }

    const date = localDateKey(now.getTime(), persona.timezone);
    const marker = `autonomous:${date}`;
    const marked = await this.prisma.eveProactiveState.findUnique({
      where: { personaId_date_marker: { personaId, date, marker } },
      select: { id: true },
    });
    if (marked) {
      return {
        personaId,
        date,
        limit: 0,
        generated: 0,
        reason: 'already-generated',
      };
    }

    const initiative = normalizeInitiative(
      communicationOf(parseJson(persona.communication)).initiative,
    );
    const limit = maxAutonomousItems(persona.stage, initiative);

    if (limit <= 0) {
      await this.markAutonomous(personaId, date, marker);
      return {
        personaId,
        date,
        limit,
        generated: 0,
        reason: persona.stage === 'dumped' ? 'dumped' : 'limit',
      };
    }

    // Daily life is the gate for autonomous pings: no day, no pings.
    const { day } = await this.dailyLife(personaId, date, now);

    const links = await this.prisma.evePersonaAccount.findMany({
      where: { personaId, enabled: true },
      select: { accountId: true },
    });
    if (links.length === 0) {
      return { personaId, date, limit, generated: 0, reason: 'no-chat' };
    }

    const chats = await this.prisma.eveChatBinding.findMany({
      where: {
        personaId,
        accountId: { in: links.map((link) => link.accountId) },
        allowed: true,
        threadId: 0,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: 10,
      select: { accountId: true, chatId: true },
    });
    if (chats.length === 0) {
      return { personaId, date, limit, generated: 0, reason: 'no-chat' };
    }
    const target = chats[0]!;

    const pendingSoon = await this.prisma.eveAgendaItem.count({
      where: {
        personaId,
        state: 'pending',
        pingAt: {
          gt: now,
          lte: new Date(now.getTime() + AUTONOMOUS_HORIZON_MS),
        },
      },
    });
    const remaining = Math.max(0, limit - pendingSoon);
    if (remaining <= 0) {
      await this.markAutonomous(personaId, date, marker);
      return { personaId, date, limit, generated: 0, reason: 'limit' };
    }

    const horizonEnd = now.getTime() + AUTONOMOUS_HORIZON_MS;
    const rng = createRng(hashSeed(`${personaId}:${date}:autonomous`));
    const leadMs =
      AUTONOMOUS_MIN_LEAD_MS + Math.floor(rng() * 10) * 60_000; // 5..14 min
    let cursor =
      Math.ceil((now.getTime() + leadMs) / (5 * 60_000)) * 5 * 60_000;

    const llmItems = await this.llmAutonomousItems({
      persona,
      day,
      target,
      remaining,
      now,
      date,
    });
    let generated = 0;
    if (llmItems.length > 0) {
      for (const item of llmItems) {
        await this.prisma.eveAgendaItem.create({
          data: {
            personaId,
            accountId: target.accountId,
            chatId: target.chatId,
            about: item.about,
            reason: item.reason,
            kind: 'proactive-life',
            state: 'pending',
            importance: item.importance,
            pingAt: new Date(item.pingAt),
            history: JSON.stringify([`autonomous:${date}`]),
          },
        });
        generated += 1;
      }
    }

    const ideas = autonomousIdeas(day);
    for (
      let index = 0;
      llmItems.length === 0 && index < ideas.length && generated < remaining;
      index++
    ) {
      let pingAt = this.nextAwakeTime(cursor, persona);
      if (pingAt > horizonEnd) break;
      const about = ideas[index]!;
      const history = [`autonomous:${date}`];
      await this.prisma.eveAgendaItem.create({
        data: {
          personaId,
          accountId: target.accountId,
          chatId: target.chatId,
          about,
          reason: 'самой захотелось написать',
          kind: 'proactive-life',
          state: 'pending',
          importance: importanceFor(persona.stage, index),
          pingAt: new Date(pingAt),
          history: JSON.stringify(history),
        },
      });
      generated += 1;
      // 45 minutes minimum spacing + deterministic 0..10 min jitter.
      cursor = pingAt + AUTONOMOUS_MIN_GAP_MS + Math.floor(rng() * 3) * 5 * 60_000;
    }

    await this.markAutonomous(personaId, date, marker);
    return {
      personaId,
      date,
      limit,
      generated,
      reason: generated > 0 ? 'generated' : 'limit',
    };
  }

  /**
   * LLM proposal for today's autonomous pings. The deterministic templates in
   * `autonomousIdeas` stay the fallback: without a provider, or when every
   * proposal is rejected, the old path still produces a day.
   */
  private async llmAutonomousItems(input: {
    persona: {
      id: string;
      name: string;
      age: number;
      stage: string;
      timezone: string;
      sleepFrom: number;
      sleepTo: number;
      communication: string;
      docs: Array<{ kind: string; content: string }>;
    };
    day: EveDailyLife;
    target: { accountId: string; chatId: bigint };
    remaining: number;
    now: Date;
    date: string;
  }): Promise<
    Array<{
      about: string;
      reason: string;
      pingAt: number;
      importance: 1 | 2 | 3;
    }>
  > {
    if (!this.llm.isConfigured() || input.remaining <= 0) return [];
    try {
      const [logs, palace, existingItems] = await Promise.all([
        this.prisma.eveSessionLog.findMany({
          where: {
            personaId: input.persona.id,
            accountId: input.target.accountId,
            chatId: input.target.chatId,
          },
          orderBy: { createdAt: 'desc' },
          take: 16,
          select: { line: true },
        }),
        this.prisma.evePalaceDrawer.findMany({
          where: { personaId: input.persona.id },
          orderBy: [{ salience: 'desc' }, { createdAt: 'desc' }],
          take: 8,
          select: { hall: true, content: true },
        }),
        this.prisma.eveAgendaItem.findMany({
          where: { personaId: input.persona.id, state: 'pending' },
          orderBy: { pingAt: 'asc' },
          take: 50,
          select: { about: true },
        }),
      ]);
      const existing = existingItems.map((item) => item.about);
      const history = logs
        .map((row) => row.line)
        .reverse()
        .map((line) => ({
          role: line.startsWith('assistant:') ? 'assistant' : 'user',
          content: line.replace(/^(assistant|user):\s*/, ''),
        }));
      const response = await this.llm.chat(
        buildAutonomousAgendaMessages({
          personaName: input.persona.name,
          stage: input.persona.stage,
          stageDescription: '',
          score: '',
          communication: input.persona.communication,
          personaDoc:
            input.persona.docs.find((doc) => doc.kind === 'persona')?.content ??
            '',
          dailyLife: renderDailyLifeMarkdown(input.day),
          history,
          memory: palace
            .map((row) => `- [${row.hall}] ${row.content}`)
            .join('\n'),
          existing,
          now: input.now.toISOString(),
          timezone: input.persona.timezone,
          maxItems: input.remaining,
        }),
        { temperature: 0.8, maxTokens: 1_600, json: true },
      );
      const parsed = parseLlmJson(response ?? '');
      if (!parsed) return [];
      const normalized = normalizeLlmAgendaItems(parseAgendaItems(parsed), {
        now: input.now.getTime(),
        timezone: input.persona.timezone,
        sleepFrom: input.persona.sleepFrom,
        sleepTo: input.persona.sleepTo,
        blocks: input.day.blocks,
        existing,
        limit: input.remaining,
        horizonMs: AUTONOMOUS_HORIZON_MS,
      });
      return normalized.items.map((item) => ({
        about: item.about,
        reason: item.reason,
        pingAt: item.pingAt,
        importance: item.importance,
      }));
    } catch (error) {
      this.logger.warn(
        `Eve autonomous agenda LLM failed for ${input.persona.id}: ${(error as Error).message}`,
      );
      return [];
    }
  }

  /** Advances to the first non-sleeping 5-minute slot at or after `fromMs`. */
  private nextAwakeTime(
    fromMs: number,
    persona: { timezone: string; sleepFrom: number; sleepTo: number },
  ): number {
    let at = fromMs;
    for (let attempt = 0; attempt < 48 * 12; attempt++) {
      const hour = localHour(at, persona.timezone);
      if (!isSleepingHour(hour, persona.sleepFrom, persona.sleepTo)) return at;
      at += 30 * 60_000;
    }
    return at;
  }

  private async markAutonomous(
    personaId: string,
    date: string,
    marker: string,
  ): Promise<void> {
    await this.prisma.eveProactiveState.upsert({
      where: { personaId_date_marker: { personaId, date, marker } },
      create: { personaId, date, marker },
      update: {},
    });
  }

  // ---------------------------------------------------------------------
  // Daily life
  // ---------------------------------------------------------------------

  /**
   * One LLM attempt for the day plan. Returns `null` on a missing provider,
   * a timeout or an invalid plan (hours/social/shape), so the caller keeps the
   * deterministic generator. Never throws.
   */
  private async llmDay(
    seed: EveDailyLifeSeed,
    profile: { name: string; age: number; nationality: string },
    signal?: AbortSignal,
  ): Promise<EveDailyLife | null> {
    if (!this.llm.isConfigured()) return null;
    try {
      const raw = await this.llm.chat(
        buildDailyLifeMessages({
          name: profile.name,
          age: profile.age,
          nationality: profile.nationality,
          dateLocal: seed.dateLocal,
          vibe: seed.vibe,
          sleepFrom: seed.sleepFrom,
          sleepTo: seed.sleepTo,
          lifeSharing: seed.communication?.lifeSharing,
        }),
        {
          temperature: 0.9,
          maxTokens: 2_400,
          json: true,
          ...(signal ? { signal } : {}),
        },
      );
      if (!raw) {
        this.logger.warn(
          `Eve daily-life LLM returned no text for ${seed.personaId}/${seed.dateLocal}; using the deterministic day`,
        );
        return null;
      }
      const day = parseLlmDailyLife(raw, seed);
      if (!day) {
        this.logger.warn(
          `Eve daily-life LLM returned an invalid plan for ${seed.personaId}/${seed.dateLocal}; using the deterministic day`,
        );
      }
      return day;
    } catch (error) {
      this.logger.warn(
        `Eve daily-life LLM failed for ${seed.personaId}/${seed.dateLocal}: ${(error as Error).message}; using the deterministic day`,
      );
      return null;
    }
  }

  /**
   * Ensures one `EveDailyLife` row for a local date. The plan comes from the
   * LLM when it is configured and valid, otherwise from the deterministic
   * generator; either way it is stored once and reused for the rest of the day.
   */
  async dailyLife(
    personaId: string,
    date?: string,
    now: Date = new Date(),
    signal?: AbortSignal,
  ): Promise<EveDailyLifeResult> {
    const persona = await this.prisma.evePersona.findUnique({
      where: { id: personaId },
      select: {
        id: true,
        name: true,
        age: true,
        nationality: true,
        timezone: true,
        sleepFrom: true,
        sleepTo: true,
        vibe: true,
        communication: true,
      },
    });
    if (!persona) {
      throw notFound('EVE_PERSONA_NOT_FOUND', 'Eve persona not found');
    }

    const dateLocal = date ?? localDateKey(now.getTime(), persona.timezone);
    const existing = await this.prisma.eveDailyLife.findUnique({
      where: { personaId_date: { personaId, date: dateLocal } },
    });
    if (existing) {
      const parsed = parseStoredDay(existing.json, dateLocal);
      if (parsed) {
        return { personaId, date: dateLocal, created: false, day: parsed };
      }
      // A corrupted cache must regenerate rather than crash the tick.
    }

    const seed: EveDailyLifeSeed = {
      personaId,
      dateLocal,
      sleepFrom: persona.sleepFrom,
      sleepTo: persona.sleepTo,
      vibe: persona.vibe,
      communication: communicationOf(parseJson(persona.communication)),
    };
    const day =
      (await this.llmDay(seed, persona, signal)) ?? generateDailyLife(seed);
    await this.prisma.eveDailyLife.upsert({
      where: { personaId_date: { personaId, date: dateLocal } },
      create: {
        personaId,
        date: dateLocal,
        json: JSON.stringify(day),
        markdown: renderDailyLifeMarkdown(day),
      },
      update: {
        json: JSON.stringify(day),
        markdown: renderDailyLifeMarkdown(day),
      },
    });
    return { personaId, date: dateLocal, created: true, day };
  }
}

function parseJson(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return record(JSON.parse(raw));
  } catch {
    return {};
  }
}

function parseStoredDay(raw: string, dateLocal: string): EveDailyLife | null {
  try {
    const value = record(JSON.parse(raw));
    if (!Array.isArray(value.blocks) || value.blocks.length === 0) return null;
    return {
      dateLocal:
        typeof value.dateLocal === 'string' ? value.dateLocal : dateLocal,
      ...(typeof value.weather === 'string' ? { weather: value.weather } : {}),
      vibe: typeof value.vibe === 'string' ? value.vibe : 'обычный день',
      blocks: value.blocks as EveDailyLifeBlock[],
      events: Array.isArray(value.events)
        ? value.events.filter((item): item is string => typeof item === 'string')
        : [],
      wants: Array.isArray(value.wants)
        ? value.wants.filter((item): item is string => typeof item === 'string')
        : [],
    };
  } catch {
    return null;
  }
}
