import { Injectable } from '@nestjs/common';
import type { AiChatBlockModel, AiChatEventModel } from '@repo/database';
import { notFound } from '../common/api-error.js';
import { parseLimit } from '../messaging/params.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { emitLog } from '../logs/log-sink.js';

/** Why a chat's AI state changed; mirrors the `AiChatEvent.kind` column. */
export type AiChatEventKind = 'warning' | 'block' | 'unblock' | 'clear' | 'access';

/** Who caused it. `soul` = the soul blocked itself after its warnings. */
export type AiChatEventActor = 'user' | 'soul' | 'system';

/** Public shape of one audit row; number ids instead of Prisma `BigInt`. */
export interface AiChatEventView {
  id: string;
  accountId: string;
  chatId: number;
  threadId: number;
  kind: AiChatEventKind;
  reason: string | null;
  warnings: number;
  actor: AiChatEventActor;
  createdAt: string;
}

export interface RecordAiChatEventInput {
  accountId: string;
  chatId: number;
  /** `0` = whole chat, positive = forum topic / comment thread. */
  threadId?: number;
  kind: AiChatEventKind;
  reason?: string | null;
  /** Resulting warning counter at the time of the event. */
  warnings?: number;
  /** Defaults to `user`. */
  actor?: AiChatEventActor;
}

export interface AiWarningsCleared {
  removed: boolean;
  warnings: number;
  blocked: boolean;
}

/** `AiChatBlock.blockedBy` of a row that only carries the warning counter. */
const WARNING_ONLY = 'warning';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function toView(row: AiChatEventModel): AiChatEventView {
  return {
    id: row.id,
    accountId: row.accountId,
    chatId: Number(row.chatId),
    threadId: row.threadId,
    kind: row.kind as AiChatEventKind,
    reason: row.reason,
    warnings: row.warnings,
    actor: (row.actor as AiChatEventActor) ?? 'user',
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Append-only audit trail of AI decisions about a chat: warnings, blocks,
 * unblocks, warning clears and access changes.
 *
 * `AiAccessService` writes the rows while applying a state change, so a block
 * can always be explained later ("who warned, why, how many"). Recording must
 * never break the state change itself, hence the swallowed error.
 */
@Injectable()
export class AiChatEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Best-effort append; a logging failure never fails the caller. */
  async record(input: RecordAiChatEventInput): Promise<void> {
    try {
      await this.prisma.aiChatEvent.create({
        data: {
          accountId: input.accountId,
          chatId: BigInt(input.chatId),
          threadId: this.thread(input.threadId),
          kind: input.kind,
          reason: input.reason ?? null,
          warnings: input.warnings ?? 0,
          actor: input.actor ?? 'user',
        },
      });
    } catch (error) {
      emitLog({
        level: 'warn',
        source: 'ai',
        action: 'ai.chat.event.record',
        message: `Could not record an AI chat event: ${(error as Error).message}`,
        status: 'failed',
        accountId: input.accountId,
        chatId: input.chatId,
        details: { kind: input.kind },
      });
    }
  }

  /** Newest first, exact thread (`0` = whole chat). */
  async list(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
    limit?: number,
  ): Promise<AiChatEventView[]> {
    await this.requireAccount(userId, accountId);
    const rows = (await this.prisma.aiChatEvent.findMany({
      where: {
        accountId,
        chatId: BigInt(chatId),
        threadId: this.thread(threadId),
      },
      orderBy: { createdAt: 'desc' },
      take: this.cap(limit),
    })) as AiChatEventModel[];
    return rows.map(toView);
  }

  /**
   * Resets the warning counter of exactly this chat/topic and records a
   * `clear` event. Unlike unblocking, the row stays: an existing block
   * (`blockedBy` user/soul) keeps denying access, only its counter is zeroed.
   */
  async clearWarnings(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<AiWarningsCleared> {
    await this.requireAccount(userId, accountId);
    const thread = this.thread(threadId);
    const row = (await this.prisma.aiChatBlock.findUnique({
      where: {
        accountId_chatId_threadId: {
          accountId,
          chatId: BigInt(chatId),
          threadId: thread,
        },
      },
    })) as AiChatBlockModel | null;

    if (!row) return { removed: false, warnings: 0, blocked: false };

    await this.prisma.aiChatBlock.update({
      where: { id: row.id },
      data: { warnings: 0 },
    });
    const blocked = row.blockedBy !== WARNING_ONLY;
    await this.record({
      accountId,
      chatId,
      threadId: thread,
      kind: 'clear',
      reason: 'warnings cleared',
      warnings: 0,
      actor: 'user',
    });
    return { removed: true, warnings: 0, blocked };
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

  private cap(value: number | undefined): number {
    return value === undefined
      ? DEFAULT_LIMIT
      : parseLimit(value, MAX_LIMIT);
  }
}
