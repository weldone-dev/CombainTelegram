import { Injectable } from '@nestjs/common';
import type {
  AiChatSkillModel,
  SkillModel,
  SoulModel,
  SoulSkillModel,
} from '@repo/database';
import type { SkillView } from '../ai/ai.types.js';
import { apiError, notFound } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ChatSkillsView {
  /** Slugs the autopilot should use right now (chat override or soul). */
  effective: string[];
  /** Where `effective` came from. */
  source: 'chat' | 'soul';
  /** The soul's own skill set, shown as "reset to default". */
  defaults: string[];
  /** Catalog rows for `effective`, in that order (ignores deleted slugs). */
  skills: SkillView[];
}

const MAX_SKILLS = 100;

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** Stored `skillSlugs` JSON: strings only, deduped, order preserved. */
export function parseSlugs(raw: unknown): string[] {
  const source =
    typeof raw === 'string' ? parseJson(raw) : (raw ?? null);
  if (!Array.isArray(source)) return [];
  const result: string[] = [];
  for (const item of source) {
    if (typeof item !== 'string') continue;
    const slug = item.trim();
    if (!slug || result.includes(slug)) continue;
    result.push(slug);
  }
  return result;
}

/** Strict request parsing: an array (or a JSON array string), else 400. */
export function parseSlugsInput(raw: unknown): string[] {
  const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
  if (!Array.isArray(parsed)) {
    throw apiError('VALIDATION_ERROR', 'skillSlugs must be an array of slugs');
  }
  const result: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || !item.trim()) {
      throw apiError('VALIDATION_ERROR', 'skillSlugs must contain slugs');
    }
    const slug = item.trim();
    if (!result.includes(slug)) result.push(slug);
  }
  if (result.length > MAX_SKILLS) {
    throw apiError(
      'VALIDATION_ERROR',
      `skillSlugs must contain at most ${MAX_SKILLS} entries`,
    );
  }
  return result;
}

function parseTools(raw: string): string[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : [];
}

function toSkillView(skill: SkillModel): SkillView {
  return {
    id: skill.id,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    tools: parseTools(skill.tools),
    origin: skill.origin,
    enabled: skill.enabled,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

type SoulWithId = Pick<SoulModel, 'id'>;
type SoulSkillWithSkill = SoulSkillModel & { skill: SkillModel };

/**
 * Per-chat (and per-topic) skill overrides.
 *
 * A stored `AiChatSkill` row replaces the soul's skill set for that
 * conversation; an empty array is a deliberate "no skills here" and does not
 * fall back. Without a row the soul's skills apply, so removing the override
 * always restores the default.
 */
@Injectable()
export class AiChatSkillsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Full dashboard view of one chat/topic. */
  async view(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<ChatSkillsView> {
    await this.requireAccount(userId, accountId);
    const thread = this.thread(threadId);
    const row = await this.chatRow(accountId, chatId, thread);
    const defaults = await this.soulSlugs(accountId);
    const effective = row ? parseSlugs(row.skillSlugs) : defaults;
    return {
      effective,
      source: row ? 'chat' : 'soul',
      defaults,
      skills: await this.skillViews(effective),
    };
  }

  /**
   * Effective skill set of one chat/topic and where it came from.
   *
   * Same queries as {@link resolveSkillSlugs}; the `source` lets the autopilot
   * log which set a run used without a second lookup. No user id: callers
   * already resolved an owned account (the autopilot runs per account).
   */
  async resolve(
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<{ slugs: string[]; source: 'chat' | 'soul' }> {
    const row = await this.chatRow(accountId, chatId, this.thread(threadId));
    if (row) return { slugs: parseSlugs(row.skillSlugs), source: 'chat' };
    return { slugs: await this.soulSlugs(accountId), source: 'soul' };
  }

  /**
   * Signature for the autopilot wiring:
   * `resolveSkillSlugs(accountId, chatId, threadId = 0): Promise<string[]>`.
   * No user id: callers already resolved an owned account (autopilot runs per
   * account). Returns the stored chat override, otherwise the soul's skills.
   */
  async resolveSkillSlugs(
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<string[]> {
    return (await this.resolve(accountId, chatId, threadId)).slugs;
  }

  /** Replaces the chat/topic override after validating every slug exists. */
  async set(
    userId: string,
    accountId: string,
    chatId: number,
    rawSlugs: unknown,
    threadId = 0,
  ): Promise<ChatSkillsView> {
    await this.requireAccount(userId, accountId);
    const thread = this.thread(threadId);
    const slugs = parseSlugsInput(rawSlugs);
    await this.requireSkills(slugs);

    await this.prisma.aiChatSkill.upsert({
      where: {
        accountId_chatId_threadId: {
          accountId,
          chatId: BigInt(chatId),
          threadId: thread,
        },
      },
      create: {
        accountId,
        chatId: BigInt(chatId),
        threadId: thread,
        skillSlugs: JSON.stringify(slugs),
      },
      update: { skillSlugs: JSON.stringify(slugs) },
    });
    return this.view(userId, accountId, chatId, thread);
  }

  /** Drops the override; the soul's skills apply again. */
  async remove(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<{ removed: boolean }> {
    await this.requireAccount(userId, accountId);
    const { count } = await this.prisma.aiChatSkill.deleteMany({
      where: {
        accountId,
        chatId: BigInt(chatId),
        threadId: this.thread(threadId),
      },
    });
    return { removed: count > 0 };
  }

  /** Every slug must name an existing skill; the message lists the missing. */
  private async requireSkills(slugs: string[]): Promise<void> {
    if (slugs.length === 0) return;
    const rows = (await this.prisma.skill.findMany({
      where: { slug: { in: slugs } },
      select: { slug: true },
    })) as Array<Pick<SkillModel, 'slug'>>;
    const known = new Set(rows.map((row) => row.slug));
    const missing = slugs.filter((slug) => !known.has(slug));
    if (missing.length > 0) {
      throw apiError(
        'SKILL_NOT_FOUND',
        `Unknown skills: ${missing.join(', ')}`,
        400,
        { details: { missing } },
      );
    }
  }

  private async skillViews(slugs: string[]): Promise<SkillView[]> {
    if (slugs.length === 0) return [];
    const rows = (await this.prisma.skill.findMany({
      where: { slug: { in: slugs } },
    })) as SkillModel[];
    const bySlug = new Map(rows.map((row) => [row.slug, row]));
    return slugs
      .map((slug) => bySlug.get(slug))
      .filter((row): row is SkillModel => row !== undefined)
      .map(toSkillView);
  }

  /** The soul's skill set; an account without a soul has none. */
  private async soulSlugs(accountId: string): Promise<string[]> {
    const soul = (await this.prisma.soul.findUnique({
      where: { accountId },
      select: { id: true },
    })) as SoulWithId | null;
    if (!soul) return [];
    const links = (await this.prisma.soulSkill.findMany({
      where: { soulId: soul.id },
      include: { skill: true },
    })) as SoulSkillWithSkill[];
    return links.map((link) => link.skill.slug);
  }

  private async chatRow(
    accountId: string,
    chatId: number,
    threadId: number,
  ): Promise<AiChatSkillModel | null> {
    return (await this.prisma.aiChatSkill.findUnique({
      where: {
        accountId_chatId_threadId: {
          accountId,
          chatId: BigInt(chatId),
          threadId,
        },
      },
    })) as AiChatSkillModel | null;
  }

  /** Same ownership rule as `AccountsService.requireAccount`. */
  private async requireAccount(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
  }

  /** `0` for the whole chat, a positive thread id otherwise. */
  private thread(value: number | undefined): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : 0;
  }
}
