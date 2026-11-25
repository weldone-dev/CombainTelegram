import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { N8nClientService } from './n8n-client.service.js';
import { WorkflowsService } from './workflows.service.js';
import type {
  N8nExecutionsResult,
  N8nTestResult,
  N8nWorkflowsResult,
  WorkflowAccountsInput,
  WorkflowCreateInput,
  WorkflowUpdateInput,
  WorkflowView,
} from './workflows.types.js';

/**
 * Workflow registry (local pointers into n8n) and the read-only n8n proxy the
 * dashboard uses to pick a workflow and show its recent executions. Nothing
 * here changes n8n state: the editor opens in n8n itself.
 */
@ApiTags('workflows')
@Controller('workflows')
export class WorkflowsController {
  constructor(
    private readonly workflows: WorkflowsService,
    private readonly n8n: N8nClientService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Local workflows with their assigned accounts' })
  list(@CurrentUser() user: UserModel): Promise<WorkflowView[]> {
    return this.workflows.list(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Point the app at an existing n8n workflow' })
  create(
    @CurrentUser() user: UserModel,
    @Body() body: WorkflowCreateInput = {},
  ): Promise<WorkflowView> {
    return this.workflows.create(user.id, body);
  }

  @Get('n8n')
  @ApiOperation({ summary: 'Workflows available in n8n (never throws)' })
  n8nWorkflows(): Promise<N8nWorkflowsResult> {
    return this.n8n.listWorkflows();
  }

  @Post('n8n/test')
  @HttpCode(200)
  @ApiOperation({ summary: 'Probe the configured n8n instance' })
  n8nTest(): Promise<N8nTestResult> {
    return this.n8n.test();
  }

  @Get('n8n/:id/executions')
  @ApiOperation({ summary: 'Recent executions of one n8n workflow' })
  n8nExecutions(
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ): Promise<N8nExecutionsResult> {
    return this.n8n.executions(id, limit);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Rename, enable, draft or re-point a workflow' })
  update(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Body() body: WorkflowUpdateInput = {},
  ): Promise<WorkflowView> {
    return this.workflows.update(user.id, id, body);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete the pointer and unassign its accounts' })
  remove(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
  ): Promise<{ removed: boolean }> {
    return this.workflows.remove(user.id, id);
  }

  @Put(':id/accounts')
  @ApiOperation({ summary: 'Assign exactly these accounts to the workflow' })
  assign(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Body() body: WorkflowAccountsInput = {},
  ): Promise<WorkflowView> {
    return this.workflows.assignAccounts(user.id, id, body);
  }
}
