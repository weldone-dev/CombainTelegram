import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { Client } from 'tdlib-native';
import type { message, user } from 'tdlib-native/types';
import type {
  TelegramAccountModel,
  TelegramSessionModel,
} from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { emitLog } from '../logs/log-sink.js';
import { EventDeduplicator } from '../realtime/dedupe.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import type { PeerLike } from '../messaging/message-view.js';
import { TdChatRegistry } from './td-chat-registry.js';
import { TdClientManagerService } from './td-client-manager.service.js';
import { peerOfTdChat, peerOfTdUser } from './td-message-view.js';
import {
  chatTypeFromTdChatType,
  mapEditedMessage,
  mapTdUpdate,
} from './td-updates.mapping.js';
import type {
  TdHandledUpdate,
  TdMappedEvent,
  TdUpdateContext,
} from './td-updates.mapping.js';

interface TdSessionState {
  accountId: string;
  sessionId: string;
  client: Client;
  registry: TdChatRegistry;
  users: Map<number, user>;
  userRequests: Map<number, Promise<user | null>>;
  dispose: () => void;
}

type AccountWithSessions = TelegramAccountModel & {
  sessions: TelegramSessionModel[];
};

/**
 * TDLib counterpart of `UpdatesService`.
 *
 * Subscribes to every non-revoked `engine = "tdlib"` session of a user's
 * accounts and re-publishes the updates through {@link RealtimeService} using
 * the same events and marked-peer-id payloads as mtcute. TDLib delivers an
 * update once per session, so the same 10 s `EventDeduplicator` window keeps
 * duplicate PC/phone deliveries away from the browser.
 *
 * The native client is owned by `TdClientManagerService`; stopping a user only
 * removes listeners and never destroys the client.
 */
@Injectable()
export class TdUpdatesService implements OnModuleDestroy {
  private readonly logger = new Logger(TdUpdatesService.name);
  private readonly sessions = new Map<string, Map<string, TdSessionState>>();
  private readonly starting = new Map<string, Promise<void>>();
  private readonly dedupe = new EventDeduplicator();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tdClients: TdClientManagerService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Idempotent: subscribes to every not-yet-bound TDLib session of the user. */
  startForUser(userId: string): Promise<void> {
    const running = this.starting.get(userId);
    if (running) return running;

    const promise = this.subscribeUser(userId).finally(() => {
      this.starting.delete(userId);
    });
    this.starting.set(userId, promise);
    return promise;
  }

  /** Re-checks after a TDLib session attaches; no-op without a live subscriber. */
  async refreshForUser(userId: string): Promise<void> {
    if (!this.sessions.has(userId)) return;
    await this.startForUser(userId);
  }

  async stopForUser(userId: string): Promise<void> {
    const sessions = this.sessions.get(userId);
    this.sessions.delete(userId);
    if (!sessions) return;

    for (const state of sessions.values()) {
      try {
        state.dispose();
      } catch {
        // Listener already gone.
      }
    }
  }

  isStarted(userId: string): boolean {
    return this.sessions.has(userId);
  }

