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
import { AiProvidersService } from './ai-providers.service.js';
import type {
  AiProviderCreateInput,
  AiProviderDeleteResult,
  AiProviderImportResult,
  AiProviderLimitsInput,
  AiProviderLimitsUpdateResult,
  AiProviderLimitsView,
  AiProviderModelsInput,
  AiProviderModelsView,
  AiProviderPreset,
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

  /** Presets for one-click creation (`opencode-go`, `custom`). */
  @Get('presets')
  presets(): AiProviderPreset[] {
    return this.providers.presets();
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

  /** Model ids the provider itself offers; falls back to the stored list. */
  @Get(':id/models')
  models(@Param('id') id: string): Promise<AiProviderModelsView> {
    return this.providers.models(id);
  }

  /** Saves the chosen model list (and its default) on the provider row. */
  @Put(':id/models')
  saveModels(
    @Param('id') id: string,
    @Body() body: AiProviderModelsInput = {},
  ): Promise<AiProviderView> {
    return this.providers.saveModels(id, body);
  }

  /** Stored limits plus real quota (OpenCode Go) and local counters. */
  @Get(':id/limits')
  limits(@Param('id') id: string): Promise<AiProviderLimitsView> {
    return this.providers.limits(id);
  }

  @Patch(':id/limits')
  updateLimits(
    @Param('id') id: string,
    @Body() body: AiProviderLimitsInput = {},
  ): Promise<AiProviderLimitsUpdateResult> {
    return this.providers.updateLimits(id, body);
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
