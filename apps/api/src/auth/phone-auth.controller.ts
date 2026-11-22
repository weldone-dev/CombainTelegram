import { Body, Controller, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { PhoneAuthService } from './phone-auth.service.js';
import type {
  PhoneCompletedView,
  PhoneResendView,
  PhoneStartDto,
  PhoneStartView,
  PhoneVerifyView,
} from './phone-auth.service.js';

@ApiTags('auth')
@Controller('auth/phone')
export class PhoneAuthController {
  constructor(private readonly phoneAuth: PhoneAuthService) {}

  @Post('start')
  start(
    @CurrentUser() user: UserModel,
    @Body() body: PhoneStartDto = {},
  ): Promise<PhoneStartView> {
    return this.phoneAuth.start(user, body);
  }

  @Post('verify')
  verify(
    @CurrentUser() user: UserModel,
    @Body() body: { attemptId?: unknown; code?: unknown } = {},
  ): Promise<PhoneVerifyView> {
    return this.phoneAuth.verify(user, body.attemptId, body.code);
  }

  @Post('password')
  password(
    @CurrentUser() user: UserModel,
    @Body() body: { attemptId?: unknown; password?: unknown } = {},
  ): Promise<PhoneCompletedView> {
    return this.phoneAuth.password(user, body.attemptId, body.password);
  }

  @Post('signup')
  signup(
    @CurrentUser() user: UserModel,
    @Body()
    body: {
      attemptId?: unknown;
      firstName?: unknown;
      lastName?: unknown;
    } = {},
  ): Promise<PhoneCompletedView> {
    return this.phoneAuth.signup(
      user,
      body.attemptId,
      body.firstName,
      body.lastName,
    );
  }

  @Post('resend')
  resend(
    @CurrentUser() user: UserModel,
    @Body() body: { attemptId?: unknown } = {},
  ): Promise<PhoneResendView> {
    return this.phoneAuth.resend(user, body.attemptId);
  }

  @Post('cancel')
  cancel(
    @CurrentUser() user: UserModel,
    @Body() body: { attemptId?: unknown } = {},
  ): Promise<{ cancelled: boolean }> {
    return this.phoneAuth.cancel(user, body.attemptId);
  }
}
