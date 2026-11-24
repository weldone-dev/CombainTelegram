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
import { AiProvidersService } from './ai-providers.service.js';
import type {
  AiProviderCreateInput,
  AiProviderDeleteResult,
  AiProviderImportResult,
  AiProviderTestResult,
  AiProviderUpdateInput,
  AiProviderView,
} from './ai-providers.types.js';

/**
 * CRUD over the configured LLM providers. Keys are write-only: responses only
 * say whether a key is stored (`hasKey`).
 */
@ApiTags('ai-providers')
@Controller('ai/providers')
export class AiProvidersController {
  constructor(private readonly providers: AiProvidersService) {}

  @Get()
  list(): Promise<AiProviderView[]> {
    return this.providers.list();
  }

  @Post()
  create(@Body() body: AiProviderCreateInput = {}): Promise<AiProviderView> {
    return this.providers.create(body);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() body: AiProviderUpdateInput = {},
  ): Promise<AiProviderView> {
    return this.providers.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string): Promise<AiProviderDeleteResult> {
    return this.providers.remove(id);
  }

  @Post(':id/default')
  makeDefault(@Param('id') id: string): Promise<AiProviderView> {
    return this.providers.makeDefault(id);
  }

  @Post(':id/test')
  test(@Param('id') id: string): Promise<AiProviderTestResult> {
    return this.providers.test(id);
  }

  @Post('import-settings')
  importSettings(): Promise<AiProviderImportResult> {
    return this.providers.importSettings();
  }
}
