import { Injectable, Logger } from '@nestjs/common';
import { MessagingService } from '../messaging/messaging.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { LogsService } from '../logs/logs.service.js';
import { emitLog } from '../logs/log-sink.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiConfigService } from './ai-config.service.js';
import { AiPolicyService, PolicyError } from './ai-policy.service.js';
import { MemoryService } from './memory.service.js';
import { SkillsService } from './skills.service.js';
import { SoulsService } from './souls.service.js';
import {
  AutomationsService,
  type AutomationView,
} from '../automations/automations.service.js';
import { BotsService } from '../bots/bots.service.js';
import { AiAccessService } from '../ai-access/ai-access.service.js';
import type {
  AgentTool,
  AiCapability,
  ToolContext,
  ToolResult,
  ToolSchema,
  ToolCallView,
} from './ai.types.js';

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function number(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

function limit(value: unknown, fallback = 20, max = 100): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.round(parsed)));
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/** Forum topic / comment thread: `0` means the whole chat. */
function threadIdOf(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** Optional string argument: absent stays absent, empty or null clears. */
function nullableText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${field} must be a boolean`);
}

function trimMessage(message: {
  id: number;
  date: string;
  outgoing: boolean;
  senderName: string;
  text: string;
  mediaType: string | null;
}) {
  return {
    id: message.id,
    date: message.date,
    outgoing: message.outgoing,
    sender: message.senderName,
    text: message.text.slice(0, 1200),
    media: message.mediaType,
  };
}

/**
 * The single tool registry shared by the UI agent, MCP clients, bots and
 * automations. Every call passes through {@link AiPolicyService}; write tools
 * respect `dryRun` and are logged.
 */
@Injectable()
export class AgentToolsService {
  private readonly logger = new Logger(AgentToolsService.name);
  private readonly tools: AgentTool[] = [];

  constructor(
    private readonly accounts: AccountsService,
    private readonly messaging: MessagingService,
    private readonly logs: LogsService,
    private readonly souls: SoulsService,
    private readonly memory: MemoryService,
    private readonly skills: SkillsService,
    private readonly config: AiConfigService,
    private readonly policy: AiPolicyService,
    private readonly automations: AutomationsService,
    private readonly bots: BotsService,
    private readonly prisma: PrismaService,
    private readonly access: AiAccessService,
  ) {
    this.registerAll();
  }

  list(): ToolCallView[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      capability: tool.capability,
      write: tool.telegramWrite === true,
    }));
  }

  /** Tool definitions for the LLM/MCP, filtered by skill and policy. */
  async schemas(
    ctx: ToolContext,
    filter?: string[] | null,
  ): Promise<ToolSchema[]> {
    const caps = await this.policy.capabilities();
    return this.tools
      .filter((tool) => caps[tool.capability])
      .filter((tool) => !tool.sources || tool.sources.includes(ctx.source))
      .filter((tool) => filter === null || filter === undefined || filter.includes(tool.name))
      .map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
  }

  async execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      return { ok: false, code: 'UNKNOWN_TOOL', error: `Unknown tool ${name}` };
    }
    if (tool.sources && !tool.sources.includes(ctx.source)) {
      return {
        ok: false,
        code: 'TOOL_NOT_ALLOWED',
        error: `Tool ${name} is not available from ${ctx.source}`,
      };
    }
    const args = object(rawArgs);
    const requestedAccount = text(args.accountId);
    if (
      ctx.accountId &&
      requestedAccount &&
      requestedAccount !== ctx.accountId
    ) {
      return {
        ok: false,
        code: 'ACCOUNT_SCOPE',
        error: `This surface is limited to account ${ctx.accountId}`,
      };
    }
    const started = Date.now();
    try {
      const dryRun = await this.policy.assert(tool.capability, {
        ...ctx,
        accountId: text(args.accountId, ctx.accountId ?? '') || ctx.accountId,
        chatId:
          number(args.chatId) ??
          number(args.chat_id) ??
          ctx.chatId,
      });
      if (tool.telegramWrite && dryRun) {
        const result = {
          dryRun: true,
          wouldCall: tool.name,
          args,
          note:
            'dryRun is on: nothing was sent to Telegram. Turn it off in AI → Разрешения.',
        };
        this.audit(tool, args, ctx, started, true, true);
        return { ok: true, result, dryRun: true };
      }
      const result = await tool.handler(args, ctx);
      this.audit(tool, args, ctx, started, true, false);
      return { ok: true, result };
    } catch (error) {
      const code = error instanceof PolicyError ? error.code : 'TOOL_ERROR';
      const message = (error as Error).message;
      this.audit(tool, args, ctx, started, false, false, message);
      return { ok: false, code, error: message };
    }
  }

  private audit(
    tool: AgentTool,
    args: Record<string, unknown>,
    ctx: ToolContext,
    started: number,
    ok: boolean,
    dryRun: boolean,
    error?: string,
  ): void {
    emitLog({
      level: ok ? 'info' : 'warn',
      source: ctx.source === 'mcp' ? 'mcp' : 'ai',
      action: `ai.tool.${tool.name}`,
      message: `${tool.name} ${ok ? (dryRun ? '(dry run)' : 'done') : 'failed'}`,
      status: ok ? 'ok' : 'failed',
      durationMs: Date.now() - started,
      accountId: text(args.accountId) || ctx.accountId || undefined,
      chatId: number(args.chatId) ?? ctx.chatId ?? undefined,
      details: { source: ctx.source, args: this.redact(args), error },
    });
  }

  private redact(args: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...args };
    if (typeof copy.token === 'string') copy.token = '***';
    if (typeof copy.apiKey === 'string') copy.apiKey = '***';
    return copy;
  }

  private requireAccount(args: Record<string, unknown>, ctx: ToolContext): string {
    const accountId = text(args.accountId, ctx.accountId ?? '');
    if (!accountId) throw new Error('accountId is required');
    return accountId;
  }

  private requireChat(args: Record<string, unknown>, ctx: ToolContext): number {
    const chatId = number(args.chatId) ?? ctx.chatId;
    if (!chatId) throw new Error('chatId is required');
    return chatId;
  }

  /**
   * Second gate for calls that take access away (mute a chat). It reuses the
   * capability flags of {@link AiPolicyService} instead of a new confirmation
   * switch, so `policy_update` stays the only way to grant it. Tools whose
   * whole purpose is destructive (`chat_block`, `automation_pause_chat`) carry
   * that capability themselves and are already filtered and asserted there.
   */
  private async requireDestructive(
    capability: AiCapability,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<void> {
    await this.policy.assert(capability, {
      ...ctx,
      accountId: text(args.accountId, ctx.accountId ?? '') || ctx.accountId,
      chatId: number(args.chatId) ?? ctx.chatId,
    });
  }

  /** Compact answer for the per-chat automation tools (views only, no rows). */
  private chatAutomations(
    accountId: string,
    chatId: number,
    threadId: unknown,
    rows: AutomationView[],
  ) {
    return {
      accountId,
      chatId,
      threadId: threadIdOf(threadId),
      count: rows.length,
      automations: rows.map((row) => ({
        id: row.id,
        name: row.name,
        enabled: row.enabled,
        selfPaused: row.selfPaused,
        selfPauseReason: row.selfPauseReason,
      })),
    };
  }

  private register(tool: AgentTool): void {
    this.tools.push(tool);
  }

  private registerAll(): void {
    this.register({
      name: 'system_status',
      description:
        'Current AI provider, model, permission policy and counts of souls/skills/automations.',
      capability: 'read',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const [settings, souls, skills, automations, bots] = await Promise.all([
          this.config.view(),
          this.souls.list(),
          this.skills.list(),
          this.prisma.automation.count(),
          this.prisma.telegramBot.count(),
        ]);
        return {
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          fastModel: settings.fastModel,
          hasApiKey: settings.hasApiKey,
          dryRun: settings.dryRun,
          capabilities: settings.capabilities,
          souls: souls.length,
          skills: skills.length,
          automations,
          bots,
          mcpEndpoint: settings.mcp.endpoint,
        };
      },
    });

    this.register({
      name: 'settings_get',
      description: 'AI provider settings and permission policy (API key masked).',
      capability: 'read',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        const settings = await this.config.view();
        return {
          provider: settings.provider,
          baseUrl: settings.baseUrl,
          model: settings.model,
          fastModel: settings.fastModel,
          apiKeyHint: settings.apiKeyHint,
          temperature: settings.temperature,
          maxSteps: settings.maxSteps,
          dryRun: settings.dryRun,
          capabilities: settings.capabilities,
          allowAccountIds: settings.allowAccountIds,
          allowChatIds: settings.allowChatIds,
          blockChatIds: settings.blockChatIds,
          ownerTgUserIds: settings.ownerTgUserIds,
        };
      },
    });

    this.register({
      name: 'policy_get',
      description: 'Current MCP/AI permission policy.',
      capability: 'read',
      parameters: { type: 'object', properties: {} },
      handler: async () => this.config.policy(),
    });

    this.register({
      name: 'accounts_list',
      description: 'Telegram accounts attached to the app.',
      capability: 'read',
      parameters: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const list = await this.accounts.list(ctx.userId);
        return list
          .filter(
            (account) => !ctx.accountId || account.id === ctx.accountId,
          )
          .map((account) => ({
          id: account.id,
          tgUserId: account.tgUserId,
          name: `${account.firstName}${account.lastName ? ` ${account.lastName}` : ''}`,
          username: account.username,
          phoneMasked: account.phoneMasked,
          activeSessionId: account.activeSessionId,
        }));
      },
    });

    this.register({
      name: 'accounts_get',
      description: 'One Telegram account by id.',
      capability: 'read',
      parameters: {
        type: 'object',
        properties: { accountId: { type: 'string' } },
        required: ['accountId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const list = await this.accounts.list(ctx.userId);
        const account = list.find((item) => item.id === accountId);
        if (!account) throw new Error(`Account ${accountId} not found`);
        return {
          id: account.id,
          tgUserId: account.tgUserId,
          name: `${account.firstName}${account.lastName ? ` ${account.lastName}` : ''}`,
          username: account.username,
          phoneMasked: account.phoneMasked,
          sessions: account.sessions.map((session) => ({
            id: session.id,
            engine: session.engine,
            label: session.label,
            revoked: Boolean(session.revokedAt),
          })),
        };
      },
    });

    const accountProperty = {
      type: 'string',
      description: 'Account id; defaults to the active account.',
    };

    this.register({
      name: 'chats_list',
      description: 'Dialogs of one account or all accounts (title, id, unread).',
      capability: 'read',
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          limit: { type: 'number', default: 40 },
        },
      },
      handler: async (args, ctx) => {
        const accounts = await this.accounts.list(ctx.userId);
        const wanted = text(args.accountId, ctx.accountId ?? '');
        const targets = wanted
          ? accounts.filter((account) => account.id === wanted)
          : accounts;
        const result: unknown[] = [];
        for (const account of targets) {
          const chats = await this.messaging.listChats(ctx.userId, account.id, {
            limit: limit(args.limit, 40),
          });
          result.push({
            accountId: account.id,
            chats: chats.map((chat) => ({
              id: chat.id,
              type: chat.type,
              title: chat.title,
              username: chat.username,
              unread: chat.unreadCount,
              pinned: chat.pinned,
              lastMessage: chat.lastMessage ? trimMessage(chat.lastMessage) : null,
            })),
          });
        }
        return result;
      },
    });

    this.register({
      name: 'chats_get',
      description: 'Details of one chat.',
      capability: 'read',
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
        },
        required: ['chatId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        return this.messaging.getChat(ctx.userId, accountId, String(chatId));
      },
    });

    this.register({
      name: 'chats_search',
      description: 'Find dialogs by title or username.',
      capability: 'read',
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          query: { type: 'string' },
          limit: { type: 'number', default: 15 },
        },
        required: ['query'],
      },
      handler: async (args, ctx) => {
        const query = text(args.query).toLowerCase();
        if (!query) throw new Error('query is required');
        const accounts = await this.accounts.list(ctx.userId);
        const wanted = text(args.accountId, ctx.accountId ?? '');
        const targets = wanted
          ? accounts.filter((account) => account.id === wanted)
          : accounts;
        const result: unknown[] = [];
        for (const account of targets) {
          const chats = await this.messaging.listChats(ctx.userId, account.id, {
            limit: 200,
          });
          result.push({
            accountId: account.id,
            chats: chats
              .filter(
                (chat) =>
                  chat.title.toLowerCase().includes(query) ||
                  (chat.username ?? '').toLowerCase().includes(query),
              )
              .slice(0, limit(args.limit, 15))
              .map((chat) => ({
                id: chat.id,
                type: chat.type,
                title: chat.title,
                username: chat.username,
              })),
          });
        }
        return result;
      },
    });

    this.register({
      name: 'messages_history',
      description: 'Recent messages in a chat, newest last.',
      capability: 'read',
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          limit: { type: 'number', default: 20 },
          offsetId: { type: 'number' },
        },
        required: ['chatId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const history = await this.messaging.listMessages(
          ctx.userId,
          accountId,
          String(chatId),
          {
            limit: limit(args.limit, 20),
            offsetId: number(args.offsetId) ?? undefined,
          },
        );
        return {
          chatId,
          messages: history.messages.map(trimMessage),
          nextOffsetId: history.nextOffsetId ?? null,
        };
      },
    });

    this.register({
      name: 'messages_search',
      description: 'Search messages inside one chat.',
      capability: 'read',
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          query: { type: 'string' },
          limit: { type: 'number', default: 20 },
        },
        required: ['chatId', 'query'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const query = text(args.query);
        const found = await this.messaging.searchMessages(
          ctx.userId,
          accountId,
          String(chatId),
          { q: query, limit: limit(args.limit, 20) },
        );
        return {
          chatId,
          query,
          messages: found.messages.map(trimMessage),
          nextOffsetId: found.nextOffsetId ?? null,
        };
      },
    });

    this.register({
      name: 'logs_search',
      description: 'Search structured application logs (errors, RPC, auth).',
      capability: 'read',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
          accountId: { type: 'string' },
          limit: { type: 'number', default: 30 },
        },
      },
      handler: async (args, ctx) => {
        const page = await this.logs.query({
          q: text(args.query) || undefined,
          level: text(args.level) || undefined,
          accountId: text(args.accountId, ctx.accountId ?? '') || undefined,
          limit: limit(args.limit, 30, 100),
        });
        return {
          entries: page.entries.map((entry) => ({
            at: entry.createdAt,
            level: entry.level,
            source: entry.source,
            action: entry.action,
            message: entry.message,
            status: entry.status,
            accountId: entry.accountId,
            telegramError: entry.telegramError,
          })),
          nextBefore: page.nextBefore,
        };
      },
    });

    this.register({
      name: 'souls_list',
      description: 'Souls (personas) of all accounts with autopilot mode.',
      capability: 'souls',
      parameters: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const list = await this.souls.list();
        return list
          .filter((soul) => !ctx.accountId || soul.accountId === ctx.accountId)
          .map((soul) => ({
          accountId: soul.accountId,
          name: soul.name,
          essence: soul.essence.slice(0, 300),
          tone: soul.tone,
          mode: soul.mode,
          language: soul.language,
          skills: soul.skills.map((skill) => skill.slug),
          settings: soul.settings,
        }));
      },
    });

    this.register({
      name: 'soul_get',
      description: 'Full soul of one account.',
      capability: 'souls',
      parameters: {
        type: 'object',
        properties: { accountId: { type: 'string' } },
        required: ['accountId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        return this.souls.get(accountId);
      },
    });

    this.register({
      name: 'soul_update',
      description:
        'Create or update the soul of an account. Always confirm the draft with the owner before calling.',
      capability: 'souls',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          name: { type: 'string' },
          essence: { type: 'string' },
          tone: { type: 'string' },
          goals: { type: 'string' },
          boundaries: { type: 'string' },
          language: { type: 'string' },
          systemPrompt: { type: 'string' },
          mode: { type: 'string', enum: ['off', 'draft', 'auto'] },
          temperature: { type: 'number' },
          skillSlugs: { type: 'array', items: { type: 'string' } },
          settings: { type: 'object' },
        },
        required: ['accountId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        return this.souls.update(accountId, args);
      },
    });

    this.register({
      name: 'memory_view',
      description:
        'Short-term turns and long-term summary/facts for an account (optionally one chat).',
      capability: 'souls',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          chatId: { type: 'number' },
        },
        required: ['accountId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        return this.memory.view(accountId, number(args.chatId));
      },
    });

    this.register({
      name: 'memory_add',
      description: 'Store one durable fact about a person or chat.',
      capability: 'souls',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          chatId: { type: 'number' },
          content: { type: 'string' },
          kind: { type: 'string', enum: ['fact', 'preference', 'event', 'profile'] },
          importance: { type: 'number', minimum: 1, maximum: 5 },
        },
        required: ['accountId', 'content'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        return this.memory.addFact(accountId, number(args.chatId), text(args.content), {
          kind: text(args.kind, 'fact'),
          importance: Number(args.importance) || 2,
          source: 'mcp',
        });
      },
    });

    this.register({
      name: 'memory_summarize',
      description: 'Compact short-term turns of one chat into the long-term summary.',
      capability: 'souls',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          chatId: { type: 'number' },
        },
        required: ['accountId', 'chatId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        return this.memory.summarize(accountId, chatId, { force: true });
      },
    });

    this.register({
      name: 'memory_clear',
      description: 'Delete all memory of one chat (turns, summary, facts).',
      capability: 'delete',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          chatId: { type: 'number' },
        },
        required: ['accountId', 'chatId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        await this.memory.clearChat(accountId, chatId);
        return { cleared: true, accountId, chatId };
      },
    });

    this.register({
      name: 'skills_list',
      description: 'Available skills (instruction packs).',
      capability: 'skills',
      parameters: { type: 'object', properties: {} },
      handler: async () => this.skills.list(),
    });

    this.register({
      name: 'skill_get',
      description: 'One skill by slug or id.',
      capability: 'skills',
      parameters: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
      handler: async (args) => this.skills.require(text(args.slug)),
    });

    this.register({
      name: 'skill_create',
      description:
        'Create a new skill. Instructions are a markdown prompt; tools is an optional allowlist.',
      capability: 'skills',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          instructions: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
        },
        required: ['slug', 'name', 'instructions'],
      },
      handler: async (args) => this.skills.create(args),
    });

    this.register({
      name: 'skill_update',
      description: 'Update a skill (name, description, instructions, tools, enabled).',
      capability: 'skills',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          instructions: { type: 'string' },
          tools: { type: 'array', items: { type: 'string' } },
          enabled: { type: 'boolean' },
        },
        required: ['slug'],
      },
      handler: async (args) => this.skills.update(text(args.slug), args),
    });

    this.register({
      name: 'skill_delete',
      description: 'Delete a user skill (system skills cannot be deleted).',
      capability: 'skills',
      parameters: {
        type: 'object',
        properties: { slug: { type: 'string' } },
        required: ['slug'],
      },
      handler: async (args) => this.skills.remove(text(args.slug)),
    });

    this.register({
      name: 'messages_send',
      description:
        'Send a text message as the account. Never message strangers without explicit permission.',
      capability: 'send',
      telegramWrite: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          text: { type: 'string' },
          replyToId: { type: 'number' },
        },
        required: ['chatId', 'text'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const replyToId = number(args.replyToId) ?? undefined;
        const caps = await this.policy.capabilities();
        if (!caps.sendUnknown) {
          try {
            await this.messaging.getChat(ctx.userId, accountId, String(chatId));
          } catch {
            throw new Error(
              'Этот чат неизвестен аккаунту. Отправка незнакомым людям запрещена разрешениями (sendUnknown).',
            );
          }
        }
        return this.messaging.sendMessage(ctx.userId, accountId, String(chatId), {
          text: text(args.text),
          replyToId,
        });
      },
    });

    this.register({
      name: 'messages_edit',
      description: 'Edit a message sent by this account.',
      capability: 'edit',
      telegramWrite: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          messageId: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['chatId', 'messageId', 'text'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const messageId = number(args.messageId);
        if (!messageId) throw new Error('messageId is required');
        return this.messaging.editMessage(
          ctx.userId,
          accountId,
          String(chatId),
          String(messageId),
          { text: text(args.text) },
        );
      },
    });

    this.register({
      name: 'messages_delete',
      description: 'Delete a message for everyone. Off by default.',
      capability: 'delete',
      telegramWrite: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          messageId: { type: 'number' },
        },
        required: ['chatId', 'messageId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const messageId = number(args.messageId);
        if (!messageId) throw new Error('messageId is required');
        return this.messaging.deleteMessage(
          ctx.userId,
          accountId,
          String(chatId),
          String(messageId),
          {},
        );
      },
    });

    this.register({
      name: 'messages_react',
      description: 'Set or remove a reaction on a message (null removes).',
      capability: 'react',
      telegramWrite: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          messageId: { type: 'number' },
          emoji: { type: ['string', 'null'] },
        },
        required: ['chatId', 'messageId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const messageId = number(args.messageId);
        if (!messageId) throw new Error('messageId is required');
        const emoji =
          typeof args.emoji === 'string' && args.emoji.trim()
            ? args.emoji.trim()
            : null;
        return this.messaging.sendReaction(
          ctx.userId,
          accountId,
          String(chatId),
          String(messageId),
          { emoji },
        );
      },
    });

    this.register({
      name: 'messages_read',
      description: 'Mark a chat as read.',
      capability: 'read',
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          maxId: { type: 'number' },
        },
        required: ['chatId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        return this.messaging.markRead(
          ctx.userId,
          accountId,
          String(chatId),
          { maxId: number(args.maxId) ?? undefined },
        );
      },
    });

    this.register({
      name: 'policy_update',
      description:
        'Change AI/MCP permissions. Only possible when the "policy" capability is already enabled. Always show the diff and get confirmation first.',
      capability: 'policy',
      parameters: {
        type: 'object',
        properties: {
          capabilities: { type: 'object' },
          allowAccountIds: { type: 'array', items: { type: 'string' } },
          allowChatIds: { type: 'array', items: { type: 'number' } },
          blockChatIds: { type: 'array', items: { type: 'number' } },
          ownerTgUserIds: { type: 'array', items: { type: 'string' } },
          dryRun: { type: 'boolean' },
        },
      },
      handler: async (args) => this.config.updatePolicy(args),
    });

    this.register({
      name: 'automations_list',
      description: 'Automations of the app (schedule or incoming-message triggers).',
      capability: 'automations',
      parameters: {
        type: 'object',
        properties: { accountId: { type: 'string' } },
      },
      handler: async (args, ctx) =>
        this.automations.list(
          text(args.accountId, ctx.accountId ?? '') || null,
        ),
    });

    this.register({
      name: 'automation_create',
      description:
        'Create an automation. Trigger: {"kind":"every","minutes":N} | {"kind":"daily","at":"HH:MM"} | {"kind":"incoming_message","keywords":[],"chatIds":[]}. Action: {"type":"agent","prompt":"..."} | {"type":"send_message","chatId":N,"text":"..."} | {"type":"summarize","chatId":N}. Pass chatId (+ threadId) to bind it to one chat; createdBy defaults to "soul" for a chat-bound automation.',
      capability: 'automations',
      write: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          trigger: { type: 'object' },
          action: { type: 'object' },
          enabled: { type: 'boolean', default: false },
          chatId: {
            type: 'number',
            description: 'Telegram chat id; requires accountId.',
          },
          threadId: {
            type: 'number',
            description:
              'Forum topic / comment thread the automation is bound to; 0 = whole chat.',
          },
          timezone: {
            type: 'string',
            description:
              'IANA zone for "daily" triggers, e.g. Europe/Moscow; server-local when omitted.',
          },
          createdBy: {
            type: 'string',
            enum: ['user', 'soul', 'assistant'],
            description: 'Defaults to "soul" when the automation is chat-bound.',
          },
        },
        required: ['name', 'trigger', 'action'],
      },
      handler: async (args, ctx) => {
        const accountId = text(args.accountId, ctx.accountId ?? '') || undefined;
        // Chat context: the call itself names a chat, or the surface is one.
        const explicitChat =
          args.chatId !== undefined && args.chatId !== null && args.chatId !== '';
        const chatId = explicitChat ? number(args.chatId) : (ctx.chatId ?? null);
        if (explicitChat && chatId === null) {
          throw new Error('chatId must be a numeric Telegram id');
        }
        // An unbound (global) automation stays a user automation; anything
        // tied to a chat and created from here is the soul's own follow-up.
        const createdBy =
          text(args.createdBy) || (chatId !== null ? 'soul' : undefined);
        return this.automations.create({
          accountId,
          name: args.name,
          description: args.description,
          trigger: args.trigger,
          action: args.action,
          enabled: args.enabled,
          ...(chatId !== null ? { chatId } : {}),
          ...(args.threadId !== undefined
            ? { threadId: threadIdOf(args.threadId) }
            : {}),
          ...(text(args.timezone) ? { timezone: text(args.timezone) } : {}),
          ...(createdBy ? { createdBy } : {}),
        });
      },
    });

    this.register({
      name: 'automation_update',
      description: 'Update an automation by id (partial).',
      capability: 'automations',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          trigger: { type: 'object' },
          action: { type: 'object' },
          enabled: { type: 'boolean' },
        },
        required: ['id'],
      },
      handler: async (args) =>
        this.automations.update(text(args.id), args),
    });

    this.register({
      name: 'automation_delete',
      description: 'Delete an automation by id.',
      capability: 'automations',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) =>
        this.automations.remove(text(args.id)),
    });

    this.register({
      name: 'automation_run',
      description: 'Queue an automation for the next scheduler tick.',
      capability: 'automations',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
      handler: async (args) => this.automations.requestRun(text(args.id)),
    });

    const threadProperty = {
      type: 'number',
      description:
        'Forum topic / comment thread id; omit or 0 for the whole chat.',
    };

    this.register({
      name: 'automation_pause_chat',
      description:
        'Pause every automation bound to this chat/topic: the soul cancels its own follow-ups there after disrespectful treatment. The reason is stored and shown in the chat card. Resume with automation_resume_chat.',
      capability: 'automations',
      write: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          threadId: threadProperty,
          reason: {
            type: 'string',
            description: 'Why the follow-ups stop, in one sentence for the owner.',
          },
        },
        required: ['chatId', 'reason'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const reason = text(args.reason);
        if (reason.length < 3) {
          throw new Error(
            'reason is required (at least 3 characters): say why the chat is paused',
          );
        }
        const rows = await this.automations.pauseForChat({
          accountId,
          chatId,
          threadId: threadIdOf(args.threadId),
          reason,
        });
        return this.chatAutomations(accountId, chatId, args.threadId, rows);
      },
    });

    this.register({
      name: 'automation_resume_chat',
      description:
        'Resume the automations of this chat/topic that were paused (by the soul or by the owner).',
      capability: 'automations',
      write: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          threadId: threadProperty,
        },
        required: ['chatId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const rows = await this.automations.resume({
          accountId,
          chatId,
          threadId: threadIdOf(args.threadId),
        });
        return this.chatAutomations(accountId, chatId, args.threadId, rows);
      },
    });

    this.register({
      name: 'ai_access_get',
      description:
        'AI access of one chat/topic: whether the soul may act (allowed), whether it is blocked, the warning counter, the block reason and the soul assigned to this chat.',
      capability: 'read',
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          threadId: threadProperty,
        },
        required: ['chatId'],
      },
      handler: async (args, ctx) =>
        this.access.view(
          ctx.userId,
          this.requireAccount(args, ctx),
          this.requireChat(args, ctx),
          threadIdOf(args.threadId),
        ),
    });

    this.register({
      name: 'ai_access_set',
      description:
        'Decide whether the soul may work in one chat/topic and which soul serves it. enabled=false mutes the soul there (destructive: needs the "admin" capability); soulId=null clears the assignment; note is a short line for the chat card.',
      capability: 'souls',
      write: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          threadId: threadProperty,
          enabled: {
            type: 'boolean',
            description: 'false mutes the soul in this chat/topic.',
          },
          soulId: {
            type: ['string', 'null'],
            description: 'Soul that serves this chat; null clears it.',
          },
          note: {
            type: ['string', 'null'],
            description: 'Short note shown in the chat card.',
          },
        },
        required: ['chatId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const enabled = optionalBoolean(args.enabled, 'enabled');
        if (enabled === false) {
          await this.requireDestructive('admin', args, ctx);
        }
        return this.access.setAccess({
          userId: ctx.userId,
          accountId,
          chatId,
          threadId: threadIdOf(args.threadId),
          enabled,
          soulId: nullableText(args.soulId),
          note: nullableText(args.note),
        });
      },
    });

    this.register({
      name: 'chat_warn',
      description:
        'Warn this chat and add one warning. The app blocks the chat automatically when the warnings reach the threshold, so use chat_warn once per incident: tell the person in your own words why you are warning them, and only warn again if they repeat it — never warn twice for the same message. The result reports the counter and whether this warning closed the chat (blocked).',
      capability: 'admin',
      write: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          threadId: threadProperty,
          reason: {
            type: 'string',
            description: 'What the person did, in one sentence.',
          },
        },
        required: ['chatId'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        return this.access.bumpWarning({
          userId: ctx.userId,
          accountId,
          chatId,
          threadId: threadIdOf(args.threadId),
          reason: text(args.reason) || null,
          blockedBy: 'soul',
        });
      },
    });

    this.register({
      name: 'chat_block',
      description:
        'Block the soul in this chat/topic immediately. A reason (at least 3 characters) is required and is shown to the owner; prefer chat_warn unless the behaviour is clearly abusive. Undo with chat_unblock.',
      capability: 'admin',
      write: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          threadId: threadProperty,
          reason: {
            type: 'string',
            description: 'What the person did, in one sentence.',
          },
        },
        required: ['chatId', 'reason'],
      },
      handler: async (args, ctx) => {
        const accountId = this.requireAccount(args, ctx);
        const chatId = this.requireChat(args, ctx);
        const reason = text(args.reason);
        if (reason.length < 3) {
          throw new Error(
            'reason is required (at least 3 characters): say what the person did',
          );
        }
        return this.access.block({
          userId: ctx.userId,
          accountId,
          chatId,
          threadId: threadIdOf(args.threadId),
          reason,
          blockedBy: 'soul',
        });
      },
    });

    this.register({
      name: 'chat_unblock',
      description:
        'Lift the block of this chat/topic and reset its warning counter.',
      capability: 'admin',
      write: true,
      parameters: {
        type: 'object',
        properties: {
          accountId: accountProperty,
          chatId: { type: 'number' },
          threadId: threadProperty,
        },
        required: ['chatId'],
      },
      handler: async (args, ctx) =>
        this.access.unblock(
          ctx.userId,
          this.requireAccount(args, ctx),
          this.requireChat(args, ctx),
          threadIdOf(args.threadId),
        ),
    });

    this.register({
      name: 'bots_list',
      description:
        'Telegram bots configured in the app (shared soul-creator and per-account assistants). Tokens are never returned.',
      capability: 'bots',
      parameters: { type: 'object', properties: {} },
      handler: async (_args, ctx) => {
        const list = await this.bots.list();
        return list.filter(
          (bot) => !ctx.accountId || bot.accountId === ctx.accountId,
        );
      },
    });

    this.register({
      name: 'bot_set_token',
      description:
        'Save a BotFather token for the shared soul-creator bot (accountId omitted) or for one account. Never echo the token back.',
      capability: 'bots',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          token: { type: 'string' },
          username: { type: 'string' },
          title: { type: 'string' },
        },
        required: ['token'],
      },
      handler: async (args, ctx) => {
        const token = text(args.token);
        if (token) {
          const me = await this.bots.identify(token);
          if (!text(args.username)) args.username = me.username ?? undefined;
          if (!text(args.title)) args.title = me.firstName;
        }
        const accountId = text(args.accountId, ctx.accountId ?? '');
        if (accountId) {
          return this.bots.createForAccount(accountId, args);
        }
        return this.bots.upsertShared(args);
      },
    });

    this.register({
      name: 'bot_update',
      description:
        'Update a bot: enabled, username, title, allowed Telegram user ids, skill slugs.',
      capability: 'bots',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          enabled: { type: 'boolean' },
          username: { type: 'string' },
          title: { type: 'string' },
          allowedUserIds: { type: 'array', items: { type: 'string' } },
          skillSlugs: { type: 'array', items: { type: 'string' } },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const bot = await this.bots.update(text(args.id), args);
        if (args.skillSlugs !== undefined) {
          await this.bots.setSkills(bot.id, args.skillSlugs);
        }
        return this.bots.get(bot.id);
      },
    });

    this.register({
      name: 'settings_update',
      description:
        'Change the LLM provider/model and agent tuning. API key is write-only.',
      capability: 'policy',
      parameters: {
        type: 'object',
        properties: {
          baseUrl: { type: 'string' },
          model: { type: 'string' },
          fastModel: { type: 'string' },
          apiKey: { type: 'string' },
          temperature: { type: 'number' },
          maxSteps: { type: 'number' },
          dryRun: { type: 'boolean' },
        },
      },
      handler: async (args) => this.config.update(args),
    });
  }
}
