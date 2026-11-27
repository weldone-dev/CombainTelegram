/**
 * Daily life: what she is doing today.
 *
 * Pure helpers only. NestJS stores the generated day and the markdown cache;
 * this module validates the LLM shape, encodes/decodes the cache marker,
 * renders the human block and answers "what is she doing at hour H".
 */

import { formatMinutes, localParts } from './time';
import type { DailyLife, DailyLifeBlock, PersonaConfig } from './types';

export const DAILY_LIFE_MIN_BLOCKS = 6;
export const DAILY_LIFE_MAX_BLOCKS = 9;
export const DAILY_LIFE_EVENTS_MAX = 6;
export const DAILY_LIFE_WANTS_MAX = 6;
export const DAILY_LIFE_RECENT_DAYS = 5;

const SOCIAL_VALUES: DailyLifeBlock['social'][] = [
  'alone',
  'with-friends',
  'with-family',
  'with-coworkers',
  'in-transit',
];

const SOCIAL_RU: Record<DailyLifeBlock['social'], string> = {
  alone: 'одна',
  'with-friends': 'с друзьями',
  'with-family': 'с семьёй',
  'with-coworkers': 'с коллегами/одногруппниками',
  'in-transit': 'в дороге',
};

export type DailyLifeIssue =
  | 'not-an-object'
  | 'blocks-not-array'
  | 'too-few-blocks'
  | 'too-many-blocks'
  | 'events-too-few'
  | 'wants-too-few'
  | 'invalid-date';

export interface DailyLifeValidation {
  value: DailyLife;
  issues: DailyLifeIssue[];
}

export function emptyDailyLife(dateLocal: string): DailyLife {
  return {
    dateLocal,
    vibe: 'обычный день',
    blocks: [],
    events: [],
    wants: [],
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** "08:00" / "8:00" / 8 / "24:00" → hour 0..23, or null. */
export function parseHourValue(value: unknown): number | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    const hour = Math.trunc(value);
    if (hour === 24) return 0;
    return hour >= 0 && hour <= 23 ? hour : null;
  }
  if (typeof value === 'string') {
    const match = /^(\d{1,2})(?::(\d{2}))?$/.exec(value.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2] ?? '0');
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (minute !== 0) return null; // blocks are hour-granular
    if (hour === 24) return 0;
    return hour >= 0 && hour <= 23 ? hour : null;
  }
  return null;
}

function stringList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, max);
}

export function normalizeDailyLifeBlock(value: unknown): DailyLifeBlock | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const fromHour = parseHourValue(raw.fromHour);
  const toHour = parseHourValue(raw.toHour);
  if (fromHour === null || toHour === null || fromHour === toHour) return null;
  const social = SOCIAL_VALUES.includes(raw.social as DailyLifeBlock['social'])
    ? (raw.social as DailyLifeBlock['social'])
    : 'alone';
  return {
    fromHour,
    toHour,
    activity:
      typeof raw.activity === 'string' && raw.activity.trim()
        ? raw.activity.trim().slice(0, 80)
        : 'обычные дела',
    ...(typeof raw.mood === 'string' && raw.mood.trim()
      ? { mood: raw.mood.trim().slice(0, 60) }
      : {}),
    social,
    phoneAvailable: raw.phoneAvailable !== false,
  };
}

/**
 * Validate/normalize an LLM day. Missing fields degrade to defaults; issues are
 * returned instead of thrown so the caller can log and still cache the day.
 */
export function validateDailyLife(
  raw: unknown,
  options: { dateLocal: string },
): DailyLifeValidation {
  const issues: DailyLifeIssue[] = [];
  const record = asRecord(raw);
  if (!record) {
    return { value: emptyDailyLife(options.dateLocal), issues: ['not-an-object'] };
  }

  const dateLocal =
    typeof record.dateLocal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(record.dateLocal)
      ? record.dateLocal
      : options.dateLocal;
  if (record.dateLocal !== undefined && dateLocal !== record.dateLocal) {
    issues.push('invalid-date');
  }

  let blocks: DailyLifeBlock[] = [];
  if (Array.isArray(record.blocks)) {
    blocks = record.blocks
      .map(normalizeDailyLifeBlock)
      .filter((block): block is DailyLifeBlock => block !== null)
      .sort((a, b) => a.fromHour - b.fromHour);
    if (blocks.length > DAILY_LIFE_MAX_BLOCKS) {
      issues.push('too-many-blocks');
      blocks = blocks.slice(0, DAILY_LIFE_MAX_BLOCKS);
    }
    if (blocks.length > 0 && blocks.length < DAILY_LIFE_MIN_BLOCKS) {
      issues.push('too-few-blocks');
    }
  } else if (record.blocks !== undefined) {
    issues.push('blocks-not-array');
  }

  const events = stringList(record.events, DAILY_LIFE_EVENTS_MAX);
  const wants = stringList(record.wants, DAILY_LIFE_WANTS_MAX);
  if (events.length > 0 && events.length < 2) issues.push('events-too-few');
  if (wants.length > 0 && wants.length < 2) issues.push('wants-too-few');

  return {
    value: {
      dateLocal,
      ...(typeof record.weather === 'string' && record.weather.trim()
        ? { weather: record.weather.trim().slice(0, 120) }
        : {}),
      vibe:
        typeof record.vibe === 'string' && record.vibe.trim()
          ? record.vibe.trim().slice(0, 120)
          : 'обычный день',
      blocks,
      events,
      wants,
    },
    issues,
  };
}

export function isUsableDailyLife(value: DailyLife): boolean {
  return value.blocks.length > 0 && value.vibe.trim().length > 0;
}

