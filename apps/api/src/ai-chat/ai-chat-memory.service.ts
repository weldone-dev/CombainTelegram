import { Injectable } from '@nestjs/common';
import type {
  SoulMemoryModel,
  SoulSummaryModel,
  SoulTurnModel,
} from '@repo/database';
import { notFound } from '../common/api-error.js';
import { parseLimit } from '../messaging/params.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface ChatMemoryTurnView {
  role: string;
  content: string;
  createdAt: string;
}

export interface ChatMemoryFactView {
  kind: string;
  content: string;
  importance: number;
  createdAt: string;
}

export interface ChatMemoryView {
  accountId: string;
  chatId: number;
  /** Raw recent turns, newest first (capped by `limit`). */
  shortTerm: ChatMemoryTurnView[];
  longTerm: {
    /** Rolling summary of this chat; empty when none was built yet. */
    summary: string;
    facts: ChatMemoryFactView[];
  };
}

const MAX_LIMIT = 200;

function toTurn(row: SoulTurnModel): ChatMemoryTurnView {
  return {
    role: row.role,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
  };
}

function toFact(row: SoulMemoryModel): ChatMemoryFactView {
  return {
    kind: row.kind,
    content: row.content,
    importance: row.importance,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Read-only memory of one private chat, as the dashboard shows it: the recent
 * `SoulTurn` buffer plus the long-term `SoulSummary`/`SoulMemory` picture.
 *
 * Writes and compaction stay in `MemoryService`; this service only presents
 * the same tables scoped to an owned account and one chat.
 */
@Injectable()
export class AiChatMemoryService {
  constructor(private readonly prisma: PrismaService) {}

  async view(
    userId: string,
    accountId: string,
    chatId: number,
    limit?: number,
  ): Promise<ChatMemoryView> {
    await this.requireAccount(userId, accountId);
    const take = parseLimit(limit, MAX_LIMIT);
    const chat = BigInt(chatId);

    const [turns, summary, facts] = await Promise.all([
      this.prisma.soulTurn.findMany({
        where: { accountId, chatId: chat },
        orderBy: { createdAt: 'desc' },
        take,
      }) as Promise<SoulTurnModel[]>,
      this.prisma.soulSummary.findUnique({
        where: { accountId_chatId: { accountId, chatId: chat } },
      }) as Promise<SoulSummaryModel | null>,
      this.prisma.soulMemory.findMany({
        where: { accountId, chatId: chat },
        orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
        take,
      }) as Promise<SoulMemoryModel[]>,
    ]);

    return {
      accountId,
      chatId,
      shortTerm: turns.map(toTurn),
      longTerm: {
        summary: summary?.summary ?? '',
        facts: facts.map(toFact),
      },
    };
  }

  /**
   * Drops the whole AI context of one chat: the short-term turn buffer, the
   * rolling summary and the durable facts. The next reply starts from a clean
   * slate; the Telegram history itself is untouched.
   */
  async clear(
    userId: string,
    accountId: string,
    chatId: number,
  ): Promise<{ cleared: true; chatId: number }> {
    await this.requireAccount(userId, accountId);
    const chat = BigInt(chatId);
    await this.prisma.$transaction([
      this.prisma.soulTurn.deleteMany({ where: { accountId, chatId: chat } }),
      this.prisma.soulSummary.deleteMany({
        where: { accountId, chatId: chat },
      }),
      this.prisma.soulMemory.deleteMany({ where: { accountId, chatId: chat } }),
    ]);
    return { cleared: true, chatId };
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
}
