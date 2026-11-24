import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { apiError } from '../common/api-error.js';
import {
  AutomationsService,
  parseChatId,
  parseThreadId,
  type AutomationInput,
} from './automations.service.js';
import { AutomationRunnerService } from './automation-runner.service.js';

function requiredChatId(value: unknown): number {
  const chatId = parseChatId(value);
  if (chatId === null) {
    throw apiError('INVALID_CHAT', 'chatId must be a numeric Telegram id', 400);
  }
  return chatId;
}

function optionalThreadId(value: unknown): number | null {
  if (value === undefined || value === '') return null;
  const threadId = parseThreadId(value);
  if (threadId === null) {
    throw apiError(
      'INVALID_THREAD',
      'threadId must be a non-negative integer',
      400,
    );
  }
  return threadId;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

@ApiTags('ai')
@Controller('ai/automations')
export class AutomationsController {
  constructor(
    private readonly automations: AutomationsService,
    private readonly runner: AutomationRunnerService,
  ) {}

  @Get()
  async list(
    @Query('accountId') accountId?: string,
    @Query('chatId') rawChatId?: string,
    @Query('threadId') rawThreadId?: string,
    @Query('soulId') soulId?: string,
  ) {
    return {
      automations: await this.automations.list(accountId || null, {
        chatId:
          rawChatId === undefined ? null : requiredChatId(rawChatId),
        threadId: optionalThreadId(rawThreadId),
        soulId: optionalText(soulId),
      }),
    };
  }

  @Get('chats/:accountId/:chatId')
  async chat(
    @Param('accountId') accountId: string,
    @Param('chatId') rawChatId: string,
    @Query('threadId') rawThreadId?: string,
    @Query('soulId') soulId?: string,
  ) {
    return this.automations.chat(accountId, requiredChatId(rawChatId), {
      threadId: optionalThreadId(rawThreadId),
      soulId: optionalText(soulId),
    });
  }

  @Post('chats/:accountId/:chatId/pause')
  async pauseChat(
    @Param('accountId') accountId: string,
    @Param('chatId') rawChatId: string,
    @Body()
    body: { threadId?: unknown; soulId?: unknown; reason?: unknown } = {},
  ) {
    return {
      paused: await this.automations.pauseForChat({
        accountId,
        chatId: requiredChatId(rawChatId),
        threadId: optionalThreadId(body.threadId),
        soulId: optionalText(body.soulId),
        reason: optionalText(body.reason),
      }),
    };
  }

  @Post('chats/:accountId/:chatId/resume')
  async resumeChat(
    @Param('accountId') accountId: string,
    @Param('chatId') rawChatId: string,
    @Query('threadId') rawThreadId?: string,
    @Query('soulId') soulId?: string,
  ) {
    return {
      resumed: await this.automations.resume({
        accountId,
        chatId: requiredChatId(rawChatId),
        threadId: optionalThreadId(rawThreadId),
        soulId: optionalText(soulId),
      }),
    };
  }

  @Post()
  async create(@Body() body: AutomationInput) {
    return this.automations.create(body);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: AutomationInput) {
    return this.automations.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.automations.remove(id);
  }

  @Post(':id/run')
  async run(@Param('id') id: string) {
    return this.runner.runNow(id);
  }

  @Post(':id/resume')
  async resume(@Param('id') id: string) {
    const rows = await this.automations.resume(id);
    return { automation: rows[0] ?? null };
  }

  @Get(':id/runs')
  async runs(@Param('id') id: string, @Query('limit') rawLimit?: string) {
    const limit = Number(rawLimit);
    return {
      runs: await this.automations.runs(
        id,
        Number.isFinite(limit) ? limit : 30,
      ),
    };
  }
}
