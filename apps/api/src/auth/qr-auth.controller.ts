import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { QrAuthService } from './qr-auth.service.js';
import type {
  QrStartDto,
  QrStartView,
  QrStatusView,
} from './qr-auth.service.js';

@ApiTags('auth')
@Controller('auth/qr')
export class QrAuthController {
  constructor(private readonly qrAuth: QrAuthService) {}

  @Post('start')
  start(
    @CurrentUser() user: UserModel,
    @Body() body: QrStartDto = {},
  ): Promise<QrStartView> {
    return this.qrAuth.start(user, body);
  }

  @Get(':attemptId')
  status(
    @CurrentUser() user: UserModel,
    @Param('attemptId') attemptId: string,
  ): Promise<QrStatusView> {
    return this.qrAuth.status(user, attemptId);
  }

  @Post(':attemptId/password')
  password(
    @CurrentUser() user: UserModel,
    @Param('attemptId') attemptId: string,
    @Body() body: { password?: unknown } = {},
  ): Promise<{ status: string }> {
    return this.qrAuth.password(user, attemptId, body.password);
  }

  @Post(':attemptId/cancel')
  cancel(
    @CurrentUser() user: UserModel,
    @Param('attemptId') attemptId: string,
  ): Promise<{ cancelled: boolean }> {
    return this.qrAuth.cancel(user, attemptId);
  }
}
