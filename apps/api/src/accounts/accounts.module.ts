import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { AccountSessionsService } from './account-sessions.service.js';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';

@Module({
  imports: [TelegramModule, RealtimeModule],
  controllers: [AccountsController],
  providers: [AccountSessionsService, AccountsService],
  exports: [AccountSessionsService, AccountsService],
})
export class AccountsModule {}
