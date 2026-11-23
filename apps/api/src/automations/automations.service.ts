import { Injectable } from '@nestjs/common';
import type { AutomationModel, AutomationRunModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { apiError, notFound } from '../common/api-error.js';

export interface AutomationView {
  id: string;
  accountId: string | null;
  name: string;
  description: string;
  enabled: boolean;
  triggerType: string;
  trigger: Record<string, unknown>;
  actionType: string;
  action: Record<string, unknown>;
  lastRunAt: string | null;
  nextRunAt: string | null;
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

export interface AutomationInput {
  accountId?: unknown;
  name?: unknown;
  description?: unknown;
  enabled?: unknown;
  trigger?: unknown;
  action?: unknown;
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
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

function scheduleNext(trigger: Record<string, unknown>, from: Date): Date | null {
  const kind = text(trigger.kind, 'every');
  if (kind === 'every') {
    const minutes = Number(trigger.minutes);
    if (!Number.isFinite(minutes) || minutes < 1) return null;
    return new Date(from.getTime() + Math.min(10080, minutes) * 60_000);
  }
  if (kind === 'daily') {
    const at = text(trigger.at, '09:00');
    const match = /^(\d{1,2}):(\d{2})$/.exec(at);
    if (!match) return null;
    const hour = Math.min(23, Number(match[1]));
    const minute = Math.min(59, Number(match[2]));
    const next = new Date(from);
    next.setHours(hour, minute, 0, 0);
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
): Date | null {
  const kind = text(trigger.kind, 'every');
  if (kind === 'every' || kind === 'daily') return scheduleNext(trigger, from);
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
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    triggerType: row.triggerType,
    trigger: record(row.trigger),
    actionType: row.actionType,
    action: record(row.action),
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    runCount: row.runCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

@Injectable()
export class AutomationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(accountId?: string | null): Promise<AutomationView[]> {
    const rows = (await this.prisma.automation.findMany({
      where: accountId ? { accountId } : {},
      orderBy: { createdAt: 'asc' },
    })) as AutomationModel[];
    return rows.map(toView);
  }

  async get(id: string): Promise<AutomationView> {
    const row = (await this.prisma.automation.findUnique({
      where: { id },
    })) as AutomationModel | null;
    if (!row) throw notFound('AUTOMATION_NOT_FOUND', 'Automation not found');
    return toView(row);
  }

  async create(input: AutomationInput): Promise<AutomationView> {
    const name = text(input.name);
    if (!name) throw apiError('INVALID_NAME', 'name is required', 400);
    const accountId = text(input.accountId) || null;
    if (accountId) {
      const account = await this.prisma.telegramAccount.findUnique({
        where: { id: accountId },
      });
      if (!account) throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
    }
    const trigger = record(input.trigger);
    const action = record(input.action);
    const actionType = text(action.type, 'agent');
    if (!['agent', 'send_message', 'summarize'].includes(actionType)) {
      throw apiError('INVALID_ACTION', 'Unknown action type', 400);
    }
    const enabled = input.enabled === true || input.enabled === 'true';
    const next = enabled ? nextRunFor(trigger) : null;
    const row = (await this.prisma.automation.create({
      data: {
        accountId,
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
    const current = await this.get(id);
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = text(input.name);
      if (!name) throw apiError('INVALID_NAME', 'name is required', 400);
      data.name = name;
    }
    if (input.description !== undefined) {
      data.description = text(input.description);
    }
    let trigger = current.trigger;
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
    if (input.accountId !== undefined) {
      const accountId = text(input.accountId) || null;
      data.accountId = accountId;
    }
    let enabled = current.enabled;
    if (input.enabled !== undefined) {
      enabled = input.enabled === true || input.enabled === 'true';
      data.enabled = enabled;
    }
    data.nextRunAt =
      enabled && triggerTypeFor(trigger) === 'schedule'
        ? nextRunFor(trigger)
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
    await this.get(id);
    const row = (await this.prisma.automation.update({
      where: { id },
      data: { nextRunAt: new Date() },
    })) as AutomationModel;
    return toView(row);
  }

  async due(): Promise<AutomationModel[]> {
    return (await this.prisma.automation.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: new Date() },
      },
      orderBy: { nextRunAt: 'asc' },
      take: 20,
    })) as AutomationModel[];
  }

  async complete(
    id: string,
    trigger: Record<string, unknown>,
  ): Promise<void> {
    const next = nextRunFor(trigger);
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
  ): Promise<AutomationView[]> {
    const rows = (await this.prisma.automation.findMany({
      where: {
        enabled: true,
        triggerType: 'incoming_message',
        OR: [{ accountId }, { accountId: null }],
      },
    })) as AutomationModel[];
    const lower = textValue.toLowerCase();
    return rows
      .map(toView)
      .filter((automation) => {
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
}
