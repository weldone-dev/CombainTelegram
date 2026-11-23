import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { apiError } from '../common/api-error.js';
import { AiConfigService } from './ai-config.service.js';
import { AgentService } from './agent.service.js';
import { AgentToolsService } from './agent-tools.service.js';
import { MemoryService } from './memory.service.js';
import { SkillsService } from './skills.service.js';
import { SoulsService } from './souls.service.js';
import type { LlmMessage, SoulUpdate } from './ai.types.js';

interface ChatMessageInput {
  role?: unknown;
  content?: unknown;
}

interface ChatBody {
  accountId?: unknown;
  chatId?: unknown;
  messages?: ChatMessageInput[];
  prompt?: unknown;
  skillSlugs?: unknown;
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function chatMessages(body: ChatBody): LlmMessage[] {
  if (!Array.isArray(body.messages)) return [];
  return body.messages
    .filter(
      (item): item is ChatMessageInput & { role: string; content: string } =>
        Boolean(item) &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.content === 'string',
    )
    .map((item) => ({ role: item.role as 'user' | 'assistant', content: item.content }));
}

function skillSlugs(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function runView(run: {
  id: string;
  accountId: string | null;
  chatId: bigint | null;
  source: string;
  status: string;
  prompt: string;
  output: string | null;
  model: string | null;
  steps: number;
  trace: string;
  inputTokens: number;
  outputTokens: number;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}) {
  let trace: unknown = [];
  try {
    trace = JSON.parse(run.trace);
  } catch {
    trace = [];
  }
  return {
    id: run.id,
    accountId: run.accountId,
    chatId: run.chatId === null ? null : Number(run.chatId),
    source: run.source,
    status: run.status,
    prompt: run.prompt,
    output: run.output,
    model: run.model,
    steps: run.steps,
    trace,
    inputTokens: run.inputTokens,
    outputTokens: run.outputTokens,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(
    private readonly config: AiConfigService,
    private readonly agent: AgentService,
    private readonly tools: AgentToolsService,
    private readonly souls: SoulsService,
    private readonly memory: MemoryService,
    private readonly skills: SkillsService,
  ) {}

  @Get('settings')
  async settings() {
    return this.config.view();
  }

  @Put('settings')
  async updateSettings(@Body() body: Record<string, unknown>) {
    return this.config.update(body);
  }

  @Put('policy')
  async updatePolicy(@Body() body: Record<string, unknown>) {
    return this.config.updatePolicy(body);
  }

  @Get('tools')
  toolsList() {
    return { tools: this.tools.list() };
  }

  @Get('souls')
  async soulsList() {
    return { souls: await this.souls.list() };
  }

  @Get('skills')
  async skillsList() {
    return { skills: await this.skills.list() };
  }

  @Post('skills')
  async createSkill(@Body() body: Record<string, unknown>) {
    return this.skills.create(body);
  }

  @Patch('skills/:id')
  async updateSkill(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.skills.update(id, body);
  }

  @Delete('skills/:id')
  async deleteSkill(@Param('id') id: string) {
    return this.skills.remove(id);
  }

  @Get('runs')
  async runs(
    @Query('accountId') accountId?: string,
    @Query('source') source?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = Number(rawLimit);
    const rows = await this.agent.runs({
      accountId: str(accountId) || null,
      source: str(source) || null,
      limit: Number.isFinite(limit) ? limit : 30,
    });
    return { runs: rows.map(runView) };
  }

  @Get('mcp')
  async mcp() {
    const settings = await this.config.view();
    return {
      endpoint: settings.mcp.endpoint,
      token: settings.mcp.token,
      tools: this.tools.list(),
    };
  }

  @Post('mcp/rotate')
  async rotateMcpToken() {
    return { token: await this.config.rotateMcpToken() };
  }

  @Post('test')
  async test(@CurrentUser() user: UserModel) {
    try {
      const result = await this.agent.run({
        userId: user.id,
        source: 'test',
        prompt: 'Ответь одним коротким предложением: система работает.',
        systemExtra: 'Не вызывай инструменты. Ответь одним предложением.',
        tools: [],
      });
      return {
        ok: true,
        text: result.text,
        model: result.model,
        usage: result.usage,
      };
    } catch (error) {
      throw apiError(
        'AI_FAILED',
        `Проверка не удалась: ${(error as Error).message}`,
        502,
      );
    }
  }

  @Post('chat')
  async chat(@CurrentUser() user: UserModel, @Body() body: ChatBody) {
    const messages = chatMessages(body);
    const prompt = str(body.prompt);
    if (!prompt && messages.length === 0) {
      throw apiError('INVALID_PROMPT', 'prompt or messages is required', 400);
    }
    let history = messages;
    let last = prompt;
    if (!last && history.length > 0) {
      last = history[history.length - 1]?.content ?? '';
      history = history.slice(0, -1);
    }
    // Clients often send the full transcript including the new prompt.
    if (
      last &&
      history.length > 0 &&
      history[history.length - 1]?.role === 'user' &&
      (history[history.length - 1]?.content ?? '').trim() === last
    ) {
      history = history.slice(0, -1);
    }
    try {
      const result = await this.agent.run({
        userId: user.id,
        accountId: str(body.accountId) || null,
        chatId: num(body.chatId),
        source: 'ui',
        prompt: last,
        history: history.filter((message) => (message.content ?? '').trim()),
        skillSlugs: skillSlugs(body.skillSlugs),
      });
      return {
        runId: result.runId,
        text: result.text,
        model: result.model,
        steps: result.steps,
        trace: result.trace,
        usage: result.usage,
      };
    } catch (error) {
      throw apiError(
        'AI_FAILED',
        `Агент не смог ответить: ${(error as Error).message}`,
        502,
      );
    }
  }
}

@ApiTags('ai')
@Controller('accounts/:accountId/soul')
export class SoulController {
  constructor(
    private readonly souls: SoulsService,
    private readonly memory: MemoryService,
  ) {}

  @Get()
  async get(@Param('accountId') accountId: string) {
    return this.souls.get(accountId);
  }

  @Put()
  async update(
    @Param('accountId') accountId: string,
    @Body() body: SoulUpdate,
  ) {
    return this.souls.update(accountId, body);
  }

  @Get('memory')
  async memoryView(
    @Param('accountId') accountId: string,
    @Query('chatId') rawChatId?: string,
  ) {
    return this.memory.view(accountId, num(rawChatId));
  }

  @Post('memory/summarize')
  async summarize(
    @Param('accountId') accountId: string,
    @Body() body: { chatId?: unknown },
  ) {
    const chatId = num(body.chatId);
    if (!chatId) throw apiError('INVALID_CHAT', 'chatId is required', 400);
    return this.memory.summarize(accountId, chatId, { force: true });
  }

  @Post('memory/facts')
  async addFact(
    @Param('accountId') accountId: string,
    @Body()
    body: {
      chatId?: unknown;
      content?: unknown;
      kind?: unknown;
      importance?: unknown;
    },
  ) {
    const content = str(body.content);
    if (!content) throw apiError('INVALID_FACT', 'content is required', 400);
    return this.memory.addFact(accountId, num(body.chatId), content, {
      kind: str(body.kind) || 'fact',
      importance: Number(body.importance) || 2,
      source: 'user',
    });
  }

  @Delete('memory/facts/:factId')
  async deleteFact(
    @Param('accountId') accountId: string,
    @Param('factId') factId: string,
  ) {
    void accountId;
    return this.memory.deleteFact(factId);
  }

  @Delete('memory/chats/:chatId')
  async clearChat(
    @Param('accountId') accountId: string,
    @Param('chatId') rawChatId: string,
  ) {
    const chatId = num(rawChatId);
    if (!chatId) throw apiError('INVALID_CHAT', 'chatId is required', 400);
    await this.memory.clearChat(accountId, chatId);
    return { cleared: true };
  }
}
