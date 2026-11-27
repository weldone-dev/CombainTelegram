import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { TelegramClient } from '@mtcute/node';
import type { tl } from '@mtcute/node';
import { PrismaService } from '../prisma/prisma.service.js';
import { ClientManagerService } from '../telegram/client-manager.service.js';
import { resolveActiveSession } from '../accounts/active-session.js';
import { toMessageView } from '../messaging/message-view.js';
import { emitLog } from '../logs/log-sink.js';
import { EventDeduplicator } from './dedupe.js';
import {
  markedPeerId,
  reactionEventsFromRawUpdate,
} from './reactions.js';
import { RealtimeService } from './realtime.service.js';

/** Minimal shape of mtcute's `Emitter<T>` (add/remove a listener). */
interface ListenerEmitter<T> {
  add(listener: (value: T) => void): void;
  remove(listener: (value: T) => void): void;
}

interface RecentMessage {
  outgoing: boolean;
  /** Text/date for the deleted-message policy; absent when unknown. */
  text?: string;
  date?: string;
}

interface SessionState {
  accountId: string;
  sessionId: string;
  client: TelegramClient;
  disposers: Array<() => void>;
  /** `${chatId}:${messageId}` → author facts for delete/reaction payloads. */
  recent: Map<string, RecentMessage>;
  /**
   * Non-channel message id → chat id. Common (private/basic-group) message ids
   * are unique for the account, while channel ids live in a per-channel space.
   */
  commonChats: Map<number, number>;
}

/** Upper bound of the in-memory message index per session. */
const RECENT_MESSAGES_MAX = 2_000;
/** How many old entries a trim drops at once. */
const RECENT_MESSAGES_TRIM = 500;

/**
 * Keeps a Map bounded by insertion order: trims `batch` entries once `max` is
 * exceeded. Both maps are caches, so dropping old entries is safe.
 */
