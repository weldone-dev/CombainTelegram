import { Injectable } from '@nestjs/common';
import type { AiChatAccessModel, AiChatBlockModel } from '@repo/database';
import { notFound } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * `AiChatBlock.blockedBy` of a row that only carries the warning counter.
 *
 * The schema has no separate "warnings only" table, so `bumpWarning` keeps the
 * counter in the block row and marks it as not blocking yet. When the counter
 * reaches `AI_BLOCK_AFTER_WARNINGS` the same row turns into a real block and
 * `blockedBy` becomes `user` or `soul`. Everything outside this module reads
 * the derived REST shape, never the rows.
 */
const WARNING_ONLY = 'warning';

const DEFAULT_BLOCK_AFTER_WARNINGS = 3;

/** Who the block is attributed to. Anything else is coerced to `user`. */
export type BlockedBy = 'user' | 'soul';

export interface AiAccessDecision {
  /** A block always wins; without an enabled access row the chat is closed. */
  allowed: boolean;
  access: AiChatAccessModel | null;
  /** The active block (whole-chat or thread), `null` when not blocked. */
  block: AiChatBlockModel | null;
  /** Warning counter of the most specific row, even before it blocks. */
  warnings: number;
}

/** Public shape of one chat/topic; raw Prisma rows never leave the service. */
export interface AiAccessView {
  allowed: boolean;
  blocked: boolean;
  reason: string | null;
  warnings: number;
  soulId: string | null;
  note: string | null;
  threadId: number;
}

