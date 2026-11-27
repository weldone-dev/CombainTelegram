import type { EveScheduleDelayedAction } from "../../../lib/eve-schedules";

export const KIND_LABELS: Record<string, string> = {
  turn: "ответ",
  send: "отправка",
  edit: "правка",
  delete: "удаление",
  react: "реакция",
  read: "прочтение",
};

export const REASON_LABELS: Record<string, string> = {
  delay: "задержка",
  sleep: "сон",
  busy: "занята",
  offline: "офлайн",
  followup: "follow-up",
  "self-edit": "самоправка",
  superseded: "перекрыто",
};

export const STATE_LABELS: Record<string, string> = {
  pending: "ждёт",
  sent: "отправлено",
  failed: "ошибка",
  dropped: "снято",
};

export type Tone = "zinc" | "sky" | "green" | "amber" | "red";

export function stateTone(state: string): Tone {
  switch (state) {
    case "sent":
      return "green";
    case "failed":
      return "red";
    case "dropped":
      return "zinc";
    case "pending":
      return "amber";
    default:
      return "sky";
  }
}

export function kindTone(kind: string): Tone {
  switch (kind) {
    case "turn":
      return "sky";
    case "send":
      return "green";
    case "edit":
      return "amber";
    case "delete":
      return "red";
    case "react":
      return "green";
    default:
      return "zinc";
  }
}

/**
 * Human description of a five-field cron expression. Only the common shapes
 * Eve uses locally are spelled out; anything else is shown verbatim, so an
 * unknown expression is never silently misrepresented.
 */
export function humanCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron.trim() || "—";
  const [minute, hour, day, month, weekday] = parts;

  if (cron.trim() === "* * * * *") return "каждую минуту";
  const everyMinute = /^\*\/(\d+)$/.exec(minute);
  if (everyMinute && hour === "*" && day === "*" && month === "*" && weekday === "*") {
    return `каждые ${everyMinute[1]} мин`;
  }
  if (minute === "0" && hour === "*" && day === "*" && month === "*" && weekday === "*") {
    return "каждый час";
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    return `ежедневно в ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    day === "*" &&
    month === "*" &&
    weekday !== "*"
  ) {
    return `еженедельно (день ${weekday}) в ${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
  }
  return `по cron: ${cron.trim()}`;
}

/** "через 3 мин" / "2 мин назад" / "через 1 ч 5 мин". */
export function relativeDue(iso: string | null, nowMs: number): string {
  if (!iso) return "—";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "—";
  const diffMs = target - nowMs;
  const minutes = Math.max(0, Math.round(Math.abs(diffMs) / 60_000));
  if (minutes === 0) return diffMs >= 0 ? "сейчас" : "только что";
  let span: string;
  if (minutes < 60) {
    span = `${minutes} мин`;
  } else if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    span = rest > 0 ? `${hours} ч ${rest} мин` : `${hours} ч`;
  } else {
    span = `${Math.round(minutes / (24 * 60))} д`;
  }
  return diffMs >= 0 ? `через ${span}` : `${span} назад`;
}

export function formatDue(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatCreated(iso: string, nowMs: number): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  })} · ${relativeDue(iso, nowMs)}`;
}

export function isOverdue(
  action: Pick<EveScheduleDelayedAction, "state" | "dueAt">,
  nowMs: number,
): boolean {
  if (action.state !== "pending" || !action.dueAt) return false;
  const due = Date.parse(action.dueAt);
  return Number.isFinite(due) && due <= nowMs;
}

/** Rows with no clock wait for a presence change rather than the timer. */
export function waitsForState(action: EveScheduleDelayedAction): boolean {
  return action.dueAt === null;
}

/** Earliest future `dueAt` among pending rows, or null. */
export function nextDueAt(
  actions: EveScheduleDelayedAction[],
  nowMs: number,
): { iso: string; relative: string } | null {
  let best: string | null = null;
  let bestTime = Number.POSITIVE_INFINITY;
  for (const action of actions) {
    if (action.state !== "pending" || !action.dueAt) continue;
    const time = Date.parse(action.dueAt);
    if (!Number.isFinite(time) || time < nowMs) continue;
    if (time < bestTime) {
      bestTime = time;
      best = action.dueAt;
    }
  }
  return best ? { iso: best, relative: relativeDue(best, nowMs) } : null;
}

export function matchesSearch(
  action: EveScheduleDelayedAction,
  search: string,
): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;
  return [
    action.preview,
    action.lastError ?? "",
    action.kind,
    action.reason,
    action.state,
    action.chatId,
    action.personaId,
    action.accountId,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}
