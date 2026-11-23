import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module.js';
import { MessagingModule } from '../messaging/messaging.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { TelegramModule } from '../telegram/telegram.module.js';
import { AiConfigService } from './ai-config.service.js';
import { AiPolicyService } from './ai-policy.service.js';
import { AgentToolsService } from './agent-tools.service.js';
import { AgentService } from './agent.service.js';
import { LlmService } from './llm.service.js';
import { MemoryService } from './memory.service.js';
import { SkillsService } from './skills.service.js';
import { SoulsService } from './souls.service.js';
import { DmAutopilotService } from './dm-autopilot.service.js';
import { AiController, SoulController } from './ai.controller.js';
import { AutomationsService } from '../automations/automations.service.js';
import { AutomationRunnerService } from '../automations/automation-runner.service.js';
import { AutomationSchedulerService } from '../automations/automation-scheduler.service.js';
import { AutomationsController } from '../automations/automations.controller.js';
import { BotsService } from '../bots/bots.service.js';
import { BotRunnerService } from '../bots/bot-runner.service.js';
import { BotsController } from '../bots/bots.controller.js';
import { McpController } from '../mcp/mcp.controller.js';

/**
 * AI, souls, memory, skills, automations, bots and the MCP endpoint.
 *
 * All services live in one module because they share the tool registry and the
 * agent; keeping them together avoids circular imports between "read" and
 * "act" sides of the AI layer.
 */
@Module({
  imports: [
    TelegramModule,
    AccountsModule,
    MessagingModule,
    RealtimeModule,
  ],
  controllers: [
    AiController,
    SoulController,
    AutomationsController,
    BotsController,
    McpController,
  ],
  providers: [
    AiConfigService,
    LlmService,
    AiPolicyService,
    SkillsService,
    SoulsService,
    MemoryService,
    AgentToolsService,
    AgentService,
    DmAutopilotService,
    AutomationsService,
    AutomationRunnerService,
    AutomationSchedulerService,
    BotsService,
    BotRunnerService,
  ],
  exports: [
    AiConfigService,
    AiPolicyService,
    AgentService,
    SoulsService,
    MemoryService,
    SkillsService,
  ],
})
export class AiModule {}
