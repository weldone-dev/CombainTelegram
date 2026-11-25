import { Module } from '@nestjs/common';
import { AccountAiStateModule } from '../../account-ai-state/account-ai-state.module.js';
import { AiModule } from '../../ai/ai.module.js';
import { AiChatModule } from '../../ai-chat/ai-chat.module.js';
import { MessagingModule } from '../../messaging/messaging.module.js';
import { RealtimeModule } from '../../realtime/realtime.module.js';
import { TelegramModule } from '../../telegram/telegram.module.js';
import { N8nAccountsService } from './n8n-accounts.service.js';
import { N8nActionsController } from './n8n-actions.controller.js';
import { N8nActionsService } from './n8n-actions.service.js';
import { N8nContextService } from './n8n-context.service.js';
import { N8nEventsService } from './n8n-events.service.js';
import { N8nReadController } from './n8n-read.controller.js';
import { N8nTokenGuard } from './n8n-token.guard.js';

/**
 * n8n integration: the guarded Action API (`/integrations/n8n`) and the event
 * bridge that pushes to the workflow webhook.
 *
 * `AiModule` supplies the autopilot (`replyNow`), the tool registry and the
 * automations service; `AiAccessModule` is global. The bridge listens to
 * `RealtimeService` exactly like the socket gateway does, so no service has to
 * import this module and the dependency graph stays acyclic.
 */
@Module({
  imports: [
    MessagingModule,
    RealtimeModule,
    TelegramModule,
    AccountAiStateModule,
    AiChatModule,
    AiModule,
  ],
  controllers: [N8nReadController, N8nActionsController],
  providers: [
    N8nTokenGuard,
    N8nContextService,
    N8nEventsService,
    N8nAccountsService,
    N8nActionsService,
  ],
  exports: [N8nEventsService],
})
export class N8nIntegrationsModule {}
