import type { EveSchedulesOverview } from "../../../lib/eve-schedules";

/**
 * `?demo=1` fixtures. They never touch the API; timestamps are relative to
 * "now" so the overdue badge and "через N мин" stay meaningful in a preview.
 */
export function demoSchedules(nowMs: number): EveSchedulesOverview {
  const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
  return {
    static: [
      {
        name: "presence",
        cron: "* * * * *",
        path: "schedules/presence.ts",
        hasRun: true,
        timezone: null,
      },
      {
        name: "proactive",
        cron: "* * * * *",
        path: "schedules/proactive.ts",
        hasRun: true,
        timezone: null,
      },
    ],
    dynamic: [
      {
        name: "reminders/followups",
        cron: "*/15 * * * *",
        path: "schedules/reminders.ts",
        creator: "model",
      },
    ],
    delayed: [
      {
        id: "demo-1",
        personaId: "persona-demo",
        accountId: "account-demo",
        chatId: "1830539716",
        threadId: 0,
        kind: "turn",
        reason: "delay",
        state: "pending",
        dueAt: iso(2 * 60_000),
        createdAt: iso(-4 * 60_000),
        attempts: 0,
        lastError: null,
        preview: "Доброе утро, Алиса! Как прошёл вчерашний созвон?",
      },
      {
        id: "demo-2",
        personaId: "persona-demo",
        accountId: "account-demo",
        chatId: "6123456789",
        threadId: 17,
        kind: "react",
        reason: "delay",
        state: "pending",
        dueAt: iso(-3 * 60_000),
        createdAt: iso(-5 * 60_000),
        attempts: 0,
        lastError: null,
        preview: "🔥",
      },
      {
        id: "demo-3",
        personaId: "persona-demo",
        accountId: "account-demo",
        chatId: "1830539716",
        threadId: 0,
        kind: "turn",
        reason: "sleep",
        state: "pending",
        dueAt: null,
        createdAt: iso(-90 * 60_000),
        attempts: 0,
        lastError: null,
        preview: "Ты ещё спишь? Напиши, когда проснёшься.",
      },
      {
        id: "demo-4",
        personaId: "persona-demo",
        accountId: "account-demo",
        chatId: "6123456789",
        threadId: 17,
        kind: "edit",
        reason: "self-edit",
        state: "failed",
        dueAt: iso(-30 * 60_000),
        createdAt: iso(-32 * 60_000),
        attempts: 5,
        lastError: "HTTP 400: message can't be edited",
        preview: "Уже вышла, буду через десять минут.",
      },
      {
        id: "demo-5",
        personaId: "persona-demo",
        accountId: "account-demo",
        chatId: "1830539716",
        threadId: 0,
        kind: "turn",
        reason: "delay",
        state: "dropped",
        dueAt: iso(-60 * 60_000),
        createdAt: iso(-62 * 60_000),
        attempts: 0,
        lastError: "superseded",
        preview: "Ответ на прошлое сообщение",
      },
    ],
    counts: { pending: 3, overdue: 1, failed: 1, dropped: 1 },
  };
}
