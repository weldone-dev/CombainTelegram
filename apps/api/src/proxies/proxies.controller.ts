import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { UserModel } from '@repo/database';
import { CurrentUser } from '../user-context/current-user.decorator.js';
import { ProxiesService } from './proxies.service.js';
import type { ProxyCreateDto, ProxyUpdateDto } from './proxies.service.js';
import type { ProxyTestResult, ProxyView } from './proxy-view.js';

@ApiTags('proxies')
@Controller('proxies')
export class ProxiesController {
  constructor(private readonly proxies: ProxiesService) {}

  @Get()
  list(@CurrentUser() user: UserModel): Promise<ProxyView[]> {
    return this.proxies.list(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: UserModel,
    @Body() body: ProxyCreateDto = {},
  ): Promise<ProxyView> {
    return this.proxies.create(user.id, body);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
    @Body() body: ProxyUpdateDto = {},
  ): Promise<ProxyView> {
    return this.proxies.update(user.id, id, body);
  }

  @Delete(':id')
  remove(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
  ): Promise<{ removed: boolean }> {
    return this.proxies.remove(user.id, id);
  }

  @Post(':id/test')
  test(
    @CurrentUser() user: UserModel,
    @Param('id') id: string,
  ): Promise<ProxyTestResult> {
    return this.proxies.test(user.id, id);
  }
}
