import {
  Body,
  Catch,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  PayloadTooLargeException,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseFilters,
  UseInterceptors,
} from '@nestjs/common';
import type { ArgumentsHost, ExceptionFilter } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { apiError, notFound } from '../common/api-error.js';
import { MessagingService } from './messaging.service.js';
import type {
  ChatInfoMediaView,
  ChatInfoSimilarView,
  ChatInfoView,
  ChatPeerView,
  ChatRemovedView,
  ChatSearchView,
  DeletedMessageView,
  ForwardView,
  MediaDownloadView,
  MessageHistoryView,
  MessageTranscriptionView,
  MessageTranslationView,
  ReadAllView,
  ReadView,
} from './messaging.service.js';
import type {
  ChatView,
  MessagePollView,
  MessageThreadView,
  MessageView,
} from './message-view.js';
import { MAX_MEDIA_BYTES } from './media.js';

interface UploadedMediaFile {
  originalname?: string;
  mimetype?: string;
  size?: number;
  buffer?: Buffer;
}

/** Minimal passive response surface used for the 204 reaction fallback. */
interface HttpResponse {
  status(code: number): unknown;
}

/**
 * Multer reports oversized files as a Nest `PayloadTooLargeException`, whose
 * default body does not match the `{ code, message }` API error contract.
 */
@Catch(PayloadTooLargeException)
class MediaUploadTooLargeFilter implements ExceptionFilter {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const error = apiError(
      'PAYLOAD_TOO_LARGE',
      `file must be at most ${MAX_MEDIA_BYTES} bytes`,
      413,
    );
    this.adapterHost.httpAdapter.reply(
      context.getResponse(),
      error.getResponse(),
      413,
    );
  }
}

@ApiTags('messaging')
@Controller('accounts/:accountId/chats')
export class MessagingController {
  constructor(private readonly messaging: MessagingService) {}

