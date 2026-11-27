import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { AiChatAccessModel, AiChatBlockModel } from '@repo/database';
import { ChatStateService } from '../../ai/chat-state.service.js';
import {
  N8nActionsService,
  SOUL_REPLY_DEDUPE_TTL_MS,
} from './n8n-actions.service.js';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const ACCOUNT = 'account-1';
const CHAT = 42;

function blockRow(): AiChatBlockModel {
  return {
    id: 'block-1',
    userId: 'user-1',
    accountId: ACCOUNT,
    chatId: BigInt(CHAT),
    threadId: 0,
    reason: 'spam',
    warnings: 1,
    blockedBy: 'user',
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as AiChatBlockModel;
}

function accessRow(): AiChatAccessModel {
  return {
    id: 'access-1',
    userId: 'user-1',
    accountId: ACCOUNT,
    chatId: BigInt(CHAT),
    threadId: 0,
    soulId: null,
    enabled: true,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as AiChatAccessModel;
}

function harness(
  options: { block?: AiChatBlockModel | null } = {},
) {
  const accounts = {
    requireAccount: vi.fn(async () => undefined),
    isEveBound: vi.fn(async () => false),
  };
  const access = {
    accessFor: vi.fn(async () => ({
      allowed: options.block ? false : true,
      access: options.block ? null : accessRow(),
      block: options.block ?? null,
      warnings: 0,
    })),
    bumpWarning: vi.fn(async () => ({ warnings: 1, blocked: false })),
    block: vi.fn(async () => ({
      allowed: false,
      blocked: true,
      reason: 'spam',
      warnings: 0,
      soulId: null,
      note: null,
      threadId: 0,
    })),
    unblock: vi.fn(async () => ({ removed: true, warnings: 0, blocked: false })),
  };
  const automations = {
    pauseForChat: vi.fn(async () => [{ id: 'auto-1' }, { id: 'auto-2' }]),
    resume: vi.fn(async () => [{ id: 'auto-1' }]),
  };
  const memory = {
    addFact: vi.fn(async () => ({
      id: 'fact-1',
      chatId: CHAT,
      kind: 'preference',
      content: 'loves tea',
      importance: 4,
      source: 'n8n',
      createdAt: NOW.toISOString(),
    })),
    clearChat: vi.fn(async () => undefined),
  };
  const chatMemory = {
    view: vi.fn(async () => ({
      accountId: ACCOUNT,
      chatId: CHAT,
      shortTerm: [
        { role: 'user', content: 'hi', createdAt: NOW.toISOString() },
      ],
      longTerm: {
        summary: 'A short summary',
        facts: [
          {
            kind: 'fact',
            content: 'likes tea',
            importance: 3,
            createdAt: NOW.toISOString(),
          },
        ],
      },
    })),
  };
  const autopilot = {
    isChatAllowed: vi.fn(async () => true),
    replyNow: vi.fn(async () => ({
      sent: true,
      superseded: false,
      text: 'Hello',
      messageIds: [2003],
      state: 'sent',
    })),
    generateReply: vi.fn(async () => ({
      runId: 'run-1',
      parts: [{ text: 'Hello', replyToMessageId: 55 }],
      reasoning: null,
      state: 'composing',
      superseded: false,
      duplicate: false,
      blocked: false,
    })),
    sendText: vi.fn(
      async (input: { parts: string[]; typing?: unknown }) => ({
        messageIds: input.parts.map((_, index) => 10 + index),
        state: 'sent',
        typingMs: input.typing === 'off' ? 0 : 600,
      }),
    ),
  };
  const tools = {
    execute: vi.fn(async () => ({ ok: true, result: { done: true } })),
  };
  const tags = {
    list: vi.fn(async () => ['lead', 'vip']),
    add: vi.fn(async () => ['lead', 'vip']),
    remove: vi.fn(async () => ({
      removed: true,
      tags: ['vip'],
    })),
  };
  const messaging = {
    sendTyping: vi.fn(async () => ({ status: 'typing' })),
    markRead: vi.fn(async () => ({ read: true, maxId: 77 })),
  };
  const presenceService = {
    setOnline: vi.fn(async (_accountId: string, online: boolean) => ({
      online,
    })),
  };
  const souls = {
    model: vi.fn(async () => ({
      id: 'soul-1',
      accountId: ACCOUNT,
      settings: JSON.stringify({
        typingMode: 'on_compose',
        typingHeartbeatMs: 4_000,
      }),
    })),
  };
  const states = new ChatStateService({ emitToUser: vi.fn() } as never);

  const service = new N8nActionsService(
    accounts as never,
    access as never,
    automations as never,
    memory as never,
    chatMemory as never,
    tags as never,
    autopilot as never,
    tools as never,
    messaging as never,
    presenceService as never,
    souls as never,
    states,
  );

  return {
    service,
    accounts,
    access,
    automations,
    memory,
    chatMemory,
    tags,
    autopilot,
    tools,
    messaging,
    presenceService,
    souls,
    states,
  };
}

function failure(run: () => Promise<unknown>): Promise<HttpException> {
  return run().then(
    () => {
      throw new Error('expected the call to fail');
    },
    (error: unknown) => {
      if (error instanceof HttpException) return error;
      throw error;
    },
  );
}

function codeOf(error: HttpException): string {
  return (error.getResponse() as { code: string }).code;
}

describe('N8nActionsService.sendText', () => {
  it('refuses an Eve-bound account and sends nothing', async () => {
    const h = harness();
    h.accounts.isEveBound.mockResolvedValueOnce(true);
    const error = await failure(() =>
      h.service.sendText('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        text: 'hello',
      }),
    );
    expect(error.getStatus()).toBe(409);
    expect(codeOf(error)).toBe('N8N_EVE_ACCOUNT');
    expect(h.autopilot.sendText).not.toHaveBeenCalled();
  });

  it('refuses a blocked chat with CHAT_BLOCKED and sends nothing', async () => {
    const h = harness({ block: blockRow() });
    const error = await failure(() =>
      h.service.sendText('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        text: 'hello',
      }),
    );
    expect(error.getStatus()).toBe(403);
    expect(codeOf(error)).toBe('CHAT_BLOCKED');
    expect(h.autopilot.sendText).not.toHaveBeenCalled();
  });

  it('splits on --- and applies the reply target to the first bubble only', async () => {
    const h = harness();

    const result = await h.service.sendText('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      text: ' first \n---\n second ',
      replyToId: 77,
      quote: 'the quote',
    });

    expect(h.autopilot.sendText).toHaveBeenCalledWith({
      userId: 'user-1',
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      parts: ['first', 'second'],
      replyToId: 77,
      quote: 'the quote',
      typing: 'auto',
    });
    expect(result).toEqual({
      sent: true,
      messageIds: [10, 11],
      state: 'sent',
      typingMs: 600,
    });
  });

  it('accepts an explicit parts array and a typing override', async () => {
    const h = harness();
    const result = await h.service.sendText('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      parts: ['one', 'two', 'three'],
      typing: 'off',
    });

    expect(h.autopilot.sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        parts: ['one', 'two', 'three'],
        typing: 'off',
      }),
    );
    expect(result.messageIds).toEqual([10, 11, 12]);
    expect(result.typingMs).toBe(0);
  });

  it('cuts a long text into 4096-character parts', async () => {
    const h = harness();
    const result = await h.service.sendText('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      text: 'a'.repeat(4097),
    });
    expect(result.messageIds).toHaveLength(2);
    const input = h.autopilot.sendText.mock.calls[0]?.[0] as {
      parts: string[];
    };
    expect([...input.parts[0] ?? '']).toHaveLength(4096);
  });
});