  /** Drops listeners and re-subscribes, e.g. after the client was reopened. */
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
      userSessions = new Map<string, TdSessionState>();
      this.sessions.set(userId, userSessions);
    }

    const accounts = (await this.prisma.telegramAccount.findMany({
      where: { userId },
      include: { sessions: true },
    })) as AccountWithSessions[];

    for (const account of accounts) {
      for (const session of account.sessions) {
        if (session.revokedAt) continue;
        if (session.engine !== 'tdlib') continue;
        if (userSessions.has(session.id)) continue;

        try {
          const client = await this.tdClients.clientForSession(session);
          const state = this.bind(userId, account.id, session, client);
          userSessions.set(session.id, state);
        } catch (error) {
          const message = (error as Error).message;
          this.logger.warn(
            `Could not subscribe to the TDLib session ${session.id} of account ${account.id}: ${message}`,
          );
          emitLog({
            level: 'warn',
            source: 'realtime',
            action: 'realtime.tdlib.subscribe',
            message: `Could not subscribe to the TDLib session ${session.id} of account ${account.id}: ${message}`,
            status: 'failed',
            userId,
            accountId: account.id,
            sessionId: session.id,
            proxyId: session.proxyId,
            details: { error: message },
          });
        }
      }
    }
  }

  private bind(
    userId: string,
    accountId: string,
    session: TelegramSessionModel,
    client: Client,
  ): TdSessionState {
    const registry = new TdChatRegistry(client);
    registry.attach();
    void registry.seed().catch(() => undefined);

    const state: TdSessionState = {
      accountId,
      sessionId: session.id,
      client,
      registry,
      users: new Map(),
      userRequests: new Map(),
      dispose: () => undefined,
    };

    const unsubscribeUsers = client.updates.subscribe((update) => {
      if (update._ === 'updateUser') state.users.set(update.user.id, update.user);
    });
    const unsubscribeUpdates = client.updates.subscribe((update) => {
      void this.handleUpdate(userId, state, update as TdHandledUpdate);
    });

    state.dispose = () => {
      unsubscribeUpdates();
      unsubscribeUsers();
      registry.dispose();
    };
    return state;
  }

  private contextFor(state: TdSessionState): TdUpdateContext {
    return {
      accountId: state.accountId,
      sessionId: state.sessionId,
      chat: (chatId) => state.registry.get(chatId),
      chatType: (chatId) => {
        const entry = state.registry.get(chatId);
        return entry ? chatTypeFromTdChatType(entry.type) : undefined;
      },
      resolveSender: (entry) => this.senderPeer(state, entry),
    };
  }

  private senderPeer(state: TdSessionState, entry: message): PeerLike | undefined {
    const sender = entry.sender_id;
    if (sender?._ === 'messageSenderUser') {
      const cached = state.users.get(sender.user_id);
      return cached ? peerOfTdUser(cached, sender.user_id) : undefined;
    }
    if (sender?._ === 'messageSenderChat') {
      const cached = state.registry.get(sender.chat_id);
      if (cached) return peerOfTdChat(cached);
    }
    return undefined;
  }

  private ensureUser(
    state: TdSessionState,
    userId: number,
  ): Promise<user | null> {
    const cached = state.users.get(userId);
    if (cached) return Promise.resolve(cached);
    const inflight = state.userRequests.get(userId);
    if (inflight) return inflight;

    const request = state.client.api
      .getUser({ user_id: userId })
      .then((entry) => {
        state.users.set(entry.id, entry);
        return entry;
      })
      .catch(() => null)
      .finally(() => state.userRequests.delete(userId));
    state.userRequests.set(userId, request);
    return request;
  }

  /** Fetches sender users so the mapper can use real names. */
  private async warmMessages(
    state: TdSessionState,
    messages: message[],
  ): Promise<void> {
    const ids = new Set<number>();
    for (const entry of messages) {
      if (entry.sender_id?._ === 'messageSenderUser') {
        ids.add(entry.sender_id.user_id);
      }
    }
    await Promise.all([...ids].map((id) => this.ensureUser(state, id)));
  }

  /** Handles one TDLib update; never throws into the TDLib emitter. */
  private async handleUpdate(
    userId: string,
    state: TdSessionState,
    update: TdHandledUpdate,
  ): Promise<void> {
    try {
      if (update._ === 'updateNewMessage') {
        await this.warmMessages(state, [update.message]);
        const mapped = mapTdUpdate(update, this.contextFor(state));
        if (mapped?.type === 'event') this.publish(userId, mapped);
        return;
      }

      const mapped = mapTdUpdate(update, this.contextFor(state));
      if (!mapped) return;

      if (mapped.type === 'fetch') {
        let fresh: message;
        try {
          fresh = await state.client.api.getMessage({
            chat_id: mapped.tdChatId,
            message_id: mapped.messageId,
          });
        } catch (error) {
          this.logFailure(
            userId,
            state,
            'realtime.tdlib.edit',
            `Could not fetch edited message ${mapped.messageId} in chat ${mapped.tdChatId}: ${(error as Error).message}`,
          );
          return;
        }
        await this.warmMessages(state, [fresh]);
        this.publish(
          userId,
          mapEditedMessage(fresh, this.contextFor(state)),
        );
        return;
      }

      this.publish(userId, mapped);
    } catch (error) {
      this.logFailure(
        userId,
        state,
        'realtime.tdlib.update',
        `Could not map TDLib update ${update._}: ${(error as Error).message}`,
      );
    }
  }

  private publish(userId: string, mapped: TdMappedEvent): void {
    if (!this.dedupe.shouldEmit(mapped.dedupeKey)) return;
    this.realtime.emitToUser(userId, mapped.event, mapped.payload);
  }

  private logFailure(
    userId: string,
    state: TdSessionState,
    action: string,
    text: string,
  ): void {
    this.logger.warn(text);
    emitLog({
      level: 'warn',
      source: 'realtime',
      action,
      message: text,
      status: 'failed',
      userId,
      accountId: state.accountId,
      sessionId: state.sessionId,
      details: { error: text },
    });
  }
}
