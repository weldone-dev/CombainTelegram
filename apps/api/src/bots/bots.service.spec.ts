import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TelegramBotModel } from '@repo/database';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';
import { BotsService } from './bots.service.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');
const VALID_TOKEN = '123456:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

type BotRow = TelegramBotModel & { skills: Array<{ skill: { slug: string } }> };

function botRow(overrides: Partial<TelegramBotModel> = {}): BotRow {
  return {
    id: 'bot-1',
    accountId: null,
    username: null,
    title: null,
    mode: 'soul-creator',
    enabled: true,
    tokenEncrypted: null,
    tokenNonce: null,
    tokenTag: null,
    tokenDekWrapped: null,
    tokenDekNonce: null,
    tokenDekTag: null,
    allowedUserIds: '[]',
    lastUpdateId: 0n,
    lastError: null,
    lastPolledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    skills: [],
    ...overrides,
  };
}

function createHarness() {
  const rows: BotRow[] = [];
  const botSkills: Array<{ botId: string; skillId: string }> = [];
  const skillRows = [
    { id: 'skill-1', slug: 'soul-creator' },
    { id: 'skill-2', slug: 'telegram-assistant' },
  ];
  const accounts = [{ id: 'acc-1' }];
  let sequence = 0;

  const withSkills = (row: BotRow): BotRow => ({
    ...row,
    skills: botSkills
      .filter((link) => link.botId === row.id)
      .map((link) => ({
        skill: {
          slug:
            skillRows.find((skill) => skill.id === link.skillId)?.slug ??
            'unknown',
        },
      })),
  });

  const find = (where: Record<string, unknown> = {}): BotRow | undefined =>
    rows.find((row) => {
      if ('id' in where && row.id !== where.id) return false;
      if ('accountId' in where) {
        const expected = where.accountId;
        if (expected === null && row.accountId !== null) return false;
        if (typeof expected === 'string' && row.accountId !== expected) {
          return false;
        }
      }
      if ('mode' in where && row.mode !== where.mode) return false;
      return true;
    });

  const prisma = {
    telegramBot: {
      findMany: vi.fn(
        async (
          args: {
            where?: { enabled?: boolean; tokenEncrypted?: { not: null } };
            include?: { skills?: unknown };
          } = {},
        ) =>
          rows
            .slice()
            .filter(
              (row) =>
                args.where?.enabled === undefined ||
                row.enabled === args.where.enabled,
            )
            .filter(
              (row) =>
                args.where?.tokenEncrypted === undefined ||
                row.tokenEncrypted !== null,
            )
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
            .map((row) => (args.include?.skills ? withSkills(row) : row)),
      ),
      findFirst: vi.fn(async (args: { where: Record<string, unknown> }) => {
        const row = find(args.where);
        return row ? withSkills(row) : null;
      }),
      findUnique: vi.fn(
        async (args: {
          where: Record<string, unknown>;
          include?: { skills?: unknown };
        }) => {
          const row = find(args.where);
          if (!row) return null;
          return args.include?.skills ? withSkills(row) : row;
        },
      ),
      create: vi.fn(async (args: { data: Partial<TelegramBotModel> }) => {
        sequence += 1;
        const row = botRow({
          ...args.data,
          id: `bot-${sequence}`,
          createdAt: new Date(NOW.getTime() + sequence),
          updatedAt: new Date(NOW.getTime() + sequence),
        });
        rows.push(row);
        return row;
      }),
      update: vi.fn(
        async (args: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = rows.find((candidate) => candidate.id === args.where.id);
          if (!row) throw new Error('bot not found');
          Object.assign(row, args.data, { updatedAt: new Date() });
          return row;
        },
      ),
      deleteMany: vi.fn(async (args: { where: { id: string } }) => {
        const index = rows.findIndex((row) => row.id === args.where.id);
        if (index >= 0) rows.splice(index, 1);
        return { count: index >= 0 ? 1 : 0 };
      }),
    },
    telegramAccount: {
      findUnique: vi.fn(async (args: { where: { id: string } }) =>
        accounts.find((account) => account.id === args.where.id) ?? null,
      ),
    },
    skill: {
      findMany: vi.fn(async (args: { where: { slug: { in: string[] } } }) =>
        skillRows.filter((skill) => args.where.slug.in.includes(skill.slug)),
      ),
    },
    botSkill: {
      deleteMany: vi.fn(async (args: { where: { botId: string } }) => {
        for (let index = botSkills.length - 1; index >= 0; index -= 1) {
          if (botSkills[index].botId === args.where.botId) {
            botSkills.splice(index, 1);
          }
        }
        return { count: 0 };
      }),
      create: vi.fn(
        async (args: { data: { botId: string; skillId: string } }) => {
          botSkills.push(args.data);
          return args.data;
        },
      ),
    },
    $transaction: vi.fn(async (operations: Array<Promise<unknown>>) =>
      Promise.all(operations),
    ),
  };

  const crypto = new SessionCryptoService(
    new TelegramConfigService(new ConfigService({})),
  );
  const config = {
    ownerTgUserIds: vi.fn(async () => ['99']),
  };

  const service = new BotsService(
    prisma as never,
    crypto,
    config as never,
  );

  return { service, prisma, crypto, config, rows, botSkills };
}