describe('N8nActionsService.soulReply', () => {
  it('delegates to the autopilot pipeline with parsed fields', async () => {
    const h = harness();
    const result = await h.service.soulReply('user-1', {
      accountId: ACCOUNT,
      chatId: String(CHAT),
      threadId: 3,
      prompt: 'Позови на кофе',
      replyToMessageId: 55,
      returnText: 'true',
    });
    expect(h.autopilot.replyNow).toHaveBeenCalledWith({
      userId: 'user-1',
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 3,
      prompt: 'Позови на кофе',
      replyToMessageId: 55,
      returnText: true,
    });
    expect(result).toEqual({
      sent: true,
      superseded: false,
      text: 'Hello',
      messageIds: [2003],
      state: 'sent',
    });
  });

  it('passes a superseded result through without throwing', async () => {
    const h = harness();
    h.autopilot.replyNow.mockResolvedValueOnce({
      sent: false,
      superseded: true,
      text: 'Hello',
      messageIds: [],
      state: 'superseded',
    });
    await expect(
      h.service.soulReply('user-1', { accountId: ACCOUNT, chatId: CHAT }),
    ).resolves.toEqual({
      sent: false,
      superseded: true,
      text: 'Hello',
      messageIds: [],
      state: 'superseded',
    });
  });
});

