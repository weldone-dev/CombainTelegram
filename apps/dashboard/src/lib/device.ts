const DEVICE_STORAGE_KEY = "combain.deviceId";

function generateDeviceId(): string {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Math.random().toString(36).slice(2)}${Math.random()
          .toString(36)
          .slice(2)}`;
  return `web-${random}`;
}

/** Stable per-browser device identity; created and persisted on first use. */
export function getDeviceId(): string {
  if (typeof window === "undefined") return "web-server";
  try {
    const stored = window.localStorage.getItem(DEVICE_STORAGE_KEY);
    if (stored?.trim()) return stored.trim();
  } catch {
    // Fall through to an in-memory identity.
  }
  const created = generateDeviceId();
  try {
    window.localStorage.setItem(DEVICE_STORAGE_KEY, created);
  } catch {
    // A blocked localStorage must not break account login.
  }
  return created;
}

/** Fresh identity for "new device" (PC + phone slots of the same account). */
export function createDeviceId(): string {
  const created = generateDeviceId();
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(DEVICE_STORAGE_KEY, created);
    } catch {
      // A blocked localStorage must not break account login.
    }
  }
  return created;
}
