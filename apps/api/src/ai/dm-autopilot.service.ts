import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type { MessageView } from '../messaging/message-view.js';
import type { TelegramAccountModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { DefaultUserService } from '../user-context/default-user.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { UpdatesService } from '../realtime/updates.service.js';
import { TdUpdatesService } from '../tdlib/td-updates.service.js';
import { emitLog } from '../logs/log-sink.js';
import { AgentService } from './agent.service.js';
import { MemoryService } from './memory.service.js';
import { SoulsService, parseSoulSettings } from './souls.service.js';
import { typingDurationMs } from './typing.js';

interface MessageNewPayload {
  accountId?: unknown;
  chatId?: unknown;
  message?: Partial<MessageView>;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  accountId: string;
  chatId: number;
  message: MessageView;
  senderName: string;
}

const BATCH_MS = 1500;
const MAX_AGE_MS = 120_000;

/** Autopilot only ever works in `draft` or `auto`; anything else is off. */
function isAutopilotMode(mode: string): boolean {
  return mode === 'draft' || mode === 'auto';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.min(15_000, ms)));
}

/**
 * Always-on listener for incoming personal messages. Replies only when the
 * account has a soul with `mode = "auto"` (or produces a draft in
 * `mode = "draft"`) and the chat is allowlisted by the soul settings. All
 * other accounts/chats are ignored, so test traffic never messages strangers.
 */
