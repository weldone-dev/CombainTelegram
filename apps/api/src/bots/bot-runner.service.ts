import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { TelegramBotModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { BotsService } from './bots.service.js';
import { TelegramBotApi, BotApiError } from './telegram-bot-api.js';
import type { BotApiUpdate } from './telegram-bot-api.js';
import { AgentService } from '../ai/agent.service.js';
import { SkillsService } from '../ai/skills.service.js';
import { DefaultUserService } from '../user-context/default-user.service.js';
import { emitLog } from '../logs/log-sink.js';
import type { LlmMessage } from '../ai/ai.types.js';

const HELP = `Я — ИИ-ассистент этого приложения.

Просто напишите задачу обычным текстом, например:
• «Создай душу для аккаунта: спокойный, ироничный, помогает по работе»
• «Покажи последние сообщения в чате X»
• «Сделай автоответ на сообщения от Ани»

Команды:
/id — ваш Telegram id и id чата
/reset — очистить контекст этого диалога
/help — эта справка`;

function chunk(text: string, size = 3900): string[] {
  const result: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    result.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) result.push(rest);
  return result;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Long-polls every enabled bot. The shared bot (`soul-creator`) edits souls,
 * skills and automations; per-account bots assist their own account with the
 * skill set attached to them.
 */
@Injectable()
export class BotRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BotRunnerService.name);
  private readonly loops = new Map<string, AbortController>();
  private supervisor?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: BotsService,
    private readonly users: DefaultUserService,
    private readonly agent: AgentService,
    private readonly skills: SkillsService,
  ) {}

  onModuleInit(): void {
    this.supervisor = setInterval(() => void this.sync(), 10_000);
    void this.sync();
  }

  onModuleDestroy(): void {
    if (this.supervisor) clearInterval(this.supervisor);
    for (const controller of this.loops.values()) controller.abort();
    this.loops.clear();
  }

  /** Starts loops for new bots and stops loops for removed/disabled ones. */
  private async sync(): Promise<void> {
    try {
      const pollable = await this.bots.pollable();
      const active = new Set(pollable.map(({ bot }) => bot.id));
      for (const [id, controller] of this.loops) {
        if (!active.has(id)) {
          controller.abort();
          this.loops.delete(id);
        }
      }
      for (const { bot, token } of pollable) {
        if (this.loops.has(bot.id)) continue;
        const controller = new AbortController();
        this.loops.set(bot.id, controller);
        void this.loop(bot, token, controller.signal).finally(() => {
          this.loops.delete(bot.id);
        });
      }
    } catch (error) {
      this.logger.warn(`Bot supervisor tick failed: ${(error as Error).message}`);
    }
  }

  private async loop(
    bot: TelegramBotModel,
    token: string,
    signal: AbortSignal,
  ): Promise<void> {
    const api = new TelegramBotApi(token);
    try {
      await api.deleteWebhook();
    } catch (error) {
      this.logger.warn(
        `deleteWebhook failed for bot ${bot.id}: ${(error as Error).message}`,
      );
    }
    let offset = Number(bot.lastUpdateId);
    while (!signal.aborted) {
      try {
        const updates = await api.getUpdates(offset, 25);
        for (const update of updates) {
          if (signal.aborted) break;
          offset = Math.max(offset, update.update_id + 1);
          await this.handleUpdate(bot, api, update);
        }
        if (updates.length > 0) {
          await this.bots.setPolling(bot.id, {
            lastUpdateId: BigInt(offset),
            lastError: null,
          });
        }
      } catch (error) {
        if (signal.aborted) break;
        const message =
          error instanceof BotApiError
            ? error.message
            : (error as Error).message;
        await this.bots
          .setPolling(bot.id, { lastError: message.slice(0, 500) })
          .catch(() => undefined);
        emitLog({
          level: 'warn',
          source: 'bot',
          action: 'bot.poll',
          message: `Long poll failed for bot ${bot.id}: ${message}`,
          status: 'failed',
        });
        await sleep(
          error instanceof BotApiError && error.status === 409 ? 30_000 : 5_000,
          signal,
        );
      }
    }
  }

  /** Handles one Bot API update; split out of the polling loop for tests. */
  async handleUpdate(
    bot: TelegramBotModel,
    api: TelegramBotApi,
    update: BotApiUpdate,
  ): Promise<void> {
    const message = update.message;
    if (!message || !message.text) return;
    if (message.chat.type !== 'private') return;
    if (message.from?.is_bot) return;
    await this.handle(bot, api, message, message.text);
  }

  private async handle(
    bot: TelegramBotModel,
    api: TelegramBotApi,
    message: NonNullable<BotApiUpdate['message']>,
    rawText: string,
  ): Promise<void> {
    const chatId = message.chat.id;
    const senderId = message.from?.id ?? chatId;
    const allowed = await this.bots.allowedTgUserIds(bot);
    if (allowed.length > 0 && !allowed.includes(String(senderId))) {
      await api
        .sendMessage(
          chatId,
          `Этот бот привязан к аккаунту владельца. Ваш id: ${senderId}`,
        )
        .catch(() => undefined);
      emitLog({
        level: 'warn',
        source: 'bot',
        action: 'bot.deny',
        message: `Unauthorized bot user ${senderId}`,
        status: 'failed',
        details: { botId: bot.id },
      });
      return;
    }

    const text = rawText.trim();
    if (text === '/start' || text === '/help') {
      await api.sendMessage(chatId, HELP).catch(() => undefined);
      return;
    }
    if (text === '/id') {
      await api
        .sendMessage(
          chatId,
          `user_id: ${senderId}\nchat_id: ${chatId}\nbot: @${bot.username ?? 'unknown'}`,
        )
        .catch(() => undefined);
      return;
    }
    if (text === '/reset') {
      await this.prisma.botTurn.deleteMany({
        where: { botId: bot.id, chatId: BigInt(chatId) },
      });
      await api.sendMessage(chatId, 'Контекст диалога очищен.').catch(
        () => undefined,
      );
      return;
    }

    const user = await this.users.get();
    const history = (await this.prisma.botTurn.findMany({
      where: { botId: bot.id, chatId: BigInt(chatId) },
      orderBy: { createdAt: 'desc' },
      take: 12,
    })) as Array<{ role: string; content: string }>;
    const messages: LlmMessage[] = history
      .reverse()
      .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
      .map((turn) => ({
        role: turn.role === 'assistant' ? 'assistant' : 'user',
        content: turn.content,
      }));

    const skillSlugs = await this.skills.forBot(bot.id);
    const defaultSkill =
      bot.mode === 'soul-creator' ? 'soul-creator' : 'telegram-assistant';
    const slugs =
      skillSlugs.length > 0
        ? skillSlugs.map((skill) => skill.slug)
        : [defaultSkill];

    await api.sendChatAction(chatId).catch(() => undefined);

    try {
      const result = await this.agent.run({
        userId: user.id,
        accountId: bot.accountId ?? null,
        chatId: null,
        source: bot.mode === 'soul-creator' ? 'soul-creator' : 'bot',
        prompt: text,
        history: messages,
        skillSlugs: slugs,
        systemExtra:
          bot.mode === 'soul-creator'
            ? 'Ты общаешься с владельцем через Telegram-бота «Создатель душ». Отвечай простым текстом без Markdown, задавай не больше одного вопроса за сообщение.'
            : 'Ты — ассистент одного Telegram-аккаунта в его личном боте. Отвечай простым текстом без Markdown.',
      });

      const reply = result.text.trim() || 'Готово.';
      for (const part of chunk(reply)) {
        await api.sendMessage(chatId, part).catch((error: unknown) => {
          this.logger.warn(
            `Bot ${bot.id} could not send a reply: ${(error as Error).message}`,
          );
        });
      }
      await this.prisma.botTurn.createMany({
        data: [
          { botId: bot.id, chatId: BigInt(chatId), role: 'user', content: text.slice(0, 4000) },
          { botId: bot.id, chatId: BigInt(chatId), role: 'assistant', content: reply.slice(0, 4000) },
        ],
      });
      const total = await this.prisma.botTurn.count({
        where: { botId: bot.id, chatId: BigInt(chatId) },
      });
      if (total > 40) {
        const old = (await this.prisma.botTurn.findMany({
          where: { botId: bot.id, chatId: BigInt(chatId) },
          orderBy: { createdAt: 'asc' },
          take: total - 40,
          select: { id: true },
        })) as Array<{ id: string }>;
        await this.prisma.botTurn.deleteMany({
          where: { id: { in: old.map((turn) => turn.id) } },
        });
      }
    } catch (error) {
      await api
        .sendMessage(
          chatId,
          `Не получилось: ${(error as Error).message.slice(0, 500)}`,
        )
        .catch(() => undefined);
      emitLog({
        level: 'error',
        source: 'bot',
        action: 'bot.reply',
        message: `Bot ${bot.id} failed: ${(error as Error).message}`,
        status: 'failed',
      });
    }
  }
}
