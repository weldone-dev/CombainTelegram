import { Module } from '@nestjs/common';
import { AiAccessModule } from '../ai-access/ai-access.module.js';
import { AiChatController } from './ai-chat.controller.js';
import { AiChatMemoryService } from './ai-chat-memory.service.js';
import { AiChatSkillsService } from './ai-chat-skills.service.js';

/**
 * Per-chat AI state: skill overrides, memory view and the AI event history.
 * `AiChatEventsService` (the recorder) lives in `AiAccessModule`, imported
 * here explicitly (it is also `@Global()`), so the event endpoints reuse the
 * same writer as the state changes instead of duplicating the audit trail.
 *
 * `AiChatSkillsService.resolveSkillSlugs` is exported for the autopilot
 * wiring; `AiAccountModule` imports this module so one registration in
 * `AppModule` also exposes these routes.
 */
@Module({
  imports: [AiAccessModule],
  controllers: [AiChatController],
  providers: [AiChatSkillsService, AiChatMemoryService],
  exports: [AiChatSkillsService, AiChatMemoryService],
})
export class AiChatModule {}
