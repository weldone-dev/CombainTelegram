import { Injectable, Logger } from '@nestjs/common';
import type { SoulMemoryModel, SoulSummaryModel, SoulTurnModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiConfigService } from './ai-config.service.js';
import { LlmService } from './llm.service.js';
import { emitLog } from '../logs/log-sink.js';

export interface TurnView {
  id: string;
  role: string;
  content: string;
  messageId: number | null;
  createdAt: string;
}

export interface FactView {
  id: string;
  chatId: number | null;
  kind: string;
  content: string;
  importance: number;
  source: string;
  createdAt: string;
}

export interface MemoryView {
  accountId: string;
  chatId: number | null;
  summary: string;
  facts: FactView[];
  turns: TurnView[];
  stats: { turns: number; facts: number };
  updatedAt: string | null;
}

export interface MemoryContext {
  summary: string;
  facts: FactView[];
  turns: TurnView[];
}

const COMPACT_AFTER = 30;
const KEEP_TURNS = 12;
const MAX_SUMMARY_TURNS = 60;

function toTurn(row: SoulTurnModel): TurnView {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    messageId: row.messageId === null ? null : Number(row.messageId),
    createdAt: row.createdAt.toISOString(),
  };
}

function toFact(row: SoulMemoryModel): FactView {
  return {
    id: row.id,
    chatId: row.chatId === null ? null : Number(row.chatId),
    kind: row.kind,
    content: row.content,
    importance: row.importance,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
  };
}

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-zа-яё0-9]+/i)
    .filter((word) => word.length >= 4);
}

