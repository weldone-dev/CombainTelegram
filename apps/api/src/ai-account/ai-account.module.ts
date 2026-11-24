import { Global, Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { AiChatModule } from '../ai-chat/ai-chat.module.js';
import { AiAccountController } from './ai-account.controller.js';
import { AiAccountPolicyService } from './ai-account-policy.service.js';
import { AiAccountSettingsService } from './ai-account-settings.service.js';

/**
 * Per-account AI settings: capability overrides plus the account-aware policy
 * resolver. `AiModule` provides the global policy (`AiConfigService`,
 * `AiPolicyService`); `AiChatModule` is imported here so a single module
 * registration in `AppModule` pulls in the per-chat routes as well.
 *
 * `@Global()` because `AiModule` needs `AiAccountPolicyService` (the tool
 * registry checks every call against the account's overrides) but cannot
 * import this module: this one already imports `AiModule`, so a regular import
 * would be a cycle. Global exports behave like `AiAccessModule`.
 */
@Global()
@Module({
  imports: [AiModule, AiChatModule],
  controllers: [AiAccountController],
  providers: [AiAccountSettingsService, AiAccountPolicyService],
  exports: [AiAccountSettingsService, AiAccountPolicyService],
})
export class AiAccountModule {}
