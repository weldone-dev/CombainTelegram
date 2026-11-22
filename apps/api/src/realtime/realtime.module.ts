import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module.js';
import { EventsGateway } from './events.gateway.js';
import { RealtimeService } from './realtime.service.js';
import { UpdatesService } from './updates.service.js';

@Module({
  imports: [TelegramModule],
  providers: [RealtimeService, UpdatesService, EventsGateway],
  exports: [RealtimeService, UpdatesService],
})
export class RealtimeModule {}
