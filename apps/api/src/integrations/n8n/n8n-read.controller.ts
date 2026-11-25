import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../../user-context/current-user.decorator.js';
import { N8nAccountsService } from './n8n-accounts.service.js';
import type {
  N8nAccountDetailView,
  N8nAccountView,
  N8nChatReadView,
  N8nChatView,
  N8nVariablesView,
} from './n8n-accounts.service.js';
import { N8nEventsService } from './n8n-events.service.js';
import type { N8nEventPage } from './n8n-events.service.js';
import { N8N_TOKEN_HEADER, N8nTokenGuard } from './n8n-token.guard.js';
import { waitMs } from './n8n-params.js';

/**
 * Read side of the Action API: what n8n may act on and which events it has not
 * seen yet. Guarded by the shared `x-combain-token` secret.
 */
@ApiTags('integrations-n8n')
@ApiHeader({
  name: N8N_TOKEN_HEADER,
  required: true,
  description: 'Shared secret from N8N_ACTION_TOKEN',
})
@Controller('integrations/n8n')
@UseGuards(N8nTokenGuard)
export class N8nReadController {
  constructor(
    private readonly accounts: N8nAccountsService,
    private readonly events: N8nEventsService,
  ) {}

  @Get('accounts')
  @ApiOperation({
    summary: 'Telegram accounts with workflow assignment, soul and variables',
  })
  listAccounts(@CurrentUser() user: UserModel): Promise<N8nAccountView[]> {
    return this.accounts.list(user.id);
  }

  @Get('accounts/:accountId')
  @ApiOperation({
    summary: 'Full account view: identity, workflow, soul, variables, limits',
  })
  account(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
  ): Promise<N8nAccountDetailView> {
    return this.accounts.detail(user.id, accountId);
  }

  @Get('accounts/:accountId/chats')
  @ApiOperation({ summary: 'Chat list of one account (id, title, type, unread)' })
  listChats(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Query('limit') limit?: string,
  ): Promise<N8nChatView[]> {
    return this.accounts.chats(user.id, accountId, limit);
  }

  @Get('accounts/:accountId/chats/:chatId')
  @ApiOperation({
    summary: 'One chat with tags/access/settings and its last messages',
  })
  chat(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('threadId') threadId?: string,
    @Query('messages') messages?: string,
  ): Promise<N8nChatReadView> {
    return this.accounts.chat(
      user.id,
      accountId,
      chatId,
      threadId,
      messages,
    );
  }

  @Get('accounts/:accountId/variables')
  @ApiOperation({ summary: 'Free-form variables of one account' })
  variables(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
  ): Promise<N8nVariablesView> {
    return this.accounts.variables(user.id, accountId);
  }

  @Patch('accounts/:accountId/variables')
  @ApiOperation({
    summary: 'Replace the free-form variables of one account',
    description:
      'Body `{ "variables": { ... } }`: a plain JSON object of at most 32 ' +
      'string values, each at most 2000 characters and 16 KB in total.',
  })
  setVariables(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<N8nVariablesView> {
    return this.accounts.setVariables(user.id, accountId, body);
  }

  @Get('events')
  @ApiOperation({
    summary: 'Event feed for manual debugging/replay (not the n8n trigger)',
    description:
      'Durable rows, oldest first, with an optional long poll. n8n is ' +
      'triggered by the push webhook (N8N_WEBHOOK_URL), so no schedule or ' +
      'trigger node needs to poll this endpoint; use it to inspect or replay ' +
      'events whose push failed (deliveredAt stays null).',
  })
  listEvents(
    @CurrentUser() user: UserModel,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('wait') wait?: string,
  ): Promise<N8nEventPage> {
    return this.events.list(user.id, {
      cursor: cursor?.trim() || undefined,
      limit,
      waitMs: waitMs(wait),
    });
  }
}