function httpBody(error: unknown): { code: string; message: string } {
  return (
    error as { getResponse(): { code: string; message: string } }
  ).getResponse();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BotsService tokens', () => {
  it('round-trips a token through SessionCryptoService and never returns it', async () => {
    const harness = createHarness();

    const created = await harness.service.upsertShared({ token: VALID_TOKEN });

    expect(created.hasToken).toBe(true);
    await expect(harness.service.token(created.id)).resolves.toBe(VALID_TOKEN);

    const view = await harness.service.get(created.id);
    expect(view.hasToken).toBe(true);
    expect(JSON.stringify(view)).not.toContain(VALID_TOKEN);
    expect(view).not.toHaveProperty('tokenEncrypted');
    expect(view).not.toHaveProperty('token');

    const listed = await harness.service.list();
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(VALID_TOKEN);
  });

  it('binds the encrypted token to bot:<id> as AAD', async () => {
    const harness = createHarness();
    const created = await harness.service.upsertShared({ token: VALID_TOKEN });
    const row = harness.rows[0];

    const payload = {
      cipher: new Uint8Array(row.tokenEncrypted as Uint8Array),
      nonce: new Uint8Array(row.tokenNonce as Uint8Array),
      tag: new Uint8Array(row.tokenTag as Uint8Array),
      dekWrapped: new Uint8Array(row.tokenDekWrapped as Uint8Array),
      dekNonce: new Uint8Array(row.tokenDekNonce as Uint8Array),
      dekTag: new Uint8Array(row.tokenDekTag as Uint8Array),
      keyVersion: 1,
    };

    expect(
      harness.crypto.decrypt(payload, `bot:${created.id}`).toString('utf8'),
    ).toBe(VALID_TOKEN);
    expect(() => harness.crypto.decrypt(payload, 'bot:another-bot')).toThrow();
  });

  it('rejects a malformed token and accepts a BotFather-shaped one', async () => {
    const harness = createHarness();
    const created = await harness.service.upsertShared({});

    const error = await harness.service
      .update(created.id, { token: 'abc' })
      .catch((caught: unknown) => caught);
    expect(httpBody(error).code).toBe('INVALID_BOT_TOKEN');

    const updated = await harness.service.update(created.id, {
      token: VALID_TOKEN,
    });
    expect(updated.hasToken).toBe(true);
    await expect(harness.service.token(created.id)).resolves.toBe(VALID_TOKEN);
  });

  it('returns null instead of throwing when stored columns are incomplete', async () => {
    const harness = createHarness();
    const created = await harness.service.upsertShared({});
    harness.rows[0].tokenEncrypted = new Uint8Array([1, 2, 3]);

    await expect(harness.service.token(created.id)).resolves.toBeNull();
  });
});

