import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { MessagingService } from './messaging.service.js';
import type { FoldersView, GlobalSearchView } from './messaging.service.js';

@ApiTags('messaging')
@Controller('accounts/:accountId')
export class MessagingSearchController {
  constructor(private readonly messaging: MessagingService) {}

  @Get('folders')
  @ApiOperation({ summary: 'List chat folders of an account' })
  listFolders(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<FoldersView> {
    return this.messaging.listFolders(user.id, accountId, sessionId);
  }

  @Get('search')
  @ApiOperation({ summary: 'Global search for chats and users' })
  searchGlobal(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('sessionId') sessionId?: string,
  ): Promise<GlobalSearchView> {
    return this.messaging.searchGlobal(user.id, accountId, {
      q,
      limit,
      sessionId,
    });
  }
}
