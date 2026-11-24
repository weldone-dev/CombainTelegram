import { Injectable } from '@nestjs/common';
import type { AgentRunModel } from '@repo/database';
import { notFound } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Default and hard cap of `GET /ai/runs`; the dashboard keeps it small. */
export const RUNS_DEFAULT_LIMIT = 20;
export const RUNS_MAX_LIMIT = 100;

export interface RunsQuery {
  userId: string;
  accountId?: string | null;
  chatId?: number | null;
  source?: string | null;
  limit?: number | null;
}

/**
 * Reads the Telegram message ids an agent run produced.
 *
 * `AgentRun.messageIds` is a JSON array stored as text. Malformed or legacy
 * values become an empty list instead of failing the endpoint.
 */
export function parseMessageIds(raw: string | null | undefined): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => Number(item))
      .filter((item) => Number.isSafeInteger(item) && item !== 0);
  } catch {
    return [];
  }
}

/** Clamps the requested page size into the supported range. */
export function runsLimit(value: number | null | undefined): number {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return RUNS_DEFAULT_LIMIT;
  }
  return Math.min(RUNS_MAX_LIMIT, Math.max(1, Math.trunc(value)));
}

/**
 * Storage side of the agent-run history: list/filter runs, load one run and
 * attach the ids of the Telegram bubbles a run produced.
 *
 * Kept outside `AgentService` so the autopilot and the HTTP controller can use
 * it without importing the whole agent. Account ownership is checked here, as
 * everywhere else in the AI controller.
 */
@Injectable()
export class AiRunsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Newest-first page of runs, filtered by account / chat / source. */
  async list(query: RunsQuery): Promise<AgentRunModel[]> {
    const accountId = query.accountId ?? null;
    if (accountId) await this.requireAccount(query.userId, accountId);

    return (await this.prisma.agentRun.findMany({
      where: {
        ...(accountId ? { accountId } : {}),
        ...(query.chatId !== null && query.chatId !== undefined
          ? { chatId: BigInt(query.chatId) }
          : {}),
        ...(query.source ? { source: query.source } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: runsLimit(query.limit),
    })) as AgentRunModel[];
  }

  /** One run, only when its account belongs to the caller. */
  async get(userId: string, id: string): Promise<AgentRunModel> {
    const run = (await this.prisma.agentRun.findUnique({
      where: { id },
    })) as AgentRunModel | null;
    if (!run) throw notFound('RUN_NOT_FOUND', 'Agent run not found');
    if (run.accountId) await this.requireAccount(userId, run.accountId);
    return run;
  }

  /**
   * Records which Telegram bubbles the run produced. Called after a DM reply
   * is fully sent so the dashboard can attach the reasoning to each bubble.
   */
  async attachMessages(runId: string, messageIds: number[]): Promise<void> {
    await this.prisma.agentRun.update({
      where: { id: runId },
      data: { messageIds: JSON.stringify(messageIds) },
    });
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
}
