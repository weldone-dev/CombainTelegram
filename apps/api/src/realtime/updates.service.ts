import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { TelegramClient } from '@mtcute/node';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientManagerService } from '../telegram/client-manager.service.js';
import { resolveActiveSession } from '../accounts/active-session.js';
import { toMessageView } from '../messaging/message-view.js';
import { emitLog } from '../logs/log-sink.js';
import { EventDeduplicator } from './dedupe.js';
import { RealtimeService } from './realtime.service.js';

/** Minimal shape of mtcute's `Emitter<T>` (add/remove a listener). */
interface ListenerEmitter<T> {
  add(listener: (value: T) => void): void;
  remove(listener: (value: T) => void): void;
}

interface SessionState {
  accountId: string;
  sessionId: string;
  client: TelegramClient;
  disposers: Array<() => void>;
}

/**
 * Subscribes to Telegram updates for every session of a user's accounts and
 * re-publishes them through {@link RealtimeService}.
 *
 * One user can have several sessions per Telegram account (PC + phone). Each
 * session gets its own set of listeners and its own `startUpdatesLoop()`;
 * identical events seen through different sessions of the same account are
 * deduplicated for 10 seconds so the browser receives one event.
 */
@Injectable()
export class UpdatesService implements OnModuleDestroy {
  private readonly logger = new Logger(UpdatesService.name);
  private readonly sessions = new Map<string, Map<string, SessionState>>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly dedupe = new EventDeduplicator();
  /** Accounts already logged as "served by TDLib" at debug level. */
  private readonly tdlibAccounts = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly clients: ClientManagerService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Idempotent: subscribes to every session of the user's accounts that is not
   * subscribed yet, then starts the updates loop. Safe to call on every WS
   * connect/reconnect and after new accounts are attached.
   */
  startForUser(userId: string): Promise<void> {
    const running = this.starting.get(userId);
    if (running) return running;

    const promise = this.subscribeUser(userId).finally(() => {
      this.starting.delete(userId);
    });
    this.starting.set(userId, promise);
    return promise;
  }

  /**
   * Re-checks the user's accounts after a session was attached. Unlike
   * {@link startForUser} it does nothing when the user has no live WS
   * subscription, so attaching an account does not spin up update loops for
   * users who are not listening.
   */
  async refreshForUser(userId: string): Promise<void> {
    if (!this.sessions.has(userId)) return;
    await this.startForUser(userId);
  }

  async stopForUser(userId: string): Promise<void> {
    const sessions = this.sessions.get(userId);
    this.sessions.delete(userId);
    if (!sessions) return;

    await Promise.allSettled(
      [...sessions.values()].map((state) => this.dispose(state)),
    );
  }

  isStarted(userId: string): boolean {
    return this.sessions.has(userId);
  }

  /**
   * Drops every live subscription of the user and subscribes again, so a
   * changed transport (proxy assignment) is picked up without a WS reconnect.
   * No-op when the user has no active subscription.
   */
  async reconnectForUser(userId: string): Promise<void> {
    if (!this.sessions.has(userId)) return;
    await this.stopForUser(userId);
    await this.startForUser(userId);
  }

  async onModuleDestroy(): Promise<void> {
    const users = [...this.sessions.keys()];
    await Promise.allSettled(users.map((userId) => this.stopForUser(userId)));
    this.dedupe.reset();
  }

