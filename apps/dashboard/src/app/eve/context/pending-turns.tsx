"use client";

import { Card, Pill } from "../../../components/dashboard/ai-ui";
import type { EvePersonaView } from "../../../lib/eve-api";
import type { EveDelayedActionView } from "../../../lib/eve-actions";
import { accountName } from "../../../lib/format";
import type { AccountView } from "../../../lib/types";
import { excerpt, formatSnapshotTime } from "./context-utils";

/**
 * Pending delayed turns: messages the persona decided to answer later.
 * Until the Nest tick re-enters Eve there is no context snapshot, so without
 * this section a queued turn looks like a lost message.
 */

type Tone = "zinc" | "sky" | "green" | "amber" | "red";

interface QueueStatus {
  label: string;
  tone: Tone;
  overdue: boolean;
}

export function pendingStatus(
  action: EveDelayedActionView,
  nowMs: number,
): QueueStatus {
  if (action.state === "sent") {
    return { label: "отправлен", tone: "green", overdue: false };
  }
  if (action.state === "failed") {
    return { label: "ошибка", tone: "red", overdue: false };
  }
  if (action.state === "dropped") {
    return { label: "снят с очереди", tone: "zinc", overdue: false };
  }
  // A state other than `pending` that is not terminal yet: the tick is already
  // handling the row.
  if (action.state !== "pending") {
    return { label: "отправляется", tone: "sky", overdue: false };
  }
  const due = action.dueAt ? Date.parse(action.dueAt) : Number.NaN;
  if (Number.isFinite(due) && due <= nowMs) {
    return { label: "просрочен", tone: "red", overdue: true };
  }
  if (Number.isFinite(due)) {
    return { label: "ждёт", tone: "amber", overdue: false };
  }
  return { label: "ждёт сигнала", tone: "sky", overdue: false };
}

/** "через 3 мин" / "2 мин назад" / "через 1 ч 5 мин". */
export function relativeMinutes(
  iso: string | null,
  nowMs: number,
): string {
  if (!iso) return "—";
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) return "—";
  const diffMs = target - nowMs;
  const minutes = Math.max(0, Math.round(Math.abs(diffMs) / 60_000));
  let span: string;
  if (minutes === 0) return diffMs >= 0 ? "сейчас" : "только что";
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

const SOURCE_LABELS: Record<string, string> = {
  "active-dialog": "активный диалог",
  "conflict-cold": "холод после ссоры",
  asleep: "спит",
  "night-wake": "ночное пробуждение",
  dumped: "игнор (dumped)",
  llm: "решение LLM",
  fallback: "fallback",
};

const REASON_LABELS: Record<string, string> = {
  delay: "задержка",
  sleep: "сон",
  busy: "занята",
  offline: "офлайн",
  followup: "follow-up",
};

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Incoming text of the frozen payload: `incoming` or the last burst message. */
function incomingOf(action: EveDelayedActionView): {
  text: string;
  extra: number;
} {
  const burst = Array.isArray(action.payload.burst)
    ? action.payload.burst.map((entry) => record(entry))
    : [];
  const burstTexts = burst
    .map((entry) => (typeof entry.text === "string" ? entry.text.trim() : ""))
    .filter(Boolean);
  const incoming =
    typeof action.payload.incoming === "string"
      ? action.payload.incoming.trim()
      : "";
  const text = incoming || burstTexts[burstTexts.length - 1] || "";
  return { text, extra: Math.max(0, burstTexts.length - 1) };
}

export function PendingTurns({
  actions,
  personas,
  accounts,
  nowMs,
}: {
  actions: EveDelayedActionView[];
  personas: EvePersonaView[];
  accounts: AccountView[];
  nowMs: number;
}) {
  const personaNames = new Map(personas.map((persona) => [persona.id, persona.name]));
  const accountNames = new Map(
    accounts.map((account) => [account.id, accountName(account)]),
  );
  const overdue = actions.filter(
    (action) => pendingStatus(action, nowMs).overdue,
  ).length;

  return (
    <Card
      title="В очереди"
      description={`${actions.length} turn(ов) ждут отправки${
        overdue > 0 ? `, просрочено: ${overdue}` : ""
      } · обновляется вместе со снапшотами`}
    >
      <ul className="space-y-1.5">
        {actions.map((action) => {
          const status = pendingStatus(action, nowMs);
          const incoming = incomingOf(action);
          const behavior = record(action.payload.behavior);
          const source =
            typeof behavior.source === "string" ? behavior.source : "";
          const delaySec =
            typeof behavior.delaySec === "number" &&
            Number.isFinite(behavior.delaySec)
              ? behavior.delaySec
              : undefined;
          const hint =
            typeof action.payload.hint === "string" ? action.payload.hint : "";
          const personaName =
            personaNames.get(action.personaId) || action.personaId || "—";
          const accountLabel =
            accountNames.get(action.accountId) || action.accountId || "—";

          return (
            <li
              key={action.id}
              className={`rounded-md border px-2.5 py-2 ${
                status.overdue
                  ? "border-red-900/70 bg-red-950/20"
                  : "border-zinc-800 bg-zinc-950/30"
              }`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <Pill tone={status.tone}>{status.label}</Pill>
                <Pill tone={action.reason === "sleep" ? "sky" : "zinc"}>
                  {REASON_LABELS[action.reason] || action.reason || "delay"}
                </Pill>
                <span
                  className="font-mono text-[10px] text-zinc-500"
                  title={`Создан: ${formatSnapshotTime(action.createdAt)}`}
                >
                  создан {formatSnapshotTime(action.createdAt)}
                </span>
                <span className="ml-auto font-mono text-[10px] text-zinc-400">
                  {action.dueAt ? (
                    <>
                      due {formatSnapshotTime(action.dueAt)}
                      <span
                        className={
                          status.overdue
                            ? "ml-1 text-red-300"
                            : "ml-1 text-zinc-500"
                        }
                      >
                        · {relativeMinutes(action.dueAt, nowMs)}
                      </span>
                    </>
                  ) : (
                    <span className="text-zinc-400">без времени (ждёт сигнала)</span>
                  )}
                </span>
              </div>

              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-zinc-500">
                <span className="truncate text-zinc-300">{personaName}</span>
                <span>·</span>
                <span className="truncate">{accountLabel}</span>
                <span>·</span>
                <span className="truncate font-mono">
                  chat {action.chatId || "—"}
                  {action.threadId ? ` / ${action.threadId}` : ""}
                </span>
                {action.attempts > 0 && (
                  <>
                    <span>·</span>
                    <span>попыток: {action.attempts}</span>
                  </>
                )}
              </div>

              <p className="mt-1 line-clamp-2 break-words text-[11px] text-zinc-300">
                {incoming.text
                  ? excerpt(incoming.text, 180)
                  : "входящий текст не сохранён в payload"}
                {incoming.extra > 0 && (
                  <span className="text-zinc-500"> (+{incoming.extra} сообщ.)</span>
                )}
              </p>

              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-zinc-500">
                <Pill tone="zinc">{SOURCE_LABELS[source] || source || "источник не указан"}</Pill>
                {delaySec !== undefined && (
                  <span>delay {delaySec} с</span>
                )}
                {action.lastError && (
                  <span className="break-words text-red-300">
                    ошибка: {excerpt(action.lastError, 80)}
                  </span>
                )}
              </div>
              {hint && (
                <p className="mt-1 break-words text-[10px] text-zinc-500">
                  hint: {excerpt(hint, 140)}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
