import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { AccountSessionsService } from './account-sessions.service.js';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';
import { TdlibAuthClientFactory } from './tdlib-auth.client.js';
import {
  TdlibAuthController,
  TdlibMigrationController,
} from './tdlib-auth.controller.js';
import { TdlibAuthService } from './tdlib-auth.service.js';

@Module({
  imports: [TelegramModule, RealtimeModule],
  controllers: [
    AccountsController,
    TdlibMigrationController,
    TdlibAuthController,
  ],
  providers: [
    AccountSessionsService,
    AccountsService,
    TdlibAuthClientFactory,
    TdlibAuthService,
  ],
  exports: [AccountSessionsService, AccountsService],
})
export class AccountsModule {}
