import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { ChatAdminController } from './chat-admin.controller.js';
import { ChatAdminService } from './chat-admin.service.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingSearchController } from './messaging-search.controller.js';
import { MessagingService } from './messaging.service.js';

@Module({
  imports: [AccountsModule],
  controllers: [
    MessagingController,
    MessagingSearchController,
    ChatAdminController,
  ],
  providers: [MessagingService, ChatAdminService],
  exports: [MessagingService],
})
export class MessagingModule {}
