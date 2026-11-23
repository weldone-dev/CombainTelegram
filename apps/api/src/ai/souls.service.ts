import { Injectable } from '@nestjs/common';
import type { SoulModel, TelegramAccountModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { SkillsService } from './skills.service.js';
import {
  DEFAULT_SOUL_SETTINGS,
  type SoulSettings,
  type SoulUpdate,
  type SoulView,
} from './ai.types.js';

type AccountWithSoul = TelegramAccountModel & { soul: SoulModel | null };

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function numbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item !== 0);
}

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function parseSoulSettings(raw: unknown): SoulSettings {
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
  return {
    allowAllChats: source.allowAllChats === true,
    chatIds: numbers(source.chatIds),
    excludeChatIds: numbers(source.excludeChatIds),
    replyDelayMs: clampInt(
      source.replyDelayMs,
      DEFAULT_SOUL_SETTINGS.replyDelayMs,
      0,
      120_000,
    ),
    maxPerHour: clampInt(source.maxPerHour, DEFAULT_SOUL_SETTINGS.maxPerHour, 0, 500),
    maxPerChatPerDay: clampInt(
      source.maxPerChatPerDay,
      DEFAULT_SOUL_SETTINGS.maxPerChatPerDay,
      0,
      5000,
    ),
    typing: source.typing !== false,
  };
}

@Injectable()
export class SoulsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
  ) {}

  async list(): Promise<SoulView[]> {
    const accounts = (await this.prisma.telegramAccount.findMany({
      include: { soul: true },
      orderBy: { createdAt: 'asc' },
    })) as AccountWithSoul[];
    const result: SoulView[] = [];
    for (const account of accounts) {
      const soul = account.soul ?? (await this.ensure(account));
      result.push(await this.view(soul));
    }
    return result;
  }

  async get(accountId: string): Promise<SoulView> {
    const account = (await this.prisma.telegramAccount.findUnique({
      where: { id: accountId },
      include: { soul: true },
    })) as AccountWithSoul | null;
    if (!account) throw new Error(`Account ${accountId} not found`);
    const soul = account.soul ?? (await this.ensure(account));
    return this.view(soul);
  }

  /** Raw model for internal use (agent prompt building). */
  async model(accountId: string): Promise<SoulModel | null> {
    return (await this.prisma.soul.findUnique({
      where: { accountId },
    })) as SoulModel | null;
  }

  private async ensure(account: AccountWithSoul): Promise<SoulModel> {
    const name = account.firstName || account.username || 'Аккаунт';
    return (await this.prisma.soul.upsert({
      where: { accountId: account.id },
      create: {
        accountId: account.id,
        name,
        settings: JSON.stringify(DEFAULT_SOUL_SETTINGS),
      },
      update: {},
    })) as SoulModel;
  }

  async update(accountId: string, input: SoulUpdate): Promise<SoulView> {
    const current = await this.get(accountId);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = text(input.name, current.name);
    if (input.essence !== undefined) data.essence = text(input.essence);
    if (input.tone !== undefined) data.tone = text(input.tone);
    if (input.goals !== undefined) data.goals = text(input.goals);
    if (input.boundaries !== undefined) {
      data.boundaries = text(input.boundaries);
    }
    if (input.language !== undefined) {
      data.language = text(input.language, 'ru');
    }
    if (input.systemPrompt !== undefined) {
      data.systemPrompt = optionalText(input.systemPrompt);
    }
    if (input.mode !== undefined) {
      const mode = String(input.mode);
      if (!['off', 'draft', 'auto'].includes(mode)) {
        throw new Error('Soul mode must be off, draft or auto');
      }
      data.mode = mode;
    }
    if (input.settings !== undefined) {
      data.settings = JSON.stringify({
        ...current.settings,
        ...parseSoulSettings(input.settings),
      });
    }
    if (input.model !== undefined) data.model = optionalText(input.model);
    if (input.temperature !== undefined) {
      const value = Number(input.temperature);
      data.temperature = Number.isFinite(value)
        ? Math.min(2, Math.max(0, value))
        : current.temperature;
    }
    if (Object.keys(data).length > 0) {
      await this.prisma.soul.update({ where: { accountId }, data });
    }
    if (input.skillSlugs !== undefined) {
      const slugs = Array.isArray(input.skillSlugs)
        ? input.skillSlugs.filter(
            (item): item is string => typeof item === 'string',
          )
        : [];
      await this.skills.attachToSoul(current.id, slugs);
    }
    return this.get(accountId);
  }

  async reset(accountId: string): Promise<void> {
    await this.prisma.soul.deleteMany({ where: { accountId } });
  }

  async view(soul: SoulModel): Promise<SoulView> {
    const skills = await this.skills.forSoul(soul.id);
    const mode = ['off', 'draft', 'auto'].includes(soul.mode)
      ? (soul.mode as SoulView['mode'])
      : 'off';
    return {
      id: soul.id,
      accountId: soul.accountId,
      name: soul.name,
      essence: soul.essence,
      tone: soul.tone,
      goals: soul.goals,
      boundaries: soul.boundaries,
      language: soul.language,
      systemPrompt: soul.systemPrompt,
      mode,
      settings: parseSoulSettings(soul.settings),
      model: soul.model,
      temperature: soul.temperature,
      skills,
      createdAt: soul.createdAt.toISOString(),
      updatedAt: soul.updatedAt.toISOString(),
    };
  }

  /** Builds the persona part of the system prompt. */
  async promptFor(
    soul: Pick<
      SoulModel,
      | 'name'
      | 'essence'
      | 'tone'
      | 'goals'
      | 'boundaries'
      | 'language'
      | 'systemPrompt'
    >,
  ): Promise<string> {
    const lines = [
      `Ты — «${soul.name}», цифровая душа Telegram-аккаунта.`,
      soul.essence ? `Кто ты: ${soul.essence}` : '',
      soul.tone ? `Тон и стиль: ${soul.tone}` : '',
      soul.goals ? `Цели в общении: ${soul.goals}` : '',
      soul.boundaries ? `Границы и запреты: ${soul.boundaries}` : '',
      `Язык общения: ${soul.language || 'ru'}.`,
      soul.systemPrompt ? `Дополнительно: ${soul.systemPrompt}` : '',
    ];
    return lines.filter(Boolean).join('\n');
  }

  /** Whether a private chat is covered by the soul's autopilot allowlist. */
  allowsChat(soul: SoulModel, chatId: number): boolean {
    const settings = parseSoulSettings(soul.settings);
    if (settings.excludeChatIds.includes(chatId)) return false;
    if (settings.allowAllChats) return true;
    return settings.chatIds.includes(chatId);
  }
}
