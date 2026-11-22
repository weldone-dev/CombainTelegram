import { Global, Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module.js';
import { DefaultUserGuard } from './default-user.guard.js';
import { DefaultUserService } from './default-user.service.js';

@Global()
@Module({
  imports: [TelegramModule],
  providers: [DefaultUserService, DefaultUserGuard],
  exports: [DefaultUserService, DefaultUserGuard],
})
export class UserContextModule {}