  private async subscribeUser(userId: string): Promise<void> {
    let userSessions = this.sessions.get(userId);
    if (!userSessions) {
      userSessions = new Map<string, SessionState>();
      this.sessions.set(userId, userSessions);
    }

    const accounts = await this.prisma.telegramAccount.findMany({
      where: { userId },
      include: { sessions: true },
    });

    for (const account of accounts) {
      // Realtime follows the active engine of the account. A TDLib-active
      // account is served by `TdUpdatesService`; mtcute updates for the same
      // account would carry a different id space, so they are dropped
      // entirely instead of racing the TDLib bridge.
      const active = resolveActiveSession(account);
      if (!active || active.engine === 'tdlib') {
        if (!this.tdlibAccounts.has(account.id)) {
          this.tdlibAccounts.add(account.id);
          this.logger.debug(
            `Skipping mtcute updates for account ${account.id}: its active session is TDLib`,
          );
        }
        continue;
      }
      this.tdlibAccounts.delete(account.id);

      for (const session of account.sessions) {
        if (session.revokedAt) continue;
        // TDLib sessions are not mtcute clients; realtime for them is handled
        // separately, so they must never reach ClientManagerService.
        if (session.engine === 'tdlib') continue;
        if (userSessions.has(session.id)) continue;

        try {
          const client = await this.clients.clientForSession(session);
          const state: SessionState = {
            accountId: account.id,
            sessionId: session.id,
            client,
            disposers: [],
          };
          this.bind(state, userId);
          userSessions.set(session.id, state);

          try {
            await client.startUpdatesLoop();
          } catch (error) {
            this.logger.warn(
              `Could not start the updates loop for session ${session.id}: ${(error as Error).message}`,
            );
            emitLog({
              level: 'warn',
              source: 'realtime',
              action: 'realtime.updates.start',
              message: `Could not start the updates loop for session ${session.id}: ${(error as Error).message}`,
              status: 'failed',
              accountId: account.id,
              sessionId: session.id,
              proxyId: session.proxyId,
              details: { error: (error as Error).message },
            });
          }
        } catch (error) {
          this.logger.warn(
            `Could not subscribe to session ${session.id} of account ${account.id}: ${(error as Error).message}`,
          );
          emitLog({
            level: 'warn',
            source: 'realtime',
            action: 'realtime.updates.subscribe',
            message: `Could not subscribe to session ${session.id} of account ${account.id}: ${(error as Error).message}`,
            status: 'failed',
            accountId: account.id,
            sessionId: session.id,
            proxyId: session.proxyId,
            details: { error: (error as Error).message },
          });
        }
      }
    }
  }

  private bind(state: SessionState, userId: string): void {
    const { accountId, sessionId, client } = state;
    const emit = (event: string, payload: unknown): void => {
      this.realtime.emitToUser(userId, event, payload);
    };
    const add = <T>(
      emitter: ListenerEmitter<T>,
      listener: (value: T) => void,
    ): void => {
      emitter.add(listener);
      state.disposers.push(() => emitter.remove(listener));
    };

    add(client.onNewMessage, (message) => {
      const chatId = message.chat.id;
      if (!this.dedupe.shouldEmit(`${accountId}:${chatId}:${message.id}:new`)) {
        return;
      }
      emit('message.new', {
        accountId,
        sessionId,
        chatId,
        message: toMessageView(message),
      });
    });

    add(client.onEditMessage, (message) => {
      const chatId = message.chat.id;
      if (
        !this.dedupe.shouldEmit(`${accountId}:${chatId}:${message.id}:edited`)
      ) {
        return;
      }
      emit('message.edited', {
        accountId,
        sessionId,
        chatId,
        message: toMessageView(message),
      });
    });

    add(client.onDeleteMessage, (update) => {
      const chatId = update.channelId ?? null;
      const messageIds = update.messageIds;
      const key = `${accountId}:${chatId ?? 'null'}:${messageIds.join('.')}:deleted`;
      if (!this.dedupe.shouldEmit(key)) return;
      emit('message.deleted', { accountId, sessionId, chatId, messageIds });
    });

    add(client.onHistoryRead, (update) => {
      const kind = update.isOutbox ? 'read_outbox' : 'read_inbox';
      const key = `${accountId}:${update.chatId}:${update.maxReadId}:${kind}`;
      if (!this.dedupe.shouldEmit(key)) return;
      emit('message.read', {
        accountId,
        chatId: update.chatId,
        maxId: update.maxReadId,
        outbox: update.isOutbox,
        unread: update.unreadCount,
      });
    });

    add(client.onUserTyping, (update) => {
      const key = `${accountId}:${update.chatId}:${update.userId}:typing:${update.status}`;
      if (!this.dedupe.shouldEmit(key)) return;
      emit('chat.typing', {
        accountId,
        chatId: update.chatId,
        userId: update.userId,
        status: update.status,
        chatType: update.chatType,
      });
    });
  }

  private async dispose(state: SessionState): Promise<void> {
    for (const dispose of state.disposers) {
      try {
        dispose();
      } catch {
        // listener already gone
      }
    }
    state.disposers.length = 0;

    await state.client.stopUpdatesLoop().catch((error: unknown) => {
      this.logger.debug(
        `Could not stop the updates loop for session ${state.sessionId}: ${(error as Error).message}`,
      );
    });
  }
}
