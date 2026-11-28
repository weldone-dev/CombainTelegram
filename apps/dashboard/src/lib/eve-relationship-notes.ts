/**
 * Relationship notes are a plain string written by Eve's reflection turns:
 * every line looks like `[reflect YYYY-MM-DD] текст`, older free-form lines may
 * still be present. This module turns that blob into rows the chat drawer can
 * render and link to the persona memory page.
 */

export interface RelationshipNoteLine {
  /** `YYYY-MM-DD` for a reflect line, `null` for a legacy free-form line. */
  date: string | null;
  text: string;
}

const REFLECT_LINE = /^\[reflect (\d{4}-\d{2}-\d{2})\]\s*([\s\S]*)$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Split notes into trimmed, non-empty lines, tagging the reflect prefix. */
export function parseRelationshipNotes(notes: string): RelationshipNoteLine[] {
  return notes
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const match = REFLECT_LINE.exec(line);
      if (!match) return { date: null, text: line };
      return { date: match[1] ?? null, text: (match[2] ?? "").trim() };
    });
}

/** True when at least one line carries a `[reflect YYYY-MM-DD]` prefix. */
export function hasReflectNotes(lines: RelationshipNoteLine[]): boolean {
  return lines.some((line) => line.date !== null);
}

/** True when a `YYYY-MM-DD` string is a real calendar day. */
export function isDayKey(value: string): boolean {
  if (!DAY.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00`);
  return !Number.isNaN(parsed.getTime());
}

function pad(part: number): string {
  return String(part).padStart(2, "0");
}

/**
 * Calendar days (`YYYY-MM-DD`) an ISO timestamp belongs to: the browser's local
 * day (what `toLocaleString` shows) and the UTC day (what Eve writes into daily
 * summaries and reflect notes). Matching either keeps a click on a note date
 * from missing records around midnight.
 */
export function isoDayKeys(value: string | null | undefined): string[] {
  if (!value) return [];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return [];
  const keys = [
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`,
    parsed.toISOString().slice(0, 10),
  ];
  return keys.filter((key, index) => keys.indexOf(key) === index);
}

/** Does an ISO timestamp or a day key fall on `day`? */
export function matchesDay(
  value: string | null | undefined,
  day: string,
): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (DAY.test(trimmed)) return trimmed === day;
  return isoDayKeys(trimmed).includes(day);
}
