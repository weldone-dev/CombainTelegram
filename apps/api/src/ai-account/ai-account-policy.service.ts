import { Injectable } from '@nestjs/common';
import { AiConfigService } from '../ai/ai-config.service.js';
import { AiPolicyService, PolicyError } from '../ai/ai-policy.service.js';
import type { PolicyCode, PolicyDecision } from '../ai/ai-policy.service.js';
import type {
  AiCapabilities,
  AiCapability,
  AiPolicyView,
  ToolContext,
} from '../ai/ai.types.js';
import { emitLog } from '../logs/log-sink.js';
import { AiAccountSettingsService } from './ai-account-settings.service.js';

/** Capabilities whose execution touches Telegram (mirrors `AiPolicyService`). */
const WRITE_CAPABILITIES = new Set<AiCapability>([
  'send',
  'edit',
  'delete',
  'react',
]);

/**
 * Account-aware permissions resolver.
 *
 * `AiPolicyService` stays the global source of truth; this service layers the
 * account's `AiAccountSetting.permissions` on top of it without touching that
 * file. When a capability is not overridden the call is delegated unchanged,
 * so the global permissions card and `GET /ai/settings` keep working exactly
 * as before. Only a key the account actually overrides changes the verdict:
 * it can either deny a globally allowed capability or grant one the global
 * policy denies (the account/chat allowlists and `dryRun` still apply).
 */
@Injectable()
export class AiAccountPolicyService {
  constructor(
    private readonly settings: AiAccountSettingsService,
    private readonly config: AiConfigService,
    private readonly policy: AiPolicyService,
  ) {}

  /** Effective capabilities of `accountId` (global policy when `null`). */
  async capabilities(accountId: string | null): Promise<AiCapabilities> {
    const global = await this.config.policy();
    const resolved = await this.settings.resolveFor(
      accountId,
      global.capabilities,
    );
    return resolved.effective;
  }

  async evaluate(
    capability: AiCapability,
    ctx: ToolContext,
  ): Promise<PolicyDecision> {
    const global = await this.config.policy();
    const resolved = await this.settings.resolveFor(
      ctx.accountId,
      global.capabilities,
    );
    const { defaults, effective } = resolved;

    // Same answer either way: let the global policy decide (one implementation
    // of the allowlists, logging and dry-run rules).
    if (effective[capability] === defaults[capability]) {
      return this.policy.evaluate(capability, ctx);
    }

    if (!effective[capability]) {
      return this.deny(
        capability,
        ctx,
        'CAPABILITY_DISABLED',
        `Capability "${capability}" is disabled for account ${ctx.accountId ?? 'this account'}.`,
      );
    }

    // The account override grants a globally disabled capability; the rest of
    // the global policy (allowlists, chat blocks, dryRun) still applies.
    return this.evaluateGranted(capability, ctx, global);
  }

  /** Throws a typed error; callers convert it to a tool error. */
  async assert(capability: AiCapability, ctx: ToolContext): Promise<boolean> {
    const decision = await this.evaluate(capability, ctx);
    if (!decision.allowed) {
      throw new PolicyError(
        decision.reason ?? 'AI permission denied.',
        decision.code ?? 'CAPABILITY_DISABLED',
      );
    }
    return decision.dryRun;
  }

  private evaluateGranted(
    capability: AiCapability,
    ctx: ToolContext,
    policy: AiPolicyView,
  ): PolicyDecision {
    if (
      ctx.accountId &&
      policy.allowAccountIds.length > 0 &&
      !policy.allowAccountIds.includes(ctx.accountId)
    ) {
      return {
        allowed: false,
        dryRun: false,
        code: 'ACCOUNT_DENIED',
        reason: `Account ${ctx.accountId} is not in the AI allowlist.`,
      };
    }

    const chatId = ctx.chatId;
    if (chatId !== null) {
      if (policy.blockChatIds.includes(chatId)) {
        return {
          allowed: false,
          dryRun: false,
          code: 'CHAT_DENIED',
          reason: `Chat ${chatId} is blocked for the AI.`,
        };
      }
      if (
        WRITE_CAPABILITIES.has(capability) &&
        policy.allowChatIds.length > 0 &&
        !policy.allowChatIds.includes(chatId)
      ) {
        return {
          allowed: false,
          dryRun: false,
          code: 'CHAT_DENIED',
          reason: `Chat ${chatId} is not in the AI chat allowlist.`,
        };
      }
    }

    return {
      allowed: true,
      dryRun:
        policy.dryRun &&
        WRITE_CAPABILITIES.has(capability) &&
        ctx.source !== 'dm',
    };
  }

  private deny(
    capability: AiCapability,
    ctx: ToolContext,
    code: PolicyCode,
    reason: string,
  ): PolicyDecision {
    emitLog({
      level: 'warn',
      source: 'ai',
      action: 'ai.policy.deny',
      message: reason,
      status: 'failed',
      accountId: ctx.accountId ?? undefined,
      chatId: ctx.chatId ?? undefined,
      details: { capability, source: ctx.source, code, scope: 'account' },
    });
    return { allowed: false, dryRun: false, reason, code };
  }
}