function parseFacts(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function parseJsonBlock(raw: string): unknown {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Two-level memory:
 *
 * - short-term: `SoulTurn` rows, the raw buffer of recent messages per chat;
 * - long-term: a rolling `SoulSummary` per chat plus durable `SoulMemory`
 *   facts. When the buffer grows past `COMPACT_AFTER`, the oldest turns are
 *   summarised by the fast model, extracted facts are stored and the raw rows
 *   are pruned. Retrieval is keyword+recency ranked (no embeddings needed).
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AiConfigService,
    private readonly llm: LlmService,
  ) {}

  async append(
    accountId: string,
    chatId: number,
    role: 'user' | 'assistant' | 'draft',
    content: string,
    options: { messageId?: number | null; runId?: string | null } = {},
  ): Promise<TurnView> {
    const row = (await this.prisma.soulTurn.create({
      data: {
        accountId,
        chatId: BigInt(chatId),
        role,
        content: content.slice(0, 8000),
        messageId:
          options.messageId !== undefined && options.messageId !== null
            ? BigInt(options.messageId)
            : null,
        runId: options.runId ?? null,
      },
    })) as SoulTurnModel;
    return toTurn(row);
  }

  async recentTurns(
    accountId: string,
    chatId: number,
    limit = 24,
  ): Promise<TurnView[]> {
    const rows = (await this.prisma.soulTurn.findMany({
      where: { accountId, chatId: BigInt(chatId) },
      orderBy: { createdAt: 'desc' },
      take: limit,
    })) as SoulTurnModel[];
    return rows.reverse().map(toTurn);
  }

  async getSummary(
    accountId: string,
    chatId: number,
  ): Promise<SoulSummaryModel | null> {
    return (await this.prisma.soulSummary.findUnique({
      where: { accountId_chatId: { accountId, chatId: BigInt(chatId) } },
    })) as SoulSummaryModel | null;
  }

  async facts(
    accountId: string,
    chatId: number | null,
    options: { query?: string; limit?: number } = {},
  ): Promise<FactView[]> {
    const rows = (await this.prisma.soulMemory.findMany({
      where:
        chatId === null
          ? { accountId, chatId: null }
          : { accountId, OR: [{ chatId: BigInt(chatId) }, { chatId: null }] },
      orderBy: [{ importance: 'desc' }, { createdAt: 'desc' }],
      take: 200,
    })) as SoulMemoryModel[];
    const queryWords = new Set(words(options.query ?? ''));
    const scored = rows.map((row) => {
      const contentWords = words(row.content);
      const overlap = contentWords.filter((word) => queryWords.has(word)).length;
      const ageDays =
        (Date.now() - row.createdAt.getTime()) / (1000 * 60 * 60 * 24);
      const recency = Math.max(0, 30 - ageDays) / 30;
      return {
        row,
        score: overlap * 3 + row.importance + recency,
      };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored
      .slice(0, options.limit ?? 8)
      .map((entry) => toFact(entry.row));
  }

  async addFact(
    accountId: string,
    chatId: number | null,
    content: string,
    options: {
      kind?: string;
      importance?: number;
      source?: string;
    } = {},
  ): Promise<FactView> {
    const clean = content.replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!clean) throw new Error('Memory fact must not be empty');
    const existing = (await this.prisma.soulMemory.findMany({
      where:
        chatId === null
          ? { accountId, chatId: null }
          : { accountId, chatId: BigInt(chatId) },
      select: { id: true, content: true },
    })) as Pick<SoulMemoryModel, 'id' | 'content'>[];
    const normalized = clean.toLowerCase();
    const duplicate = existing.find(
      (row) => row.content.toLowerCase() === normalized,
    );
    if (duplicate) {
      const row = (await this.prisma.soulMemory.update({
        where: { id: duplicate.id },
        data: { importance: options.importance ?? 2 },
      })) as SoulMemoryModel;
      return toFact(row);
    }
    const row = (await this.prisma.soulMemory.create({
      data: {
        accountId,
        chatId: chatId === null ? null : BigInt(chatId),
        kind: options.kind ?? 'fact',
        content: clean,
        importance: Math.min(5, Math.max(1, options.importance ?? 2)),
        source: options.source ?? 'agent',
      },
    })) as SoulMemoryModel;
    return toFact(row);
  }

  async deleteFact(id: string): Promise<{ removed: boolean }> {
    await this.prisma.soulMemory.deleteMany({ where: { id } });
    return { removed: true };
  }

  async clearChat(accountId: string, chatId: number): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.soulTurn.deleteMany({
        where: { accountId, chatId: BigInt(chatId) },
      }),
      this.prisma.soulSummary.deleteMany({
        where: { accountId, chatId: BigInt(chatId) },
      }),
      this.prisma.soulMemory.deleteMany({
        where: { accountId, chatId: BigInt(chatId) },
      }),
    ]);
  }

  async view(accountId: string, chatId: number | null): Promise<MemoryView> {
    const summary =
      chatId === null ? null : await this.getSummary(accountId, chatId);
    const turns =
      chatId === null ? [] : await this.recentTurns(accountId, chatId, 50);
    const facts = await this.facts(accountId, chatId, { limit: 100 });
    const turnCount = await this.prisma.soulTurn.count({
      where:
        chatId === null
          ? { accountId }
          : { accountId, chatId: BigInt(chatId) },
    });
    const factCount = await this.prisma.soulMemory.count({
      where:
        chatId === null
          ? { accountId }
          : { accountId, chatId: BigInt(chatId) },
    });
    return {
      accountId,
      chatId,
      summary: summary?.summary ?? '',
      facts,
      turns,
      stats: { turns: turnCount, facts: factCount },
      updatedAt: summary?.updatedAt.toISOString() ?? null,
    };
  }

  /** Full context for the agent prompt. */
  async context(
    accountId: string,
    chatId: number,
    query: string,
  ): Promise<MemoryContext> {
    const [summary, facts, turns] = await Promise.all([
      this.getSummary(accountId, chatId),
      this.facts(accountId, chatId, { query, limit: 8 }),
      this.recentTurns(accountId, chatId, 20),
    ]);
    return {
      summary: summary?.summary ?? '',
      facts,
      turns,
    };
  }

  /**
   * Compacts old turns into the rolling summary. Returns false when the buffer
   * is below the threshold or the compaction failed, and true when it ran.
   */
  async maybeCompact(accountId: string, chatId: number): Promise<boolean> {
    const count = await this.prisma.soulTurn.count({
      where: { accountId, chatId: BigInt(chatId) },
    });
    if (count < COMPACT_AFTER) return false;
    try {
      await this.summarize(accountId, chatId, { force: true });
      return true;
    } catch (error) {
      emitLog({
        level: 'warn',
        source: 'ai',
        action: 'memory.compact',
        message: `Memory compaction failed: ${(error as Error).message}`,
        status: 'failed',
        accountId,
        chatId,
      });
      return false;
    }
  }

  async summarize(
    accountId: string,
    chatId: number,
    options: { force?: boolean } = {},
  ): Promise<{ summary: string; factsAdded: number; turnsUsed: number }> {
    const provider = await this.config.resolved();
    if (!provider.baseUrl || !provider.model || !provider.apiKey) {
      throw new Error('LLM is not configured; cannot summarise memory.');
    }
    const rows = (await this.prisma.soulTurn.findMany({
      where: { accountId, chatId: BigInt(chatId) },
      orderBy: { createdAt: 'asc' },
      take: MAX_SUMMARY_TURNS,
    })) as SoulTurnModel[];
    if (rows.length < 4 && !options.force) {
      return { summary: '', factsAdded: 0, turnsUsed: 0 };
    }
    const current = await this.getSummary(accountId, chatId);
    const transcript = rows
      .map((row) => `${row.role === 'assistant' ? 'Я' : 'Собеседник'}: ${row.content}`)
      .join('\n');
    const prompt = [
      'Текущая сводка:',
      current?.summary || '(пусто)',
      '',
      'Новые реплики:',
      transcript,
      '',
      'Верни только JSON: {"summary":"3-6 предложений", "facts":[{"kind":"fact|preference|event|profile","content":"...","importance":1}]}',
      'Факты — только устойчивые (имя, город, работа, привычки, договорённости). Не дублируй уже известное. Если фактов нет — [].',
    ].join('\n');
    const raw = await this.llm.complete({
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: provider.fastModel || provider.model,
      system:
        'Ты обновляешь долговременную память переписки. Пиши кратко, только по делу, без выдумок. Отвечай JSON-объектом.',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2,
      maxTokens: 900,
    });
    const parsed = parseJsonBlock(raw) as
      | { summary?: unknown; facts?: unknown }
      | null;
    const parsedSummary =
      typeof parsed?.summary === 'string' ? parsed.summary.trim() : '';
    const facts = Array.isArray(parsed?.facts) ? parsed.facts : [];
    if (!parsedSummary && facts.length === 0) {
      // The model answered nothing useful (empty content or broken JSON).
      // Pruning now would drop the raw turns without a summary to replace
      // them, so keep the buffer and try again on the next compaction.
      emitLog({
        level: 'warn',
        source: 'ai',
        action: 'memory.summarize.empty',
        message: `Compaction returned no summary; kept ${rows.length} raw turns`,
        status: 'failed',
        accountId,
        chatId,
        details: { turns: rows.length, raw: raw.slice(0, 200) },
      });
      return {
        summary: current?.summary ?? '',
        factsAdded: 0,
        turnsUsed: 0,
      };
    }
    const summaryText =
      parsedSummary || current?.summary || '';
    return this.saveSummary(accountId, chatId, {
      summaryText,
      facts,
      factContents: current ? parseFacts(current.facts) : [],
      rows,
    });
  }

  private async saveSummary(
    accountId: string,
    chatId: number,
    input: {
      summaryText: string;
      facts: unknown[];
      factContents: string[];
      rows: SoulTurnModel[];
    },
  ): Promise<{ summary: string; factsAdded: number; turnsUsed: number }> {
    const { summaryText, facts, factContents, rows } = input;
    let factsAdded = 0;
    for (const item of facts.slice(0, 20)) {
      if (!item || typeof item !== 'object') continue;
      const fact = item as Record<string, unknown>;
      const content =
        typeof fact.content === 'string' ? fact.content.trim() : '';
      if (!content) continue;
      try {
        await this.addFact(accountId, chatId, content, {
          kind: typeof fact.kind === 'string' ? fact.kind : 'fact',
          importance: Number(fact.importance) || 2,
          source: 'summary',
        });
        if (!factContents.includes(content)) factContents.push(content);
        factsAdded += 1;
      } catch {
        // Ignore a single malformed fact.
      }
    }
    const through = rows[rows.length - 1]?.createdAt ?? null;
    await this.prisma.soulSummary.upsert({
      where: { accountId_chatId: { accountId, chatId: BigInt(chatId) } },
      create: {
        accountId,
        chatId: BigInt(chatId),
        summary: summaryText,
        facts: JSON.stringify(factContents),
        turnsThrough: through,
      },
      update: {
        summary: summaryText,
        facts: JSON.stringify(factContents),
        turnsThrough: through,
      },
    });
    if (rows.length > KEEP_TURNS) {
      const cutoff = rows[rows.length - KEEP_TURNS].createdAt;
      await this.prisma.soulTurn.deleteMany({
        where: {
          accountId,
          chatId: BigInt(chatId),
          createdAt: { lt: cutoff },
        },
      });
    }
    emitLog({
      level: 'info',
      source: 'ai',
      action: 'memory.summarize',
      message: `Memory compacted: ${rows.length} turns → ${summaryText.length} chars, ${factsAdded} facts`,
      status: 'ok',
      accountId,
      chatId,
    });
    return { summary: summaryText, factsAdded, turnsUsed: rows.length };
  }

  /** Renders memory as a compact block for the system prompt. */
  formatContext(context: MemoryContext): string {
    const lines: string[] = [];
    if (context.summary) {
      lines.push(`Долгосрочная сводка: ${context.summary}`);
    }
    if (context.facts.length > 0) {
      lines.push(
        `Факты: ${context.facts.map((fact) => fact.content).join('; ')}`,
      );
    }
    return lines.join('\n');
  }
}
