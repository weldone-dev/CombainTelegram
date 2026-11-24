import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { apiError } from '../common/api-error.js';
import {
  parseChatId,
  parseOptionalBoolean,
} from '../messaging/params.js';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { AiAccessService } from './ai-access.service.js';
import type {
  AiAccessList,
  AiAccessView,
  AiUnblockResult,
  AiWarningResult,
  BlockedBy,
} from './ai-access.service.js';

const MAX_TEXT = 1000;

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

/** Optional human text: trimmed, empty becomes `null`. */
function optionalText(
  value: unknown,
  field: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw apiError('VALIDATION_ERROR', `${field} must be a string or null`);
  }
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_TEXT) {
    throw apiError(
      'VALIDATION_ERROR',
      `${field} must be at most ${MAX_TEXT} characters`,
    );
  }
  return text;
}

function optionalBlockedBy(value: unknown): BlockedBy | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === 'user' || value === 'soul') return value;
  throw apiError('VALIDATION_ERROR', 'blockedBy must be "user" or "soul"');
}

/**
 * Per-chat AI permissions and blacklist: may the soul read/answer this chat or
 * forum topic, and is it muted by the user or by its own warning counter.
 */
@ApiTags('ai-access')
@Controller('accounts/:accountId')
export class AiAccessController {
  constructor(private readonly access: AiAccessService) {}

  @Get('ai-access')
  @ApiOperation({ summary: 'Access rows and active blocks of the account' })
  list(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
  ): Promise<AiAccessList> {
    return this.access.list(user.id, accountId);
  }

  @Get('chats/:chatId/ai-access')
  @ApiOperation({ summary: 'AI permission of one chat or forum topic' })
  get(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('threadId') threadId?: string,
  ): Promise<AiAccessView> {
    return this.access.view(
      user.id,
      accountId,
      parseChatId(chatId),
      parseThreadId(threadId),
    );
  }

  @Put('chats/:chatId/ai-access')
  @ApiOperation({ summary: 'Allow, mute or re-scope the AI in a chat/topic' })
  set(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body()
    body: {
      enabled?: unknown;
      soulId?: unknown;
      note?: unknown;
      threadId?: unknown;
    } = {},
  ): Promise<AiAccessView> {
    return this.access.setAccess({
      userId: user.id,
      accountId,
      chatId: parseChatId(chatId),
      threadId: parseThreadId(body.threadId),
      enabled: parseOptionalBoolean(body.enabled, 'enabled'),
      soulId: optionalText(body.soulId, 'soulId'),
      note: optionalText(body.note, 'note'),
    });
  }

  @Delete('chats/:chatId/ai-access')
  @ApiOperation({ summary: 'Remove the stored access row (falls back to deny)' })
  remove(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('threadId') threadId?: string,
  ): Promise<{ removed: boolean }> {
    return this.access.removeAccess(
      user.id,
      accountId,
      parseChatId(chatId),
      parseThreadId(threadId),
    );
  }

  @Post('chats/:chatId/ai-block')
  @ApiOperation({ summary: 'Block the AI in a chat/topic' })
  block(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body()
    body: { reason?: unknown; blockedBy?: unknown; threadId?: unknown } = {},
  ): Promise<AiAccessView> {
    return this.access.block({
      userId: user.id,
      accountId,
      chatId: parseChatId(chatId),
      threadId: parseThreadId(body.threadId),
      reason: optionalText(body.reason, 'reason'),
      blockedBy: optionalBlockedBy(body.blockedBy),
    });
  }

  @Delete('chats/:chatId/ai-block')
  @ApiOperation({ summary: 'Lift the block and reset its warning counter' })
  unblock(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('threadId') threadId?: string,
  ): Promise<AiUnblockResult> {
    return this.access.unblock(
      user.id,
      accountId,
      parseChatId(chatId),
      parseThreadId(threadId),
    );
  }

  @Post('chats/:chatId/ai-warning')
  @ApiOperation({
    summary: 'Add a warning; the threshold auto-blocks the chat',
  })
  warn(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body() body: { reason?: unknown; threadId?: unknown } = {},
  ): Promise<AiWarningResult> {
    return this.access.bumpWarning({
      userId: user.id,
      accountId,
      chatId: parseChatId(chatId),
      threadId: parseThreadId(body.threadId),
      reason: optionalText(body.reason, 'reason'),
    });
  }
}
