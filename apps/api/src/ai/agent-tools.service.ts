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
import { AutomationsService } from '../automations/automations.service.js';
import { BotsService } from '../bots/bots.service.js';
import type {
  AgentTool,
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
        return list.map((account) => ({
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
      handler: async (args) => {
        const page = await this.logs.query({
          q: text(args.query) || undefined,
          level: text(args.level) || undefined,
          accountId: text(args.accountId) || undefined,
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
      handler: async () => {
        const list = await this.souls.list();
        return list.map((soul) => ({
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
        'Create an automation. Trigger: {"kind":"every","minutes":N} | {"kind":"daily","at":"HH:MM"} | {"kind":"incoming_message","keywords":[],"chatIds":[]}. Action: {"type":"agent","prompt":"..."} | {"type":"send_message","chatId":N,"text":"..."} | {"type":"summarize","chatId":N}.',
      capability: 'automations',
      parameters: {
        type: 'object',
        properties: {
          accountId: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          trigger: { type: 'object' },
          action: { type: 'object' },
          enabled: { type: 'boolean', default: false },
        },
        required: ['name', 'trigger', 'action'],
      },
      handler: async (args, ctx) =>
        this.automations.create({
          ...args,
          accountId: text(args.accountId, ctx.accountId ?? '') || undefined,
        }),
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

    this.register({
      name: 'bots_list',
      description:
        'Telegram bots configured in the app (shared soul-creator and per-account assistants). Tokens are never returned.',
      capability: 'bots',
      parameters: { type: 'object', properties: {} },
      handler: async () => this.bots.list(),
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