describe('N8nActionsService.generate', () => {
  it('delegates to generateReply without sending or typing', async () => {
    const h = harness();
    const result = await h.service.generate('user-1', {
      accountId: ACCOUNT,
      chatId: String(CHAT),
      threadId: 3,
      messageId: 55,
      prompt: 'Позови на кофе',
      maxParts: 3,
    });

    expect(h.autopilot.generateReply).toHaveBeenCalledWith({
      userId: 'user-1',
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 3,
      messageId: 55,
      prompt: 'Позови на кофе',
      maxParts: 3,
    });
    expect(h.autopilot.sendText).not.toHaveBeenCalled();
    expect(result).toEqual({
      runId: 'run-1',
      parts: [{ text: 'Hello', replyToMessageId: 55 }],
      reasoning: null,
      state: 'composing',
      superseded: false,
      duplicate: false,
      blocked: false,
    });
  });

  it('rejects a missing account without calling the model', async () => {
    const h = harness();
    const error = await failure(() =>
      h.service.generate('user-1', { chatId: CHAT }),
    );
    expect(error.getStatus()).toBe(400);
    expect(codeOf(error)).toBe('VALIDATION_ERROR');
    expect(h.autopilot.generateReply).not.toHaveBeenCalled();
  });

  it('passes a blocked and a duplicate result through', async () => {
    const h = harness();
    h.autopilot.generateReply.mockResolvedValueOnce({
      runId: null,
      parts: [],
      reasoning: null,
      state: 'blocked',
      superseded: false,
      duplicate: false,
      blocked: true,
    });
    await expect(
      h.service.generate('user-1', { accountId: ACCOUNT, chatId: CHAT }),
    ).resolves.toMatchObject({ blocked: true, state: 'blocked' });

    h.autopilot.generateReply.mockResolvedValueOnce({
      runId: null,
      parts: [],
      reasoning: null,
      state: 'idle',
      superseded: false,
      duplicate: true,
      blocked: false,
    });
    await expect(
      h.service.generate('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        messageId: 55,
      }),
    ).resolves.toMatchObject({ duplicate: true });
  });
});

describe('N8nActionsService.memory', () => {
  it('stores a fact with kind, importance and source', async () => {
    const h = harness();
    const result = await h.service.memoryAdd('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      kind: 'preference',
      content: '  loves tea  ',
      importance: 4,
    });
    expect(h.memory.addFact).toHaveBeenCalledWith(ACCOUNT, CHAT, 'loves tea', {
      kind: 'preference',
      importance: 4,
      source: 'n8n',
    });
    expect(result.fact.content).toBe('loves tea');
  });

  it('returns summary, facts and turns', async () => {
    const h = harness();
    const view = await h.service.memoryView(
      'user-1',
      ACCOUNT,
      CHAT,
      '10',
    );
    expect(h.chatMemory.view).toHaveBeenCalledWith(
      'user-1',
      ACCOUNT,
      CHAT,
      10,
    );
    expect(view.summary).toBe('A short summary');
    expect(view.facts).toHaveLength(1);
    expect(view.turns[0]?.role).toBe('user');
  });

  it('clears the whole context of an owned chat', async () => {
    const h = harness();
    await expect(
      h.service.memoryClear('user-1', { accountId: ACCOUNT, chatId: CHAT }),
    ).resolves.toEqual({ accountId: ACCOUNT, chatId: CHAT, cleared: true });
    expect(h.accounts.requireAccount).toHaveBeenCalledWith('user-1', ACCOUNT);
    expect(h.memory.clearChat).toHaveBeenCalledWith(ACCOUNT, CHAT);
  });
});

