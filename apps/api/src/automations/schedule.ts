/**
 * Wall-clock schedule helpers with IANA timezone support.
 *
 * `Intl.DateTimeFormat` is the only zone database we need, so no extra
 * dependency is added for `Asia/Yekaterinburg`-style schedules. Interval
 * ("every N minutes") triggers are absolute and therefore zone-independent;
 * the helpers below are used for `at: "HH:MM"` triggers, whose wall clock must
 * follow the automation's zone instead of the server's.
 */

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** True when `value` is an IANA zone the runtime understands. */
export function isValidTimeZone(value: string): boolean {
  if (!value.trim()) return false;
  try {
    formatterFor(value).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Parses `HH:MM`, clamping out-of-range digits to the last valid value. */
export function parseClock(value: string): WallClock | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Math.min(23, Number(match[1]));
  const minute = Math.min(59, Number(match[2]));
  return { year: 0, month: 1, day: 1, hour, minute, second: 0 };
}

function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const pick = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type);
    return part ? Number(part.value) : 0;
  };
  return {
    year: pick('year'),
    month: pick('month'),
    day: pick('day'),
    hour: pick('hour'),
    minute: pick('minute'),
    second: pick('second'),
  };
}

/** Zone offset in milliseconds east of UTC at a given instant. */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const whole = Math.floor(instantMs / 1000) * 1000;
  const clock = wallClockAt(new Date(whole), timeZone);
  return (
    Date.UTC(
      clock.year,
      clock.month - 1,
      clock.day,
      clock.hour,
      clock.minute,
      clock.second,
    ) - whole
  );
}

/**
 * Converts a wall clock reading in `timeZone` to a UTC instant. The offset is
 * resolved twice so that DST transitions resolve to the offset in force at the
 * resulting instant.
 */
export function wallClockToInstant(
  clock: Pick<WallClock, 'year' | 'month' | 'day' | 'hour' | 'minute'>,
  timeZone: string,
): Date {
  const guess = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    0,
    0,
  );
  const firstPass = guess - zoneOffsetMs(guess, timeZone);
  return new Date(guess - zoneOffsetMs(firstPass, timeZone));
}

/**
 * Next occurrence of `HH:MM` on the automation's zone wall clock. Exactly-now
 * counts as passed, matching the server-local behaviour.
 */
export function nextDailyInZone(
  at: string,
  from: Date,
  timeZone: string,
): Date | null {
  const clock = parseClock(at);
  if (!clock) return null;
  const now = wallClockAt(from, timeZone);
  const passed =
    clock.hour < now.hour ||
    (clock.hour === now.hour && clock.minute <= now.minute);
  let { year, month, day } = now;
  if (passed) {
    // Date.UTC normalises month/year rollover.
    const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
    year = tomorrow.getUTCFullYear();
    month = tomorrow.getUTCMonth() + 1;
    day = tomorrow.getUTCDate();
  }
  return wallClockToInstant(
    { year, month, day, hour: clock.hour, minute: clock.minute },
    timeZone,
  );
}
