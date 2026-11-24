import { Global, Module } from '@nestjs/common';
import { AiAccessController } from './ai-access.controller.js';
import { AiAccessService } from './ai-access.service.js';
import { AiChatEventsService } from './ai-chat-events.service.js';

/**
 * Per-chat AI permissions and blacklist. Standalone on purpose: the autopilot
 * and the dashboard use it through `AiAccessService` without pulling the whole
 * `AiModule` in, and `PrismaModule` is global.
 *
 * `@Global()` because it is registered once in `AppModule` and every consumer
 * (the autopilot, the tool registry in `AiModule`, bots) must be able to inject
 * `AiAccessService` without importing this module and creating a second graph
 * edge between `AiModule` and `AiAccessModule`. `AiChatEventsService` (the
 * audit trail written on every state change) is exported for the same reason:
 * `AiChatModule` exposes it as `GET .../ai-events`.
 */
@Global()
@Module({
  controllers: [AiAccessController],
  providers: [AiAccessService, AiChatEventsService],
  exports: [AiAccessService, AiChatEventsService],
})
export class AiAccessModule {}
