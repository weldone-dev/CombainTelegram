import type { TelegramAccountModel, TelegramSessionModel } from '@repo/database';

export interface SessionView {
  id: string;
  deviceId: string;
  label: string | null;
  platform: string;
  profile: string;
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
  phoneMasked: string | null;
  isActive: boolean;
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
    proxyId: session.proxyId,
    createdAt: session.createdAt.toISOString(),
    lastUsedAt: session.lastUsedAt?.toISOString() ?? null,
    revokedAt: session.revokedAt?.toISOString() ?? null,
  };
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
    phoneMasked: phone ? maskPhone(phone) : null,
    isActive: account.isActive,
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
