import { Injectable } from '@nestjs/common';
import type { UserModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { TelegramConfigService } from '../telegram/telegram.config.js';

/**
 * There is no local registration or login: the app is single-user and every
 * request runs as `DEFAULT_USER_ID` (default `local`), created on first use.
 */
@Injectable()
export class DefaultUserService {
  private cached?: UserModel;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramConfigService,
  ) {}

  async get(): Promise<UserModel> {
    if (this.cached) return this.cached;

    const id = this.config.defaultUserId;
    this.cached = await this.prisma.user.upsert({
      where: { id },
      create: { id },
      update: {},
    });
    return this.cached;
  }
}