/** Parse a raw JSON string/object from the LLM (code fences tolerated). */
export function parseDailyLifeJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === 'string') {
    const text = raw.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    if (!text) return null;
    try {
      return asRecord(JSON.parse(text));
    } catch {
      const match = /\{[\s\S]*\}/.exec(text);
      if (!match) return null;
      try {
        return asRecord(JSON.parse(match[0]));
      } catch {
        return null;
      }
    }
  }
  return asRecord(raw);
}

/** Human-readable markdown stored in `daily-life/<date>.md`. */
export function renderDailyLifeHuman(value: DailyLife): string {
  const lines = [`# День ${value.dateLocal}`];
  if (value.weather) lines.push(`погода: ${value.weather}`);
  lines.push(`настрой дня: ${value.vibe}`);
  lines.push('', '## Расписание');
  if (value.blocks.length === 0) {
    lines.push('- (расписание не задано)');
  } else {
    for (const block of value.blocks) {
      const social = SOCIAL_RU[block.social];
      const phone = block.phoneAvailable ? '' : ', без телефона';
      const mood = block.mood ? ` (${block.mood})` : '';
      lines.push(
        `- ${formatMinutes(block.fromHour * 60)}–${formatMinutes(
          block.toHour * 60,
        )} — ${block.activity} [${social}${phone}]${mood}`,
      );
    }
  }
  lines.push('', '## События дня');
  if (value.events.length === 0) lines.push('- (ничего заметного)');
  else for (const event of value.events) lines.push(`- ${event}`);
  lines.push('', '## Чего хочется');
  if (value.wants.length === 0) lines.push('- (ничего конкретного)');
  else for (const want of value.wants) lines.push(`- ${want}`);
  return lines.join('\n');
}

/** Cache format: markdown + `<!--daily:{json}-->`. */
export function encodeDailyLifeCache(value: DailyLife): string {
  return `${renderDailyLifeHuman(value)}\n\n<!--daily:${JSON.stringify(value)}-->`;
}

/** Decode the cache. Any broken JSON means "regenerate", not a crash. */
export function decodeDailyLifeCache(
  markdown: string,
  dateLocal: string,
): DailyLife | null {
  const match = /<!--daily:([\s\S]*?)-->/.exec(markdown);
  if (!match) return null;
  const parsed = parseDailyLifeJson(match[1]);
  if (!parsed) return null;
  return validateDailyLife(parsed, { dateLocal }).value;
}

function hourInBlock(hour: number, block: DailyLifeBlock): boolean {
  if (block.fromHour === block.toHour) return false;
  if (block.fromHour < block.toHour) {
    return hour >= block.fromHour && hour < block.toHour;
  }
  return hour >= block.fromHour || hour < block.toHour;
}

/**
 * Block containing a local hour. Exact match only: gaps are gaps. (The
 * reference returned the last block for gaps, which made "сейчас на работе"
 * appear at 03:00.)
 */
export function blockAtHour(
  value: DailyLife,
  hour: number,
): DailyLifeBlock | undefined {
  return value.blocks.find((block) => hourInBlock(hour, block));
}

export function currentBlock(
  value: DailyLife,
  config: Pick<PersonaConfig, 'timezone'>,
  now = Date.now(),
): DailyLifeBlock | undefined {
  return blockAtHour(value, localParts(now, config.timezone).hour);
}

export function isPhoneAvailable(value: DailyLife, hour: number): boolean {
  const block = blockAtHour(value, hour);
  return block ? block.phoneAvailable : true;
}

/** `phoneAvailable=false` block at the given local hour. */
export function isQuietBlock(value: DailyLife | undefined, hour: number): boolean {
  if (!value) return false;
  const block = blockAtHour(value, hour);
  return block !== undefined && !block.phoneAvailable;
}

/** Prompt fragment "what she is doing now". */
export function dailyLifePromptFragment(
  value: DailyLife,
  config: Pick<PersonaConfig, 'timezone'>,
  now = Date.now(),
): string {
  const hour = localParts(now, config.timezone).hour;
  const block = blockAtHour(value, hour);
  const lines = [
    `# Твой день (${value.dateLocal}) — это твоя жизнь, не его`,
    `настрой дня: ${value.vibe}`,
  ];
  if (value.weather) lines.push(`погода: ${value.weather}`);

  if (block) {
    lines.push(
      `сейчас (${formatMinutes(block.fromHour * 60)}–${formatMinutes(
        block.toHour * 60,
      )}): ${block.activity}. социально: ${SOCIAL_RU[block.social]}.`,
    );
    lines.push(
      block.phoneAvailable
        ? 'телефон под рукой: можешь отвечать, если есть пауза.'
        : 'телефон сейчас недоступен: отвечать не можешь или не хочешь.',
    );
    if (block.mood) lines.push(`микро-настроение: ${block.mood}`);
  } else {
    lines.push('сейчас между делами: точного занятия нет.');
  }

  if (value.events.length > 0) {
    lines.push(`что сегодня происходит: ${value.events.slice(0, 3).join('; ')}`);
  }
  if (value.wants.length > 0) {
    lines.push(`чего хочется: ${value.wants.slice(0, 3).join('; ')}`);
  }
  lines.push(
    'Не вываливай это на него списком. Это фон: упоминай естественно и только к месту.',
  );
  return lines.join('\n');
}

/** Events from previous days, for the "do not repeat" prompt note. */
export function collectRecentEvents(
  previous: DailyLife[],
  days = DAILY_LIFE_RECENT_DAYS,
): string[] {
  const deduped = new Set<string>();
  for (const day of previous.slice(-days)) {
    for (const event of day.events) deduped.add(event);
  }
  return [...deduped].slice(-20);
}
