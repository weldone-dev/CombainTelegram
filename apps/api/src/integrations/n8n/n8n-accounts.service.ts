import { Injectable } from '@nestjs/common';
import {
  AccountAiStateService,
  parseJsonObject,
  parseVariablesColumn,
} from '../../account-ai-state/account-ai-state.service.js';
import { apiError, notFound } from '../../common/api-error.js';
import { parseChatId, parseLimit } from '../../messaging/params.js';
import { MessagingService } from '../../messaging/messaging.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { N8nContextService } from './n8n-context.service.js';
import type { N8nChatBlock, N8nSoulSummary } from './n8n-context.service.js';

// Validation lives with the shared writer (`AccountAiStateService`); re-exported
// here for callers that still import it from the n8n module.
export {
  validateVariables,
  VARIABLES_MAX_KEYS,
  VARIABLES_MAX_VALUE_CHARS,
  VARIABLES_MAX_BYTES,
} from '../../account-ai-state/account-ai-state.service.js';

/** One account as n8n sees it. */
export interface N8nAccountView {
  id: string;
  title: string;
  username: string | null;
  workflowId: string | null;
  workflowName: string | null;
  /** `off` | `draft` | `auto`; `off` when the account has no soul yet. */
  soulMode: string;
  /** The account can be driven by a workflow right now. */
  enabled: boolean;
  /** Free-form per-account variables (parsed `aiVariables`). */
  variables: Record<string, string>;
  soul: N8nSoulSummary | null;
}

/** The subset of a chat the Action API exposes. */
export interface N8nChatView {
  id: number;
  title: string;
  type: string;
  username: string | null;
  unread: number;
}

/** Per-account runtime limits derived from the soul settings. */
export interface N8nAccountLimits {
  maxPerHour: number;
  maxPerChatPerDay: number;
  replyDelayMs: number;
  typing: boolean;
  typingSpeed: number;
}

/** Full account view of `GET /accounts/:accountId`. */
export interface N8nAccountDetailView {
  id: string;
  tgUserId: string;
  title: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  phone: string | null;
  isActive: boolean;
  workflow: { id: string; name: string; enabled: boolean } | null;
  soul: {
    name: string;
    mode: string;
    temperature: number;
    model: string | null;
    /** Parsed soul settings, not the raw JSON string. */
    settings: Record<string, unknown>;
  } | null;
  variables: Record<string, string>;
  limits: N8nAccountLimits | null;
  /** Distinct chats/topics with stored AI state (access, tags or settings). */
  chatCount: number;
}

export interface N8nChatMessageView {
  id: number;
  date: string;
  text: string;
  outgoing: boolean;
  transcript: string | null;
}

export interface N8nChatReadView {
  chat: N8nChatBlock & { settings: Record<string, unknown> };
  messages: N8nChatMessageView[];
}

export interface N8nVariablesView {
  accountId: string;
  variables: Record<string, string>;
}

interface AccountRow {
  id: string;
  firstName: string;
  lastName: string | null;
  username: string | null;
  isActive: boolean;
  workflowId: string | null;
  aiVariables: string;
  tgUserId?: bigint;
  soul: {
    name: string;
    mode: string;
    temperature: number;
    model: string | null;
    settings: string;
  } | null;
  workflow: { id: string; name: string; enabled: boolean } | null;
}

/** Same defaults as `DEFAULT_SOUL_SETTINGS` in the AI layer. */
const SOUL_LIMIT_DEFAULTS: N8nAccountLimits = {
  maxPerHour: 12,
  maxPerChatPerDay: 40,
  replyDelayMs: 1_200,
  typing: true,
  typingSpeed: 300,
};

const MAX_CHATS = 200;
const MAX_CHAT_MESSAGES = 100;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

/** Limits subset of the parsed soul settings, with the AI defaults. */
function limitsOf(
  settings: Record<string, unknown> | null,
): N8nAccountLimits | null {
  if (!settings) return null;
  return {
    maxPerHour: clampInt(settings.maxPerHour, SOUL_LIMIT_DEFAULTS.maxPerHour, 0, 500),
    maxPerChatPerDay: clampInt(
      settings.maxPerChatPerDay,
      SOUL_LIMIT_DEFAULTS.maxPerChatPerDay,
      0,
      5_000,
    ),
    replyDelayMs: clampInt(
      settings.replyDelayMs,
      SOUL_LIMIT_DEFAULTS.replyDelayMs,
      0,
      120_000,
    ),
    typing: settings.typing !== false,
    typingSpeed: clampInt(
      settings.typingSpeed,
      SOUL_LIMIT_DEFAULTS.typingSpeed,
      40,
      600,
    ),
  };
}

/**
 * Read side of the Action API: which accounts exist, which workflow owns them,
 * what their chat list looks like and which variables/soul state they carry.
 * Everything is scoped to one local user.
 */