@Injectable()
export class DmAutopilotService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DmAutopilotService.name);
  private subscription?: Subscription;
  private readonly pending = new Map<string, Pending>();
  private readonly busy = new Set<string>();
  private readonly seen = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: DefaultUserService,
    private readonly messaging: MessagingService,
    private readonly realtime: RealtimeService,
    private readonly updates: UpdatesService,
    private readonly tdUpdates: TdUpdatesService,
    private readonly agent: AgentService,
    private readonly memory: MemoryService,
    private readonly souls: SoulsService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.subscription = this.realtime.events$.subscribe((event) => {
      if (event.event !== 'message.new') return;
      void this.onMessage(event.userId, event.payload).catch((error) => {
        this.logger.warn(
          `Autopilot event failed: ${(error as Error).message}`,
        );
      });
    });

    // Updates usually start on the first WS connection. Autopilot must work
    // with no dashboard open, so subscribe at boot as well.
    try {
      const user = await this.users.get();
      await this.tdUpdates.startForUser(user.id);
      await this.updates.startForUser(user.id);
    } catch (error) {
      this.logger.warn(
        `Could not start Telegram updates for autopilot: ${(error as Error).message}`,
      );
    }
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }

  private async onMessage(userId: string, payload: unknown): Promise<void> {
    const data = payload as MessageNewPayload;
    const accountId = typeof data.accountId === 'string' ? data.accountId : '';
    const chatId = Number(data.chatId);
    const message = data.message as MessageView | undefined;
    if (!accountId || !Number.isSafeInteger(chatId) || !message) return;
    if (message.outgoing || message.service) return;
    if (!message.id) return;
    if (chatId <= 0) return; // private chats only (groups/channels are negative)
    if (Date.now() - new Date(message.date).getTime() > MAX_AGE_MS) return;

    const account = (await this.prisma.telegramAccount.findUnique({
      where: { id: accountId },
    })) as TelegramAccountModel | null;
    if (!account) return;
    if (Number(account.tgUserId) === chatId) return; // Saved Messages

    const soul = await this.souls.model(accountId);
    if (!soul || !isAutopilotMode(soul.mode)) return;
    if (!this.souls.allowsChat(soul, chatId)) return;

    const key = `${accountId}:${chatId}:${message.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 5000) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }

    const text = (message.text || '').trim();
    if (!text && !message.mediaType) return;
    const senderName = message.senderName || `Чат ${chatId}`;

    // A human shows the read receipt the moment the message is opened, so the
    // agent marks everything up to this message as read before generating the
    // reply — not after the typing simulation a minute later.
    await this.markRead(userId, accountId, chatId, message.id);

    const chatKey = `${accountId}:${chatId}`;
    const existing = this.pending.get(chatKey);
    if (existing) clearTimeout(existing.timer);
    const settings = parseSoulSettings(soul.settings);
    const timer = setTimeout(() => {
      this.pending.delete(chatKey);
      void this.reply(userId, accountId, chatId, message, senderName).catch(
        (error) => {
          this.logger.warn(
            `Autopilot reply failed: ${(error as Error).message}`,
          );
        },
      );
    }, Math.min(BATCH_MS, Math.max(200, settings.replyDelayMs)));
    this.pending.set(chatKey, {
      timer,
      accountId,
      chatId,
      message,
      senderName,
    });
  }

  /**
   * Marks the chat read up to `messageId` on the active engine. Read receipts
   * are best-effort: a failure must never block the autopilot reply.
   */
  private async markRead(
    userId: string,
    accountId: string,
    chatId: number,
    messageId: number,
  ): Promise<void> {
    try {
      await this.messaging.markRead(userId, accountId, String(chatId), {
        maxId: messageId,
      });
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.read',
        message: `Read up to message ${messageId} in ${chatId}`,
        status: 'ok',
        accountId,
        chatId,
      });
    } catch (error) {
      this.logger.warn(
        `Could not mark chat ${chatId} as read: ${(error as Error).message}`,
      );
    }
  }

  /** Keeps the Telegram "typing…" action alive for `durationMs`. */
  private async holdTyping(
    userId: string,
    accountId: string,
    chatId: number,
    durationMs: number,
  ): Promise<void> {
    const end = Date.now() + durationMs;
    do {
      await this.messaging
        .sendTyping(userId, accountId, String(chatId), { status: 'typing' })
        .catch(() => undefined);
      const left = end - Date.now();
      if (left > 0) await sleep(Math.min(4_000, left));
    } while (Date.now() < end);
  }

  private async reply(
    userId: string,
    accountId: string,
    chatId: number,
    message: MessageView,
    senderName: string,
  ): Promise<void> {
    const chatKey = `${accountId}:${chatId}`;
    if (this.busy.has(chatKey)) return;
    const soul = await this.souls.model(accountId);
    if (!soul || !isAutopilotMode(soul.mode)) return;
    if (!this.souls.allowsChat(soul, chatId)) return;
    const settings = parseSoulSettings(soul.settings);

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [perHour, perChat] = await Promise.all([
      this.prisma.soulTurn.count({
        where: {
          accountId,
          role: 'assistant',
          createdAt: { gte: hourAgo },
        },
      }),
      this.prisma.soulTurn.count({
        where: {
          accountId,
          chatId: BigInt(chatId),
          role: 'assistant',
          createdAt: { gte: dayAgo },
        },
      }),
    ]);
    if (settings.maxPerHour > 0 && perHour >= settings.maxPerHour) {
      emitLog({
        level: 'warn',
        source: 'ai',
        action: 'dm.autopilot.rate_limit',
        message: `Per-hour limit reached (${settings.maxPerHour})`,
        status: 'failed',
        accountId,
        chatId,
      });
      return;
    }
    if (settings.maxPerChatPerDay > 0 && perChat >= settings.maxPerChatPerDay) {
      return;
    }

    this.busy.add(chatKey);
    try {
      const text = message.text.trim() || `[${message.mediaType ?? 'media'}]`;
      const prompt = [
        `Входящее личное сообщение от «${senderName}»:`,
        text.slice(0, 4000),
        '',
        soul.mode === 'draft'
          ? 'Предложи ответ от лица владельца. Верни только текст ответа.'
          : 'Ответь от лица владельца. Верни только текст ответа.',
      ].join('\n');

      if (settings.typing && soul.mode === 'auto') {
        await this.messaging
          .sendTyping(userId, accountId, String(chatId))
          .catch(() => undefined);
      }

      const result = await this.agent.run({
        userId,
        accountId,
        chatId,
        source: 'dm',
        prompt,
        tools: [],
        systemExtra:
          'Это живая переписка. Не упоминай ИИ, инструменты и настройки. Один короткий ответ, без кавычек и Markdown.',
        history: (
          await this.memory.recentTurns(accountId, chatId, 10)
        )
          .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
          .map((turn) => ({
            role: turn.role === 'assistant' ? 'assistant' : 'user',
            content: turn.content,
          })),
      });

      const replyText = result.text.trim();
      if (!replyText) return;

      await this.memory.append(accountId, chatId, 'user', text, {
        messageId: message.id,
      });

      if (soul.mode === 'draft') {
        await this.memory.append(accountId, chatId, 'draft', replyText, {
          runId: result.runId,
        });
        this.realtime.emitToUser(userId, 'ai.draft', {
          accountId,
          chatId,
          text: replyText,
          senderName,
          runId: result.runId,
        });
        return;
      }

      await sleep(settings.replyDelayMs);
      if (settings.typing) {
        await this.holdTyping(
          userId,
          accountId,
          chatId,
          typingDurationMs([...replyText].length, settings.typingSpeed),
        );
      }
      const sent = await this.messaging.sendMessage(
        userId,
        accountId,
        String(chatId),
        { text: replyText, replyToId: message.id },
      );
      await this.memory.append(accountId, chatId, 'assistant', replyText, {
        messageId: sent.id,
        runId: result.runId,
      });
      this.realtime.emitToUser(userId, 'ai.reply', {
        accountId,
        chatId,
        text: replyText,
        message: sent,
        runId: result.runId,
      });
      emitLog({
        level: 'info',
        source: 'ai',
        action: 'dm.autopilot.reply',
        message: `Autopilot replied in ${chatId}`,
        status: 'ok',
        accountId,
        chatId,
        details: { runId: result.runId, senderName },
      });
      void this.memory.maybeCompact(accountId, chatId);
    } finally {
      this.busy.delete(chatKey);
    }
  }
}
