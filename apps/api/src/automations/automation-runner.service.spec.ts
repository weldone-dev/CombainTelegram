import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { notFound } from '../common/api-error.js';
import { AutomationRunnerService } from './automation-runner.service.js';
import type { AutomationView } from './automations.service.js';

const NOW = new Date('2026-11-24T10:00:00.000Z');

function automationView(
  overrides: Partial<AutomationView> = {},
): AutomationView {
  return {
    id: 'auto-1',
    accountId: 'acc-1',
    name: 'Digest',
    description: '',
    enabled: true,
    triggerType: 'schedule',
    trigger: { kind: 'every', minutes: 10 },
    actionType: 'agent',
    action: { type: 'agent', prompt: 'Report' },
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function createHarness(
  view: AutomationView | null = automationView(),
  options: { allowed?: boolean; dryRun?: boolean; reason?: string } = {},
) {
  const views = new Map<string, AutomationView>();
  if (view) views.set(view.id, view);

  const automations = {
    get: vi.fn(async (id: string) => {
      const found = views.get(id);
      if (!found) {
        throw notFound('AUTOMATION_NOT_FOUND', 'Automation not found');
      }
      return found;
    }),
    startRun: vi.fn(async (id: string) => ({
      id: 'run-1',
      automationId: id,
      status: 'running',
    })),
    finishRun: vi.fn(async () => undefined),
    complete: vi.fn(async () => undefined),
  };
  const agent = {
    run: vi.fn(async () => ({ text: 'agent output' })),
  };
  const policy = {
    evaluate: vi.fn(async () => ({
      allowed: options.allowed ?? true,
      dryRun: options.dryRun ?? true,
      ...(options.reason ? { reason: options.reason } : {}),
    })),
  };
  const memory = {
    summarize: vi.fn(async () => ({ turnsUsed: 3 })),
  };
  const messaging = {
    sendMessage: vi.fn(async () => ({ id: 1 })),
  };
  const users = { get: vi.fn(async () => ({ id: 'local' })) };
  const realtime = { events$: of() };

  const service = new AutomationRunnerService(
    automations as never,
    agent as never,
    policy as never,
    memory as never,
    messaging as never,
    users as never,
    realtime as never,
  );

  return { service, automations, agent, policy, memory, messaging, users };
}

function httpBody(error: unknown): { code: string; message: string } {
  return (
    error as { getResponse(): { code: string; message: string } }
  ).getResponse();
}

describe('AutomationRunnerService send_message', () => {
  it('records a dry run without touching MessagingService', async () => {
    const harness = createHarness(
      automationView({
        actionType: 'send_message',
        action: { type: 'send_message', chatId: 5, text: 'hi' },
      }),
      { dryRun: true },
    );

    const result = await harness.service.runNow('auto-1');

    expect(result).toEqual({
      runId: 'run-1',
      status: 'ok',
      output: 'dryRun: would send to 5: hi',
    });
    expect(harness.messaging.sendMessage).not.toHaveBeenCalled();
    expect(harness.automations.finishRun).toHaveBeenCalledWith('run-1', {
      status: 'ok',
      output: 'dryRun: would send to 5: hi',
    });
    expect(harness.automations.complete).toHaveBeenCalledWith('auto-1', {
      kind: 'every',
      minutes: 10,
    });
  });

  it('sends through MessagingService when dryRun is off', async () => {
    const harness = createHarness(
      automationView({
        actionType: 'send_message',
        action: { type: 'send_message', chatId: 5, text: 'hi' },
      }),
      { dryRun: false },
    );

    const result = await harness.service.runNow('auto-1');

    expect(result).toEqual({
      runId: 'run-1',
      status: 'ok',
      output: 'sent to 5',
    });
    expect(harness.messaging.sendMessage).toHaveBeenCalledWith(
      'local',
      'acc-1',
      '5',
      { text: 'hi' },
    );
  });

  it('fails a run without chatId or text and still completes it', async () => {
    const harness = createHarness(
      automationView({
        actionType: 'send_message',
        action: { type: 'send_message', chatId: 5 },
      }),
      { dryRun: false },
    );

    const result = await harness.service.runNow('auto-1');

    expect(result).toEqual({
      runId: 'run-1',
      status: 'failed',
      error: 'send_message needs chatId and text',
    });
    expect(harness.messaging.sendMessage).not.toHaveBeenCalled();
    expect(harness.automations.finishRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      error: 'send_message needs chatId and text',
    });
    expect(harness.automations.complete).toHaveBeenCalledTimes(1);
  });

  it('fails a dry run that the policy refuses', async () => {
    const harness = createHarness(
      automationView({
        actionType: 'send_message',
        action: { type: 'send_message', chatId: 5, text: 'hi' },
      }),
      { allowed: false, dryRun: false, reason: 'Chat is blocked' },
    );

    const result = await harness.service.runNow('auto-1');

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Chat is blocked');
    expect(harness.automations.finishRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      error: 'Chat is blocked',
    });
    expect(harness.messaging.sendMessage).not.toHaveBeenCalled();
  });
});