describe('N8nActionsService.tags', () => {
  it('lists the tags of an owned chat', async () => {
    const h = harness();
    await expect(
      h.service.tagsView('user-1', ACCOUNT, CHAT),
    ).resolves.toEqual({
      accountId: ACCOUNT,
      chatId: CHAT,
      tags: ['lead', 'vip'],
      available: true,
    });
    expect(h.accounts.requireAccount).toHaveBeenCalledWith('user-1', ACCOUNT);
    expect(h.tags.list).toHaveBeenCalledWith(ACCOUNT, CHAT);
  });

  it('delegates a set to the tags service and reports availability', async () => {
    const h = harness();
    h.tags.add.mockResolvedValueOnce(['lead', 'vip']);

    await expect(
      h.service.tagsSet('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        tag: ' VIP ',
      }),
    ).resolves.toEqual({
      accountId: ACCOUNT,
      chatId: CHAT,
      tags: ['lead', 'vip'],
      available: true,
    });
    // Normalisation belongs to the tags service, not to the HTTP layer.
    expect(h.tags.add).toHaveBeenCalledWith(ACCOUNT, CHAT, ' VIP ');
  });

  it('delegates a remove and returns removed plus the remaining tags', async () => {
    const h = harness();
    await expect(
      h.service.tagsRemove('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        tag: 'lead',
      }),
    ).resolves.toEqual({
      accountId: ACCOUNT,
      chatId: CHAT,
      tags: ['vip'],
      removed: true,
      available: true,
    });
    expect(h.tags.remove).toHaveBeenCalledWith(ACCOUNT, CHAT, 'lead');
  });

  it('refuses a foreign account before touching the tags', async () => {
    const h = harness();
    h.accounts.requireAccount.mockRejectedValueOnce(new Error('not found'));

    await expect(
      h.service.tagsSet('user-1', {
        accountId: 'other-account',
        chatId: CHAT,
        tag: 'vip',
      }),
    ).rejects.toThrow('not found');
    expect(h.tags.add).not.toHaveBeenCalled();
  });
});

describe('N8nActionsService access actions', () => {
  it('adds a warning attributed to the user', async () => {
    const h = harness();
    await expect(
      h.service.warn('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        threadId: 2,
        reason: 'rude',
      }),
    ).resolves.toEqual({ warnings: 1, blocked: false });
    expect(h.access.bumpWarning).toHaveBeenCalledWith({
      userId: 'user-1',
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 2,
      reason: 'rude',
      blockedBy: 'user',
    });
  });

  it('requires a reason of at least three characters to block', async () => {
    const h = harness();
    const error = await failure(() =>
      h.service.block('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        reason: 'no',
      }),
    );
    expect(error.getStatus()).toBe(400);
    expect(codeOf(error)).toBe('REASON_REQUIRED');
    expect(h.access.block).not.toHaveBeenCalled();
  });

  it('blocks with a valid reason and unblocks without one', async () => {
    const h = harness();
    await h.service.block('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      reason: 'spam',
    });
    expect(h.access.block).toHaveBeenCalledWith({
      userId: 'user-1',
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
      reason: 'spam',
      blockedBy: 'user',
    });

    await expect(
      h.service.unblock('user-1', { accountId: ACCOUNT, chatId: CHAT }),
    ).resolves.toEqual({ removed: true, warnings: 0, blocked: false });
  });

  it('pauses and resumes the automations of a chat', async () => {
    const h = harness();
    const paused = await h.service.pauseAutomations('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 4,
      reason: 'wait',
    });
    expect(h.automations.pauseForChat).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 4,
      reason: 'wait',
    });
    expect(paused).toMatchObject({ count: 2, automationIds: ['auto-1', 'auto-2'] });

    const resumed = await h.service.resumeAutomations('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
    });
    expect(h.automations.resume).toHaveBeenCalledWith({
      accountId: ACCOUNT,
      chatId: CHAT,
      threadId: 0,
    });
    expect(resumed).toMatchObject({ count: 1, automationIds: ['auto-1'] });
  });
});