  @Get()
  @ApiOperation({
    summary: 'List dialogs (chats) of an account, optionally by folder',
  })
  listChats(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Query('limit') limit?: string,
    @Query('folderId') folderId?: string,
    @Query('archived') archived?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatView[]> {
    return this.messaging.listChats(user.id, accountId, {
      limit,
      folderId,
      archived,
      sessionId,
    });
  }

  @Get('resolve')
  @ApiOperation({ summary: 'Resolve a username or t.me link to a chat' })
  resolveChat(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Query('username') username?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatView> {
    return this.messaging.resolveChat(user.id, accountId, {
      username,
      sessionId,
    });
  }

  @Post('read-all')
  @ApiOperation({ summary: 'Mark every unread dialog as read' })
  markAllRead(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Body() body: { sessionId?: unknown } = {},
  ): Promise<ReadAllView> {
    return this.messaging.markAllRead(user.id, accountId, body);
  }

  @Get(':chatId/avatar')
  @Header('Content-Type', 'image/jpeg')
  @Header('Cache-Control', 'private, max-age=600')
  @Header('X-Content-Type-Options', 'nosniff')
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
  ): Promise<ChatPeerView> {
    return this.messaging.getChat(user.id, accountId, chatId, sessionId);
  }

  @Get(':chatId/info')
  @ApiOperation({ summary: 'Full chat info for the info panel' })
  getChatInfo(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatInfoView> {
    return this.messaging.getChatInfo(user.id, accountId, chatId, sessionId);
  }

  @Get(':chatId/info/media')
  @ApiOperation({
    summary: 'Chat info tab: photos/videos, links or polls',
  })
  getChatInfoMedia(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('kind') kind?: string,
    @Query('limit') limit?: string,
    @Query('offsetId') offsetId?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatInfoMediaView> {
    return this.messaging.getChatInfoMedia(user.id, accountId, chatId, {
      kind,
      limit,
      offsetId,
      sessionId,
    });
  }

  @Get(':chatId/info/similar')
  @ApiOperation({ summary: 'Similar channels for the info panel' })
  getChatInfoSimilar(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatInfoSimilarView> {
    return this.messaging.getChatInfoSimilar(
      user.id,
      accountId,
      chatId,
      sessionId,
    );
  }

  @Patch(':chatId')
  @ApiOperation({
    summary: 'Apply dialog flags: pin, mute, archive, mark unread',
  })
  updateChat(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body()
    body: {
      pinned?: unknown;
      muted?: unknown;
      archived?: unknown;
      unread?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatView> {
    return this.messaging.updateChat(user.id, accountId, chatId, body);
  }

  @Delete(':chatId')
  @ApiOperation({
    summary: 'Delete/leave a chat, or clear its history with clearHistory=true',
  })
  deleteChat(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('revoke') revoke?: string,
    @Query('clearHistory') clearHistory?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatRemovedView> {
    return this.messaging.deleteChat(user.id, accountId, chatId, {
      revoke,
      clearHistory,
      sessionId,
    });
  }

  @Get(':chatId/search')
  @ApiOperation({ summary: 'Search messages inside one chat' })
  searchMessages(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offsetId') offsetId?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatSearchView> {
    return this.messaging.searchMessages(user.id, accountId, chatId, {
      q,
      limit,
      offsetId,
      sessionId,
    });
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

  @Get(':chatId/messages/:messageId/thread')
  @ApiOperation({
    summary:
      'Comments of a channel post (newest first; nextOffsetId pages older)',
  })
  getMessageThread(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Query('limit') limit?: string,
    @Query('offsetId') offsetId?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<MessageThreadView> {
    return this.messaging.getMessageThread(
      user.id,
      accountId,
      chatId,
      messageId,
      { limit, offsetId, sessionId },
    );
  }

  @Post(':chatId/messages/:messageId/comment')
  @ApiOperation({ summary: 'Comment on a channel post' })
  sendComment(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Body() body: { text?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageView> {
    return this.messaging.sendComment(
      user.id,
      accountId,
      chatId,
      messageId,
      body,
    );
  }

  @Post(':chatId/messages')
  @ApiOperation({ summary: 'Send a text message' })
  sendMessage(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body()
    body: { text?: unknown; replyToId?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageView> {
    return this.messaging.sendMessage(user.id, accountId, chatId, body);
  }

  @Post(':chatId/media')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: MAX_MEDIA_BYTES } }),
  )
  @UseFilters(MediaUploadTooLargeFilter)
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: 'Upload and send one photo or document (multipart `file`)',
  })
  sendMedia(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @UploadedFile() file: UploadedMediaFile | undefined,
    @Body()
    body: {
      caption?: unknown;
      replyToId?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<MessageView> {
    if (!file?.buffer || file.buffer.byteLength === 0) {
      throw apiError('VALIDATION_ERROR', 'file is required');
    }
    return this.messaging.sendMedia(user.id, accountId, chatId, {
      buffer: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
      size: file.size ?? file.buffer.byteLength,
      caption: body.caption,
      replyToId: body.replyToId,
      sessionId: body.sessionId,
    });
  }

  @Get(':chatId/messages/:messageId/media')
  @Header('Cache-Control', 'private, max-age=600')
  @Header('X-Content-Type-Options', 'nosniff')
  @ApiOperation({
    summary: 'Download the photo or document attached to a message',
  })
  async downloadMedia(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Query('sessionId') sessionId?: string,
    @Query('filename') filename?: string,
    @Query('thumb') thumb?: string,
  ): Promise<StreamableFile> {
    const media: MediaDownloadView = await this.messaging.downloadMedia(
      user.id,
      accountId,
      chatId,
      messageId,
      sessionId,
      filename,
      thumb,
    );
    return new StreamableFile(media.data, {
      type: media.mimeType,
      disposition: media.disposition,
      length: media.length,
    });
  }

  @Post(':chatId/messages/:messageId/reaction')
  @ApiOperation({ summary: 'Send or remove a reaction on a message' })
  async sendReaction(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Body() body: { emoji?: unknown; sessionId?: unknown } = {},
    @Res({ passthrough: true }) res: HttpResponse,
  ): Promise<MessageView | null> {
    const message = await this.messaging.sendReaction(
      user.id,
      accountId,
      chatId,
      messageId,
      body,
    );
    if (!message) {
      // The reaction was accepted but Telegram did not return the message.
      res.status(204);
      return null;
    }
    return message;
  }

  @Post(':chatId/messages/:messageId/vote')
  @ApiOperation({ summary: 'Vote in or retract a vote from a poll' })
  votePoll(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Body() body: { options?: unknown; sessionId?: unknown } = {},
  ): Promise<MessagePollView> {
    return this.messaging.votePoll(user.id, accountId, chatId, messageId, body);
  }

  @Post(':chatId/messages/:messageId/translate')
  @ApiOperation({ summary: 'Translate a message (default target: ru)' })
  translateMessage(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Body() body: { to?: unknown; sessionId?: unknown } = {},
  ): Promise<MessageTranslationView> {
    return this.messaging.translateMessage(
      user.id,
      accountId,
      chatId,
      messageId,
      body,
    );
  }

  @Post(':chatId/messages/:messageId/transcribe')
  @ApiOperation({ summary: 'Transcribe a voice message' })
  transcribeVoice(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<MessageTranscriptionView> {
    return this.messaging.transcribeVoice(
      user.id,
      accountId,
      chatId,
      messageId,
      sessionId,
    );
  }

  @Post(':chatId/forward')
  @ApiOperation({ summary: 'Forward messages from another chat into this one' })
  forwardMessages(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body()
    body: {
      fromChatId?: unknown;
      messageIds?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ForwardView> {
    return this.messaging.forwardMessages(user.id, accountId, chatId, body);
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
  @ApiOperation({
    summary:
      'Delete a message; revoke=false (default) removes it only for this account',
  })
  deleteMessage(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('messageId') messageId: string,
    @Query('revoke') revoke?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<DeletedMessageView> {
    return this.messaging.deleteMessage(
      user.id,
      accountId,
      chatId,
      messageId,
      { revoke, sessionId },
    );
  }

  @Post(':chatId/read')
  @ApiOperation({
    summary: 'Mark chat history as read (optionally up to maxId)',
  })
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