describe('AutomationRunnerService agent action', () => {
  it('runs the agent with source automation and stores the output', async () => {
    const harness = createHarness(
      automationView({
        actionType: 'agent',
        action: {
          type: 'agent',
          prompt: 'Summarize today',
          skillSlugs: ['digest', 7],
        },
      }),
    );

    const result = await harness.service.runNow('auto-1');

    expect(harness.agent.run).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'local',
        accountId: 'acc-1',
        chatId: null,
        source: 'automation',
        prompt: 'Summarize today',
        skillSlugs: ['digest'],
      }),
    );
    expect(result).toEqual({
      runId: 'run-1',
      status: 'ok',
      output: 'agent output',
    });
    expect(harness.automations.finishRun).toHaveBeenCalledWith('run-1', {
      status: 'ok',
      output: 'agent output',
    });
  });

  it('appends the dry-run note when the agent output would be sent', async () => {
    const harness = createHarness(
      automationView({
        actionType: 'agent',
        action: { type: 'agent', prompt: 'Report', chatId: 5 },
      }),
      { dryRun: true },
    );

    const result = await harness.service.runNow('auto-1');

    expect(result.output).toBe(
      'agent output\n\n(dryRun: сообщение не отправлено)',
    );
    expect(harness.policy.evaluate).toHaveBeenCalledWith(
      'send',
      expect.objectContaining({
        userId: 'local',
        accountId: 'acc-1',
        chatId: 5,
        source: 'automation',
      }),
    );
    expect(harness.messaging.sendMessage).not.toHaveBeenCalled();
  });

  it('sends the agent output when policy allows a live send', async () => {
    const harness = createHarness(
      automationView({
        actionType: 'agent',
        action: {
          type: 'agent',
          prompt: 'Report',
          chatId: 5,
          sendOutput: true,
        },
      }),
      { dryRun: false },
    );

    await harness.service.runNow('auto-1');

    expect(harness.messaging.sendMessage).toHaveBeenCalledWith(
      'local',
      'acc-1',
      '5',
      { text: 'agent output' },
    );
  });

  it('marks the run failed when the agent throws', async () => {
    const harness = createHarness(automationView());
    harness.agent.run.mockRejectedValue(new Error('LLM down'));

    const result = await harness.service.runNow('auto-1');

    expect(result).toEqual({
      runId: 'run-1',
      status: 'failed',
      error: 'LLM down',
    });
    expect(harness.automations.finishRun).toHaveBeenCalledWith('run-1', {
      status: 'failed',
      error: 'LLM down',
    });
    expect(harness.automations.complete).toHaveBeenCalledTimes(1);
  });
});

describe('AutomationRunnerService summarize', () => {
  it('forces a memory summary for the target chat', async () => {
    const harness = createHarness(
      automationView({
        actionType: 'summarize',
        action: { type: 'summarize', chatId: 5 },
      }),
    );

    const result = await harness.service.runNow('auto-1');

    expect(harness.memory.summarize).toHaveBeenCalledWith('acc-1', 5, {
      force: true,
    });
    expect(result.output).toBe('summary updated (3 turns)');
  });

  it('requires both accountId and chatId', async () => {
    const harness = createHarness(
      automationView({
        accountId: null,
        actionType: 'summarize',
        action: { type: 'summarize', chatId: 5 },
      }),
    );

    const result = await harness.service.runNow('auto-1');

    expect(result.status).toBe('failed');
    expect(result.error).toBe('summarize needs accountId and chatId');
    expect(harness.memory.summarize).not.toHaveBeenCalled();
  });
});

describe('AutomationRunnerService.runNow', () => {
  it('throws when the automation does not exist', async () => {
    const harness = createHarness(null);

    const error = await harness.service
      .runNow('missing')
      .catch((caught: unknown) => caught);

    expect(httpBody(error).code).toBe('AUTOMATION_NOT_FOUND');
    expect(harness.automations.startRun).not.toHaveBeenCalled();
  });

  it('passes the automation id and input to startRun', async () => {
    const harness = createHarness();

    await harness.service.runNow('auto-1');

    expect(harness.automations.startRun).toHaveBeenCalledWith('auto-1', {});
  });
});
