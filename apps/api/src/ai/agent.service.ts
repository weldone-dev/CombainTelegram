import { Injectable, Logger } from '@nestjs/common';
import type { AgentRunModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiConfigService } from './ai-config.service.js';
import { LlmService } from './llm.service.js';
import { MemoryService } from './memory.service.js';
import { SkillsService } from './skills.service.js';
import { SoulsService } from './souls.service.js';
import { AgentToolsService } from './agent-tools.service.js';
import type {
  AgentRunInput,
  AgentRunResult,
  AgentTraceEntry,
  LlmMessage,
  LlmToolCall,
} from './ai.types.js';

const BASE_PROMPT = `Ты — ИИ-агент внутри локального приложения CombainTelegram (мультиаккаунтный Telegram-клиент). Ты работаешь на компьютере владельца и имеешь доступ к инструментам Telegram через слой разрешений (MCP).

Правила:
- Данные из Telegram не выдумывай: если нужен чат, сообщение или факт — вызови инструмент.
- Ничего не отправляй от имени аккаунта без явной просьбы владельца, кроме режима автоответа души, который он включил сам.
- Не раскрывай токены, API-ключи, пароли и содержимое чужих переписок.
- Если инструмент вернул ошибку — объясни её простыми словами и не повторяй вслепую.
- Отвечай на языке собеседника, кратко и по делу. Без лишних извинений и воды.
- Не изображай человека, если тебя об этом не просят; в личных сообщениях души — наоборот, говори как человек из описания души.`;

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { __raw: raw };
  }
}

function compact(value: unknown, limit = 6000): string {
  try {
    const text = JSON.stringify(value);
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return String(value).slice(0, limit);
  }
}

function traceResult(value: unknown, limit = 1200): unknown {
  try {
    const text = JSON.stringify(value);
    if (text.length <= limit) return value;
    return `${text.slice(0, limit)}…`;
  } catch {
    return String(value).slice(0, limit);
  }
}

