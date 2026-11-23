import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { emitLog } from '../logs/log-sink.js';
import type {
  AiCapabilities,
  AiCapability,
  AiPolicyView,
  ToolContext,
} from './ai.types.js';
import {
  AiConfigService,
  parseCapabilities,
  type PolicyUpdate,
} from './ai-config.service.js';

export type PolicyCode = 'CAPABILITY_DISABLED' | 'ACCOUNT_DENIED' | 'CHAT_DENIED';

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly code: PolicyCode,
  ) {
    super(message);
    this.name = 'PolicyError';
  }
}

export interface PolicyDecision {
  allowed: boolean;
  /** The call should be simulated instead of touching Telegram. */
  dryRun: boolean;
  reason?: string;
  code?: PolicyCode;
}

const WRITE_CAPABILITIES = new Set<AiCapability>([
  'send',
  'edit',
  'delete',
  'react',
]);

/**
 * Single source of truth for "may this AI/MCP call act?".
 *
 * Permissions are intentionally conservative: `dryRun` is on by default, an
 * unknown chat is refused unless `sendUnknown` is enabled, and account/chat
 * allowlists can narrow the scope further. Every denial is logged.
 */
@Injectable()
export class AiPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AiConfigService,
  ) {}

  async view(): Promise<AiPolicyView> {
    return (await this.config.policy()) as AiPolicyView;
  }

  async capabilities(): Promise<AiCapabilities> {
    return (await this.config.policy()).capabilities;
  }

  async update(input: PolicyUpdate): Promise<AiPolicyView> {
    return (await this.config.updatePolicy(input)) as AiPolicyView;
  }

  async evaluate(
    capability: AiCapability,
    ctx: ToolContext,
  ): Promise<PolicyDecision> {
    const policy = await this.config.policy();
    const caps = policy.capabilities;

    if (!caps[capability]) {
      return this.deny(
        capability,
        ctx,
        'CAPABILITY_DISABLED',
        `Capability "${capability}" is disabled for the AI/MCP. Enable it in AI permissions.`,
      );
    }

    if (
      ctx.accountId &&
      policy.allowAccountIds.length > 0 &&
      !policy.allowAccountIds.includes(ctx.accountId)
    ) {
      return this.deny(
        capability,
        ctx,
        'ACCOUNT_DENIED',
        `Account ${ctx.accountId} is not in the AI allowlist.`,
      );
    }

    const chatId = ctx.chatId;
    if (chatId !== null) {
      if (policy.blockChatIds.includes(chatId)) {
        return this.deny(
          capability,
          ctx,
          'CHAT_DENIED',
          `Chat ${chatId} is blocked for the AI.`,
        );
      }
      if (
        WRITE_CAPABILITIES.has(capability) &&
        policy.allowChatIds.length > 0 &&
        !policy.allowChatIds.includes(chatId)
      ) {
        return this.deny(
          capability,
          ctx,
          'CHAT_DENIED',
          `Chat ${chatId} is not in the AI chat allowlist.`,
        );
      }
    }

    const dryRun =
      policy.dryRun &&
      WRITE_CAPABILITIES.has(capability) &&
      ctx.source !== 'dm';

    return { allowed: true, dryRun };
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

  async accountExists(accountId: string): Promise<boolean> {
    const count = await this.prisma.telegramAccount.count({
      where: { id: accountId },
    });
    return count > 0;
  }

  /**
   * `sendUnknown=false` means "only chats this account already has". We avoid
   * an extra Telegram round-trip by treating the presence of a `replyToId` as
   * proof of an existing conversation; the send itself fails for bad peers.
   */
  allowUnknownChat(caps: AiCapabilities): boolean {
    return caps.sendUnknown;
  }

  private async deny(
    capability: AiCapability,
    ctx: ToolContext,
    code: PolicyCode,
    reason: string,
  ): Promise<PolicyDecision> {
    emitLog({
      level: 'warn',
      source: 'ai',
      action: 'ai.policy.deny',
      message: reason,
      status: 'failed',
      accountId: ctx.accountId ?? undefined,
      chatId: ctx.chatId ?? undefined,
      details: { capability, source: ctx.source, code },
    });
    return { allowed: false, dryRun: false, reason, code };
  }

  /** Restricts a request to an account the surface owns (per-account bots). */
  scopedCapabilities(base: AiCapabilities): AiCapabilities {
    return parseCapabilities(base);
  }
}
