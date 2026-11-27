/**
 * Converts a Nest persona row into the pure `PersonaConfig` used by the
 * engine. Both the channel and the dynamic instructions read the same row, so
 * the parsing lives here instead of being duplicated.
 */

import type {
  BusySlot,
  CommunicationProfile,
  PersonaConfig,
  Stage,
  Weekday,
} from './types';

const STAGE_IDS = new Set<string>([
  'met-irl-got-tg',
  'tg-given-cold',
  'tg-given-warming',
  'convinced',
  'first-date-done',
  'dating-early',
  'dating-stable',
  'long-term',
  'dumped',
]);

const WEEKDAYS = new Set<string>(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

export function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Parses a JSON column; any broken value degrades to `fallback`. */
export function parseJsonColumn(
  value: unknown,
  fallback: Record<string, unknown> = {},
): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim() || value === '{}') {
    return fallback;
  }
  try {
    return recordOf(JSON.parse(value));
  } catch {
    return fallback;
  }
}

function timeOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Normalizes one busy slot. A slot without a label, a valid time range or a
 * non-zero duration is dropped: a broken routine must never make presence
 * claim "she is busy" for the whole day.
 */
export function normalizeBusySlot(value: unknown): BusySlot | null {
  const row = recordOf(value);
  const label = textOf(row.label).replace(/\s+/g, ' ').trim().slice(0, 80);
  const from = timeOf(row.from);
  const to = timeOf(row.to);
  if (!label || !from || !to || from === to) return null;
  const days = Array.isArray(row.days)
    ? row.days
        .filter(
          (day): day is Weekday =>
            typeof day === 'string' && WEEKDAYS.has(day),
        )
        .slice(0, 7)
    : undefined;
  const checkRaw = row.checkAfterMin;
  const checkAfterMin =
    Array.isArray(checkRaw) &&
    checkRaw.length === 2 &&
    Number.isFinite(Number(checkRaw[0])) &&
    Number.isFinite(Number(checkRaw[1]))
      ? ([
          Math.max(0, Math.round(Number(checkRaw[0]))),
          Math.max(0, Math.round(Number(checkRaw[1]))),
        ] as [number, number])
      : undefined;
  return {
    label,
    ...(days && days.length > 0 ? { days } : {}),
    from,
    to,
    ...(checkAfterMin ? { checkAfterMin } : {}),
  };
}

/** Busy routine from a Nest JSON column/array. Empty means "no routine". */
export function parseBusySchedule(value: unknown): BusySlot[] | undefined {
  const raw =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!Array.isArray(raw)) return undefined;
  const slots = raw
    .map(normalizeBusySlot)
    .filter((slot): slot is BusySlot => slot !== null)
    .slice(0, 12);
  return slots.length > 0 ? slots : undefined;
}

/**
 * Persona row → engine config. A missing name is the only fatal problem: the
 * caller then falls back to generic behavior.
 */
export function personaConfigFromRow(
  persona: Record<string, unknown>,
): PersonaConfig | null {
  const name = textOf(persona.name).trim();
  if (!name) return null;
  const communication = parseJsonColumn(
    persona.communication,
  ) as Partial<CommunicationProfile>;
  const stage = STAGE_IDS.has(textOf(persona.stage))
    ? (textOf(persona.stage) as Stage)
    : 'tg-given-warming';
  const busySchedule = parseBusySchedule(persona.busySchedule);
  return {
    name,
    age: Number(persona.age) || 22,
    nationality: textOf(persona.nationality) || 'RU',
    timezone: textOf(persona.timezone) || 'Europe/Moscow',
    stage,
    sleepFrom: Number(persona.sleepFrom ?? 23),
    sleepTo: Number(persona.sleepTo ?? 8),
    nightWakeChance: Number(persona.nightWakeChance ?? 0.05),
    ignoreTendency: Number(persona.ignoreTendency ?? 35),
    communication,
    ...(textOf(persona.vibe) ? { vibe: textOf(persona.vibe) } : {}),
    ...(busySchedule ? { busySchedule } : {}),
  };
}