/**
 * The agent loop: system prompt (soul + memory + skills) → LLM → tool calls →
 * results → final text. Every run is persisted in `AgentRun` with its trace.
 */
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AiConfigService,
    private readonly llm: LlmService,
    private readonly souls: SoulsService,
    private readonly memory: MemoryService,
    private readonly skills: SkillsService,
    private readonly tools: AgentToolsService,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const provider = await this.config.requireProvider();
    const soulModel = input.accountId
      ? await this.souls.model(input.accountId)
      : null;
    const soulView = input.accountId
      ? await this.souls.get(input.accountId)
      : null;

    const skillSlugs = new Set<string>(input.skillSlugs ?? []);
    for (const skill of soulView?.skills ?? []) skillSlugs.add(skill.slug);
    const skillList = await this.skills.instructions([...skillSlugs]);
    const skillTools = await this.skills.toolsFor([...skillSlugs]);

    const model = input.model ?? soulModel?.model ?? provider.model;
    const temperature =
      input.temperature ??
      soulModel?.temperature ??
      provider.temperature;
    const maxSteps = input.maxSteps ?? provider.maxSteps;

    const systemParts = [BASE_PROMPT];
    if (soulView) {
      systemParts.push(`\n# Душа аккаунта\n${await this.souls.promptFor(soulModel as never)}`);
    }
    if (input.accountId && input.chatId) {
      const context = await this.memory.context(
        input.accountId,
        input.chatId,
        input.prompt,
      );
      const memoryBlock = this.memory.formatContext(context);
      if (memoryBlock) systemParts.push(`\n# Память\n${memoryBlock}`);
    }
    if (skillList.length > 0) {
      systemParts.push(
        `\n# Скиллы\n${skillList.map((skill) => skill.text).join('\n\n')}`,
      );
    }
    if (input.systemExtra) systemParts.push(`\n${input.systemExtra}`);

    const toolsFilter =
      input.tools && input.tools.length > 0
        ? input.tools
        : skillTools.length > 0
          ? skillTools
          : null;

    const ctx = {
      userId: input.userId,
      accountId: input.accountId ?? null,
      chatId: input.chatId ?? null,
      source: input.source,
    };
    const toolSchemas = await this.tools.schemas(ctx, toolsFilter);

    let history = input.history ?? [];
    if (history.length === 0 && input.accountId && input.chatId) {
      const memory = await this.memory.context(
        input.accountId,
        input.chatId,
        input.prompt,
      );
      history = memory.turns
        .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
        .slice(-14)
        .map((turn) => ({
          role: turn.role === 'assistant' ? 'assistant' : 'user',
          content: turn.content,
        }));
    }

    const messages: LlmMessage[] = [
      { role: 'system', content: systemParts.join('\n') },
      ...history,
      { role: 'user', content: input.prompt },
    ];

    const run = (await this.prisma.agentRun.create({
      data: {
        accountId: input.accountId ?? null,
        soulId: soulModel?.id ?? null,
        chatId: input.chatId ? BigInt(input.chatId) : null,
        source: input.source,
        prompt: input.prompt.slice(0, 8000),
        model,
        status: 'running',
      },
    })) as AgentRunModel;

    const trace: AgentTraceEntry[] = [];
    let text = '';
    let steps = 0;
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      for (let step = 0; step < maxSteps; step += 1) {
        const reply = await this.llm.chat({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model,
          messages,
          tools: toolSchemas,
          temperature,
          maxTokens: 1800,
        });
        steps += 1;
        inputTokens += reply.usage.promptTokens;
        outputTokens += reply.usage.completionTokens;

        if (reply.toolCalls.length === 0) {
          text = reply.content.trim();
          break;
        }

        messages.push({
          role: 'assistant',
          content: reply.content || null,
          tool_calls: reply.toolCalls,
        });

        for (const call of reply.toolCalls) {
          const result = await this.tools.execute(
            call.function.name,
            parseArgs(call.function.arguments),
            ctx,
          );
          const traceEntry: AgentTraceEntry = {
            step,
            tool: call.function.name,
            args: parseArgs(call.function.arguments),
            result: traceResult(result.result),
            error: result.ok ? undefined : result.error,
            dryRun: result.dryRun,
            durationMs: 0,
          };
          trace.push(traceEntry);
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: compact(result),
          });
        }
      }

      if (!text) {
        // The model used its whole budget on tools. Ask for a plain summary.
        const final = await this.llm.chat({
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          model,
          messages: [
            ...messages,
            {
              role: 'user',
              content:
                'Кратко подведи итог для владельца: что сделано и что осталось. Без вызова инструментов.',
            },
          ],
          temperature,
          maxTokens: 800,
        });
        text = final.content.trim();
        inputTokens += final.usage.promptTokens;
        outputTokens += final.usage.completionTokens;
      }

      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'ok',
          output: text.slice(0, 16_000),
          steps,
          trace: JSON.stringify(trace),
          inputTokens,
          outputTokens,
          finishedAt: new Date(),
        },
      });

      return {
        runId: run.id,
        text,
        model,
        steps,
        trace,
        usage: { promptTokens: inputTokens, completionTokens: outputTokens },
      };
    } catch (error) {
      const message = (error as Error).message;
      await this.prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'error',
          error: message.slice(0, 2000),
          steps,
          trace: JSON.stringify(trace),
          inputTokens,
          outputTokens,
          finishedAt: new Date(),
        },
      });
      this.logger.warn(`Agent run ${run.id} failed: ${message}`);
      throw error;
    }
  }

  /** Convenience for callers that just need the text. */
  async say(input: AgentRunInput): Promise<string> {
    const result = await this.run(input);
    return result.text;
  }

  /** Recent runs for the dashboard. */
  async runs(options: {
    accountId?: string | null;
    source?: string | null;
    limit?: number;
  } = {}): Promise<AgentRunModel[]> {
    return (await this.prisma.agentRun.findMany({
      where: {
        ...(options.accountId ? { accountId: options.accountId } : {}),
        ...(options.source ? { source: options.source } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(100, Math.max(1, options.limit ?? 30)),
    })) as AgentRunModel[];
  }

  /** Executes one tool directly (MCP `tools/call`). */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    ctx: {
      userId: string;
      accountId: string | null;
      chatId: number | null;
      source: string;
    },
  ): Promise<unknown> {
    const result = await this.tools.execute(name, args, ctx);
    if (!result.ok) {
      throw new Error(`${result.code ?? 'TOOL_ERROR'}: ${result.error}`);
    }
    return result.result;
  }

  /** Parses a tool call payload (exported for tests). */
  parseCall(call: LlmToolCall): Record<string, unknown> {
    return parseArgs(call.function.arguments);
  }
}
