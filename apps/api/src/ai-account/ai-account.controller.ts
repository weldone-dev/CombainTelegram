import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { AiAccountSettingsService } from './ai-account-settings.service.js';
import type { AiAccountSettingsView } from './ai-account-settings.service.js';

/**
 * Per-account overrides of the global AI capabilities.
 *
 * Reads and writes only the account's own deltas: `GET /ai/settings` and the
 * global permissions card are untouched, and an account without a stored row
 * behaves exactly like the global policy.
 */
@ApiTags('ai-account')
@Controller('accounts/:accountId')
export class AiAccountController {
  constructor(private readonly settings: AiAccountSettingsService) {}

  @Get('ai-settings')
  @ApiOperation({ summary: 'Permissions of one account, merged with the global policy' })
  get(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
  ): Promise<AiAccountSettingsView> {
    return this.settings.view(user.id, accountId);
  }

  @Patch('ai-settings')
  @ApiOperation({ summary: 'Patch per-account permission overrides' })
  patch(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Body() body: Record<string, unknown> = {},
  ): Promise<AiAccountSettingsView> {
    return this.settings.update(user.id, accountId, body);
  }
}
