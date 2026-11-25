import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AccountAiStateService } from './account-ai-state.service.js';

/**
 * Per-account variables and per-chat AI overrides.
 *
 * A standalone module because both surfaces use it: the dashboard
 * (`AccountsModule`) and the n8n Action API (`N8nIntegrationsModule`). Neither
 * imports the other, so the graph stays acyclic; cache invalidation travels on
 * `RealtimeService` instead.
 */
@Module({
  imports: [RealtimeModule],
  providers: [AccountAiStateService],
  exports: [AccountAiStateService],
})
export class AccountAiStateModule {}
