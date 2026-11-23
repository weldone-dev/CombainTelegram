import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { TdlibAuthService } from './tdlib-auth.service.js';
import type {
  TdlibAuthView,
  TdlibMigrateDto,
  TdlibStartDto,
} from './tdlib-auth.service.js';

/**
 * TDLib migration of an account that already has an mtcute session, plus its
 * stored cloud password.
 *
 * Migration never terminates the mtcute session: the existing session only
 * approves TDLib's QR link (`auth.acceptLoginToken`).
 */
@ApiTags('accounts')
@Controller('accounts')
export class TdlibMigrationController {
  constructor(private readonly tdlibAuth: TdlibAuthService) {}

  @Post(':accountId/tdlib/migrate')
  migrate(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Body() body: TdlibMigrateDto = {},
  ): Promise<TdlibAuthView> {
    return this.tdlibAuth.migrate(user, accountId, body);
  }

  @Get(':accountId/tdlib/migrate/:attemptId')
  status(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('attemptId') attemptId: string,
  ): Promise<TdlibAuthView> {
    return this.tdlibAuth.migrateStatus(user, accountId, attemptId);
  }

  @Post(':accountId/tdlib/migrate/:attemptId/password')
  password(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('attemptId') attemptId: string,
    @Body() body: { password?: unknown } = {},
  ): Promise<TdlibAuthView> {
    return this.tdlibAuth.migratePassword(
      user,
      accountId,
      attemptId,
      body.password,
    );
  }

  @Delete(':accountId/tdlib/migrate/:attemptId')
  cancel(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Param('attemptId') attemptId: string,
  ): Promise<{ cancelled: boolean }> {
    return this.tdlibAuth.migrateCancel(user, accountId, attemptId);
  }

  @Get(':accountId/cloud-password')
  cloudPasswordStatus(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
  ): Promise<{ stored: boolean }> {
    return this.tdlibAuth.cloudPasswordStatus(user, accountId);
  }

  @Put(':accountId/cloud-password')
  setCloudPassword(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
    @Body() body: { password?: unknown } = {},
  ): Promise<{ stored: boolean }> {
    return this.tdlibAuth.setCloudPassword(user, accountId, body.password);
  }

  @Delete(':accountId/cloud-password')
  clearCloudPassword(
    @CurrentUser() user: UserModel,
    @Param('accountId') accountId: string,
  ): Promise<{ stored: boolean }> {
    return this.tdlibAuth.clearCloudPassword(user, accountId);
  }
}

/** Brand-new accounts logged in through TDLib (QR or phone + code). */
@ApiTags('accounts')
@Controller('tdlib/auth')
export class TdlibAuthController {
  constructor(private readonly tdlibAuth: TdlibAuthService) {}

  @Post('start')
  start(
    @CurrentUser() user: UserModel,
    @Body() body: TdlibStartDto = {},
  ): Promise<TdlibAuthView> {
    return this.tdlibAuth.start(user, body);
  }

  @Get(':attemptId')
  status(
    @CurrentUser() user: UserModel,
    @Param('attemptId') attemptId: string,
  ): Promise<TdlibAuthView> {
    return this.tdlibAuth.status(user, attemptId);
  }

  @Post(':attemptId/code')
  code(
    @CurrentUser() user: UserModel,
    @Param('attemptId') attemptId: string,
    @Body() body: { code?: unknown } = {},
  ): Promise<TdlibAuthView> {
    return this.tdlibAuth.submitCode(user, attemptId, body.code);
  }

  @Post(':attemptId/password')
  password(
    @CurrentUser() user: UserModel,
    @Param('attemptId') attemptId: string,
    @Body() body: { password?: unknown } = {},
  ): Promise<TdlibAuthView> {
    return this.tdlibAuth.password(user, attemptId, body.password);
  }

  @Delete(':attemptId')
  cancel(
    @CurrentUser() user: UserModel,
    @Param('attemptId') attemptId: string,
  ): Promise<{ cancelled: boolean }> {
    return this.tdlibAuth.cancelAttempt(user, attemptId);
  }
}