export interface AiChatAccessView {
  id: string;
  accountId: string;
  chatId: number;
  threadId: number;
  soulId: string | null;
  enabled: boolean;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AiChatBlockView {
  id: string;
  accountId: string;
  chatId: number;
  threadId: number;
  reason: string | null;
  warnings: number;
  blockedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AiAccessList {
  accesses: AiChatAccessView[];
  /** Active blocks only; warning-counter rows are not blocks. */
  blocks: AiChatBlockView[];
}

export interface AiWarningResult {
  warnings: number;
  blocked: boolean;
}

export interface AiUnblockResult extends AiWarningResult {
  removed: boolean;
}

export interface SetAccessInput {
  userId: string;
  accountId: string;
  chatId: number;
  /** `0` (default) = whole chat, positive = forum topic / comment thread. */
  threadId?: number;
  enabled?: boolean;
  soulId?: string | null;
  note?: string | null;
}

export interface BlockInput {
  userId: string;
  accountId: string;
  chatId: number;
  threadId?: number;
  reason?: string | null;
  blockedBy?: BlockedBy;
}

export interface WarningInput {
  userId: string;
  accountId: string;
  chatId: number;
  threadId?: number;
  reason?: string | null;
  /** Attribution of the automatic block once the threshold is reached. */
  blockedBy?: BlockedBy;
}

function toAccessView(row: AiChatAccessModel): AiChatAccessView {
  return {
    id: row.id,
    accountId: row.accountId,
    chatId: Number(row.chatId),
    threadId: row.threadId,
    soulId: row.soulId,
    enabled: row.enabled,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toBlockView(row: AiChatBlockModel): AiChatBlockView {
  return {
    id: row.id,
    accountId: row.accountId,
    chatId: Number(row.chatId),
    threadId: row.threadId,
    reason: row.reason,
    warnings: row.warnings,
    blockedBy: row.blockedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Per-chat AI permissions and blacklist for one Telegram account.
 *
 * `AiChatAccess` says "the soul may work in this chat/topic" (an explicit
 * `enabled = false` shadows the soul's own chat selection). `AiChatBlock` is
 * the blacklist and always wins. The soul's `allowAllChats` remains a separate
 * concern handled by the caller: this service only answers for stored rows.
 */
@Injectable()
export class AiAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Decides whether the AI may act in `chatId` / `threadId`. A positive thread
   * id falls back to the whole-chat row when the thread has no own row, and a
   * whole-chat block closes every topic of that chat.
   */
  async accessFor(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<AiAccessDecision> {
    await this.requireAccount(userId, accountId);
    const thread = this.thread(threadId);

    const [threadAccess, chatAccess, threadBlock, chatBlock] = await Promise.all(
      [
        thread > 0
          ? this.accessRow(accountId, chatId, thread)
          : Promise.resolve(null),
        this.accessRow(accountId, chatId, 0),
        thread > 0
          ? this.blockRow(accountId, chatId, thread)
          : Promise.resolve(null),
        this.blockRow(accountId, chatId, 0),
      ] as const,
    );

    const access = threadAccess ?? chatAccess;
    const block = this.activeBlock(threadBlock, chatBlock);

    return {
      allowed: block === null && access?.enabled === true,
      access,
      block,
      warnings: (threadBlock ?? chatBlock)?.warnings ?? 0,
    };
  }

  /** Public view of one chat/topic derived from `accessFor`. */
  async view(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<AiAccessView> {
    const thread = this.thread(threadId);
    const decision = await this.accessFor(userId, accountId, chatId, thread);
    return {
      allowed: decision.allowed,
      blocked: decision.block !== null,
      reason: decision.block?.reason ?? null,
      warnings: decision.warnings,
      soulId: decision.access?.soulId ?? null,
      note: decision.access?.note ?? null,
      threadId: thread,
    };
  }

  /** Upserts the access row keyed by `(accountId, chatId, threadId)`. */
  async setAccess(input: SetAccessInput): Promise<AiAccessView> {
    const { userId, accountId, chatId } = input;
    const threadId = this.thread(input.threadId);
    await this.requireAccount(userId, accountId);
    if (input.soulId !== undefined && input.soulId !== null) {
      await this.requireSoul(accountId, input.soulId);
    }

    const update: Record<string, unknown> = {};
    if (input.enabled !== undefined) update.enabled = input.enabled;
    if (input.soulId !== undefined) update.soulId = input.soulId;
    if (input.note !== undefined) update.note = input.note;

    await this.prisma.aiChatAccess.upsert({
      where: {
        accountId_chatId_threadId: {
          accountId,
          chatId: BigInt(chatId),
          threadId,
        },
      },
      create: {
        userId,
        accountId,
        chatId: BigInt(chatId),
        threadId,
        enabled: input.enabled ?? true,
        soulId: input.soulId ?? null,
        note: input.note ?? null,
      },
      update,
    });

    return this.view(userId, accountId, chatId, threadId);
  }

  /** Removes the access row of exactly this chat/topic. */
  async removeAccess(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<{ removed: boolean }> {
    await this.requireAccount(userId, accountId);
    const { count } = await this.prisma.aiChatAccess.deleteMany({
      where: { accountId, chatId: BigInt(chatId), threadId: this.thread(threadId) },
    });
    return { removed: count > 0 };
  }

  /** Blocks a chat/topic right away, keeping a warning counter if one exists. */
  async block(input: BlockInput): Promise<AiAccessView> {
    const { userId, accountId, chatId } = input;
    const threadId = this.thread(input.threadId);
    await this.requireAccount(userId, accountId);
    const blockedBy = this.blockedBy(input.blockedBy);

    const update: Record<string, unknown> = { blockedBy };
    if (input.reason !== undefined) update.reason = input.reason;

    await this.prisma.aiChatBlock.upsert({
      where: {
        accountId_chatId_threadId: {
          accountId,
          chatId: BigInt(chatId),
          threadId,
        },
      },
      create: {
        userId,
        accountId,
        chatId: BigInt(chatId),
        threadId,
        reason: input.reason ?? null,
        warnings: 0,
        blockedBy,
      },
      update,
    });

    return this.view(userId, accountId, chatId, threadId);
  }

  /** Lifts the block and drops the warning counter (unblock = clean slate). */
  async unblock(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<AiUnblockResult> {
    await this.requireAccount(userId, accountId);
    const { count } = await this.prisma.aiChatBlock.deleteMany({
      where: { accountId, chatId: BigInt(chatId), threadId: this.thread(threadId) },
    });
    return { removed: count > 0, warnings: 0, blocked: false };
  }

  /**
   * Adds one warning. Reaching `AI_BLOCK_AFTER_WARNINGS` (default 3) turns the
   * row into a real block; an already blocked chat stays blocked and is not
   * counted any further.
   */
  async bumpWarning(input: WarningInput): Promise<AiWarningResult> {
    const { userId, accountId, chatId } = input;
    const threadId = this.thread(input.threadId);
    await this.requireAccount(userId, accountId);

    const existing = await this.blockRow(accountId, chatId, threadId);
    if (existing && !this.isWarningOnly(existing)) {
      return { warnings: existing.warnings, blocked: true };
    }

    const warnings = (existing?.warnings ?? 0) + 1;
    const blocked = warnings >= this.blockAfterWarnings();
    const reason = input.reason ?? existing?.reason ?? null;

    if (existing) {
      const data: Record<string, unknown> = { warnings };
      if (blocked) {
        data.blockedBy = this.blockedBy(input.blockedBy);
        data.reason = reason;
      }
      await this.prisma.aiChatBlock.update({
        where: { id: existing.id },
        data,
      });
    } else {
      await this.prisma.aiChatBlock.create({
        data: {
          userId,
          accountId,
          chatId: BigInt(chatId),
          threadId,
          reason,
          warnings,
          blockedBy: blocked ? this.blockedBy(input.blockedBy) : WARNING_ONLY,
        },
      });
    }

    return { warnings, blocked };
  }

  /** Access + active blocks of one account, for decorating the chat list. */
  async list(userId: string, accountId: string): Promise<AiAccessList> {
    await this.requireAccount(userId, accountId);
    const [accesses, blocks] = await Promise.all([
      this.prisma.aiChatAccess.findMany({
        where: { accountId, userId },
        orderBy: [{ chatId: 'asc' }, { threadId: 'asc' }],
      }) as Promise<AiChatAccessModel[]>,
      this.prisma.aiChatBlock.findMany({
        where: { accountId, userId },
        orderBy: [{ chatId: 'asc' }, { threadId: 'asc' }],
      }) as Promise<AiChatBlockModel[]>,
    ]);
    return {
      accesses: accesses.map(toAccessView),
      blocks: blocks.filter((row) => !this.isWarningOnly(row)).map(toBlockView),
    };
  }

  /** Same ownership rule as `AccountsService.requireAccount`. */
  private async requireAccount(
    userId: string,
    accountId: string,
  ): Promise<void> {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
  }

  /** A soul is usable only on its own account (and the account is owned). */
  private async requireSoul(accountId: string, soulId: string): Promise<void> {
    const soul = await this.prisma.soul.findFirst({
      where: { id: soulId, accountId },
      select: { id: true },
    });
    if (!soul) throw notFound('SOUL_NOT_FOUND', 'Soul not found');
  }

  private async accessRow(
    accountId: string,
    chatId: number,
    threadId: number,
  ): Promise<AiChatAccessModel | null> {
    return (await this.prisma.aiChatAccess.findUnique({
      where: {
        accountId_chatId_threadId: {
          accountId,
          chatId: BigInt(chatId),
          threadId,
        },
      },
    })) as AiChatAccessModel | null;
  }

  private async blockRow(
    accountId: string,
    chatId: number,
    threadId: number,
  ): Promise<AiChatBlockModel | null> {
    return (await this.prisma.aiChatBlock.findUnique({
      where: {
        accountId_chatId_threadId: {
          accountId,
          chatId: BigInt(chatId),
          threadId,
        },
      },
    })) as AiChatBlockModel | null;
  }

  private activeBlock(
    ...rows: Array<AiChatBlockModel | null>
  ): AiChatBlockModel | null {
    for (const row of rows) {
      if (row && !this.isWarningOnly(row)) return row;
    }
    return null;
  }

  private isWarningOnly(row: AiChatBlockModel): boolean {
    return row.blockedBy === WARNING_ONLY;
  }

  private blockedBy(value: BlockedBy | undefined): BlockedBy {
    return value === 'soul' ? 'soul' : 'user';
  }

  /** `0` for the whole chat, a positive thread id otherwise. */
  private thread(value: number | undefined): number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : 0;
  }

  private blockAfterWarnings(): number {
    const raw = process.env.AI_BLOCK_AFTER_WARNINGS;
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed > 0
      ? parsed
      : DEFAULT_BLOCK_AFTER_WARNINGS;
  }
}
