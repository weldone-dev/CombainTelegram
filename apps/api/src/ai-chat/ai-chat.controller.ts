import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import type { AiChatEventView, AiWarningsCleared } from '../ai-access/ai-chat-events.service.js';
import { AiChatEventsService } from '../ai-access/ai-chat-events.service.js';
import { apiError } from '../common/api-error.js';
import { parseChatId, parseLimit } from '../messaging/params.js';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { AiChatMemoryService } from './ai-chat-memory.service.js';
import type { ChatMemoryView } from './ai-chat-memory.service.js';
import { AiChatSkillsService } from './ai-chat-skills.service.js';
import type { ChatSkillsView } from './ai-chat-skills.service.js';

/** `threadId`: `0`/absent = whole chat, positive = forum topic. */
function parseThreadId(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw apiError(
      'VALIDATION_ERROR',
      'threadId must be a non-negative integer',
    );
  }
  return parsed;
}

/** `limit` query parameter, clamped by `parseLimit` (max 200 here). */
function parseOptionalLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseLimit(value, 200);
}

/**
 * Per-chat AI state of one account: which skills apply in a chat/forum topic,
 * what the AI remembers about it, and the warning/block audit trail.
 */
@ApiTags('ai-chat')
@Controller('accounts/:accountId')
export class AiChatController {
  constructor(
    private readonly skills: AiChatSkillsService,
    private readonly memory: AiChatMemoryService,
    private readonly events: AiChatEventsService,
  ) {}

  @Get('chats/:chatId/ai-skills')
  @ApiOperation({
    summary: 'Effective, default and catalog skills of a chat/topic',
  })
  skillsView(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('threadId') threadId?: string,
  ): Promise<ChatSkillsView> {
    return this.skills.view(
      user.id,
      accountId,
      parseChatId(chatId),
      parseThreadId(threadId),
    );
  }

  @Put('chats/:chatId/ai-skills')
  @ApiOperation({ summary: 'Replace the skill override of a chat/topic' })
  skillsSet(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body() body: { skillSlugs?: unknown; threadId?: unknown } = {},
  ): Promise<ChatSkillsView> {
    return this.skills.set(
      user.id,
      accountId,
      parseChatId(chatId),
      body.skillSlugs,
      parseThreadId(body.threadId),
    );
  }

  @Delete('chats/:chatId/ai-skills')
  @ApiOperation({ summary: 'Drop the override; the soul skills apply again' })
  skillsRemove(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('threadId') threadId?: string,
  ): Promise<{ removed: boolean }> {
    return this.skills.remove(
      user.id,
      accountId,
      parseChatId(chatId),
      parseThreadId(threadId),
    );
  }

  @Get('chats/:chatId/memory')
  @ApiOperation({ summary: 'Short-term turns and long-term memory of a chat' })
  memoryView(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('limit') limit?: string,
  ): Promise<ChatMemoryView> {
    return this.memory.view(
      user.id,
      accountId,
      parseChatId(chatId),
      parseOptionalLimit(limit),
    );
  }

  @Get('chats/:chatId/ai-events')
  @ApiOperation({ summary: 'Warning/block/access history of a chat, newest first' })
  eventsList(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('threadId') threadId?: string,
    @Query('limit') limit?: string,
  ): Promise<AiChatEventView[]> {
    return this.events.list(
      user.id,
      accountId,
      parseChatId(chatId),
      parseThreadId(threadId),
      parseOptionalLimit(limit),
    );
  }

  @Delete('chats/:chatId/ai-warnings')
  @ApiOperation({ summary: 'Reset the warning counter without unblocking' })
  warningsClear(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('threadId') threadId?: string,
  ): Promise<AiWarningsCleared> {
    return this.events.clearWarnings(
      user.id,
      accountId,
      parseChatId(chatId),
      parseThreadId(threadId),
    );
  }
}