@Injectable()
export class N8nAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly messaging: MessagingService,
    private readonly context: N8nContextService,
    private readonly aiState: AccountAiStateService,
  ) {}

  async list(userId: string): Promise<N8nAccountView[]> {
    const rows = (await this.prisma.telegramAccount.findMany({
      where: { userId },
      include: {
        soul: { select: { name: true, mode: true, temperature: true } },
        workflow: { select: { id: true, name: true, enabled: true } },
      },
      orderBy: { createdAt: 'asc' },
    })) as AccountRow[];

    return rows.map((row) => {
      const title = [row.firstName, row.lastName]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join(' ');
      return {
        id: row.id,
        title: title || `Аккаунт ${row.id}`,
        username: row.username,
        workflowId: row.workflowId ?? null,
        workflowName: row.workflow?.name ?? null,
        soulMode: row.soul?.mode ?? 'off',
        enabled: row.isActive && (row.workflow?.enabled ?? true),
        variables: parseVariablesColumn(row.aiVariables),
        soul: row.soul
          ? {
              name: row.soul.name,
              mode: row.soul.mode,
              temperature: row.soul.temperature,
            }
          : null,
      };
    });
  }

  /** Identity, workflow, soul, variables, limits and the AI chat count. */
  async detail(
    userId: string,
    accountId: string,
  ): Promise<N8nAccountDetailView> {
    const row = (await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      include: {
        soul: {
          select: {
            name: true,
            mode: true,
            temperature: true,
            model: true,
            settings: true,
          },
        },
        workflow: { select: { id: true, name: true, enabled: true } },
      },
    })) as AccountRow | null;
    if (!row) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }

    const settings = row.soul ? parseJsonObject(row.soul.settings) : null;
    return {
      id: row.id,
      tgUserId: row.tgUserId?.toString() ?? '',
      title: [row.firstName, row.lastName]
        .filter((part): part is string => Boolean(part && part.trim()))
        .join(' ') || row.firstName,
      firstName: row.firstName,
      lastName: row.lastName,
      username: row.username,
      phone: await this.phone(accountId),
      isActive: row.isActive,
      workflow: row.workflow
        ? {
            id: row.workflow.id,
            name: row.workflow.name,
            enabled: row.workflow.enabled,
          }
        : null,
      soul: row.soul
        ? {
            name: row.soul.name,
            mode: row.soul.mode,
            temperature: row.soul.temperature,
            model: row.soul.model,
            settings: settings ?? {},
          }
        : null,
      variables: parseVariablesColumn(row.aiVariables),
      limits: limitsOf(settings),
      chatCount: await this.chatCount(accountId),
    };
  }

  /** One chat with tags/access and its last `messages` messages. */
  async chat(
    userId: string,
    accountId: string,
    rawChatId: string,
    rawThreadId: unknown,
    rawMessages: unknown,
  ): Promise<N8nChatReadView> {
    await this.requireAccount(userId, accountId);
    const chatId = parseChatId(rawChatId);
    const threadId = this.threadId(rawThreadId);
    const limit =
      rawMessages === undefined || rawMessages === null || rawMessages === ''
        ? 10
        : parseLimit(rawMessages, MAX_CHAT_MESSAGES);

    const [chat, settings, history] = await Promise.all([
      this.context.chat(userId, accountId, chatId, threadId),
      this.context.chatSettings(accountId, chatId, threadId),
      this.messaging.listMessages(userId, accountId, String(chatId), {
        limit,
      }),
    ]);
    const fallback: N8nChatBlock = {
      id: chatId,
      threadId,
      title: '',
      username: null,
      type: 'unknown',
      tags: [],
      access: { allowed: false, blocked: false, warnings: 0, reason: null },
    };
    return {
      chat: { ...(chat ?? fallback), settings },
      messages: history.messages.map((message) => ({
        id: message.id,
        date: message.date,
        text: message.text,
        outgoing: message.outgoing,
        transcript: null,
      })),
    };
  }

  /** Chat list of one account, in Telegram order (most recent first). */
  async chats(
    userId: string,
    accountId: string,
    rawLimit?: unknown,
  ): Promise<N8nChatView[]> {
    await this.requireAccount(userId, accountId);
    const limit = parseLimit(rawLimit, MAX_CHATS);
    const chats = await this.messaging.listChats(userId, accountId, { limit });
    return chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      type: chat.type,
      username: chat.username,
      unread: chat.unreadCount,
    }));
  }

  /** Same rows and validation as the dashboard route. */
  variables(
    userId: string,
    accountId: string,
  ): Promise<N8nVariablesView> {
    return this.aiState.variables(userId, accountId);
  }

  /** Replaces the whole variable object; the old value is not merged. */
  setVariables(
    userId: string,
    accountId: string,
    rawBody: unknown,
  ): Promise<N8nVariablesView> {
    return this.aiState.setVariables(userId, accountId, rawBody);
  }

  /**
   * Ownership check shared by every action: an account of another user is
   * reported as missing, never as forbidden, so ids cannot be probed.
   */
  async requireAccount(userId: string, accountId: string): Promise<void> {
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id: accountId, userId },
      select: { id: true },
    });
    if (!account) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
  }

  private threadId(value: unknown): number {
    if (value === undefined || value === null || value === '') return 0;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw apiError('VALIDATION_ERROR', 'threadId must be a non-negative integer');
    }
    return parsed;
  }

  private async phone(accountId: string): Promise<string | null> {
    const account = await this.context.account(accountId);
    return account?.phone ?? null;
  }

  /** Distinct chats with stored AI state; topics of one chat count once. */
  private async chatCount(accountId: string): Promise<number> {
    const [access, tags, settings] = await Promise.all([
      this.prisma.aiChatAccess.findMany({
        where: { accountId },
        select: { chatId: true },
      }),
      this.prisma.aiChatTag.findMany({
        where: { accountId },
        select: { chatId: true },
      }),
      this.prisma.aiChatSetting.findMany({
        where: { accountId },
        select: { chatId: true },
      }),
    ]);
    const chats = new Set<string>();
    for (const row of [...access, ...tags, ...settings] as Array<{
      chatId: bigint;
    }>) {
      chats.add(row.chatId.toString());
    }
    return chats.size;
  }
}
