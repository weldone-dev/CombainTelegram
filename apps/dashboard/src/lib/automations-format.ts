import type { AutomationView } from "./ai-api";

/** True for an IANA zone the browser accepts; empty is not a zone. */
export function isValidTimeZone(value: string): boolean {
  if (!value.trim()) return false;
  try {
    new Intl.DateTimeFormat("ru-RU", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** The zone the user's browser reports, used as the form default. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** "09:00 · Europe/Moscow" — the wall clock the trigger follows. */
export function triggerSchedule(
  automation: Pick<AutomationView, "trigger" | "triggerType" | "timezone">,
): string {
  const trigger = automation.trigger ?? {};
  const zone = automation.timezone ? ` · ${automation.timezone}` : "";
  if (automation.triggerType === "incoming_message") {
    const keywords = Array.isArray(trigger.keywords)
      ? trigger.keywords.filter(Boolean).join(", ")
      : "";
    return `входящее сообщение${keywords ? `: ${keywords}` : ""}`;
  }
  if (trigger.kind === "daily") {
    return `ежедневно в ${String(trigger.at ?? "09:00")}${zone}`;
  }
  if (trigger.kind === "every") {
    return `каждые ${String(trigger.minutes ?? "?")} мин`;
  }
  return "вручную";
}

/** Formats an ISO instant in the automation's zone, falling back to local. */
export function formatInZone(
  iso: string | null | undefined,
  timezone: string | null | undefined,
): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: timezone ?? undefined,
    }).format(date);
  } catch {
    return date.toLocaleString("ru-RU");
  }
}

export function createdByLabel(createdBy: string): string {
  if (createdBy === "soul") return "создано душой";
  if (createdBy === "assistant") return "создано ассистентом";
  return "создано вами";
}