describe('N8nActionsService.tool', () => {
  it('runs a tool in the automation scope', async () => {
    const h = harness();
    const result = await h.service.tool('user-1', 'chat_list', {
      accountId: ACCOUNT,
      chatId: CHAT,
      args: { limit: 5 },
    });
    expect(h.tools.execute).toHaveBeenCalledWith('chat_list', { limit: 5 }, {
      userId: 'user-1',
      accountId: ACCOUNT,
      chatId: CHAT,
      source: 'automation',
    });
    expect(result).toEqual({ ok: true, result: { done: true }, dryRun: false });
  });

  it('refuses a disabled capability with 403', async () => {
    const h = harness();
    h.tools.execute.mockResolvedValueOnce({
      ok: false,
      code: 'CAPABILITY_DISABLED',
      error: 'Capability "send" is disabled',
    });
    const error = await failure(() =>
      h.service.tool('user-1', 'send_message', { args: {} }),
    );
    expect(error.getStatus()).toBe(403);
    expect(codeOf(error)).toBe('CAPABILITY_DISABLED');
  });

  it('maps an unknown tool to 404', async () => {
    const h = harness();
    h.tools.execute.mockResolvedValueOnce({
      ok: false,
      code: 'UNKNOWN_TOOL',
      error: 'Unknown tool nope',
    });
    const error = await failure(() => h.service.tool('user-1', 'nope', {}));
    expect(error.getStatus()).toBe(404);
    expect(codeOf(error)).toBe('UNKNOWN_TOOL');
  });

  it('rejects non-object args', async () => {
    const h = harness();
    const error = await failure(() =>
      h.service.tool('user-1', 'chat_list', { args: [1, 2] }),
    );
    expect(error.getStatus()).toBe(400);
    expect(codeOf(error)).toBe('VALIDATION_ERROR');
  });
});

describe('N8nActionsService.soulReply idempotency', () => {
  it('skips the agent when the same replyToMessageId arrives again', async () => {
    const h = harness();
    const first = await h.service.soulReply('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      replyToMessageId: 55,
    });
    expect(first).toMatchObject({ sent: true, superseded: false });
    expect(first.duplicate).toBeUndefined();

    const second = await h.service.soulReply('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      replyToMessageId: 55,
    });
    expect(second).toEqual({
      sent: false,
      superseded: false,
      duplicate: true,
      text: '',
      messageIds: [],
      state: 'idle',
    });
    expect(h.autopilot.replyNow).toHaveBeenCalledTimes(1);
  });

  it('answers a different message id normally', async () => {
    const h = harness();
    await h.service.soulReply('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      replyToMessageId: 55,
    });
    await h.service.soulReply('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      replyToMessageId: 56,
    });
    expect(h.autopilot.replyNow).toHaveBeenCalledTimes(2);
  });

  it('scopes the dedupe per account and chat', async () => {
    const h = harness();
    await h.service.soulReply('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      replyToMessageId: 55,
    });
    await h.service.soulReply('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT + 1,
      replyToMessageId: 55,
    });
    expect(h.autopilot.replyNow).toHaveBeenCalledTimes(2);
  });

  it('forgets the message after the 15-minute TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T12:00:00.000Z'));
    try {
      const h = harness();
      const body = { accountId: ACCOUNT, chatId: CHAT, replyToMessageId: 55 };
      await h.service.soulReply('user-1', body);
      await h.service.soulReply('user-1', body);
      expect(h.autopilot.replyNow).toHaveBeenCalledTimes(1);

      vi.setSystemTime(
        new Date(Date.now() + SOUL_REPLY_DEDUPE_TTL_MS + 1),
      );
      await h.service.soulReply('user-1', body);
      expect(h.autopilot.replyNow).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases the key when the run fails so the next delivery may retry', async () => {
    const h = harness();
    h.autopilot.replyNow.mockRejectedValueOnce(new Error('llm down'));
    const body = { accountId: ACCOUNT, chatId: CHAT, replyToMessageId: 55 };

    await expect(h.service.soulReply('user-1', body)).rejects.toThrow(
      'llm down',
    );
    await expect(h.service.soulReply('user-1', body)).resolves.toMatchObject({
      sent: true,
    });
    expect(h.autopilot.replyNow).toHaveBeenCalledTimes(2);
  });

  it('does not dedupe when no replyToMessageId is given', async () => {
    const h = harness();
    const body = { accountId: ACCOUNT, chatId: CHAT };
    await h.service.soulReply('user-1', body);
    await h.service.soulReply('user-1', body);
    expect(h.autopilot.replyNow).toHaveBeenCalledTimes(2);
  });
});

