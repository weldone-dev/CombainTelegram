import { Controller, Get, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { WorkflowsService } from './workflows.service.js';
import type { AccountWorkflowView } from './workflows.types.js';

/** Which workflow (if any) drives one account, and which engine is active. */
@ApiTags('workflows')
@Controller('accounts/:accountId')
export class AccountWorkflowController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get('workflow')
  @ApiOperation({
    summary: 'Account workflow assignment and effective AI mode',
  })
  get(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
  ): Promise<AccountWorkflowView> {
    return this.workflows.accountWorkflow(user.id, accountId);
  }
}
