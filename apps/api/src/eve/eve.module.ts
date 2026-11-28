import { Module } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { MessagingModule } from '../messaging/messaging.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { EveContextService } from './eve-context.service.js';
import { EveController } from './eve.controller.js';
import { EveDelayedService } from './eve-delayed.service.js';
import { logEveDryRunStartup } from './eve-dry-run.js';
import { EveEventsService } from './eve-events.service.js';
import { EveGateway } from './eve.gateway.js';
import { EveLlmService } from './eve-llm.service.js';
import { EveMediaService } from './eve-media.service.js';
import { EvePersonaGenService } from './eve-persona-gen.service.js';
import { EveMemoryLifecycleService } from './eve-memory-lifecycle.service.js';
import { EveProactiveController } from './eve-proactive.controller.js';
import { EveProactiveService } from './eve-proactive.service.js';
import { EveSchedulesService } from './eve-schedules.service.js';
import { EveTimelineService } from './eve-timeline.service.js';
import { EveTurnService } from './eve-turn.service.js';
import { EveService } from './eve.service.js';
import { EveTokenGuard } from './eve-token.guard.js';

/**
 * Internal Eve channel: durable events, a live socket, and the action/memory
 * contract. The local Eve process talks to this module over HTTP/WS; it never
 * opens a Telegram client or a second Prisma writer.
 */
@Module({
  imports: [MessagingModule, RealtimeModule],
  controllers: [EveController, EveProactiveController],
  providers: [
    EveTokenGuard,
    EveGateway,
    EveContextService,
    EveLlmService,
    EveEventsService,
    EveDelayedService,
    EveMediaService,
    EvePersonaGenService,
    EveMemoryLifecycleService,
    EveTurnService,
    EveProactiveService,
    EveSchedulesService,
    EveService,
    EveTimelineService,
  ],
  exports: [
    EveLlmService,
    EveContextService,
    EveEventsService,
    EveDelayedService,
    EveService,
    EveMediaService,
    EvePersonaGenService,
    EveMemoryLifecycleService,
    EveTurnService,
    EveProactiveService,
    EveSchedulesService,
  ],
})
export class EveModule implements OnModuleInit {
  /** Loud one-time warning: a dry run must never be enabled by accident. */
  onModuleInit(): void {
    logEveDryRunStartup();
  }
}
