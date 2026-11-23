import { API_URL, ApiError, apiFetch } from "./api";

/** State of Web Push in this browser. */
export type PushStatus =
  | "unsupported"
  | "denied"
  | "disabled"
  | "subscribed"
  | "off";

export interface PushTestResult {
  sent: number;
  failed: number;
}

const SW_URL = "/sw.js";

const DISABLED_MESSAGE =
  "Push-уведомления не настроены на сервере: администратор должен задать VAPID-ключи";

/** Same text the API-disabled flow throws, so callers can recognize it. */
export const PUSH_DISABLED_MESSAGE = DISABLED_MESSAGE;

/** True when this browser can do service workers and Web Push at all. */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** Registers `/sw.js`; safe to call more than once. */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  try {
    const registration = await navigator.serviceWorker.register(SW_URL, {
      scope: "/",
    });
    // Pick up a new SW even when the byte-identical check would be skipped.
    void registration.update().catch(() => undefined);
    return registration;
  } catch {
    return null;
  }
}

async function readyRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.ready;
  } catch {
    return null;
  }
}

/** Reads the local push state without asking the server for its key. */
export async function getPushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const registration = await readyRegistration();
  if (!registration) return "off";
  try {
    const subscription = await registration.pushManager.getSubscription();
    return subscription ? "subscribed" : "off";
  } catch {
    return "off";
  }
}

/**
 * Whether the API has VAPID keys configured. A deployment without them answers
 * `PUSH_DISABLED`, which the menu shows as "не настроено на сервере".
 */
export async function pushConfiguredOnServer(): Promise<boolean | null> {
  if (!pushSupported()) return false;
  try {
    const key = await apiFetch<{ publicKey: string }>("/push/key", {});
    return Boolean(key.publicKey);
  } catch (error) {
    // `null` means "could not tell" (API unreachable), not "disabled".
    return error instanceof ApiError && error.code === "PUSH_DISABLED"
      ? false
      : null;
  }
}

/**
 * `applicationServerKey` is base64url, Web Push API wants bytes.
 */
function urlBase64ToBytes(value: string): Uint8Array {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

/**
 * `PUT /push/subscribe` is the only push route `apiFetch` cannot express (it
 * has no PUT in its request type), so it is called with `fetch` directly.
 */
async function putSubscription(payload: {
  endpoint: string;
  keys: Record<string, string> | undefined;
}): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}/push/subscribe`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Нет связи с API-сервером");
  }
  if (response.ok) return;

  const data = (await response.json().catch(() => null)) as {
    code?: string;
  } | null;
  if (data?.code === "PUSH_DISABLED") {
    throw new Error(DISABLED_MESSAGE);
  }
  if (
    data?.code === "PUSH_ENDPOINT_INVALID" ||
    data?.code === "PUSH_KEYS_INVALID"
  ) {
    throw new Error("Браузер передал некорректную push-подписку");
  }
  throw new Error("Сервер не принял push-подписку");
}

/**
 * Asks for permission, subscribes this device and stores the subscription on
 * the API. Returns the resulting status; throws a readable error only when the
 * server cannot accept the subscription (for example 503 PUSH_DISABLED).
 */
export async function enablePush(): Promise<PushStatus> {
  if (!pushSupported()) return "unsupported";

  let permission = Notification.permission;
  if (permission === "default") {
    permission = await Notification.requestPermission();
  }
  if (permission !== "granted") return "denied";

  const registration =
    (await registerServiceWorker()) ?? (await readyRegistration());
  if (!registration) {
    throw new Error("Не удалось зарегистрировать service worker");
  }

  let publicKey: string;
  try {
    const key = await apiFetch<{ publicKey: string }>("/push/key", {});
    publicKey = key.publicKey;
  } catch (error) {
    if (error instanceof ApiError && error.code === "PUSH_DISABLED") {
      throw new Error(DISABLED_MESSAGE);
    }
    throw new Error("Не удалось получить ключ push-подписок с сервера");
  }

  if (!publicKey) {
    throw new Error(DISABLED_MESSAGE);
  }

  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToBytes(publicKey) as BufferSource,
    }));

  try {
    await putSubscription({
      endpoint: subscription.endpoint,
      keys: subscription.toJSON().keys,
    });
  } catch (error) {
    // Roll back the browser subscription so the state stays consistent.
    await subscription.unsubscribe().catch(() => undefined);
    throw error;
  }

  return "subscribed";
}

/** Removes this device's subscription from the browser and the server. */
export async function disablePush(): Promise<void> {
  const registration = await readyRegistration();
  if (!registration) return;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  try {
    await apiFetch("/push/subscribe", {
      method: "DELETE",
      body: { endpoint: subscription.endpoint },
    });
  } catch {
    // The browser subscription is still removed below; a stale server row is
    // dropped on the next 404/410 delivery attempt.
  }
  await subscription.unsubscribe().catch(() => undefined);
}

/** Sends a test notification to every device subscribed to this account. */
export async function sendTestPush(): Promise<PushTestResult> {
  try {
    return await apiFetch<PushTestResult>("/push/test", {
      method: "POST",
      body: {},
    });
  } catch (error) {
    if (error instanceof ApiError && error.code === "PUSH_DISABLED") {
      throw new Error(DISABLED_MESSAGE);
    }
    throw new Error("Не удалось отправить тестовое уведомление");
  }
}
