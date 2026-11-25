import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { AccountAiStateService } from '../account-ai-state/account-ai-state.service.js';
import type {
  AccountVariablesView,
  ChatSettingsView,
} from '../account-ai-state/account-ai-state.service.js';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { parseBoolean } from '../common/validation.js';
import { notFound } from '../common/api-error.js';
import { AccountsService } from './accounts.service.js';
import type {
  DetachSessionResult,
  RemoveAccountResult,
  TelegramSessionView,
} from './accounts.service.js';
import type { AccountView } from './account-view.js';

@ApiTags('accounts')
@Controller('accounts')
export class AccountsController {
  constructor(
    private readonly accounts: AccountsService,
    private readonly aiState: AccountAiStateService,
  ) {}

  @Get()
  list(@CurrentUser() user: UserModel): Promise<AccountView[]> {
    return this.accounts.list(user.id);
  }

  @Post(':id/activate')
  activate(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
  ): Promise<AccountView> {
    return this.accounts.activate(user.id, id);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Query('revokeSession') revokeSession?: string,
  ): Promise<RemoveAccountResult> {
    return this.accounts.remove(user.id, id, parseBoolean(revokeSession));
  }

  @Get(':id/avatar')
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'private, max-age=600')
  @Header('X-Content-Type-Options', 'nosniff')
  async avatar(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
  ): Promise<StreamableFile> {
    const avatar = await this.accounts.avatar(user.id, id);
    if (!avatar) {
      throw notFound('AVATAR_NOT_FOUND', 'This account has no profile photo');
    }
    return new StreamableFile(avatar.data, { type: avatar.mime });
  }

  @Get(':id/sessions')
  telegramSessions(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
  ): Promise<TelegramSessionView[]> {
    return this.accounts.listTelegramSessions(user.id, id);
  }

  @Delete(':id/sessions/:sessionId')
  detachSession(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Query('revoke') revoke?: string,
  ): Promise<DetachSessionResult> {
    return this.accounts.detachSession(
      user.id,
      id,
      sessionId,
      parseBoolean(revoke),
    );
  }

  @Patch(':id/sessions/:sessionId')
  updateSession(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Body() body: { proxyId?: unknown; label?: unknown } = {},
  ): Promise<AccountView> {
    return this.accounts.updateSession(user.id, id, sessionId, body);
  }

  /** Pins a session as the account's transport; the UI does this explicitly. */
  @Post(':id/sessions/:sessionId/activate')
  activateSession(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
  ): Promise<AccountView> {
    return this.accounts.activateSession(user.id, id, sessionId);
  }

  /** Free-form variables a workflow reads from the n8n event payload. */
  @Get(':id/ai-variables')
  aiVariables(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
  ): Promise<AccountVariablesView> {
    return this.aiState.variables(user.id, id);
  }

  @Patch(':id/ai-variables')
  setAiVariables(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
  ): Promise<AccountVariablesView> {
    return this.aiState.setVariables(user.id, id, body);
  }

  /** Per-chat AI overrides (typing mode, max parts, ...). `0` = whole chat. */
  @Get(':id/chats/:chatId/ai-chat-settings')
  aiChatSettings(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Param('chatId') chatId: string,
    @Query('threadId') threadId?: string,
  ): Promise<ChatSettingsView> {
    return this.aiState.chatSettings(user.id, id, chatId, threadId);
  }

  @Patch(':id/chats/:chatId/ai-chat-settings')
  setAiChatSettings(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Param('chatId') chatId: string,
    @Body() body: Record<string, unknown>,
  ): Promise<ChatSettingsView> {
    return this.aiState.setChatSettings(user.id, id, chatId, body);
  }
}
