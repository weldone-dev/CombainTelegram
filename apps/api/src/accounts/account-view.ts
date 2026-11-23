import type { TelegramAccountModel, TelegramSessionModel } from '@repo/database';

export interface SessionView {
  id: string;
  deviceId: string;
  label: string | null;
  platform: string;
  profile: string;
  /** `mtcute` (string session) or `tdlib` (native TDLib database). */
  engine: string;
  proxyId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AccountView {
  id: string;
  tgUserId: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  /**
   * Decrypted phone number. The app is local and single-user, so the full
   * number is safe to return; `phoneMasked` stays for older clients.
   */
  phone: string | null;
  phoneMasked: string | null;
  isActive: boolean;
  /** Pinned transport session, or `null` when the fallback order applies. */
  activeSessionId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  deviceProfile: Record<string, unknown> | null;
  sessions: SessionView[];
}

export function serializeSession(session: TelegramSessionModel): SessionView {
  return {
    id: session.id,
    deviceId: session.deviceId,
    label: session.label,
    platform: session.platform,
    profile: session.profile,
    engine: session.engine,
    proxyId: session.proxyId,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
    revokedAt: session.revokedAt?.toISOString() ?? null,
  };
}

/** Telegram stores numbers without `+`; the UI always shows it. */
function displayPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  return phone.startsWith('+') ? phone : `+${phone}`;
}

export function serializeAccount(
  account: TelegramAccountModel,
  sessions: TelegramSessionModel[] = [],
  phone?: string | null,
): AccountView {
  return {
    id: account.id,
    tgUserId: account.tgUserId.toString(),
    firstName: account.firstName,
    lastName: account.lastName,
    username: account.username,
    phone: displayPhone(phone),
    phoneMasked: phone ? maskPhone(phone) : null,
    isActive: account.isActive,
    activeSessionId: account.activeSessionId ?? null,
    createdAt: account.createdAt.toISOString(),
    lastUsedAt: account.lastUsedAt?.toISOString() ?? null,
    deviceProfile: parseDeviceProfile(account.deviceProfile),
    sessions: sessions.map(serializeSession),
  };
}

export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 4) return `+${'*'.repeat(digits.length || 1)}`;
  return `+${'*'.repeat(Math.max(digits.length - 4, 1))}${digits.slice(-4)}`;
}

function parseDeviceProfile(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
