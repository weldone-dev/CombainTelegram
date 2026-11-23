import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BotsService } from './bots.service.js';
import type { BotInput, BotView } from './bots.service.js';
import { apiError } from '../common/api-error.js';

function tokenOf(input: BotInput): string | null {
  return typeof input.token === 'string' && input.token.trim()
    ? input.token.trim()
    : null;
}

@ApiTags('ai')
@Controller('ai/bots')
export class BotsController {
  constructor(private readonly bots: BotsService) {}

  @Get()
  async list() {
    const [bots, shared] = await Promise.all([
      this.bots.list(),
      this.bots.shared(),
    ]);
    return { bots, shared };
  }

  @Put('shared')
  async upsertShared(@Body() body: BotInput): Promise<BotView> {
    await this.validate(body);
    return this.bots.upsertShared(body);
  }

  @Put('accounts/:accountId')
  async upsertAccount(
    @Param('accountId') accountId: string,
    @Body() body: BotInput,
  ): Promise<BotView> {
    await this.validate(body);
    return this.bots.createForAccount(accountId, body);
  }

  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() body: BotInput,
  ): Promise<BotView> {
    await this.validate(body);
    return this.bots.update(id, body);
  }

  @Put(':id/skills')
  async setSkills(
    @Param('id') id: string,
    @Body() body: { skillSlugs?: unknown },
  ): Promise<BotView> {
    return this.bots.setSkills(id, body.skillSlugs);
  }

  @Post(':id/check')
  async check(@Param('id') id: string): Promise<BotView> {
    const token = await this.bots.token(id);
    if (!token) {
      throw apiError('BOT_TOKEN_MISSING', 'Bot has no token yet', 400);
    }
    const me = await this.bots.identify(token);
    await this.bots.update(id, {
      username: me.username,
      title: me.firstName,
      enabled: true,
    });
    return this.bots.get(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.bots.remove(id);
  }

  private async validate(body: BotInput): Promise<void> {
    const token = tokenOf(body);
    if (!token) return;
    const me = await this.bots.identify(token);
    if (!body.username) body.username = me.username ?? undefined;
    if (!body.title) body.title = me.firstName;
  }
}
