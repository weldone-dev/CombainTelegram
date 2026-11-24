import { Injectable } from '@nestjs/common';
import type {
  AutomationModel,
  AutomationRunModel,
  SoulModel,
} from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { apiError, notFound } from '../common/api-error.js';
import {
  isValidTimeZone,
  nextDailyInZone,
  parseClock,
} from './schedule.js';

export interface AutomationView {
  id: string;
  accountId: string | null;
  /** Chat the automation is bound to; null = any chat / not chat-bound. */
  chatId: number | null;
  /** Forum topic or channel-comment thread; 0 = whole chat. */
  threadId: number;
  /** Soul that owns the automation, when it was created by a soul. */
  soulId: string | null;
  /** user | soul | assistant */
  createdBy: string;
  /** IANA zone the schedule wall clock follows; null = server-local. */
  timezone: string | null;
  name: string;
  description: string;
  enabled: boolean;
  triggerType: string;
  trigger: Record<string, unknown>;
  actionType: string;
  action: Record<string, unknown>;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** Zone-aware alias of `nextRunAt` as an ISO instant. */
  nextDueAt: string | null;
  /** True when the soul paused the automation itself. */
  selfPaused: boolean;
  selfPausedAt: string | null;
  selfPauseReason: string | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationRunView {
  id: string;
  automationId: string;
  status: string;
  input: Record<string, unknown>;
  output: string | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** One automation in a chat card, plus the status of its latest run. */
export interface ChatAutomationView extends AutomationView {
  lastRunStatus: string | null;
  lastRunError: string | null;
}

export interface ChatAutomationsView {
  accountId: string;
  chatId: number;
  /** null = every thread of the chat. */
  threadId: number | null;
  automations: ChatAutomationView[];
  summary: {
    total: number;
    active: number;
    paused: number;
    nextDueAt: string | null;
    lastRunAt: string | null;
  };
}

/** A chat scope: one account and one Telegram chat. */
export interface ChatBinding {
  accountId: string;
  chatId: number;
  /** Omit or null for the whole chat; 0 is the whole-chat sentinel too. */
  threadId?: number | null;
  /** Restrict to automations owned by one soul. */
  soulId?: string | null;
}

export interface PauseChatInput extends ChatBinding {
  reason?: string | null;
}

export interface AutomationInput {
  accountId?: unknown;
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
  trigger?: unknown;
  action?: unknown;
  chatId?: unknown;
  threadId?: unknown;
  soulId?: unknown;
  timezone?: unknown;
  createdBy?: unknown;
}

export const CREATED_BY = ['user', 'soul', 'assistant'] as const;

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Parses a Telegram chat id. Returns null for "not set"; callers decide
 * whether an invalid value is an error or simply absent.
 */
export function parseChatId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

/** Parses a forum-topic / comment thread id; 0 is a valid whole-chat value. */
export function parseThreadId(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function chatWhere(binding: ChatBinding): Record<string, unknown> {
  const where: Record<string, unknown> = {
    accountId: binding.accountId,
    chatId: BigInt(binding.chatId),
  };
  if (binding.threadId !== undefined && binding.threadId !== null) {
    where.threadId = binding.threadId;
  }
  if (binding.soulId) where.soulId = binding.soulId;
  return where;
}

function scheduleNext(
  trigger: Record<string, unknown>,
  from: Date,
  timezone: string | null,
): Date | null {
  const kind = text(trigger.kind, 'every');
  if (kind === 'every') {
    const minutes = Number(trigger.minutes);
    if (!Number.isFinite(minutes) || minutes < 1) return null;
    return new Date(from.getTime() + Math.min(10080, minutes) * 60_000);
  }
  if (kind === 'daily') {
    const at = text(trigger.at, '09:00');
    if (timezone) return nextDailyInZone(at, from, timezone);
    const clock = parseClock(at);
    if (!clock) return null;
    const next = new Date(from);
    next.setHours(clock.hour, clock.minute, 0, 0);
    if (next.getTime() <= from.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }
  return null;
}

export function nextRunFor(
  trigger: Record<string, unknown>,
  from = new Date(),
  timezone: string | null = null,
): Date | null {
  const kind = text(trigger.kind, 'every');
  if (kind === 'every' || kind === 'daily') {
    return scheduleNext(trigger, from, timezone);
  }
  return null;
}

export function triggerTypeFor(trigger: Record<string, unknown>): string {
  return text(trigger.kind) === 'incoming_message'
    ? 'incoming_message'
    : text(trigger.kind) === 'manual'
      ? 'manual'
      : 'schedule';
}

function runView(row: AutomationRunModel): AutomationRunView {
  return {
    id: row.id,
    automationId: row.automationId,
    status: row.status,
    input: record(row.input),
    output: row.output,
    error: row.error,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

function toView(row: AutomationModel): AutomationView {
  const nextRunAt = row.nextRunAt?.toISOString() ?? null;
  return {
    id: row.id,
    accountId: row.accountId,
    chatId: row.chatId === null ? null : Number(row.chatId),
    threadId: row.threadId,
    soulId: row.soulId,
    createdBy: row.createdBy,
    timezone: row.timezone,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    triggerType: row.triggerType,
    trigger: record(row.trigger),
    actionType: row.actionType,
    action: record(row.action),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt,
    nextDueAt: nextRunAt,
    selfPaused: row.selfPausedAt !== null,
    selfPausedAt: row.selfPausedAt?.toISOString() ?? null,
    selfPauseReason: row.selfPauseReason,
    runCount: row.runCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class AutomationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    accountId?: string | null,
    filter: {
      chatId?: number | null;
      threadId?: number | null;
      soulId?: string | null;
    } = {},
  ): Promise<AutomationView[]> {
    const where: Record<string, unknown> = {};
    if (accountId) where.accountId = accountId;
    if (filter.chatId !== undefined && filter.chatId !== null) {
      where.chatId = BigInt(filter.chatId);
    }
    if (filter.threadId !== undefined && filter.threadId !== null) {
      where.threadId = filter.threadId;
    }
    if (filter.soulId) where.soulId = filter.soulId;
    const rows = (await this.prisma.automation.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    })) as AutomationModel[];
    return rows.map(toView);
  }

  async get(id: string): Promise<AutomationView> {
    return toView(await this.row(id));
  }

  async create(input: AutomationInput): Promise<AutomationView> {
    const name = text(input.name);
    if (!name) throw apiError('INVALID_NAME', 'name is required', 400);
    const { accountId, soulId } = await this.resolveScope(
      optionalText(input.accountId),
      optionalText(input.soulId),
    );
    const timezone = optionalText(input.timezone);
    if (timezone !== null && !isValidTimeZone(timezone)) {
      throw apiError(
        'INVALID_TIMEZONE',
        `Unknown IANA timezone "${timezone}"`,
        400,
      );
    }
    const chatId = this.resolveChatId(input.chatId, accountId);
    const threadId = this.resolveThreadId(input.threadId) ?? 0;
    const createdBy = this.resolveCreatedBy(input.createdBy, 'user');
    const trigger = record(input.trigger);
    const action = record(input.action);
    const actionType = text(action.type, 'agent');
    if (!['agent', 'send_message', 'summarize'].includes(actionType)) {
      throw apiError('INVALID_ACTION', 'Unknown action type', 400);
    }
    const enabled = input.enabled === true || input.enabled === 'true';
    const next = enabled ? nextRunFor(trigger, new Date(), timezone) : null;
    const row = (await this.prisma.automation.create({
      data: {
        accountId,
        chatId: chatId === null ? null : BigInt(chatId),
        threadId,
        soulId,
        createdBy,
        timezone,
        name,
        description: text(input.description),
        enabled,
        triggerType: triggerTypeFor(trigger),
        trigger: JSON.stringify(trigger),
        actionType,
        action: JSON.stringify(action),
        nextRunAt: next,
      },
    })) as AutomationModel;
    return toView(row);
  }

  async update(id: string, input: AutomationInput): Promise<AutomationView> {
    const current = await this.row(id);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = text(input.name);
      if (!name) throw apiError('INVALID_NAME', 'name is required', 400);
      data.name = name;
    }
    if (input.description !== undefined) {
      data.description = text(input.description);
    }
    let trigger = record(current.trigger);
    if (input.trigger !== undefined) {
      trigger = record(input.trigger);
      data.trigger = JSON.stringify(trigger);
      data.triggerType = triggerTypeFor(trigger);
    }
    if (input.action !== undefined) {
      const action = record(input.action);
      const actionType = text(action.type, current.actionType);
      if (!['agent', 'send_message', 'summarize'].includes(actionType)) {
        throw apiError('INVALID_ACTION', 'Unknown action type', 400);
      }
      data.action = JSON.stringify(action);
      data.actionType = actionType;
    }

    let timezone = current.timezone;
    if (input.timezone !== undefined) {
      timezone = optionalText(input.timezone);
      if (timezone !== null && !isValidTimeZone(timezone)) {
        throw apiError(
          'INVALID_TIMEZONE',
          `Unknown IANA timezone "${timezone}"`,
          400,
        );
      }
      data.timezone = timezone;
    }

    const nextAccountId =
      input.accountId !== undefined
        ? optionalText(input.accountId)
        : current.accountId;
    const nextSoulId =
      input.soulId !== undefined ? optionalText(input.soulId) : current.soulId;
    const { accountId, soulId } = await this.resolveScope(
      nextAccountId,
      nextSoulId,
    );
    if (input.accountId !== undefined) data.accountId = accountId;
    if (input.soulId !== undefined) data.soulId = soulId;

    const currentChatId = current.chatId === null ? null : Number(current.chatId);
    const chatId =
      input.chatId !== undefined
        ? this.resolveChatId(input.chatId, accountId)
        : currentChatId;
    if (input.chatId !== undefined) {
      data.chatId = chatId === null ? null : BigInt(chatId);
    } else if (chatId !== null && !accountId) {
      throw apiError('INVALID_CHAT', 'chatId requires accountId', 400);
    }
    if (input.threadId !== undefined) {
      data.threadId = this.resolveThreadId(input.threadId) ?? 0;
    }
    if (input.createdBy !== undefined) {
      data.createdBy = this.resolveCreatedBy(input.createdBy, current.createdBy);
    }

    let enabled = current.enabled;
    let reEnabled = false;
    if (input.enabled !== undefined) {
      enabled = input.enabled === true || input.enabled === 'true';
      data.enabled = enabled;
      if (enabled) {
        // A manual re-enable is a user override of the soul's self-pause.
        data.selfPausedAt = null;
        data.selfPauseReason = null;
        reEnabled = true;
      }
    }
    const selfPaused = reEnabled ? false : current.selfPausedAt !== null;
    data.nextRunAt =
      enabled && !selfPaused && triggerTypeFor(trigger) === 'schedule'
        ? nextRunFor(trigger, new Date(), timezone)
        : null;
    const row = (await this.prisma.automation.update({
      where: { id },
      data,
    })) as AutomationModel;
    return toView(row);
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    await this.prisma.automation.deleteMany({ where: { id } });
    return { removed: true };
  }

  /** Marks a due schedule for the next tick (used by the UI "Run" button). */
  async requestRun(id: string): Promise<AutomationView> {
    const row = await this.row(id);
    if (row.selfPausedAt !== null) {
      throw apiError(
        'AUTOMATION_PAUSED',
        row.selfPauseReason ?? 'Automation is paused by its soul',
        409,
      );
    }
    const updated = (await this.prisma.automation.update({
      where: { id },
      data: { nextRunAt: new Date() },
    })) as AutomationModel;
    return toView(updated);
  }

  /** Every automation of one chat, with last-run status and due time. */
  async chat(
    accountId: string,
    chatId: number,
    options: { threadId?: number | null; soulId?: string | null } = {},
  ): Promise<ChatAutomationsView> {
    const binding = this.requireBinding({
      accountId,
      chatId,
      threadId: options.threadId,
      soulId: options.soulId,
    });
    const where = chatWhere(binding);
    const rows = (await this.prisma.automation.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    })) as AutomationModel[];
    const views = rows.map(toView);
    const statuses = await this.lastRunStatuses(rows.map((row) => row.id));
    const automations: ChatAutomationView[] = views.map((view) => {
      const status = statuses.get(view.id);
      return {
        ...view,
        lastRunStatus: status?.status ?? null,
        lastRunError: status?.error ?? null,
      };
    });
    const active = automations.filter(
      (item) => item.enabled && !item.selfPaused,
    ).length;
    const dueTimes = automations
      .map((item) => item.nextDueAt)
      .filter((value): value is string => value !== null)
      .sort();
    const runTimes = automations
      .map((item) => item.lastRunAt)
      .filter((value): value is string => value !== null)
      .sort();
    return {
      accountId: binding.accountId,
      chatId: binding.chatId,
      threadId:
        binding.threadId === undefined ? null : binding.threadId,
      automations,
      summary: {
        total: automations.length,
        active,
        paused: automations.length - active,
        nextDueAt: dueTimes[0] ?? null,
        lastRunAt: runTimes.at(-1) ?? null,
      },
    };
  }

  /**
   * Lets a soul pause the automations of one chat. Only rows matching the
   * account/chat (and thread/soul, when given) are touched; `reason` is stored
   * for the chat card.
   */
  async pauseForChat(input: PauseChatInput): Promise<AutomationView[]> {
    const binding = this.requireBinding(input);
    const where = chatWhere(binding);
    const rows = (await this.prisma.automation.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    })) as AutomationModel[];
    if (rows.length === 0) return [];
    await this.prisma.automation.updateMany({
      where: { id: { in: rows.map((row) => row.id) } },
      data: {
        selfPausedAt: new Date(),
        selfPauseReason: optionalText(input.reason),
        nextRunAt: null,
      },
    });
    return this.list(binding.accountId, {
      chatId: binding.chatId,
      threadId: binding.threadId,
      soulId: binding.soulId,
    });
  }

  /**
   * Clears a soul self-pause. Pass an automation id to resume one row, or a
   * chat binding to resume every automation of that chat.
   */
  async resume(target: string | ChatBinding): Promise<AutomationView[]> {
    if (typeof target === 'string') {
      const current = await this.row(target);
      await this.resumeRows([current]);
      return [toView(await this.row(target))];
    }
    const binding = this.requireBinding(target);
    const rows = (await this.prisma.automation.findMany({
      where: chatWhere(binding),
      orderBy: { createdAt: 'asc' },
    })) as AutomationModel[];
    if (rows.length === 0) return [];
    await this.resumeRows(rows);
    return this.list(binding.accountId, {
      chatId: binding.chatId,
      threadId: binding.threadId,
      soulId: binding.soulId,
    });
  }

  async due(): Promise<AutomationModel[]> {
    return (await this.prisma.automation.findMany({
      where: {
        enabled: true,
        selfPausedAt: null,
        nextRunAt: { lte: new Date() },
      },
      orderBy: { nextRunAt: 'asc' },
      take: 20,
    })) as AutomationModel[];
  }

  async complete(
    id: string,
    trigger: Record<string, unknown>,
    timezone: string | null = null,
  ): Promise<void> {
    const next = nextRunFor(trigger, new Date(), timezone);
    await this.prisma.automation.update({
      where: { id },
      data: {
        lastRunAt: new Date(),
        nextRunAt: next,
        runCount: { increment: 1 },
      },
    });
  }

  async runs(automationId: string, limit = 30): Promise<AutomationRunView[]> {
    const rows = (await this.prisma.automationRun.findMany({
      where: { automationId },
      orderBy: { startedAt: 'desc' },
      take: Math.min(100, Math.max(1, limit)),
    })) as AutomationRunModel[];
    return rows.map(runView);
  }

  async startRun(automationId: string, input: Record<string, unknown>): Promise<AutomationRunModel> {
    return (await this.prisma.automationRun.create({
      data: {
        automationId,
        status: 'running',
        input: JSON.stringify(input),
      },
    })) as AutomationRunModel;
  }

  async finishRun(
    id: string,
    update: { status: string; output?: string; error?: string },
  ): Promise<void> {
    await this.prisma.automationRun.update({
      where: { id },
      data: {
        status: update.status,
        output: update.output?.slice(0, 8000) ?? null,
        error: update.error?.slice(0, 2000) ?? null,
        finishedAt: new Date(),
      },
    });
  }

  async matchingIncoming(
    accountId: string,
    chatId: number,
    textValue: string,
    threadId: number | null = null,
  ): Promise<AutomationView[]> {
    const rows = (await this.prisma.automation.findMany({
      where: {
        enabled: true,
        selfPausedAt: null,
        triggerType: 'incoming_message',
        OR: [{ accountId }, { accountId: null }],
      },
    })) as AutomationModel[];
    const lower = textValue.toLowerCase();
    return rows
      .map(toView)
      .filter((automation) => {
        if (automation.chatId !== null && automation.chatId !== chatId) {
          return false;
        }
        if (
          automation.chatId !== null &&
          threadId !== null &&
          automation.threadId !== 0 &&
          automation.threadId !== threadId
        ) {
          return false;
        }
        const trigger = automation.trigger;
        const chatIds = Array.isArray(trigger.chatIds)
          ? trigger.chatIds.map(Number)
          : [];
        if (chatIds.length > 0 && !chatIds.includes(chatId)) return false;
        const keywords = Array.isArray(trigger.keywords)
          ? trigger.keywords.filter(
              (item): item is string => typeof item === 'string',
            )
          : [];
        if (keywords.length === 0) return true;
        return keywords.some((keyword) =>
          lower.includes(keyword.toLowerCase()),
        );
      });
  }

  private async row(id: string): Promise<AutomationModel> {
    const row = (await this.prisma.automation.findUnique({
      where: { id },
    })) as AutomationModel | null;
    if (!row) throw notFound('AUTOMATION_NOT_FOUND', 'Automation not found');
    return row;
  }

  private requireBinding(binding: ChatBinding): ChatBinding {
    const accountId = text(binding.accountId);
    if (!accountId) {
      throw apiError('INVALID_ACCOUNT', 'accountId is required', 400);
    }
    const chatId = parseChatId(binding.chatId);
    if (chatId === null) throw apiError('INVALID_CHAT', 'chatId is required', 400);
    const threadId =
      binding.threadId === undefined || binding.threadId === null
        ? undefined
        : this.resolveThreadId(binding.threadId);
    return {
      accountId,
      chatId,
      threadId: threadId ?? undefined,
      soulId: optionalText(binding.soulId),
    };
  }

  private resolveChatId(value: unknown, accountId: string | null): number | null {
    if (value === undefined || value === null || value === '') return null;
    const chatId = parseChatId(value);
    if (chatId === null) {
      throw apiError('INVALID_CHAT', 'chatId must be a numeric Telegram id', 400);
    }
    if (!accountId) {
      throw apiError('INVALID_CHAT', 'chatId requires accountId', 400);
    }
    return chatId;
  }

  private resolveThreadId(value: unknown): number | null {
    if (value === undefined || value === null || value === '') return null;
    const threadId = parseThreadId(value);
    if (threadId === null) {
      throw apiError(
        'INVALID_THREAD',
        'threadId must be a non-negative integer',
        400,
      );
    }
    return threadId;
  }

  private resolveCreatedBy(value: unknown, fallback: string): string {
    if (value === undefined) return fallback;
    const createdBy = text(value);
    if (!(CREATED_BY as readonly string[]).includes(createdBy)) {
      throw apiError(
        'INVALID_CREATED_BY',
        `createdBy must be one of ${CREATED_BY.join(', ')}`,
        400,
      );
    }
    return createdBy;
  }

  /**
   * Validates an account and a soul: both must exist and a soul may only be
   * paired with the account it belongs to. A soul alone does not imply an
   * account — callers that bind a chat pass `accountId` explicitly.
   */
  private async resolveScope(
    accountId: string | null,
    soulId: string | null,
  ): Promise<{ accountId: string | null; soulId: string | null }> {
    if (accountId) {
      const account = await this.prisma.telegramAccount.findUnique({
        where: { id: accountId },
      });
      if (!account) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
    }
    if (soulId) {
      const soul = (await this.prisma.soul.findUnique({
        where: { id: soulId },
      })) as SoulModel | null;
      if (!soul) throw notFound('SOUL_NOT_FOUND', 'Soul not found');
      if (accountId && soul.accountId !== accountId) {
        throw apiError(
          'SOUL_ACCOUNT_MISMATCH',
          'Soul belongs to another account',
          400,
        );
      }
    }
    return { accountId, soulId };
  }

  private async resumeRows(rows: AutomationModel[]): Promise<void> {
    const now = new Date();
    for (const row of rows) {
      const trigger = record(row.trigger);
      const nextRunAt =
        row.enabled && triggerTypeFor(trigger) === 'schedule'
          ? nextRunFor(trigger, now, row.timezone)
          : null;
      await this.prisma.automation.update({
        where: { id: row.id },
        data: { selfPausedAt: null, selfPauseReason: null, nextRunAt },
      });
    }
  }

  private async lastRunStatuses(
    ids: string[],
  ): Promise<Map<string, { status: string; error: string | null }>> {
    const map = new Map<string, { status: string; error: string | null }>();
    if (ids.length === 0) return map;
    const runs = (await this.prisma.automationRun.findMany({
      where: { automationId: { in: ids } },
      orderBy: { startedAt: 'desc' },
      take: 200,
    })) as AutomationRunModel[];
    for (const run of runs) {
      if (!map.has(run.automationId)) {
        map.set(run.automationId, { status: run.status, error: run.error });
      }
    }
    return map;
  }
}