function typingCalls(h: ReturnType<typeof harness>): number {
  return h.messaging.sendTyping.mock.calls.filter(
    (call) => (call[3] as { status?: string }).status === 'typing',
  ).length;
}

function cancelCalls(h: ReturnType<typeof harness>): number {
  return h.messaging.sendTyping.mock.calls.filter(
    (call) => (call[3] as { status?: string }).status === 'cancel',
  ).length;
}

describe('N8nActionsService.typing', () => {
  it('sends periodically and stops by itself at the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    const view = await h.service.typing('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      status: 'typing',
      durationMs: 8_000,
    });

    expect(view).toEqual({ ok: true, until: NOW.getTime() + 8_000 });
    expect(h.messaging.sendTyping).toHaveBeenCalledWith(
      'user-1',
      ACCOUNT,
      String(CHAT),
      { status: 'typing' },
    );
    expect(h.states.stateOf(ACCOUNT, CHAT)).toBe('composing');

    await vi.advanceTimersByTimeAsync(4_000);
    expect(typingCalls(h)).toBe(2);

    await vi.advanceTimersByTimeAsync(4_001);
    expect(cancelCalls(h)).toBe(1);
    expect(h.states.stateOf(ACCOUNT, CHAT)).toBe('idle');

    // Nothing is left running after the deadline.
    const after = h.messaging.sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.messaging.sendTyping.mock.calls.length).toBe(after);
  });

  it('renews the deadline without restarting the heartbeat', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    await h.service.typing('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      status: 'typing',
      durationMs: 8_000,
    });
    expect(typingCalls(h)).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    const renewed = await h.service.typing('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      status: 'typing',
      durationMs: 2_000,
    });
    expect(renewed.until).toBe(NOW.getTime() + 5_000);
    // Renewal does not send an extra action; the interval keeps its cadence.
    expect(typingCalls(h)).toBe(1);

    // The original interval (every 4 s) still fires at t=4 s…
    await vi.advanceTimersByTimeAsync(1_000);
    expect(typingCalls(h)).toBe(2);

    // …while the new deadline (t=5 s) is honoured.
    await vi.advanceTimersByTimeAsync(1_001);
    expect(cancelCalls(h)).toBe(1);
    expect(h.states.stateOf(ACCOUNT, CHAT)).toBe('idle');
  });

  it('stops on an explicit cancel', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    await h.service.typing('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      status: 'typing',
      durationMs: 60_000,
    });
    expect(typingCalls(h)).toBe(1);

    await expect(
      h.service.typing('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        status: 'cancel',
      }),
    ).resolves.toEqual({ ok: true });

    expect(cancelCalls(h)).toBe(1);
    expect(h.states.stateOf(ACCOUNT, CHAT)).toBe('idle');
    const after = h.messaging.sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.messaging.sendTyping.mock.calls.length).toBe(after);
  });

  it('does not send a cancel when nothing was shown', async () => {
    const h = harness();
    await h.service.typing('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      status: 'cancel',
    });
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
  });

  it('stays silent outside the soul allowlist', async () => {
    const h = harness();
    h.autopilot.isChatAllowed.mockResolvedValueOnce(false);

    await expect(
      h.service.typing('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        status: 'typing',
      }),
    ).resolves.toEqual({ ok: true, skipped: true });
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
    expect(h.states.stateOf(ACCOUNT, CHAT)).toBe('idle');
  });

  it('refuses a blocked chat with 403', async () => {
    const h = harness({ block: blockRow() });
    const error = await failure(() =>
      h.service.typing('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        status: 'typing',
      }),
    );
    expect(error.getStatus()).toBe(403);
    expect(codeOf(error)).toBe('CHAT_BLOCKED');
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
    expect(h.states.stateOf(ACCOUNT, CHAT)).toBe('blocked');
  });

  it('rejects an invalid status with 400', async () => {
    const h = harness();
    const error = await failure(() =>
      h.service.typing('user-1', {
        accountId: ACCOUNT,
        chatId: CHAT,
        status: 'dancing',
      }),
    );
    expect(error.getStatus()).toBe(400);
    expect(codeOf(error)).toBe('VALIDATION_ERROR');
    expect(h.messaging.sendTyping).not.toHaveBeenCalled();
  });

  it('clamps durationMs into 1–60 s', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    const short = await h.service.typing('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      status: 'typing',
      durationMs: 10,
    });
    expect(short.until).toBe(NOW.getTime() + 1_000);

    const long = await h.service.typing('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      status: 'typing',
      durationMs: 120_000,
    });
    expect(long.until).toBe(NOW.getTime() + 60_000);
  });

  it('clears every heartbeat on module destroy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const h = harness();

    await h.service.typing('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      status: 'typing',
    });
    h.service.onModuleDestroy();

    const after = h.messaging.sendTyping.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.messaging.sendTyping.mock.calls.length).toBe(after);
  });
});

