import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { SpeechModule } from '../ai/speech.module.js';
import { TdFilesService } from '../tdlib/td-files.service.js';
import { TdMessagingService } from '../tdlib/td-messaging.service.js';
import { ChatAdminController } from './chat-admin.controller.js';
import { ChatAdminService } from './chat-admin.service.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingSearchController } from './messaging-search.controller.js';
import { MessagingService } from './messaging.service.js';

@Module({
  imports: [AccountsModule, TelegramModule, SpeechModule],
  controllers: [
    MessagingController,
    MessagingSearchController,
    ChatAdminController,
  ],
  providers: [
    MessagingService,
    ChatAdminService,
    TdFilesService,
    TdMessagingService,
  ],
  exports: [MessagingService],
})
export class MessagingModule {}
