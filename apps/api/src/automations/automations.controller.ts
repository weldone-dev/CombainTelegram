import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AutomationsService } from './automations.service.js';
import { AutomationRunnerService } from './automation-runner.service.js';
import type { AutomationInput } from './automations.service.js';

@ApiTags('ai')
@Controller('ai/automations')
export class AutomationsController {
  constructor(
    private readonly automations: AutomationsService,
    private readonly runner: AutomationRunnerService,
  ) {}

  @Get()
  async list(@Query('accountId') accountId?: string) {
    return {
      automations: await this.automations.list(accountId || null),
    };
  }

  @Post()
  async create(@Body() body: AutomationInput) {
    return this.automations.create(body);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: AutomationInput) {
    return this.automations.update(id, body);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.automations.remove(id);
  }

  @Post(':id/run')
  async run(@Param('id') id: string) {
    return this.runner.runNow(id);
  }

  @Get(':id/runs')
  async runs(@Param('id') id: string, @Query('limit') rawLimit?: string) {
    const limit = Number(rawLimit);
    return {
      runs: await this.automations.runs(
        id,
        Number.isFinite(limit) ? limit : 30,
      ),
    };
  }
}
