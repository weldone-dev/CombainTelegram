import { Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module.js';
import { AccountWorkflowController } from './account-workflow.controller.js';
import { N8nClientService } from './n8n-client.service.js';
import { WorkflowsController } from './workflows.controller.js';
import { WorkflowsService } from './workflows.service.js';

/**
 * Workflow registry: local pointers into n8n, the account assignment, and the
 * server-side n8n proxy. `TelegramModule` supplies `SessionCryptoService` for
 * the sealed n8n API key; `PrismaModule` is global.
 */
@Module({
  imports: [TelegramModule],
  controllers: [WorkflowsController, AccountWorkflowController],
  providers: [N8nClientService, WorkflowsService],
  exports: [N8nClientService, WorkflowsService],
})
export class WorkflowsModule {}