function trimOldest<K, V>(map: Map<K, V>, max: number, batch: number): void {
  if (map.size <= max) return;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++removed >= batch) break;
  }
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
            recent: new Map(),
            commonChats: new Map(),
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
      this.rememberMessage(state, chatId, message.id, message.isOutgoing, {
        text: message.text,
        date: message.date.toISOString(),
      });
      // mtcute only exposes the quoted text for an explicit quote; a plain
      // reply carries just the id. Fetch it before publishing, so Eve receives
      // `replyToText` in the same event instead of a duplicate later.
      void (async () => {
        const view = toMessageView(message);
        if (!view.replyToText && view.replyToId) {
          try {
            const [quoted] = await client.getMessages(chatId, [view.replyToId]);
            if (quoted?.text) view.replyToText = quoted.text.slice(0, 300);
          } catch {
            // Deleted or inaccessible message: keep the id-only reply.
          }
        }
        if (!this.dedupe.shouldEmit(`${accountId}:${chatId}:${message.id}:new`)) {
          return;
        }
        emit('message.new', {
          accountId,
          sessionId,
          chatId,
          message: view,
        });
      })();
    });

    add(client.onEditMessage, (message) => {
      const chatId = message.chat.id;
      this.rememberMessage(state, chatId, message.id, message.isOutgoing, {
        text: message.text,
        date: message.date.toISOString(),
      });
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
      const messageIds = update.messageIds;
      if (messageIds.length === 0) return;

      const channelId = update.channelId ?? null;
      if (channelId !== null) {
        this.emitDeleted(state, emit, channelId, 0, messageIds);
        return;
      }

      // A peer-less delete: resolve each id through the in-memory index and
      // publish one event per chat, so a private-chat delete is usable by Eve.
      // Ids not seen in this process keep the historical `chatId: null`.
      const groups = new Map<number | null, number[]>();
      for (const messageId of messageIds) {
        const chatId = state.commonChats.get(messageId) ?? null;
        const group = groups.get(chatId);
        if (group) group.push(messageId);
        else groups.set(chatId, [messageId]);
      }
      for (const [chatId, ids] of groups) {
        this.emitDeleted(state, emit, chatId, 0, ids);
      }
    });

    // mtcute 0.32 exposes reactions only as a raw aggregate update. The pure
    // mapper owns the payload shape; this listener adds the seen-message facts
    // (`targetIsMine`) and the shared 10 s dedupe window.
    if (client.onRawUpdate) {
      add(client.onRawUpdate, (raw) => {
        if (raw.update._ !== 'updateMessageReactions') return;
        void this.publishReaction(state, raw.update, emit).catch(() => undefined);
      });
    }

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

  /**
   * Resolves the reacted-to message's author and publishes one reaction event
   * per recent reactor. Own sends do not come back through `onNewMessage`
   * (mtcute `noDispatch`), so the index is filled by {@link noteOutgoing} too.
   * When the id is still unknown, fetch it once: dropping every reaction on a
   * message sent before the process started made react-back dead on mtcute.
   */
  private async publishReaction(
    state: SessionState,
    update: tl.RawUpdateMessageReactions,
    emit: (event: string, payload: unknown) => void,
  ): Promise<void> {
    const chatId = markedPeerId(update.peer);
    if (chatId === null) return;
    let target = state.recent.get(`${chatId}:${update.msgId}`);
    if (!target && chatId > 0) {
      try {
        const [message] = await state.client.getMessages(chatId, [update.msgId]);
        if (message) {
          this.rememberMessage(state, chatId, message.id, message.isOutgoing, {
            text: message.text,
            date: message.date.toISOString(),
          });
          target = state.recent.get(`${chatId}:${update.msgId}`);
        }
      } catch {
        // Deleted/inaccessible: publish without `targetIsMine`, Eve drops it.
      }
    }
    const events = reactionEventsFromRawUpdate(update, {
      accountId: state.accountId,
      sessionId: state.sessionId,
      ...(target ? { targetIsMine: target.outgoing } : {}),
    });
    for (const event of events) {
      if (!this.dedupe.shouldEmit(event.dedupeKey)) continue;
      emit('message.reaction', event.payload);
    }
  }

  /**
   * Records a message sent by this process, so a reaction on it resolves to
   * `targetIsMine: true` even though mtcute does not dispatch own sends.
   * Called for every Nest/Eve send (immediate, delayed, proactive, media).
   */
  noteOutgoing(
    accountId: string,
    chatId: number,
    messageId: number,
    text?: string,
    date?: Date,
  ): void {
    if (!Number.isSafeInteger(messageId) || messageId <= 0) return;
    for (const userSessions of this.sessions.values()) {
      for (const state of userSessions.values()) {
        if (state.accountId !== accountId) continue;
        this.rememberMessage(state, chatId, messageId, true, {
          ...(text ? { text } : {}),
          date: (date ?? new Date()).toISOString(),
        });
      }
    }
  }

  /** Drops the oldest entries so the reaction/delete index stays bounded. */
  private rememberMessage(
    state: SessionState,
    chatId: number,
    messageId: number,
    outgoing: boolean,
    extra?: { text?: string; date?: string },
  ): void {
    state.recent.set(`${chatId}:${messageId}`, {
      outgoing,
      ...(extra?.text ? { text: extra.text.slice(0, 1_000) } : {}),
      ...(extra?.date ? { date: extra.date } : {}),
    });
    // Channel messages are per-channel; private and basic-group ids are
    // unique for the account, so they can be resolved without the peer.
    if (chatId > 0) state.commonChats.set(messageId, chatId);
    trimOldest(state.recent, RECENT_MESSAGES_MAX, RECENT_MESSAGES_TRIM);
    trimOldest(state.commonChats, RECENT_MESSAGES_MAX, RECENT_MESSAGES_TRIM);
  }

  /**
   * Publishes one `message.deleted` event. `outgoing` is set only when every
   * deleted id is known: a mixed delete (his + hers) leaves it undefined, so
   * the persona layer cannot mistake it for "she deleted her own message".
   */
  private emitDeleted(
    state: SessionState,
    emit: (event: string, payload: unknown) => void,
    chatId: number | null,
    threadId: number,
    messageIds: number[],
  ): void {
    const facts = messageIds.map((id) =>
      state.recent.get(`${chatId}:${id}`),
    );
    const known = facts.filter(
      (fact): fact is RecentMessage => fact !== undefined,
    );
    const outgoing =
      known.length > 0 && known.length === messageIds.length
        ? known.every((fact) => fact.outgoing)
        : undefined;

    const key = `${state.accountId}:${chatId ?? 'null'}:${messageIds.join('.')}:deleted`;
    if (!this.dedupe.shouldEmit(key)) return;

    emit('message.deleted', {
      accountId: state.accountId,
      sessionId: state.sessionId,
      chatId,
      threadId,
      messageIds,
      // The Eve deletion policy needs the text and the arrival time to tell
      // "she read it" from "she missed it". Only ids we have seen are listed.
      messages: messageIds.map((id) => {
        const fact = state.recent.get(`${chatId}:${id}`);
        return {
          id,
          ...(fact?.outgoing !== undefined ? { outgoing: fact.outgoing } : {}),
          ...(fact?.text ? { text: fact.text } : {}),
          ...(fact?.date ? { date: fact.date } : {}),
        };
      }),
      ...(outgoing !== undefined ? { outgoing } : {}),
    });
  }

  private async dispose(state: SessionState): Promise<void> {
    state.recent.clear();
    state.commonChats.clear();
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
