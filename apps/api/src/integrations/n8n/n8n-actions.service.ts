import { HttpStatus, Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type {
  AiAccessView,
  AiUnblockResult,
  AiWarningResult,
} from '../../ai-access/ai-access.service.js';
import { AiAccessService } from '../../ai-access/ai-access.service.js';
import type { ChatMemoryView } from '../../ai-chat/ai-chat-memory.service.js';
import { AiChatMemoryService } from '../../ai-chat/ai-chat-memory.service.js';
import { AiChatTagsService } from '../../ai-chat/ai-chat-tags.service.js';
import type { FactView } from '../../ai/memory.service.js';
import { MemoryService } from '../../ai/memory.service.js';
import type {
  GenerateReplyResult,
  SendTextResult,
} from '../../ai/dm-autopilot.service.js';
import { DmAutopilotService } from '../../ai/dm-autopilot.service.js';
import { ChatStateService } from '../../ai/chat-state.service.js';
import type { ChatAiState } from '../../ai/chat-state.service.js';
import { AgentToolsService } from '../../ai/agent-tools.service.js';
import { PresenceService } from '../../ai/presence.service.js';
import { SoulsService, parseSoulSettings } from '../../ai/souls.service.js';
import { clampTypingHeartbeat } from '../../ai/typing.js';
import { AutomationsService } from '../../automations/automations.service.js';
import { apiError } from '../../common/api-error.js';
import { emitLog } from '../../logs/log-sink.js';
import { MessagingService } from '../../messaging/messaging.service.js';
import { parseTypingSendOption } from '../../messaging/params.js';
import { N8nAccountsService } from './n8n-accounts.service.js';
import {
  MAX_PARTS,
  bodyOf,
  optionalBoolean,
  optionalChatId,
  optionalInteger,
  optionalMessageId,
  optionalText,
  optionalThreadId,
  outgoingParts,
  requireBoolean,
  requireChatId,
  requireText,
  requireTypingStatus,
  splitOutgoingText,
} from './n8n-params.js';

export interface SendTextView extends SendTextResult {
  sent: boolean;
}

export interface SoulReplyView {
  sent: boolean;
  superseded: boolean;
  /** Present only when `replyToMessageId` was already answered recently. */
  duplicate?: true;
  text: string;
  messageIds: number[];
  /** Live state machine of the chat after the run. */
  state: ChatAiState;
}

/** `POST /actions/generate`: parts without sending or typing. */
export type GenerateView = GenerateReplyResult;

/** `POST /actions/typing`. */
export interface TypingView {
  ok: true;
  /** Epoch ms when the heartbeat stops by itself (only for `typing`). */
  until?: number;
  /** The chat is outside the soul allowlist, so nothing was sent. */
  skipped?: true;
}

/** `POST /actions/read`. */
export interface ReadActionView {
  read: boolean;
  maxId: number | null;
  state: ChatAiState;
  /** The chat is outside the soul allowlist, so nothing was sent. */
  skipped?: true;
}

/** `POST /actions/presence`. */
export interface PresenceActionView {
  online: boolean;
}

/** Default lifetime of one explicit typing heartbeat, milliseconds. */
export const TYPING_DEFAULT_MS = 8_000;
export const TYPING_MIN_MS = 1_000;
export const TYPING_MAX_MS = 60_000;

interface TypingHeartbeat {
  userId: string;
  /** Sends `typing` every `typingHeartbeatMs`. */
  timer: ReturnType<typeof setInterval>;
  /** Stops the heartbeat at the deadline. */
  deadline: ReturnType<typeof setTimeout>;
  until: number;
}

export interface ChatMemoryActionView {
  accountId: string;
  chatId: number;
  summary: string;
  facts: ChatMemoryView['longTerm']['facts'];
  turns: ChatMemoryView['shortTerm'];
}

export interface TagsView {
  accountId: string;
  chatId: number;
  tags: string[];
  available: true;
}

export interface TagsRemovedView extends TagsView {
  removed: boolean;
}

export interface AutomationToggleView {
  accountId: string;
  chatId: number;
  threadId: number;
  count: number;
  automationIds: string[];
}

export interface ToolCallView {
  ok: boolean;
  result: unknown;
  dryRun: boolean;
}

/** Tool errors that mean "the policy said no", mapped to 403. */
const POLICY_CODES = new Set([
  'CAPABILITY_DISABLED',
  'ACCOUNT_SCOPE',
  'TOOL_NOT_ALLOWED',
  'CHAT_BLOCKED',
  'CHAT_NOT_ALLOWED',
]);

/** A soul reply for the same message is never generated twice in this window. */
export const SOUL_REPLY_DEDUPE_TTL_MS = 15 * 60 * 1000;
/** LRU cap of the dedupe map; older entries are evicted first. */
export const SOUL_REPLY_DEDUPE_LIMIT = 2000;

/** Response for an already-answered message: no LLM call, no send. */
function duplicateSoulReply(): SoulReplyView {
  return {
    sent: false,
    superseded: false,
    duplicate: true,
    text: '',
    messageIds: [],
    state: 'idle',
  };
}

/**
 * The Action API n8n calls after it has read an event.
 *
 * Every method is an explicit, owner-initiated action: no workflow gate
 * applies (that gate only silences the *automatic* reply), but blocks,
 * capability policy and account ownership still do. `read` and `typing` also
 * stay silent outside the soul allowlist, so a workflow triggered for every
 * incoming message cannot mark a stranger's chat read or show "typing…" there.
 */
@Injectable()
export class N8nActionsService implements OnModuleDestroy {
  /**
   * Recently answered messages, `accountId:chatId:messageId -> timestamp`.
   * In-process on purpose: a duplicate webhook retry hits the same instance
   * within seconds, and a real multi-node deployment would need a shared store.
   */
  private readonly recentReplies = new Map<string, number>();
  /**
   * Explicit "typing…" heartbeats started by the workflow, one per chat.
   * A second `typing` call only moves the deadline; the interval keeps its
   * cadence so the action does not restart mid-cycle.
   */
  private readonly typingBeats = new Map<string, TypingHeartbeat>();

  constructor(
    private readonly accounts: N8nAccountsService,
    private readonly access: AiAccessService,
    private readonly automations: AutomationsService,
    private readonly memory: MemoryService,
    private readonly chatMemory: AiChatMemoryService,
    private readonly tags: AiChatTagsService,
    private readonly autopilot: DmAutopilotService,
    private readonly tools: AgentToolsService,
    private readonly messaging: MessagingService,
    private readonly presenceService: PresenceService,
    private readonly souls: SoulsService,
    private readonly states: ChatStateService,
  ) {}

  onModuleDestroy(): void {
    for (const beat of this.typingBeats.values()) {
      clearInterval(beat.timer);
      clearTimeout(beat.deadline);
    }
    this.typingBeats.clear();
  }

  /**
   * Sends one or more text bubbles, `---`-separated or as an explicit `parts`
   * array, capped at 4096 characters each.
   *
   * `typing` defaults to `auto`: the soul's typing policy decides how long
   * "typing…" is shown. `off` sends instantly, a number is an explicit
   * simulation in milliseconds. The reply returns the live chat `state` and
   * the total `typingMs`, so a workflow can see what happened.
   *
   * Deliberately not deduplicated: the owner (or a workflow) may repeat the
   * same text on purpose, and each call is an explicit action. Blocks still
   * apply, so a blocked chat is refused with 403.
   */
  async sendText(userId: string, raw: unknown): Promise<SendTextView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const threadId = optionalThreadId(body.threadId);
    const replyToId = optionalMessageId(body.replyToId);
    const quote = optionalText(body.quote, 'quote', 200);
    const typing = parseTypingSendOption(body.typing) ?? 'auto';
    // An explicit `parts` array wins; otherwise the text is split on `---`
    // and capped at Telegram's own 4096 characters per bubble.
    const parts =
      outgoingParts(body.parts) ??
      splitOutgoingText(requireText(body.text, 'text', 4096 * MAX_PARTS));

    await this.accounts.requireAccount(userId, accountId);
    await this.assertNotBlocked(userId, accountId, chatId, threadId);

    const result = await this.autopilot.sendText({
      userId,
      accountId,
      chatId,
      threadId,
      parts,
      replyToId,
      quote,
      typing,
    });
    return { sent: result.messageIds.length > 0, ...result };
  }

  /**
   * Generates a reply and returns its bubbles without sending or typing.
   *
   * The soul, skills, permissions, memory, history and media context are
   * resolved inside; the workflow can preview the parts, edit them, and send
   * them later with `send-text` — or not send them at all.
   */
  async generate(userId: string, raw: unknown): Promise<GenerateView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const threadId = optionalThreadId(body.threadId);
    const messageId = optionalMessageId(body.messageId);
    const prompt = optionalText(body.prompt, 'prompt', 4000);
    const maxParts = optionalInteger(body.maxParts, 'maxParts', 1, 3);

    await this.accounts.requireAccount(userId, accountId);
    return this.autopilot.generateReply({
      userId,
      accountId,
      chatId,
      threadId,
      messageId,
      prompt,
      maxParts,
    });
  }

  /**
   * Generates a soul reply through the autopilot pipeline and sends it, unless
   * `returnText` asks for the text only. A newer incoming message cancels the
   * run and comes back as `{ sent: false, superseded: true }`.
   *
   * When `replyToMessageId` is present the call is idempotent for
   * {@link SOUL_REPLY_DEDUPE_TTL_MS}: the key is reserved before the LLM runs,
   * so a webhook retry or a duplicate delivery returns `duplicate: true`
   * without another generation or send.
   */
  async soulReply(userId: string, raw: unknown): Promise<SoulReplyView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const threadId = optionalThreadId(body.threadId);
    const prompt = optionalText(body.prompt, 'prompt', 4000);
    const replyToMessageId = optionalMessageId(body.replyToMessageId);
    const returnText = optionalBoolean(body.returnText, 'returnText');

    await this.accounts.requireAccount(userId, accountId);

    const key =
      replyToMessageId === undefined
        ? null
        : this.replyKey(accountId, chatId, replyToMessageId);
    if (key && this.alreadyAnswered(key)) {
      emitLog({
        level: 'debug',
        source: 'app',
        action: 'n8n.action.duplicate',
        message: `Skipped a duplicate soul reply for message ${replyToMessageId}`,
        status: 'ok',
        accountId,
        chatId,
        details: { kind: 'soul-reply', accountId, chatId, messageId: replyToMessageId },
      });
      return duplicateSoulReply();
    }
    if (key) this.rememberReply(key);

    try {
      return await this.autopilot.replyNow({
        userId,
        accountId,
        chatId,
        threadId,
        prompt,
        replyToMessageId,
        returnText,
      });
    } catch (error) {
      // A failed run must stay retryable: release the key so the next delivery
      // may try again instead of being mistaken for a duplicate.
      if (key) this.recentReplies.delete(key);
      throw error;
    }
  }

  /**
   * Explicit "typing…" control for the workflow.
   *
   * `typing` starts (or renews) a server-side heartbeat that refreshes the
   * action every `typingHeartbeatMs` of the soul policy (default 4 s, clamped
   * to 2–5 s) and stops by itself after `durationMs` (default 8 s, clamped to
   * 1–60 s). A second call on the same chat only moves the deadline; the
   * interval keeps running. `cancel` stops the heartbeat immediately.
   *
   * This is an explicit owner action: only ownership and a block are checked,
   * a workflow-assigned account is allowed to type.
   */
  async typing(userId: string, raw: unknown): Promise<TypingView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const threadId = optionalThreadId(body.threadId);
    const status = requireTypingStatus(body.status);
    const durationMs =
      optionalInteger(
        body.durationMs,
        'durationMs',
        TYPING_MIN_MS,
        TYPING_MAX_MS,
      ) ?? TYPING_DEFAULT_MS;

    await this.accounts.requireAccount(userId, accountId);

    if (status === 'cancel') {
      await this.stopTypingHeartbeat(userId, accountId, chatId);
      return { ok: true };
    }

    const decision = await this.access.accessFor(
      userId,
      accountId,
      chatId,
      threadId,
    );
    if (decision.block) {
      // A blocked chat may not show "typing…"; drop an existing heartbeat too
      // without emitting an intermediate `idle`.
      const beat = this.clearTypingBeat(accountId, chatId);
      if (beat) {
        await this.messaging
          .sendTyping(userId, accountId, String(chatId), { status: 'cancel' })
          .catch(() => undefined);
      }
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'blocked',
      });
      throw apiError(
        'CHAT_BLOCKED',
        decision.block.reason
          ? `Chat is blocked: ${decision.block.reason}`
          : 'Chat is blocked for the AI',
        HttpStatus.FORBIDDEN,
      );
    }

    if (!(await this.autopilot.isChatAllowed(userId, accountId, chatId, threadId))) {
      await this.stopTypingHeartbeat(userId, accountId, chatId);
      emitLog({
        level: 'debug',
        source: 'app',
        action: 'n8n.action.typing',
        message: `Typing skipped in ${chatId}: chat is outside the soul allowlist`,
        status: 'ok',
        accountId,
        chatId,
      });
      return { ok: true, skipped: true };
    }

    const soul = await this.souls.model(accountId);
    const policy = parseSoulSettings(soul?.settings);
    const heartbeatMs = clampTypingHeartbeat(policy.typingHeartbeatMs);
    const until = Date.now() + durationMs;
    const key = this.chatKey(accountId, chatId);
    const existing = this.typingBeats.get(key);

    if (existing) {
      // Renewal: same interval, new deadline.
      clearTimeout(existing.deadline);
      existing.until = until;
      existing.deadline = this.typingDeadline(
        userId,
        accountId,
        chatId,
        durationMs,
      );
    } else {
      const send = (): void => {
        void this.messaging
          .sendTyping(userId, accountId, String(chatId), { status: 'typing' })
          .catch(() => undefined);
      };
      send();
      const timer = setInterval(send, heartbeatMs);
      timer.unref?.();
      this.typingBeats.set(key, {
        userId,
        timer,
        deadline: this.typingDeadline(
          userId,
          accountId,
          chatId,
          durationMs,
        ),
        until,
      });
    }

    this.states.transition({
      userId,
      accountId,
      chatId,
      state: 'composing',
      typingMode: policy.typingMode,
    });
    emitLog({
      level: 'debug',
      source: 'app',
      action: 'n8n.action.typing',
      message: `Typing heartbeat in ${chatId} until ${new Date(until).toISOString()} (every ${heartbeatMs} ms)`,
      status: 'ok',
      accountId,
      chatId,
      details: { heartbeatMs, durationMs, until },
    });
    return { ok: true, until };
  }

  /**
   * Explicit read receipt: marks the chat read up to `messageId` (or the whole
   * chat) and reports the resulting state.
   */
  async read(userId: string, raw: unknown): Promise<ReadActionView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const messageId = optionalMessageId(body.messageId);

    await this.accounts.requireAccount(userId, accountId);
    if (!(await this.autopilot.isChatAllowed(userId, accountId, chatId, 0))) {
      emitLog({
        level: 'debug',
        source: 'app',
        action: 'n8n.action.read',
        message: `Read skipped in ${chatId}: chat is outside the soul allowlist`,
        status: 'ok',
        accountId,
        chatId,
      });
      return {
        read: false,
        maxId: null,
        state: this.states.stateOf(accountId, chatId),
        skipped: true,
      };
    }
    const result = await this.messaging.markRead(
      userId,
      accountId,
      String(chatId),
      { maxId: messageId },
    );
    this.states.transition({
      userId,
      accountId,
      chatId,
      state: 'read',
      messageId: messageId ?? null,
    });
    return {
      read: result.read,
      maxId: result.maxId,
      state: this.states.stateOf(accountId, chatId),
    };
  }

  /**
   * Explicit presence switch of the account: online or offline right now.
   * The presence scheduler resumes afterwards (going online re-arms the idle
   * window), so the forced value does not stick forever.
   */
  async presence(
    userId: string,
    raw: unknown,
  ): Promise<PresenceActionView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const online = requireBoolean(body.online, 'online');

    await this.accounts.requireAccount(userId, accountId);
    return this.presenceService.setOnline(accountId, online);
  }

  private chatKey(accountId: string, chatId: number): string {
    return `${accountId}:${chatId}`;
  }

  /** Timer that stops the heartbeat of one chat after `ms`. */
  private typingDeadline(
    userId: string,
    accountId: string,
    chatId: number,
    ms: number,
  ): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      void this.stopTypingHeartbeat(userId, accountId, chatId);
    }, ms);
    timer.unref?.();
    return timer;
  }

  /**
   * Stops the heartbeat of one chat, hides the action if it was shown and
   * returns the chat state to `idle`.
   */
  /** Removes the heartbeat of one chat and clears its timers. */
  private clearTypingBeat(
    accountId: string,
    chatId: number,
  ): TypingHeartbeat | null {
    const key = this.chatKey(accountId, chatId);
    const beat = this.typingBeats.get(key);
    if (!beat) return null;
    clearInterval(beat.timer);
    clearTimeout(beat.deadline);
    this.typingBeats.delete(key);
    return beat;
  }

  private async stopTypingHeartbeat(
    userId: string,
    accountId: string,
    chatId: number,
  ): Promise<void> {
    const beat = this.clearTypingBeat(accountId, chatId);
    if (beat) {
      await this.messaging
        .sendTyping(userId, accountId, String(chatId), { status: 'cancel' })
        .catch(() => undefined);
    }
    this.states.transition({ userId, accountId, chatId, state: 'idle' });
    if (beat) {
      emitLog({
        level: 'debug',
        source: 'app',
        action: 'n8n.action.typing.stop',
        message: `Typing heartbeat in ${chatId} stopped`,
        status: 'ok',
        accountId,
        chatId,
      });
    }
  }

  /** Stores one durable fact about the chat. */
  async memoryAdd(userId: string, raw: unknown): Promise<{ fact: FactView }> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const kind = optionalText(body.kind, 'kind', 32) ?? 'fact';
    const content = requireText(body.content, 'content', 600);
    const importance = optionalInteger(body.importance, 'importance', 1, 5);

    await this.accounts.requireAccount(userId, accountId);
    const fact = await this.memory.addFact(accountId, chatId, content, {
      kind,
      importance,
      source: 'n8n',
    });
    return { fact };
  }

  /** Summary, facts and the recent turns of one chat. */
  async memoryView(
    userId: string,
    accountId: string,
    chatId: number,
    limit?: unknown,
  ): Promise<ChatMemoryActionView> {
    const view = await this.chatMemory.view(
      userId,
      accountId,
      chatId,
      optionalInteger(limit, 'limit', 1, 200),
    );
    return {
      accountId,
      chatId,
      summary: view.longTerm.summary,
      facts: view.longTerm.facts,
      turns: view.shortTerm,
    };
  }

  /** Drops turns, summary and facts of one chat (the Telegram history stays). */
  async memoryClear(
    userId: string,
    raw: unknown,
  ): Promise<{ accountId: string; chatId: number; cleared: true }> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    await this.accounts.requireAccount(userId, accountId);
    await this.memory.clearChat(accountId, chatId);
    return { accountId, chatId, cleared: true };
  }

  /** Tags attached to one chat, oldest first. */
  async tagsView(
    userId: string,
    accountId: string,
    chatId: number,
  ): Promise<TagsView> {
    await this.accounts.requireAccount(userId, accountId);
    return {
      accountId,
      chatId,
      tags: await this.tags.list(accountId, chatId),
      available: true,
    };
  }

  /** Adds one tag (idempotent) and returns the full list. */
  async tagsSet(userId: string, raw: unknown): Promise<TagsView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    await this.accounts.requireAccount(userId, accountId);
    return {
      accountId,
      chatId,
      tags: await this.tags.add(accountId, chatId, body.tag),
      available: true,
    };
  }

  /** Removes one tag (idempotent) and returns the full list. */
  async tagsRemove(userId: string, raw: unknown): Promise<TagsRemovedView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    await this.accounts.requireAccount(userId, accountId);
    const result = await this.tags.remove(accountId, chatId, body.tag);
    return {
      accountId,
      chatId,
      tags: result.tags,
      removed: result.removed,
      available: true,
    };
  }

  /** Adds one warning; the configured threshold turns it into a block. */
  async warn(userId: string, raw: unknown): Promise<AiWarningResult> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const threadId = optionalThreadId(body.threadId);
    const reason = optionalText(body.reason, 'reason', 400);
    await this.accounts.requireAccount(userId, accountId);
    return this.access.bumpWarning({
      userId,
      accountId,
      chatId,
      threadId,
      reason,
      blockedBy: 'user',
    });
  }

  /** Blocks a chat/topic. A reason of at least 3 characters is required. */
  async block(userId: string, raw: unknown): Promise<AiAccessView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const threadId = optionalThreadId(body.threadId);
    const reason = optionalText(body.reason, 'reason', 400);
    if (!reason || [...reason].length < 3) {
      throw apiError(
        'REASON_REQUIRED',
        'reason must be at least 3 characters',
      );
    }
    await this.accounts.requireAccount(userId, accountId);
    return this.access.block({
      userId,
      accountId,
      chatId,
      threadId,
      reason,
      blockedBy: 'user',
    });
  }

  /** Lifts the block and resets the warning counter of that chat/topic. */
  async unblock(userId: string, raw: unknown): Promise<AiUnblockResult> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const threadId = optionalThreadId(body.threadId);
    await this.accounts.requireAccount(userId, accountId);
    return this.access.unblock(userId, accountId, chatId, threadId);
  }

  /** Pauses every automation bound to the chat/topic. */
  async pauseAutomations(
    userId: string,
    raw: unknown,
  ): Promise<AutomationToggleView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const threadId = optionalThreadId(body.threadId);
    const reason = optionalText(body.reason, 'reason', 400);
    await this.accounts.requireAccount(userId, accountId);
    const rows = await this.automations.pauseForChat({
      accountId,
      chatId,
      threadId,
      reason: reason ?? null,
    });
    return {
      accountId,
      chatId,
      threadId,
      count: rows.length,
      automationIds: rows.map((row) => row.id),
    };
  }

  /** Clears the soul's self-pause for every automation of the chat/topic. */
  async resumeAutomations(
    userId: string,
    raw: unknown,
  ): Promise<AutomationToggleView> {
    const body = bodyOf(raw);
    const accountId = requireText(body.accountId, 'accountId', 64);
    const chatId = requireChatId(body.chatId);
    const threadId = optionalThreadId(body.threadId);
    await this.accounts.requireAccount(userId, accountId);
    const rows = await this.automations.resume({ accountId, chatId, threadId });
    return {
      accountId,
      chatId,
      threadId,
      count: rows.length,
      automationIds: rows.map((row) => row.id),
    };
  }

  /**
   * Runs one registry tool through the shared policy. A capability disabled
   * for the account (or globally) refuses with 403 instead of a silent no-op.
   */
  async tool(
    userId: string,
    name: string,
    raw: unknown,
  ): Promise<ToolCallView> {
    const body = bodyOf(raw);
    const accountId = optionalText(body.accountId, 'accountId', 64);
    const chatId = optionalChatId(body.chatId);
    if (accountId) await this.accounts.requireAccount(userId, accountId);
    const args = body.args === undefined ? {} : body.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw apiError('VALIDATION_ERROR', 'args must be an object');
    }

    const result = await this.tools.execute(name, args, {
      userId,
      accountId: accountId ?? null,
      chatId: chatId ?? null,
      source: 'automation',
    });
    if (!result.ok) {
      const code = result.code ?? 'TOOL_ERROR';
      const status =
        code === 'UNKNOWN_TOOL'
          ? HttpStatus.NOT_FOUND
          : POLICY_CODES.has(code)
            ? HttpStatus.FORBIDDEN
            : HttpStatus.BAD_REQUEST;
      throw apiError(code, result.error ?? 'Tool call failed', status);
    }
    return { ok: true, result: result.result, dryRun: result.dryRun === true };
  }

  private async assertNotBlocked(
    userId: string,
    accountId: string,
    chatId: number,
    threadId: number,
  ): Promise<void> {
    const decision = await this.access.accessFor(
      userId,
      accountId,
      chatId,
      threadId,
    );
    if (!decision.block) return;
    throw apiError(
      'CHAT_BLOCKED',
      decision.block.reason
        ? `Chat is blocked: ${decision.block.reason}`
        : 'Chat is blocked for the AI',
      HttpStatus.FORBIDDEN,
    );
  }

  private replyKey(
    accountId: string,
    chatId: number,
    messageId: number,
  ): string {
    return `${accountId}:${chatId}:${messageId}`;
  }

  /** True when the key is still inside the TTL; expired entries are dropped. */
  private alreadyAnswered(key: string, now = Date.now()): boolean {
    const at = this.recentReplies.get(key);
    if (at === undefined) return false;
    if (now - at >= SOUL_REPLY_DEDUPE_TTL_MS) {
      this.recentReplies.delete(key);
      return false;
    }
    return true;
  }

  /** Marks the key as answered and keeps the map at its LRU cap. */
  private rememberReply(key: string, now = Date.now()): void {
    this.recentReplies.delete(key);
    this.recentReplies.set(key, now);
    while (this.recentReplies.size > SOUL_REPLY_DEDUPE_LIMIT) {
      const oldest = this.recentReplies.keys().next().value;
      if (oldest === undefined) break;
      this.recentReplies.delete(oldest);
    }
  }
}
