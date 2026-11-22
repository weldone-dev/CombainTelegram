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
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { ChatAdminService } from './chat-admin.service.js';
import type {
  ChatAdminSettingsView,
  ChatInviteLinksView,
  ChatInviteView,
  ChatJoinRequestsView,
  ChatMemberView,
  ChatMembersView,
  JoinRequestsDecisionView,
} from './chat-admin.service.js';

/**
 * Administration of one group/channel: members, bans, admins, invite links
 * and chat settings. Every endpoint requires admin rights in the chat; the
 * service rejects private chats with 400 `NOT_A_GROUP`.
 */
@ApiTags('chat-admin')
@Controller('accounts/:accountId/chats/:chatId/admin')
export class ChatAdminController {
  constructor(private readonly admin: ChatAdminService) {}

  @Get('members')
  @ApiOperation({
    summary: 'List chat members (all/admins/banned/recent/bots, searchable)',
  })
  listMembers(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('query') query?: string,
    @Query('type') type?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatMembersView> {
    return this.admin.listMembers(user.id, accountId, chatId, {
      query,
      type,
      limit,
      offset,
      sessionId,
    });
  }

  @Post('members/:userId/ban')
  @ApiOperation({
    summary: 'Ban a member (untilDate is a unix timestamp in milliseconds)',
  })
  banMember(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @Body() body: { untilDate?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatMemberView> {
    return this.admin.banMember(user.id, accountId, chatId, userId, body);
  }

  @Post('members/:userId/unban')
  @ApiOperation({ summary: 'Lift a ban (the user is not re-added)' })
  unbanMember(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @Body() body: { sessionId?: unknown } = {},
  ): Promise<ChatMemberView> {
    return this.admin.unbanMember(
      user.id,
      accountId,
      chatId,
      userId,
      body.sessionId,
    );
  }

  @Post('members/:userId/kick')
  @ApiOperation({ summary: 'Kick a member (ban then immediately unban)' })
  kickMember(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @Body() body: { sessionId?: unknown } = {},
  ): Promise<ChatMemberView> {
    return this.admin.kickMember(
      user.id,
      accountId,
      chatId,
      userId,
      body.sessionId,
    );
  }

  @Post('members/:userId/rank')
  @ApiOperation({ summary: 'Set or clear an admin custom rank' })
  setMemberRank(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @Body() body: { rank?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatMemberView> {
    return this.admin.setMemberRank(user.id, accountId, chatId, userId, body);
  }

  @Post('members/:userId/admin')
  @ApiOperation({ summary: 'Promote a member with a set of admin rights' })
  promoteMember(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @Body()
    body: { rank?: unknown; rights?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatMemberView> {
    return this.admin.promoteMember(user.id, accountId, chatId, userId, body);
  }

  @Delete('members/:userId/admin')
  @ApiOperation({ summary: 'Demote an administrator' })
  demoteMember(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Param('userId') userId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatMemberView> {
    return this.admin.demoteMember(
      user.id,
      accountId,
      chatId,
      userId,
      sessionId,
    );
  }

  @Patch()
  @ApiOperation({
    summary: 'Update title, description and/or slow mode of the chat',
  })
  updateSettings(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body()
    body: {
      title?: unknown;
      about?: unknown;
      slowModeSeconds?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatAdminSettingsView> {
    return this.admin.updateSettings(user.id, accountId, chatId, body);
  }

  @Get('invites')
  @ApiOperation({ summary: 'List invite links (channels include the primary)' })
  listInvites(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatInviteLinksView> {
    return this.admin.listInvites(user.id, accountId, chatId, sessionId);
  }

  @Post('invites')
  @ApiOperation({ summary: 'Create an additional invite link' })
  createInvite(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body()
    body: {
      expiresAt?: unknown;
      usageLimit?: unknown;
      withApproval?: unknown;
      name?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatInviteView> {
    return this.admin.createInvite(user.id, accountId, chatId, body);
  }

  @Post('invites/primary')
  @ApiOperation({
    summary: 'Export the primary invite link (rotates the previous one)',
  })
  exportPrimaryInvite(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
  ): Promise<ChatInviteView> {
    return this.admin.exportPrimaryInvite(user.id, accountId, chatId);
  }

  @Post('invites/revoke')
  @ApiOperation({ summary: 'Revoke an invite link' })
  revokeInvite(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body() body: { link?: unknown; sessionId?: unknown } = {},
  ): Promise<ChatInviteView> {
    return this.admin.revokeInvite(user.id, accountId, chatId, body);
  }

  @Post('invites/edit')
  @ApiOperation({ summary: 'Edit expiry, usage limit or approval of a link' })
  editInvite(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body()
    body: {
      link?: unknown;
      expiresAt?: unknown;
      usageLimit?: unknown;
      withApproval?: unknown;
      sessionId?: unknown;
    } = {},
  ): Promise<ChatInviteView> {
    return this.admin.editInvite(user.id, accountId, chatId, body);
  }

  @Get('join-requests')
  @ApiOperation({ summary: 'Pending join requests' })
  listJoinRequests(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<ChatJoinRequestsView> {
    return this.admin.listJoinRequests(user.id, accountId, chatId, sessionId);
  }

  @Post('join-requests')
  @ApiOperation({ summary: 'Approve or decline join requests in bulk' })
  decideJoinRequests(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('chatId') chatId: string,
    @Body()
    body: { userIds?: unknown; approve?: unknown; sessionId?: unknown } = {},
  ): Promise<JoinRequestsDecisionView> {
    return this.admin.decideJoinRequests(user.id, accountId, chatId, body);
  }
}
