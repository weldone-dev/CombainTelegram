import { Global, Module } from '@nestjs/common';
import { TelegramModule } from '../telegram/telegram.module.js';
import { AiProvidersController } from './ai-providers.controller.js';
import { AiProvidersService } from './ai-providers.service.js';

/**
 * Configurable LLM providers.
 *
 * Global so `AiConfigService` can inject the resolver without `AiModule`
 * importing this module (that file is owned by another change); the module is
 * registered once in `AppModule`.
 */
@Global()
@Module({
  imports: [TelegramModule],
  controllers: [AiProvidersController],
  providers: [AiProvidersService],
  exports: [AiProvidersService],
})
export class AiProvidersModule {}