describe('BotsService.identify', () => {
  it('maps a successful getMe answer', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: { id: 777, username: 'soul_bot', first_name: 'Soul' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const harness = createHarness();
    const me = await harness.service.identify(VALID_TOKEN);

    expect(me).toEqual({ id: 777, username: 'soul_bot', firstName: 'Soul' });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.telegram.org/bot${VALID_TOKEN}/getMe`,
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('turns ok:false into BOT_TOKEN_REJECTED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ ok: false, description: 'Unauthorized' }),
      })),
    );

    const harness = createHarness();
    const error = await harness.service
      .identify(VALID_TOKEN)
      .catch((caught: unknown) => caught);

    expect(httpBody(error)).toEqual({
      code: 'BOT_TOKEN_REJECTED',
      message: 'Unauthorized',
    });
  });

  it('turns a non-2xx answer into BOT_TOKEN_REJECTED', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, description: 'Unauthorized' }),
      })),
    );

    const harness = createHarness();
    const error = await harness.service
      .identify(VALID_TOKEN)
      .catch((caught: unknown) => caught);

    expect(httpBody(error).code).toBe('BOT_TOKEN_REJECTED');
  });
});

describe('BotsService rows', () => {
  it('keeps exactly one shared bot on repeated upserts', async () => {
    const harness = createHarness();

    const first = await harness.service.upsertShared({ username: 'soul_bot' });
    const second = await harness.service.upsertShared({ title: 'Renamed' });

    expect(second.id).toBe(first.id);
    expect(harness.rows).toHaveLength(1);
    expect(harness.prisma.telegramBot.create).toHaveBeenCalledTimes(1);
    expect(second.mode).toBe('soul-creator');
    expect(second.accountId).toBeNull();
    expect(second.title).toBe('Renamed');
  });

  it('keeps one assistant bot per account and rejects unknown accounts', async () => {
    const harness = createHarness();

    const first = await harness.service.createForAccount('acc-1', {
      username: 'assistant_bot',
    });
    const second = await harness.service.createForAccount('acc-1', {
      title: 'Renamed',
    });

    expect(second.id).toBe(first.id);
    expect(harness.rows).toHaveLength(1);
    expect(harness.prisma.telegramBot.create).toHaveBeenCalledTimes(1);
    expect(second.accountId).toBe('acc-1');
    expect(second.mode).toBe('assistant');

    const error = await harness.service
      .createForAccount('missing', {})
      .catch((caught: unknown) => caught);
    expect(httpBody(error).code).toBe('ACCOUNT_NOT_FOUND');
  });

  it('replaces bot skills with the known slugs', async () => {
    const harness = createHarness();
    const created = await harness.service.createForAccount('acc-1', {});

    const view = await harness.service.setSkills(created.id, [
      'soul-creator',
      'missing',
      42,
    ]);

    expect(view.skills).toEqual(['soul-creator']);
    expect(harness.prisma.botSkill.create).toHaveBeenCalledTimes(1);
    expect(harness.botSkills).toEqual([
      { botId: created.id, skillId: 'skill-1' },
    ]);

    const replaced = await harness.service.setSkills(created.id, [
      'telegram-assistant',
    ]);
    expect(replaced.skills).toEqual(['telegram-assistant']);
    expect(harness.botSkills).toEqual([
      { botId: created.id, skillId: 'skill-2' },
    ]);
  });

  it('falls back to AiConfigService.ownerTgUserIds when the allowlist is empty', async () => {
    const harness = createHarness();
    const empty = await harness.service.upsertShared({});

    expect(empty.allowedUserIds).toEqual([]);
    await expect(
      harness.service.allowedTgUserIds(harness.rows[0]),
    ).resolves.toEqual(['99']);
    expect(harness.config.ownerTgUserIds).toHaveBeenCalledTimes(1);

    const explicit = await harness.service.upsertShared({
      allowedUserIds: ['42', 'spam'],
    });
    expect(explicit.allowedUserIds).toEqual(['42']);
    await expect(
      harness.service.allowedTgUserIds(harness.rows[0]),
    ).resolves.toEqual(['42']);
    expect(harness.config.ownerTgUserIds).toHaveBeenCalledTimes(1);
  });

  it('lists only enabled bots with a decryptable token as pollable', async () => {
    const harness = createHarness();
    await harness.service.upsertShared({ token: VALID_TOKEN });
    await harness.service.createForAccount('acc-1', {});

    await expect(harness.service.pollable()).resolves.toEqual([
      expect.objectContaining({ token: VALID_TOKEN }),
    ]);

    harness.rows[0].enabled = false;
    await expect(harness.service.pollable()).resolves.toEqual([]);
  });

  it('persists the polling cursor and clears the previous error', async () => {
    const harness = createHarness();
    const created = await harness.service.upsertShared({});

    await harness.service.setPolling(created.id, {
      lastUpdateId: 101n,
      lastError: null,
    });

    expect(harness.rows[0].lastUpdateId).toBe(101n);
    expect(harness.rows[0].lastError).toBeNull();
    expect(harness.rows[0].lastPolledAt).toBeInstanceOf(Date);
  });
});
