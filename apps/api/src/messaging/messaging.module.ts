import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingSearchController } from './messaging-search.controller.js';
import { MessagingService } from './messaging.service.js';

@Module({
  imports: [AccountsModule],
  controllers: [MessagingController, MessagingSearchController],
  providers: [MessagingService],
  exports: [MessagingService],
})
export class MessagingModule {}
