import { Injectable } from '@nestjs/common';
import type { AiAccountSettingModel } from '@repo/database';
import { AiConfigService } from '../ai/ai-config.service.js';
import { aiPolicyDefaults, mergeCapabilities } from './ai-capabilities.js';
import type { AiCapabilityOverrides } from './ai-capabilities.js';
import type { AiCapabilities, AiCapability } from '../ai/ai.types.js';
import { apiError, notFound } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

export type { AiCapabilityOverrides } from './ai-capabilities.js';

export interface AiAccountSettingsView {
  accountId: string;
  /** Raw stored overrides (`{}` = fully inherited). */
  permissions: AiCapabilityOverrides;
  /** `defaults` merged with `permissions`, key by key. */
  effective: AiCapabilities;
  /** The global policy capabilities this account inherits from. */
  defaults: AiCapabilities;
}

export interface AiAccountPatchInput {
  /** `{ permissions: { send: false, delete: null } }`; null drops an override. */
  permissions?: unknown;
}

/** Tolerant read of the stored JSON: unknown keys and non-booleans drop out. */
export function parseOverrides(raw: unknown): AiCapabilityOverrides {
  const source =
    typeof raw === 'string'
      ? (() => {
          try {
            return JSON.parse(raw) as Record<string, unknown>;
          } catch {
            return {};
          }
        })()
      : raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>)
        : {};
  const result: AiCapabilityOverrides = {};
  for (const key of Object.keys(aiPolicyDefaults()) as AiCapability[]) {
    const value = source[key];
    if (typeof value === 'boolean') result[key] = value;
  }
  return result;
}

/**
 * Strict patch: a known capability must be a boolean (`null`/absent means
 * "drop the override, inherit again"). Anything else is a 400, so a typo in
 * the dashboard cannot silently leave an account unrestricted.
 */
export function parseOverridePatch(raw: unknown): AiCapabilityOverrides {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw apiError(
      'VALIDATION_ERROR',
      'permissions must be an object of capability flags',
    );
  }
  const source = raw as Record<string, unknown>;
  const patch: AiCapabilityOverrides = {};
  for (const key of Object.keys(aiPolicyDefaults()) as AiCapability[]) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'boolean') {
      throw apiError(
        'VALIDATION_ERROR',
        `permissions.${key} must be a boolean or null`,
      );
    }
    patch[key] = value;
  }
  return patch;
}

/**
 * Per-account overrides of the global AI policy (`AiSetting.capabilities`).
 *
 * The global permissions card keeps working: an account with no stored row is
 * fully governed by the global policy, and a missing key always inherits.
 */
@Injectable()
export class AiAccountSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AiConfigService,
  ) {}

  /** Raw overrides of one account, after the ownership check. */
  async view(userId: string, accountId: string): Promise<AiAccountSettingsView> {
    await this.requireAccount(userId, accountId);
    return this.resolve(accountId);
  }

  /** Reads stored overrides; `defaults` fall back to the global policy. */
  async resolve(
    accountId: string,
    defaults?: AiCapabilities,
  ): Promise<AiAccountSettingsView> {
    const base = defaults ?? (await this.globalDefaults());
    const row = (await this.prisma.aiAccountSetting.findUnique({
      where: { accountId },
    })) as AiAccountSettingModel | null;
    return this.build(accountId, row, base);
  }

  /** Same merge for a nullable account id: no account = global policy. */
  async resolveFor(
    accountId: string | null,
    defaults?: AiCapabilities,
  ): Promise<AiAccountSettingsView> {
    const base = defaults ?? (await this.globalDefaults());
    if (!accountId) {
      return {
        accountId: '',
        permissions: {},
        effective: { ...base },
        defaults: { ...base },
      };
    }
    return this.resolve(accountId, base);
  }

  /**
   * Merges the patch into the stored overrides (PATCH semantics). `null` on a
   * key removes it; `permissions: {}` leaves the row untouched.
   */
  async update(
    userId: string,
    accountId: string,
    input: AiAccountPatchInput | unknown,
  ): Promise<AiAccountSettingsView> {
    await this.requireAccount(userId, accountId);
    // Accept both `{ permissions: {...} }` and a bare map of flags.
    const raw =
      input && typeof input === 'object' && 'permissions' in (input as object)
        ? (input as AiAccountPatchInput).permissions
        : input;
    // Throws on a malformed patch; the raw map is applied below so `null`
    // can remove an override.
    parseOverridePatch(raw);

    const row = (await this.prisma.aiAccountSetting.findUnique({
      where: { accountId },
    })) as AiAccountSettingModel | null;
    const current = parseOverrides(row?.permissions ?? {});
    const next: AiCapabilityOverrides = { ...current };
    // Validation already ran; apply the raw patch so `null` can drop a key.
    const source = (raw ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(aiPolicyDefaults()) as AiCapability[]) {
      const value = source[key];
      if (value === null) delete next[key];
      else if (typeof value === 'boolean') next[key] = value;
    }

    const stored = JSON.stringify(next);
    const saved = (await this.prisma.aiAccountSetting.upsert({
      where: { accountId },
      create: { accountId, permissions: stored },
      update: { permissions: stored },
    })) as AiAccountSettingModel;
    return this.build(accountId, saved, await this.globalDefaults());
  }

  /** Same ownership rule as `AccountsService.requireAccount`. */
  async requireAccount(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
  }

  /** Global policy capabilities; the defaults every account inherits. */
  private async globalDefaults(): Promise<AiCapabilities> {
    try {
      return (await this.config.policy()).capabilities;
    } catch {
      // A missing settings row must not break the per-account page.
      return aiPolicyDefaults();
    }
  }

  private build(
    accountId: string,
    row: AiAccountSettingModel | null,
    defaults: AiCapabilities = aiPolicyDefaults(),
  ): AiAccountSettingsView {
    const permissions = parseOverrides(row?.permissions ?? {});
    return {
      accountId,
      permissions,
      effective: mergeCapabilities(defaults, permissions),
      defaults: { ...defaults },
    };
  }
}
