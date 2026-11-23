import { Injectable } from '@nestjs/common';
import type { TelegramBotModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { AiConfigService } from '../ai/ai-config.service.js';
import type { EncryptedPayload } from '../telegram/session-crypto.service.js';
import { apiError, notFound } from '../common/api-error.js';

export interface BotView {
  id: string;
  accountId: string | null;
  mode: string;
  username: string | null;
  title: string | null;
  enabled: boolean;
  hasToken: boolean;
  allowedUserIds: string[];
  skills: string[];
  lastError: string | null;
  lastPolledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BotInput {
  accountId?: unknown;
  token?: unknown;
  username?: unknown;
  title?: unknown;
  mode?: unknown;
  enabled?: unknown;
  allowedUserIds?: unknown;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item).trim())
    .filter((item) => /^\d+$/.test(item));
}

function parseAllowed(raw: string): string[] {
  try {
    return stringList(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function toView(row: TelegramBotModel, skills: string[] = []): BotView {
  return {
    id: row.id,
    accountId: row.accountId,
    mode: row.mode,
    username: row.username,
    title: row.title,
    enabled: row.enabled,
    hasToken: Boolean(row.tokenEncrypted),
    allowedUserIds: parseAllowed(row.allowedUserIds),
    skills,
    lastError: row.lastError,
    lastPolledAt: row.lastPolledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const BOT_AAD = (id: string): string => `bot:${id}`;

/**
 * Storage and validation for Telegram bots. The polling loop lives in
 * `BotRunnerService`; this service only owns rows and encrypted tokens so it
 * can be used by the agent tools without creating a cycle.
 */
@Injectable()
export class BotsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SessionCryptoService,
    private readonly config: AiConfigService,
  ) {}

  async list(): Promise<BotView[]> {
    const rows = await this.prisma.telegramBot.findMany({
      orderBy: [{ accountId: 'asc' }, { createdAt: 'asc' }],
      include: { skills: { include: { skill: { select: { slug: true } } } } },
    });
    return rows.map((row) =>
      toView(
        row as TelegramBotModel,
        row.skills.map((link) => link.skill.slug),
      ),
    );
  }

  async get(id: string): Promise<BotView> {
    const row = await this.prisma.telegramBot.findUnique({
      where: { id },
      include: { skills: { include: { skill: { select: { slug: true } } } } },
    });
    if (!row) throw notFound('BOT_NOT_FOUND', 'Bot not found');
    return toView(
      row as TelegramBotModel,
      row.skills.map((link) => link.skill.slug),
    );
  }

  async row(id: string): Promise<TelegramBotModel> {
    const row = (await this.prisma.telegramBot.findUnique({
      where: { id },
    })) as TelegramBotModel | null;
    if (!row) throw notFound('BOT_NOT_FOUND', 'Bot not found');
    return row;
  }

  async shared(): Promise<BotView | null> {
    const row = await this.prisma.telegramBot.findFirst({
      where: { accountId: null, mode: 'soul-creator' },
      include: { skills: { include: { skill: { select: { slug: true } } } } },
    });
    return row
      ? toView(
          row as TelegramBotModel,
          row.skills.map((link) => link.skill.slug),
        )
      : null;
  }

  /** Creates or updates the shared soul-creator bot. */
  async upsertShared(input: BotInput): Promise<BotView> {
    const existing = (await this.prisma.telegramBot.findFirst({
      where: { accountId: null, mode: 'soul-creator' },
    })) as TelegramBotModel | null;
    if (existing) return this.update(existing.id, input);
    const created = (await this.prisma.telegramBot.create({
      data: {
        accountId: null,
        mode: 'soul-creator',
        username: optionalText(input.username),
        title: optionalText(input.title) ?? 'Создатель душ',
        enabled: input.enabled !== false,
        allowedUserIds: JSON.stringify(stringList(input.allowedUserIds)),
      },
    })) as TelegramBotModel;
    return this.update(created.id, input);
  }

  async createForAccount(accountId: string, input: BotInput): Promise<BotView> {
    const account = await this.prisma.telegramAccount.findUnique({
      where: { id: accountId },
    });
    if (!account) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
    const existing = (await this.prisma.telegramBot.findUnique({
      where: { accountId },
    })) as TelegramBotModel | null;
    if (existing) return this.update(existing.id, input);
    const created = (await this.prisma.telegramBot.create({
      data: {
        accountId,
        mode: 'assistant',
        username: optionalText(input.username),
        title: optionalText(input.title) ?? 'Ассистент аккаунта',
        enabled: input.enabled !== false,
        allowedUserIds: JSON.stringify(stringList(input.allowedUserIds)),
      },
    })) as TelegramBotModel;
    return this.update(created.id, input);
  }

  async update(id: string, input: BotInput): Promise<BotView> {
    const row = await this.row(id);
    const data: Record<string, unknown> = {};
    if (input.username !== undefined) {
      data.username = optionalText(input.username);
    }
    if (input.title !== undefined) data.title = optionalText(input.title);
    if (input.enabled !== undefined) {
      data.enabled = input.enabled === true || input.enabled === 'true';
    }
    if (input.allowedUserIds !== undefined) {
      data.allowedUserIds = JSON.stringify(stringList(input.allowedUserIds));
    }
    const token = optionalText(input.token);
    if (token) {
      if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
        throw apiError(
          'INVALID_BOT_TOKEN',
          'A Telegram bot token looks like 123456:ABC-DEF…',
          400,
        );
      }
      Object.assign(data, this.secretColumns(this.crypto.encrypt(token, BOT_AAD(row.id))));
      data.lastError = null;
      data.enabled = true;
    }
    const updated = (await this.prisma.telegramBot.update({
      where: { id },
      data,
    })) as TelegramBotModel;
    return toView(updated);
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    await this.prisma.telegramBot.deleteMany({ where: { id } });
    return { removed: true };
  }

  async token(id: string): Promise<string | null> {
    const row = await this.row(id);
    if (
      !row.tokenEncrypted ||
      !row.tokenNonce ||
      !row.tokenTag ||
      !row.tokenDekWrapped ||
      !row.tokenDekNonce ||
      !row.tokenDekTag
    ) {
      return null;
    }
    try {
      return this.crypto
        .decrypt(this.payload(row), BOT_AAD(id))
        .toString('utf8');
    } catch {
      return null;
    }
  }

  /** Calls Bot API `getMe`; used before saving a token. */
  async identify(token: string): Promise<{
    id: number;
    username: string | null;
    firstName: string;
  }> {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/getMe`,
      { signal: AbortSignal.timeout(15_000) },
    );
    const body = (await response.json()) as {
      ok?: boolean;
      result?: { id?: number; username?: string; first_name?: string };
      description?: string;
    };
    if (!response.ok || !body.ok || !body.result) {
      throw apiError(
        'BOT_TOKEN_REJECTED',
        body.description ?? 'Telegram rejected the bot token',
        400,
      );
    }
    return {
      id: body.result.id ?? 0,
      username: body.result.username ?? null,
      firstName: body.result.first_name ?? 'Bot',
    };
  }

  /** Enabled bots with a decryptable token, for the polling runner. */
  async pollable(): Promise<Array<{ bot: TelegramBotModel; token: string }>> {
    const rows = (await this.prisma.telegramBot.findMany({
      where: { enabled: true, tokenEncrypted: { not: null } },
    })) as TelegramBotModel[];
    const result: Array<{ bot: TelegramBotModel; token: string }> = [];
    for (const row of rows) {
      const token = await this.token(row.id);
      if (token) result.push({ bot: row, token });
    }
    return result;
  }

  /** Explicit allowlist, or every account owner's Telegram id. */
  async allowedTgUserIds(bot: TelegramBotModel): Promise<string[]> {
    const own = parseAllowed(bot.allowedUserIds);
    if (own.length > 0) return own;
    return this.config.ownerTgUserIds();
  }

  async setPolling(
    id: string,
    input: { lastUpdateId?: bigint; lastError?: string | null },
  ): Promise<void> {
    await this.prisma.telegramBot.update({
      where: { id },
      data: {
        ...(input.lastUpdateId !== undefined
          ? { lastUpdateId: input.lastUpdateId }
          : {}),
        lastError: input.lastError ?? null,
        lastPolledAt: new Date(),
      },
    });
  }

  async setSkills(id: string, slugs: unknown): Promise<BotView> {
    const list = Array.isArray(slugs)
      ? slugs.filter((item): item is string => typeof item === 'string')
      : [];
    const skills = await this.prisma.skill.findMany({
      where: { slug: { in: list } },
      select: { id: true },
    });
    await this.prisma.$transaction([
      this.prisma.botSkill.deleteMany({ where: { botId: id } }),
      ...skills.map((skill) =>
        this.prisma.botSkill.create({
          data: { botId: id, skillId: skill.id },
        }),
      ),
    ]);
    return this.get(id);
  }

  private secretColumns(secret: EncryptedPayload): Record<string, unknown> {
    return {
      tokenEncrypted: secret.cipher,
      tokenNonce: secret.nonce,
      tokenTag: secret.tag,
      tokenDekWrapped: secret.dekWrapped,
      tokenDekNonce: secret.dekNonce,
      tokenDekTag: secret.dekTag,
    };
  }

  private payload(row: TelegramBotModel): EncryptedPayload {
    return {
      cipher: new Uint8Array(row.tokenEncrypted as Uint8Array),
      nonce: new Uint8Array(row.tokenNonce as Uint8Array),
      tag: new Uint8Array(row.tokenTag as Uint8Array),
      dekWrapped: new Uint8Array(row.tokenDekWrapped as Uint8Array),
      dekNonce: new Uint8Array(row.tokenDekNonce as Uint8Array),
      dekTag: new Uint8Array(row.tokenDekTag as Uint8Array),
      keyVersion: 1,
    };
  }
}
