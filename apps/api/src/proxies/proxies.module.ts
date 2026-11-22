import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module.js';
import { ProxiesController } from './proxies.controller.js';
import { ProxiesService } from './proxies.service.js';

@Module({
  imports: [TelegramModule],
  controllers: [ProxiesController],
  providers: [ProxiesService],
  exports: [ProxiesService],
})
export class ProxiesModule {}
