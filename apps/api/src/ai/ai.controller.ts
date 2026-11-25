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
import { AiRunsService, parseMessageIds } from './ai-runs.service.js';
import { MemoryService } from './memory.service.js';
import { SkillsService } from './skills.service.js';
import { SoulsService, parseSoulSettings } from './souls.service.js';
import { DmAutopilotService } from './dm-autopilot.service.js';
import { ChatStateService } from './chat-state.service.js';
import type { SoulUpdate } from './ai.types.js';

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

type ChatHistoryMessage = { role: 'user' | 'assistant'; content: string };

function chatMessages(body: ChatBody): ChatHistoryMessage[] {
  if (!Array.isArray(body.messages)) return [];
  return body.messages
    .filter(
      (item): item is ChatMessageInput & { role: string; content: string } =>
        Boolean(item) &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.content === 'string',
    )
    .map((item) => ({
      role: item.role as 'user' | 'assistant',
      content: item.content,
    }));
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
  reasoning: string | null;
  messageIds: string | null;
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
    reasoning: run.reasoning,
    messageIds: parseMessageIds(run.messageIds),
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
    private readonly runsService: AiRunsService,
    private readonly autopilot: DmAutopilotService,
  ) {}

  @Get('settings')
  async settings() {
    return this.config.view();
  }

  @Put('settings')
  async updateSettings(@Body() body: Record<string, unknown>) {
    return this.config.update(body);
  }

  /** Same handler as `PUT`; the dashboard sends partial updates with PATCH. */
  @Patch('settings')
  async patchSettings(@Body() body: Record<string, unknown>) {
    return this.config.update(body);
  }

  /**
   * Probes the selected speech-to-text engine: `/health` for the remote
   * Parakeet service, a model-file check for the local one, `disabled` for off.
   * No key is returned.
   */
  @Post('stt/test')
  async sttTest() {
    return this.config.sttTest();
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
    @CurrentUser() user: UserModel,
    @Query('accountId') accountId?: string,
    @Query('chatId') rawChatId?: string,
    @Query('source') source?: string,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = Number(rawLimit);
    const rows = await this.runsService.list({
      userId: user.id,
      accountId: str(accountId) || null,
      chatId: num(rawChatId),
      source: str(source) || null,
      limit: Number.isFinite(limit) ? limit : null,
    });
    return { runs: rows.map(runView) };
  }

  @Get('runs/:id')
  async run(@CurrentUser() user: UserModel, @Param('id') id: string) {
    return runView(await this.runsService.get(user.id, id));
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

  /**
   * Generates a reply and returns its bubbles without sending or typing.
   *
   * This is the split an n8n workflow uses: `generate` produces the parts
   * (soul, skills, permissions, memory and media resolved inside), and
   * `send-text` sends them later or the workflow decides not to.
   */
  @Post('generate')
  async generate(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ) {
    const accountId = str(body.accountId);
    const chatId = num(body.chatId);
    if (!accountId) {
      throw apiError('INVALID_ACCOUNT', 'accountId is required', 400);
    }
    if (!chatId) throw apiError('INVALID_CHAT', 'chatId is required', 400);
    const messageId = num(body.messageId);
    const maxParts = num(body.maxParts);
    return this.autopilot.generateReply({
      userId: user.id,
      accountId,
      chatId,
      threadId: num(body.threadId) ?? undefined,
      messageId: messageId ?? undefined,
      prompt: str(body.prompt) || undefined,
      maxParts: maxParts ?? undefined,
    });
  }

  /**
   * Injects a synthetic incoming message for the dashboard's test button.
   * The workflow reacts and sends a real reply; the fake incoming bubble is
   * local and disappears on the next history refetch.
   */
  @Post('simulate-incoming')
  async simulateIncoming(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ) {
    const accountId = str(body.accountId);
    const chatId = num(body.chatId);
    const text = str(body.text);
    if (!accountId) {
      throw apiError('INVALID_ACCOUNT', 'accountId is required', 400);
    }
    if (!chatId) throw apiError('INVALID_CHAT', 'chatId is required', 400);
    return this.autopilot.simulateIncoming(
      user.id,
      accountId,
      chatId,
      text || undefined,
    );
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
        reasoning: result.reasoning,
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

/**
 * Live AI state of one chat: `idle`, `received`, `read`, `waiting`,
 * `thinking`, `composing`, `sending`, `sent`, `blocked`, `superseded` or
 * `error`. In-memory by design — it describes a run of this process.
 */
@ApiTags('ai')
@Controller('accounts/:accountId/chats/:chatId/state')
export class ChatStateController {
  constructor(
    private readonly states: ChatStateService,
    private readonly souls: SoulsService,
  ) {}

  @Get()
  async state(
    @Param('accountId') accountId: string,
    @Param('chatId') rawChatId: string,
  ) {
    const chatId = num(rawChatId);
    if (!chatId) throw apiError('INVALID_CHAT', 'chatId is required', 400);
    const record = this.states.get(accountId, chatId);
    // A chat nothing has run in yet carries no policy; fall back to the soul.
    if (record.typingMode === null) {
      const soul = await this.souls.model(accountId);
      if (soul) {
        record.typingMode = parseSoulSettings(soul.settings).typingMode;
      }
    }
    return record;
  }
}
