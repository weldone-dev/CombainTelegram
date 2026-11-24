import { describe, expect, it, vi } from 'vitest';
import type { AiAccountSettingModel } from '@repo/database';
import type { AiConfigService } from '../ai/ai-config.service.js';
import type { AiCapabilities, AiPolicyView } from '../ai/ai.types.js';
import { DEFAULT_CAPABILITIES } from '../ai/ai.types.js';
import { AiAccountSettingsService, parseOverridePatch } from './ai-account-settings.service.js';

const USER_ID = 'local';
const OTHER_USER = 'someone-else';
const ACCOUNT_ID = 'account-1';
const NOW = new Date('2026-11-24T10:00:00.000Z');

function configWith(
  capabilities: Partial<AiCapabilities> = {},
): AiConfigService {
  const policy: AiPolicyView = {
    capabilities: { ...DEFAULT_CAPABILITIES, ...capabilities },
    allowAccountIds: [],
    allowChatIds: [],
    blockChatIds: [],
    dryRun: false,
    ownerTgUserIds: [],
  };
  return {
    policy: vi.fn(async () => policy),
  } as unknown as AiConfigService;
}

function harness(options: { global?: Partial<AiCapabilities> } = {}) {
  const rows = new Map<string, AiAccountSettingModel>();
  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(
        async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === ACCOUNT_ID && where.userId === USER_ID
            ? { id: ACCOUNT_ID }
            : null,
      ),
    },
    aiAccountSetting: {
      findUnique: vi.fn(
        async ({ where }: { where: { accountId: string } }) =>
          rows.get(where.accountId) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { accountId: string };
          create: { accountId: string; permissions: string };
          update: { permissions: string };
        }): Promise<AiAccountSettingModel> => {
          const existing = rows.get(where.accountId);
          const row: AiAccountSettingModel = {
            id: existing?.id ?? 'setting-1',
            accountId: where.accountId,
            permissions: existing ? update.permissions : create.permissions,
            createdAt: existing?.createdAt ?? NOW,
            updatedAt: NOW,
          };
          rows.set(where.accountId, row);
          return row;
        },
      ),
    },
  };
  const config = configWith(options.global);
  const service = new AiAccountSettingsService(prisma as never, config);
  return { service, prisma, rows, config };
}

function storedPermissions(
  rows: Map<string, AiAccountSettingModel>,
): Record<string, unknown> {
  const raw = rows.get(ACCOUNT_ID)?.permissions;
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

describe('AiAccountSettingsService', () => {
  it('inherits everything from the global policy without a stored row', async () => {
    const { service, prisma } = harness({ global: { send: true, delete: false } });

    const view = await service.view(USER_ID, ACCOUNT_ID);

    expect(view.accountId).toBe(ACCOUNT_ID);
    expect(view.permissions).toEqual({});
    expect(view.defaults.send).toBe(true);
    expect(view.defaults.delete).toBe(false);
    expect(view.effective).toEqual(view.defaults);
    expect(prisma.aiAccountSetting.upsert).not.toHaveBeenCalled();
  });

  it('merges an override key by key over the global defaults', async () => {
    const { service, rows } = harness();
    await service.view(USER_ID, ACCOUNT_ID);

    const view = await service.update(USER_ID, ACCOUNT_ID, {
      permissions: { delete: true, sendUnknown: false },
    });

    expect(view.permissions).toEqual({ delete: true, sendUnknown: false });
    // Overridden capability wins…
    expect(view.effective.delete).toBe(true);
    // …while every other capability keeps the global value.
    expect(view.effective.send).toBe(DEFAULT_CAPABILITIES.send);
    expect(view.effective.read).toBe(DEFAULT_CAPABILITIES.read);
    expect(storedPermissions(rows)).toEqual({
      delete: true,
      sendUnknown: false,
    });
  });

  it('patches existing overrides instead of replacing them', async () => {
    const { service, rows } = harness();
    await service.update(USER_ID, ACCOUNT_ID, {
      permissions: { delete: true, admin: true },
    });
    await service.update(USER_ID, ACCOUNT_ID, {
      permissions: { admin: false },
    });

    expect(storedPermissions(rows)).toEqual({ delete: true, admin: false });
  });

  it('drops an override with null and inherits the global value again', async () => {
    const { service, rows } = harness({ global: { delete: false } });
    await service.update(USER_ID, ACCOUNT_ID, {
      permissions: { delete: true },
    });

    const view = await service.update(USER_ID, ACCOUNT_ID, {
      permissions: { delete: null },
    });

    expect(view.permissions).toEqual({});
    expect(view.effective.delete).toBe(false);
    expect(storedPermissions(rows)).toEqual({});
  });

  it('rejects non-boolean flags without writing', async () => {
    const { service, prisma } = harness();

    await expect(
      service.update(USER_ID, ACCOUNT_ID, { permissions: { send: 'yes' } }),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION_ERROR' } });
    expect(prisma.aiAccountSetting.upsert).not.toHaveBeenCalled();
  });

  it('rejects an account owned by another user', async () => {
    const { service, prisma } = harness();

    await expect(service.view(OTHER_USER, ACCOUNT_ID)).rejects.toMatchObject({
      response: { code: 'ACCOUNT_NOT_FOUND' },
    });
    await expect(
      service.update(OTHER_USER, ACCOUNT_ID, { permissions: { send: false } }),
    ).rejects.toMatchObject({ response: { code: 'ACCOUNT_NOT_FOUND' } });
    expect(prisma.aiAccountSetting.upsert).not.toHaveBeenCalled();
  });

  it('resolveFor(null) is the global policy, ignoring stored rows', async () => {
    const { service } = harness({ global: { mcp: false } });

    const view = await service.resolveFor(null);

    expect(view.permissions).toEqual({});
    expect(view.effective.mcp).toBe(false);
  });

  it('ignores unknown keys in a stored row', async () => {
    const { service, rows } = harness();
    rows.set(ACCOUNT_ID, {
      id: 'setting-1',
      accountId: ACCOUNT_ID,
      permissions: JSON.stringify({ send: false, nope: true }),
      createdAt: NOW,
      updatedAt: NOW,
    });

    const view = await service.view(USER_ID, ACCOUNT_ID);

    expect(view.permissions).toEqual({ send: false });
  });
});

describe('parseOverridePatch', () => {
  it('keeps only known boolean keys', () => {
    expect(parseOverridePatch({ send: true, deleted: true })).toEqual({
      send: true,
    });
  });

  it('rejects arrays and scalars', () => {
    expect(() => parseOverridePatch([])).toThrow();
    expect(() => parseOverridePatch('send')).toThrow();
  });
});
