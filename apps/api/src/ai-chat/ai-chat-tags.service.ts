import { Injectable } from '@nestjs/common';
import type { AiChatTagModel } from '@repo/database';
import { apiError, notFound } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Longest tag the API accepts, in code points. */
export const MAX_TAG_CHARS = 32;
/** Letters, digits, `_` and `-`; lower-cased before the check. */
const TAG_PATTERN = /^[\p{L}\p{N}_-]+$/u;

/**
 * Trims, lower-cases and validates one tag.
 *
 * Tags are labels (`vip`, `lead`, `follow-up`), not free text: the stored form
 * is the normalised one so `VIP` and `vip ` cannot both exist for one chat.
 * Letters are Unicode, so Cyrillic tags work.
 */
export function normalizeTag(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw apiError('VALIDATION_ERROR', 'tag must be a string');
  }
  const tag = raw.trim().toLowerCase();
  const chars = [...tag];
  if (chars.length === 0) {
    throw apiError('VALIDATION_ERROR', 'tag must not be empty');
  }
  if (chars.length > MAX_TAG_CHARS) {
    throw apiError(
      'VALIDATION_ERROR',
      `tag must be at most ${MAX_TAG_CHARS} characters`,
    );
  }
  if (!TAG_PATTERN.test(tag)) {
    throw apiError(
      'VALIDATION_ERROR',
      'tag may contain only letters, digits, "_" and "-"',
    );
  }
  return tag;
}

export interface ChatTagRemoveView {
  removed: boolean;
  tags: string[];
}

/** Wire shape of the per-chat tag routes. */
export interface ChatTagsView {
  accountId: string;
  chatId: number;
  tags: string[];
}

export interface ChatTagsRemovedView extends ChatTagsView {
  removed: boolean;
}

/**
 * Free-form tags of one chat, shared by the dashboard routes and the n8n
 * Action API.
 *
 * A tag belongs to a chat as a whole (no thread scope): the dashboard and a
 * workflow must see the same label for a channel post and its comments.
 * Writes are idempotent, so a repeated n8n call cannot fail on its own retry.
 */
@Injectable()
export class AiChatTagsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tags of one chat, oldest first. No ownership check: callers resolve an
   * owned account first (see {@link requireAccount}).
   */
  async list(accountId: string, chatId: number): Promise<string[]> {
    const rows = (await this.prisma.aiChatTag.findMany({
      where: { accountId, chatId: BigInt(chatId) },
      orderBy: [{ createdAt: 'asc' }, { tag: 'asc' }],
      select: { tag: true },
    })) as Array<Pick<AiChatTagModel, 'tag'>>;
    return rows.map((row) => row.tag);
  }

  /** Adds one tag; adding an existing tag is a no-op. Returns the new list. */
  async add(
    accountId: string,
    chatId: number,
    rawTag: unknown,
  ): Promise<string[]> {
    const tag = normalizeTag(rawTag);
    const chat = BigInt(chatId);
    await this.prisma.aiChatTag.upsert({
      where: { accountId_chatId_tag: { accountId, chatId: chat, tag } },
      create: { accountId, chatId: chat, tag },
      update: {},
    });
    return this.list(accountId, chatId);
  }

  /** Removes one tag; removing an absent tag reports `removed: false`. */
  async remove(
    accountId: string,
    chatId: number,
    rawTag: unknown,
  ): Promise<ChatTagRemoveView> {
    const tag = normalizeTag(rawTag);
    const { count } = await this.prisma.aiChatTag.deleteMany({
      where: { accountId, chatId: BigInt(chatId), tag },
    });
    return { removed: count > 0, tags: await this.list(accountId, chatId) };
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
}
