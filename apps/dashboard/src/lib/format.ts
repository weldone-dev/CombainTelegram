import type { AccountView } from "./types";

export function accountName(account: AccountView): string {
  const name = [account.firstName, account.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (name) return name;
  if (account.username) return `@${account.username}`;
  return `ID ${account.tgUserId}`;
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join("");
  return letters || "?";
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Сегодня";
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "Вчера";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

export function formatFileSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}

function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function sessionSummary(account: AccountView): string {
  const live = account.sessions.filter((session) => !session.revokedAt);
  const sessions = live.length > 0 ? live : account.sessions;
  const count = sessions.length;
  if (count === 0) return "нет сессий";
  const platforms = [
    ...new Set(sessions.map((session) => platformLabel(session.platform))),
  ].join("/");
  const label = plural(count, "сессия", "сессии", "сессий");
  return `${count} ${label}${platforms ? ` · ${platforms}` : ""}`;
}

export function platformLabel(platform: string): string {
  switch (platform) {
    case "desktop":
      return "Компьютер";
    case "mobile":
      return "Телефон";
    case "web":
      return "Веб";
    default:
      return platform;
  }
}
