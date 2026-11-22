import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { PushService } from './push.service.js';
import type {
  PushSubscribeInput,
  PushTestResult,
} from './push.service.js';

@ApiTags('push')
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  /** VAPID public key for `pushManager.subscribe`. */
  @Get('key')
  key(): { publicKey: string } {
    return this.push.getPublicKey();
  }

  @Put('subscribe')
  @HttpCode(204)
  async subscribe(
    @CurrentUser() user: UserModel,
    @Body() body: PushSubscribeInput,
    @Headers('user-agent') userAgent?: string,
  ): Promise<void> {
    await this.push.subscribe(user.id, body, userAgent);
  }

  @Delete('subscribe')
  @HttpCode(204)
  async unsubscribe(
    @CurrentUser() user: UserModel,
    @Body() body: { endpoint?: string } = {},
  ): Promise<void> {
    await this.push.unsubscribe(user.id, body.endpoint ?? '');
  }

  /** Sends a test notification to all subscriptions of the current user. */
  @Post('test')
  test(@CurrentUser() user: UserModel): Promise<PushTestResult> {
    return this.push.sendTest(user.id);
  }
}
