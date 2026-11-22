const NOTIFICATIONS_KEY = "ct:notifications";

export type NotificationsState = "on" | "off" | "unavailable";

/** The browser Notification API is missing in some embedded webviews. */
export function notificationsSupported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

export function readNotificationsEnabled(): boolean {
  if (!notificationsSupported()) return false;
  try {
    return window.localStorage.getItem(NOTIFICATIONS_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeNotificationsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(NOTIFICATIONS_KEY, enabled ? "1" : "0");
  } catch {
    // Preference persistence is best-effort.
  }
}

/** True only while notifications are opted in and the permission is granted. */
export function notificationsReady(): boolean {
  if (!notificationsSupported()) return false;
  if (window.Notification.permission !== "granted") return false;
  return readNotificationsEnabled();
}

function shorten(text: string, limit = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Shows a desktop notification for one incoming message. The caller decides
 * whether the window is hidden; this helper only checks opt-in and permission.
 */
export function showMessageNotification(
  chatTitle: string,
  senderName: string,
  text: string,
  chatId: number,
): void {
  if (!notificationsReady()) return;
  const body = text ? `${senderName}: ${shorten(text)}` : senderName;
  try {
    new window.Notification(chatTitle, {
      body,
      tag: `ct-chat-${chatId}`,
      silent: false,
    });
  } catch {
    // Some browsers throw when a notification cannot be constructed.
  }
}
