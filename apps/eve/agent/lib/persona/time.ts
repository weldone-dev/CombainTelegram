/**
 * Timezone-aware clock helpers used by presence, agenda, daily-life and the
 * prompt builder. Pure functions: the only input is an epoch timestamp.
 */

import type { Weekday } from './types';

export interface LocalParts {
  hour: number;
  minute: number;
  weekday: Weekday;
  /** YYYY-MM-DD in the target timezone. */
  dateKey: string;
}

const WEEKDAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const WEEKDAY_BY_SHORT: Record<string, Weekday> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

const RU_MONTHS = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];

const RU_WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function clampInt(value: number, min: number, max: number): number {
  const rounded = Math.round(clamp(value, min, max));
  // Normalize -0 so JSON/deep-equality checks see a plain 0.
  return rounded === 0 ? 0 : rounded;
}

/** Positive modulo; unlike `%` it never returns a negative number. */
export function mod(value: number, base: number): number {
  return ((value % base) + base) % base;
}

export function finiteNumber(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Convert ISO/Date/number to epoch ms, or null when unparseable. */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function fallbackLocalParts(now: number): LocalParts {
  const date = new Date(now);
  return {
    hour: date.getHours(),
    minute: date.getMinutes(),
    weekday: WEEKDAYS[(date.getDay() + 6) % 7]!,
    dateKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`,
  };
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  FORMATTERS.set(timezone, formatter);
  return formatter;
}

/** Local hour/minute/weekday/date for a timezone. Invalid timezones fall back
 * to the host clock, which is the least surprising degradation for a local
 * single-user process. */
export function localParts(now: number, timezone: string): LocalParts {
  try {
    const formatter = formatterFor(timezone);
    const parts = formatter.formatToParts(new Date(now));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    const hour = Number(get('hour')) % 24;
    const minute = Number(get('minute'));
    const weekday = WEEKDAY_BY_SHORT[get('weekday')] ?? fallbackLocalParts(now).weekday;
    const dateKey = `${get('year')}-${get('month')}-${get('day')}`;
    if (
      !Number.isFinite(hour) ||
      !Number.isFinite(minute) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)
    ) {
      return fallbackLocalParts(now);
    }
    return { hour, minute, weekday, dateKey };
  } catch {
    return fallbackLocalParts(now);
  }
}

export function localDateKey(now: number, timezone: string): string {
  return localParts(now, timezone).dateKey;
}

/** Russian label for the prompt, e.g. "пт, 27 ноя, 21:40". */
export function formatLocalTime(now: number, timezone: string): string {
  const { hour, minute, weekday } = localParts(now, timezone);
  const index = WEEKDAYS.indexOf(weekday);
  const date = new Date(now);
  let month = RU_MONTHS[date.getUTCMonth()] ?? '';
  let day = date.getUTCDate();
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      month: 'short',
      day: '2-digit',
    }).formatToParts(new Date(now));
    const m = parts.find((part) => part.type === 'month')?.value ?? '';
    const d = Number(parts.find((part) => part.type === 'day')?.value ?? '');
    const monthIndex = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ].indexOf(m);
    if (monthIndex >= 0) month = RU_MONTHS[monthIndex]!;
    if (Number.isFinite(d) && d > 0) day = d;
  } catch {
    // keep host-date fallback
  }
  return `${RU_WEEKDAYS[index] ?? 'пн'}, ${day} ${month}, ${String(hour).padStart(2, '0')}:${String(
    minute,
  ).padStart(2, '0')}`;
}

/**
 * Half-open hour window `[from, to)`. A `from > to` window crosses midnight.
 * `from === to` is a degenerate window and always returns false ("never").
 */
export function isHourInRange(hour: number, from: number, to: number): boolean {
  const h = mod(Math.trunc(hour), 24);
  const a = mod(Math.trunc(from), 24);
  const b = mod(Math.trunc(to), 24);
  if (a === b) return false;
  if (a < b) return h >= a && h < b;
  return h >= a || h < b;
}

/** Minute-of-day variant of {@link isHourInRange}; used for busy slots. */
export function isMinuteInRange(minuteOfDay: number, from: number, to: number): boolean {
  const m = mod(Math.trunc(minuteOfDay), 1440);
  const a = mod(Math.trunc(from), 1440);
  const b = mod(Math.trunc(to), 1440);
  if (a === b) return false;
  if (a < b) return m >= a && m < b;
  return m >= a || m < b;
}

/**
 * Minutes until the next occurrence of targetHour:targetMinute (0..1440).
 * If the target is exactly "now", returns 0; if it already passed, adds a day.
 */
export function minutesUntil(
  hour: number,
  minute: number,
  targetHour: number,
  targetMinute = 0,
): number {
  const now = mod(Math.trunc(hour), 24) * 60 + mod(Math.trunc(minute), 60);
  const target = mod(Math.trunc(targetHour), 24) * 60 + mod(Math.trunc(targetMinute), 60);
  return target >= now ? target - now : target + 1440 - now;
}

/** Parse "HH:MM" / "H:mm" into minute-of-day, or null when invalid. */
export function parseTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

export function formatMinutes(minuteOfDay: number): string {
  const value = mod(Math.trunc(minuteOfDay), 1440);
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function previousWeekday(day: Weekday): Weekday {
  const index = WEEKDAYS.indexOf(day);
  return WEEKDAYS[(index + 6) % 7]!;
}

export function isWeekday(value: unknown): value is Weekday {
  return typeof value === 'string' && (WEEKDAYS as string[]).includes(value);
}
