import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import type { AiAccessView, AiUnblockResult, AiWarningResult } from '../../ai-access/ai-access.service.js';
import { CurrentUser } from '../../user-context/current-user.decorator.js';
import { requireChatId, requireText } from './n8n-params.js';
import { N8nActionsService } from './n8n-actions.service.js';
import type {
  AutomationToggleView,
  ChatMemoryActionView,
  GenerateView,
  PresenceActionView,
  ReadActionView,
  SendTextView,
  SoulReplyView,
  TagsView,
  ToolCallView,
  TypingView,
} from './n8n-actions.service.js';
import { N8N_TOKEN_HEADER, N8nTokenGuard } from './n8n-token.guard.js';

/**
 * Write side of the Action API: the concrete things an n8n workflow does after
 * it decides to act (send, reply, remember, warn/block, pause, run a tool).
 */
@ApiTags('integrations-n8n')
@ApiHeader({
  name: N8N_TOKEN_HEADER,
  required: true,
  description: 'Shared secret from N8N_ACTION_TOKEN',
})
@Controller('integrations/n8n')
@UseGuards(N8nTokenGuard)
export class N8nActionsController {
  constructor(private readonly actions: N8nActionsService) {}

  @Post('actions/send-text')
  @ApiOperation({ summary: 'Send text (max 4096 per part, split on ---)' })
  sendText(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<SendTextView> {
    return this.actions.sendText(user.id, body);
  }

  @Post('actions/generate')
  @ApiOperation({
    summary: 'Generate reply parts without sending or typing',
  })
  generate(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<GenerateView> {
    return this.actions.generate(user.id, body);
  }

  @Post('actions/soul-reply')
  @ApiOperation({ summary: 'Generate and send a soul reply (or return its text)' })
  soulReply(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<SoulReplyView> {
    return this.actions.soulReply(user.id, body);
  }

  @Post('actions/typing')
  @ApiOperation({
    summary: 'Start/renew or cancel a manual "typing…" heartbeat',
  })
  typing(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<TypingView> {
    return this.actions.typing(user.id, body);
  }

  @Post('actions/read')
  @ApiOperation({ summary: 'Mark a chat read and report the resulting state' })
  read(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<ReadActionView> {
    return this.actions.read(user.id, body);
  }

  @Post('actions/presence')
  @ApiOperation({ summary: 'Force the account online or offline' })
  presence(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<PresenceActionView> {
    return this.actions.presence(user.id, body);
  }

  @Post('actions/memory/add')
  @ApiOperation({ summary: 'Store one durable fact about a chat' })
  memoryAdd(@CurrentUser() user: UserModel, @Body() body: Record<string, unknown>) {
    return this.actions.memoryAdd(user.id, body);
  }

  @Get('actions/memory')
  @ApiOperation({ summary: 'Summary, facts and recent turns of a chat' })
  memoryView(
    @CurrentUser() user: UserModel,
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
    @Query('limit') limit?: string,
  ): Promise<ChatMemoryActionView> {
    return this.actions.memoryView(
      user.id,
      requireText(accountId, 'accountId', 64),
      requireChatId(chatId),
      limit,
    );
  }

  @Post('actions/tags/set')
  @ApiOperation({ summary: 'Add one tag to a chat (idempotent)' })
  tagsSet(@CurrentUser() user: UserModel, @Body() body: Record<string, unknown>) {
    return this.actions.tagsSet(user.id, body);
  }

  @Post('actions/tags/remove')
  @ApiOperation({ summary: 'Remove one tag from a chat (idempotent)' })
  tagsRemove(@CurrentUser() user: UserModel, @Body() body: Record<string, unknown>) {
    return this.actions.tagsRemove(user.id, body);
  }

  @Post('actions/memory/clear')
  @ApiOperation({ summary: 'Clear turns, summary and facts of a chat' })
  memoryClear(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<{ accountId: string; chatId: number; cleared: true }> {
    return this.actions.memoryClear(user.id, body);
  }

  @Get('actions/tags')
  @ApiOperation({ summary: 'Tags of a chat' })
  tagsView(
    @CurrentUser() user: UserModel,
    @Query('accountId') accountId?: string,
    @Query('chatId') chatId?: string,
  ): Promise<TagsView> {
    return this.actions.tagsView(
      user.id,
      requireText(accountId, 'accountId', 64),
      requireChatId(chatId),
    );
  }

  @Post('actions/warn')
  @ApiOperation({ summary: 'Add one warning to a chat/topic' })
  warn(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<AiWarningResult> {
    return this.actions.warn(user.id, body);
  }

  @Post('actions/block')
  @ApiOperation({ summary: 'Block a chat/topic (reason of 3+ characters)' })
  block(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<AiAccessView> {
    return this.actions.block(user.id, body);
  }

  @Post('actions/unblock')
  @ApiOperation({ summary: 'Unblock a chat/topic and clear its warnings' })
  unblock(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<AiUnblockResult> {
    return this.actions.unblock(user.id, body);
  }

  @Post('actions/automations/pause')
  @ApiOperation({ summary: 'Pause every automation bound to a chat/topic' })
  pauseAutomations(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<AutomationToggleView> {
    return this.actions.pauseAutomations(user.id, body);
  }

  @Post('actions/automations/resume')
  @ApiOperation({ summary: 'Resume the automations of a chat/topic' })
  resumeAutomations(
    @CurrentUser() user: UserModel,
    @Body() body: Record<string, unknown>,
  ): Promise<AutomationToggleView> {
    return this.actions.resumeAutomations(user.id, body);
  }

  @Post('actions/tool/:name')
  @ApiOperation({ summary: 'Run one agent tool through the account policy' })
  tool(
    @CurrentUser() user: UserModel,
    @Param('name') name: string,
    @Body() body: Record<string, unknown>,
  ): Promise<ToolCallView> {
    return this.actions.tool(user.id, name, body);
  }
}
