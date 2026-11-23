import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module.js';
import { ProxiesController } from './proxies.controller.js';
import { ProxiesService } from './proxies.service.js';
import { ProxyProbeService } from './proxy-probe.service.js';

@Module({
  imports: [TelegramModule],
  controllers: [ProxiesController],
  providers: [ProxiesService, ProxyProbeService],
  exports: [ProxiesService],
})
export class ProxiesModule {}
