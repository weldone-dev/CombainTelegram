/**
 * Presence heartbeat without the Eve engine.
 *
 * The persona process owns the rich presence model; Nest only needs a cheap,
 * deterministic decision for Telegram's online flag. "Awake = online" made her
 * look like a bot that never leaves the app, so this module derives one of the
 * reference patterns from the persona id and rolls a stable 10-minute bucket.
 */

export interface BusySlot {
  label: string;
  days?: string[];
  from: string;
  to: string;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type OnlinePattern =
  | 'phone-attached'
  | 'burst-checker'
  | 'rare-checker'
  | 'evening-only'
  | 'night-owl';

const PATTERNS: OnlinePattern[] = [
  'phone-attached',
  'burst-checker',
  'burst-checker',
  'rare-checker',
  'evening-only',
  'night-owl',
];

function hash(value: string): number {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193) >>> 0;
  }
  return result || 1;
}

export function patternFor(personaId: string): OnlinePattern {
  return PATTERNS[hash(`presence:${personaId}`) % PATTERNS.length]!;
}

/** JSON column → valid slots. Broken routine means "no routine". */
export function parseBusySchedule(value: unknown): BusySlot[] {
  if (typeof value !== 'string' || !value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const row = entry as Record<string, unknown>;
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    const from = typeof row.from === 'string' ? row.from.trim() : '';
    const to = typeof row.to === 'string' ? row.to.trim() : '';
    if (!label || !/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) {
      return [];
    }
    const days = Array.isArray(row.days)
      ? row.days.filter((day): day is string => typeof day === 'string')
      : undefined;
    return [{ label, from, to, ...(days ? { days } : {}) }];
  });
}

function minutesOf(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return (hour ?? 0) * 60 + (minute ?? 0);
}

export function busyNow(
  slots: BusySlot[],
  weekday: string,
  minutes: number,
): BusySlot | null {
  const index = WEEKDAYS.indexOf(weekday as (typeof WEEKDAYS)[number]);
  const previous =
    index >= 0 ? WEEKDAYS[(index + WEEKDAYS.length - 1) % WEEKDAYS.length] : undefined;
  for (const slot of slots) {
    const from = minutesOf(slot.from);
    const to = minutesOf(slot.to);
    if (from === to) continue;
    if (from < to) {
      if (slot.days?.length && !slot.days.includes(weekday)) continue;
      if (minutes >= from && minutes < to) return slot;
      continue;
    }
    // Crosses midnight: the tail belongs to the previous day's slot.
    if (minutes >= from && (!slot.days?.length || slot.days.includes(weekday))) {
      return slot;
    }
    if (
      minutes < to &&
      previous !== undefined &&
      (!slot.days?.length || slot.days.includes(previous))
    ) {
      return slot;
    }
  }
  return null;
}

export interface OnlineInput {
  personaId: string;
  /** Local hour 0..23. */
  hour: number;
  minute: number;
  /** Weekday id: mon..sun. */
  weekday: string;
  asleep: boolean;
  /** Active conflict: she hides and does not idle online. */
  conflict?: boolean;
  busy?: BusySlot | null;
  /** Epoch ms, injectable for specs. */
  now?: number;
}

export interface OnlineDecision {
  online: boolean;
  reason: string;
  pattern: OnlinePattern;
}

/**
 * Stable online/offline decision for a 10-minute bucket. Two ticks in the same
 * bucket agree, so the status does not flicker; the next bucket may differ.
 * Awake does not imply online, and online does not imply a dialog.
 */
export function decideOnline(input: OnlineInput): OnlineDecision {
  const pattern = patternFor(input.personaId);
  if (input.asleep) {
    return { online: false, reason: 'sleep', pattern };
  }
  if (input.conflict) {
    return { online: false, reason: 'conflict', pattern };
  }
  if (input.busy) {
    return { online: false, reason: `busy:${input.busy.label}`, pattern };
  }

  const now = input.now ?? Date.now();
  const bucket = Math.floor(now / (10 * 60_000));
  const roll = (hash(`${input.personaId}:${bucket}`) % 1000) / 1000;
  const evening = input.hour >= 18 && input.hour < 23;
  const night = input.hour >= 23 || input.hour < 3;
  const workHours = input.hour >= 10 && input.hour < 18;

  let chance: number;
  switch (pattern) {
    case 'phone-attached':
      chance = 0.65;
      break;
    case 'burst-checker':
      chance = workHours ? 0.28 : evening ? 0.55 : 0.35;
      break;
    case 'rare-checker':
      chance = evening ? 0.25 : 0.08;
      break;
    case 'evening-only':
      chance = evening ? 0.6 : 0.05;
      break;
    case 'night-owl':
      chance = night ? 0.55 : evening ? 0.45 : 0.15;
      break;
  }
  const online = roll < chance;
  return {
    online,
    reason: online ? `online:${pattern}` : `offline:${pattern}`,
    pattern,
  };
}
