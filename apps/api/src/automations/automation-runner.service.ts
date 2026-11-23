import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AutomationModel } from '@repo/database';
import type { Subscription } from 'rxjs';
import { DefaultUserService } from '../user-context/default-user.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { emitLog } from '../logs/log-sink.js';
import { AgentService } from '../ai/agent.service.js';
import { AiPolicyService } from '../ai/ai-policy.service.js';
import { MemoryService } from '../ai/memory.service.js';
import { AutomationsService } from './automations.service.js';

interface IncomingPayload {
  accountId?: unknown;
  chatId?: unknown;
  message?: {
    id?: unknown;
    text?: unknown;
    outgoing?: unknown;
    service?: unknown;
  };
}

function record(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed !== 0 ? parsed : null;
}

/**
 * Executes automations: a 15-second scheduler for `schedule` triggers and a
 * realtime listener for `incoming_message` triggers. Every action goes through
 * the same tool/policy layer as the agent; `send_message` respects dryRun.
 */
@Injectable()
export class AutomationRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AutomationRunnerService.name);
  private subscription?: Subscription;
  private ticking = false;
  private readonly running = new Set<string>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly automations: AutomationsService,
    private readonly agent: AgentService,
    private readonly policy: AiPolicyService,
    private readonly memory: MemoryService,
    private readonly messaging: MessagingService,
    private readonly users: DefaultUserService,
    private readonly realtime: RealtimeService,
  ) {}

  onModuleInit(): void {
    this.subscription = this.realtime.events$.subscribe((event) => {
      if (event.event !== 'message.new') return;
      void this.onIncoming(event.userId, event.payload as IncomingPayload).catch(
        (error) => {
          this.logger.warn(
            `Incoming automation failed: ${(error as Error).message}`,
          );
        },
      );
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }

  /** Called by the scheduler; returns how many automations ran. */
  async runDue(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    let count = 0;
    try {
      const due = await this.automations.due();
      for (const automation of due) {
        if (this.running.has(automation.id)) continue;
        await this.execute(automation);
        count += 1;
      }
    } catch (error) {
      this.logger.warn(`Automation tick failed: ${(error as Error).message}`);
    } finally {
      this.ticking = false;
    }
    return count;
  }

  /** Runs one automation immediately (dashboard button). */
  async runNow(
    id: string,
  ): Promise<{ runId: string; status: string; output?: string; error?: string }> {
    const view = await this.automations.get(id);
    return this.execute(await this.automationsModel(view.id));
  }

  private async onIncoming(
    _userId: string,
    payload: IncomingPayload,
  ): Promise<void> {
    const accountId = text(payload.accountId);
    const chatId = number(payload.chatId);
    const message = payload.message;
    if (!accountId || !chatId || !message) return;
    if (message.outgoing === true || message.service === true) return;
    if (chatId <= 0) return;
    const messageId = number(message.id);
    if (!messageId) return;
    const key = `${accountId}:${chatId}:${messageId}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 5000) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }

    const body = text(message.text);
    const matches = await this.automations.matchingIncoming(
      accountId,
      chatId,
      body,
    );
    for (const match of matches) {
      if (this.running.has(match.id)) continue;
      await this.execute(await this.automationsModel(match.id), {
        messageId,
        chatId,
        text: body,
      });
    }
  }

  private async automationsModel(id: string): Promise<AutomationModel> {
    const view = await this.automations.get(id);
    return view as unknown as AutomationModel;
  }

  private async execute(
    automation: AutomationModel,
    input: Record<string, unknown> = {},
  ): Promise<{ runId: string; status: string; output?: string; error?: string }> {
    this.running.add(automation.id);
    const trigger = record(automation.trigger);
    const action = record(automation.action);
    const run = await this.automations.startRun(automation.id, input);
    try {
      const user = await this.users.get();
      const accountId = automation.accountId;
      const chatId =
        number(action.chatId) ?? number(input.chatId) ?? null;
      const actionType = automation.actionType;
      let output = '';

      if (actionType === 'agent') {
        const prompt =
          text(action.prompt) ||
          'Просмотри последние события аккаунта и подготовь короткий отчёт.';
        const result = await this.agent.run({
          userId: user.id,
          accountId,
          chatId,
          source: 'automation',
          prompt,
          skillSlugs: Array.isArray(action.skillSlugs)
            ? action.skillSlugs.filter(
                (item): item is string => typeof item === 'string',
              )
            : [],
          systemExtra:
            'Это автоматический запуск по расписанию. Действуй по инструкции и верни короткий отчёт.',
        });
        output = result.text;
        if (chatId && action.sendOutput !== false && output.trim()) {
          const decision = await this.policy.evaluate('send', {
            userId: user.id,
            accountId,
            chatId,
            source: 'automation',
          });
          if (decision.allowed && !decision.dryRun) {
            await this.messaging.sendMessage(
              user.id,
              accountId ?? '',
              String(chatId),
              { text: output },
            );
          } else if (decision.dryRun) {
            output += '\n\n(dryRun: сообщение не отправлено)';
          }
        }
      } else if (actionType === 'send_message') {
        const target = number(action.chatId);
        const body = text(action.text);
        if (!target || !body) {
          throw new Error('send_message needs chatId and text');
        }
        const decision = await this.policy.evaluate('send', {
          userId: user.id,
          accountId,
          chatId: target,
          source: 'automation',
        });
        if (!decision.allowed) {
          throw new Error(decision.reason ?? 'Send is not allowed by policy');
        }
        if (decision.dryRun) {
          output = `dryRun: would send to ${target}: ${body}`;
        } else {
          await this.messaging.sendMessage(
            user.id,
            accountId ?? '',
            String(target),
            { text: body },
          );
          output = `sent to ${target}`;
        }
      } else if (actionType === 'summarize') {
        const target = number(action.chatId);
        if (!target || !accountId) {
          throw new Error('summarize needs accountId and chatId');
        }
        const summary = await this.memory.summarize(accountId, target, {
          force: true,
        });
        output = `summary updated (${summary.turnsUsed} turns)`;
      } else {
        throw new Error(`Unknown action type ${actionType}`);
      }

      await this.automations.finishRun(run.id, { status: 'ok', output });
      await this.automations.complete(automation.id, trigger);
      emitLog({
        level: 'info',
        source: 'automation',
        action: 'automation.run',
        message: `Automation ${automation.name} finished`,
        status: 'ok',
        accountId: accountId ?? undefined,
        details: { automationId: automation.id, runId: run.id },
      });
      return { runId: run.id, status: 'ok', output };
    } catch (error) {
      const message = (error as Error).message;
      await this.automations.finishRun(run.id, {
        status: 'failed',
        error: message,
      });
      await this.automations
        .complete(automation.id, trigger)
        .catch(() => undefined);
      emitLog({
        level: 'error',
        source: 'automation',
        action: 'automation.run',
        message: `Automation ${automation.name} failed: ${message}`,
        status: 'failed',
        accountId: automation.accountId ?? undefined,
        details: { automationId: automation.id, runId: run.id },
      });
      return { runId: run.id, status: 'failed', error: message };
    } finally {
      this.running.delete(automation.id);
    }
  }
}
