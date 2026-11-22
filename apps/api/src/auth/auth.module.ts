import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ProxiesModule } from '../proxies/proxies.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { AuthAttemptStore } from './auth-attempt.store.js';
import { PhoneAuthController } from './phone-auth.controller.js';
import { PhoneAuthService } from './phone-auth.service.js';
import { QrAuthController } from './qr-auth.controller.js';
import { QrAuthService } from './qr-auth.service.js';
import { TdataAuthController } from './tdata-auth.controller.js';
import { TdataAuthService } from './tdata-auth.service.js';

@Module({
  imports: [TelegramModule, AccountsModule, RealtimeModule, ProxiesModule],
  controllers: [
    PhoneAuthController,
    QrAuthController,
    TdataAuthController,
  ],
  providers: [AuthAttemptStore, PhoneAuthService, QrAuthService, TdataAuthService],
  exports: [AuthAttemptStore],
})
export class AuthModule {}
