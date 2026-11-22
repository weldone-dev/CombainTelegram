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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { notFound } from '../common/api-error.js';
import { MessagingService } from './messaging.service.js';
import type {
  ChatInfoView,
  DeletedMessageView,
  MessageHistoryView,
  ReadView,
} from './messaging.service.js';
import type { ChatView, MessageView } from './message-view.js';

@ApiTags('messaging')
@Controller('accounts/:accountId/chats')
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  @ApiOperation({ summary: 'List dialogs (chats) of an account' })
  listChats(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Query('limit') limit?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatView[]> {
    return this.messaging.listChats(user.id, accountId, { limit, sessionId });
  }

  @Get(':chatId/avatar')
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'public, max-age=600')
  @ApiOperation({ summary: 'Profile photo of a chat (JPEG)' })
  async chatAvatar(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<StreamableFile> {
    const avatar = await this.messaging.chatAvatar(
      user.id,
      accountId,
      chatId,
      sessionId,
    );
    if (!avatar) {
      throw notFound('AVATAR_NOT_FOUND', 'This chat has no profile photo');
    }
    return new StreamableFile(avatar.data, { type: avatar.mime });
  }

  @Get(':chatId')
  @ApiOperation({ summary: 'Basic chat/user info (peer lookup)' })
  getChat(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatInfoView> {
    return this.messaging.getChat(user.id, accountId, chatId, sessionId);
  }

  @Get(':chatId/messages')
  @ApiOperation({ summary: 'Message history, newest first' })
  listMessages(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('limit') limit?: string,
    @Query('offsetId') offsetId?: string,
    @Query('newerThanId') newerThanId?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<MessageHistoryView> {
    return this.messaging.listMessages(user.id, accountId, chatId, {
      limit,
      offsetId,
      newerThanId,
      sessionId,
    });
  }

  @Post(':chatId/messages')
  @ApiOperation({ summary: 'Send a text message' })
  sendMessage(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body() body: { text?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageView> {
    return this.messaging.sendMessage(user.id, accountId, chatId, body);
  }

  @Patch(':chatId/messages/:messageId')
  @ApiOperation({ summary: 'Edit a message text' })
  editMessage(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Body() body: { text?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageView> {
    return this.messaging.editMessage(
      user.id,
      accountId,
      chatId,
      messageId,
      body,
    );
  }

  @Delete(':chatId/messages/:messageId')
  @ApiOperation({ summary: 'Delete a message' })
  deleteMessage(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<DeletedMessageView> {
    return this.messaging.deleteMessage(
      user.id,
      accountId,
      chatId,
      messageId,
      sessionId,
    );
  }

  @Post(':chatId/read')
  @ApiOperation({ summary: 'Mark chat history as read (optionally up to maxId)' })
  markRead(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body() body: { maxId?: unknown; sessionId?: unknown } = {},
  ): Promise<ReadView> {
    return this.messaging.markRead(user.id, accountId, chatId, body);
  }

  @Post(':chatId/typing')
  @ApiOperation({ summary: 'Send a typing/upload action to a chat' })
  sendTyping(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body() body: { status?: unknown; sessionId?: unknown } = {},
  ): Promise<{ status: string }> {
    return this.messaging.sendTyping(user.id, accountId, chatId, body);
  }
}