describe('N8nActionsService.read', () => {
  it('marks the chat read and reports the state', async () => {
    const h = harness();
    const result = await h.service.read('user-1', {
      accountId: ACCOUNT,
      chatId: CHAT,
      messageId: 55,
    });

    expect(h.messaging.markRead).toHaveBeenCalledWith(
      'user-1',
      ACCOUNT,
      String(CHAT),
      { maxId: 55 },
    );
    expect(result).toEqual({ read: true, maxId: 77, state: 'read' });
  });

  it('allows a read without a message id', async () => {
    const h = harness();
    await h.service.read('user-1', { accountId: ACCOUNT, chatId: CHAT });
    expect(h.messaging.markRead).toHaveBeenCalledWith(
      'user-1',
      ACCOUNT,
      String(CHAT),
      { maxId: undefined },
    );
  });

  it('does not mark a chat outside the soul allowlist read', async () => {
    const h = harness();
    h.autopilot.isChatAllowed.mockResolvedValueOnce(false);

    await expect(
      h.service.read('user-1', { accountId: ACCOUNT, chatId: CHAT }),
    ).resolves.toMatchObject({ read: false, maxId: null, skipped: true });
    expect(h.messaging.markRead).not.toHaveBeenCalled();
    expect(h.states.stateOf(ACCOUNT, CHAT)).toBe('idle');
  });
});

describe('N8nActionsService.presence', () => {
  it('delegates the explicit online switch', async () => {
    const h = harness();
    await expect(
      h.service.presence('user-1', { accountId: ACCOUNT, online: false }),
    ).resolves.toEqual({ online: false });
    expect(h.presenceService.setOnline).toHaveBeenCalledWith(ACCOUNT, false);

    await expect(
      h.service.presence('user-1', { accountId: ACCOUNT, online: true }),
    ).resolves.toEqual({ online: true });
    expect(h.presenceService.setOnline).toHaveBeenLastCalledWith(ACCOUNT, true);
  });

  it('rejects a missing online flag', async () => {
    const h = harness();
    const error = await failure(() =>
      h.service.presence('user-1', { accountId: ACCOUNT }),
    );
    expect(error.getStatus()).toBe(400);
    expect(h.presenceService.setOnline).not.toHaveBeenCalled();
  });
});
