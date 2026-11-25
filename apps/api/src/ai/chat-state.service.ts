import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RealtimeService } from '../realtime/realtime.service.js';
import type { TypingMode } from './typing.js';

/**
 * Lifecycle of one AI answer in one chat:
 *
 * `received` → `read` → `waiting` → `thinking` → `composing` → `sending`
 * → `sent` → (`idle` after ~2 s).
 *
 * `blocked`, `superseded` and `error` are terminal side states: a blocked chat
 * never reaches the model, a newer message takes a running reply over, and a
 * failed generation reports `error`. `idle` is the resting state of a chat no
 * run owns.
 */
export type ChatAiState =
  | 'idle'
  | 'received'
  | 'read'
  | 'thinking'
  | 'composing'
  | 'sending'
  | 'sent'
  | 'waiting'
  | 'blocked'
  | 'superseded'
  | 'error';

/** What the dashboard sees for one `accountId:chatId`. */
export interface ChatStateRecord {
  accountId: string;
  chatId: number;
  state: ChatAiState;
  /** When this state was entered, epoch milliseconds. */
  since: number;
  /** Agent run that owns the state, once the model has started. */
  runId: string | null;
  /** Incoming (or generated) message the state is about. */
  messageId: number | null;
  /** 1-based bubble being sent; 0 while nothing is being sent. */
  part: number;
  /** Total bubbles of the answer; 0 while unknown. */
  total: number;
  /** Explicit typing policy currently applied to the chat. */
  typingMode: TypingMode | null;
}

/** WS payload of `ai.state`: the record without the resolved-at-read bits. */
export interface AiStatePayload {
  accountId: string;
  chatId: number;
  state: ChatAiState;
  since: number;
  runId: string | null;
  messageId: number | null;
  part: number;
  total: number;
}

export interface ChatStateTransition {
  accountId: string;
  chatId: number;
  state: ChatAiState;
  /** Owner of the WS event; required on the first transition of a chat. */
  userId?: string;
  runId?: string | null;
  messageId?: number | null;
  part?: number;
  total?: number;
  typingMode?: TypingMode | null;
}

/** `sent` becomes `idle` after this pause, milliseconds. */
export const SENT_TO_IDLE_MS = 2_000;
/** A record not touched for this long is dropped from memory. */
export const CHAT_STATE_TTL_MS = 30 * 60_000;
/** How often expired records are swept, milliseconds. */
const SWEEP_INTERVAL_MS = 60_000;

interface StoredState extends ChatStateRecord {
  userId: string;
  /** Pending `sent → idle` timer, if any. */
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const ACTIVE_STATES: ReadonlySet<ChatAiState> = new Set<ChatAiState>([
  'received',
  'read',
  'waiting',
  'thinking',
  'composing',
  'sending',
]);

/** True when a run still owns the chat and a newer message should supersede it. */
export function isActiveState(state: ChatAiState): boolean {
  return ACTIVE_STATES.has(state);
}

/**
 * In-memory, per-chat AI state machine.
 *
 * Deliberately not persisted: the state describes a live reply of this process
 * (a run in flight, a heartbeat in progress), and a restart legitimately comes
 * back as `idle`. Every transition is mirrored as an `ai.state` WS event; the
 * state itself is never sent to Telegram.
 */
@Injectable()
export class ChatStateService implements OnModuleInit, OnModuleDestroy {
  private readonly records = new Map<string, StoredState>();
  /**
   * Started by the lifecycle hook, not the constructor: unit tests build the
   * service directly with fake timers and must not inherit a 60 s interval.
   */
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly realtime: RealtimeService) {}

  onModuleInit(): void {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const record of this.records.values()) {
      if (record.idleTimer) clearTimeout(record.idleTimer);
    }
    this.records.clear();
  }

  private key(accountId: string, chatId: number): string {
    return `${accountId}:${chatId}`;
  }

  /** Current record, or a resting `idle` one for a chat nothing has run in. */
  get(accountId: string, chatId: number): ChatStateRecord {
    const stored = this.records.get(this.key(accountId, chatId));
    if (stored) return this.publicRecord(stored);
    return {
      accountId,
      chatId,
      state: 'idle',
      since: 0,
      runId: null,
      messageId: null,
      part: 0,
      total: 0,
      typingMode: null,
    };
  }

  /** Current state name; `idle` when nothing has run in the chat yet. */
  stateOf(accountId: string, chatId: number): ChatAiState {
    return this.records.get(this.key(accountId, chatId))?.state ?? 'idle';
  }

  /**
   * Applies one transition and emits `ai.state` to the owner's room.
   *
   * Unspecified fields are reset instead of silently inheriting the previous
   * run (`runId`, `messageId`, `part`, `total`): a new run must not be
   * attributed to the old one. `typingMode` is sticky while unknown so a
   * mid-run transition does not lose the policy.
   */
  transition(input: ChatStateTransition): ChatStateRecord {
    const key = this.key(input.accountId, input.chatId);
    const previous = this.records.get(key);
    const userId = input.userId ?? previous?.userId ?? '';
    if (previous?.idleTimer) {
      clearTimeout(previous.idleTimer);
      previous.idleTimer = null;
    }

    const record: StoredState = {
      accountId: input.accountId,
      chatId: input.chatId,
      state: input.state,
      since: Date.now(),
      runId: input.runId ?? null,
      messageId: input.messageId ?? null,
      part: Math.max(0, Math.round(input.part ?? 0)),
      total: Math.max(0, Math.round(input.total ?? 0)),
      typingMode: input.typingMode ?? previous?.typingMode ?? null,
      userId,
      idleTimer: null,
    };
    this.records.set(key, record);

    if (record.state === 'sent') {
      const timer = setTimeout(() => {
        const current = this.records.get(key);
        if (!current || current.state !== 'sent') return;
        this.transition({
          accountId: current.accountId,
          chatId: current.chatId,
          userId: current.userId,
          state: 'idle',
          typingMode: current.typingMode,
        });
      }, SENT_TO_IDLE_MS);
      timer.unref?.();
      record.idleTimer = timer;
    }

    this.emit(userId, record);
    return this.publicRecord(record);
  }

  /** Forgets a chat (tests, explicit resets). */
  clear(accountId: string, chatId: number): void {
    const key = this.key(accountId, chatId);
    const record = this.records.get(key);
    if (record?.idleTimer) clearTimeout(record.idleTimer);
    this.records.delete(key);
  }

  /** Drops records that no transition touched for {@link CHAT_STATE_TTL_MS}. */
  private sweep(now = Date.now()): void {
    for (const [key, record] of this.records) {
      if (now - record.since < CHAT_STATE_TTL_MS) continue;
      if (record.idleTimer) clearTimeout(record.idleTimer);
      this.records.delete(key);
    }
  }

  private publicRecord(record: StoredState): ChatStateRecord {
    return {
      accountId: record.accountId,
      chatId: record.chatId,
      state: record.state,
      since: record.since,
      runId: record.runId,
      messageId: record.messageId,
      part: record.part,
      total: record.total,
      typingMode: record.typingMode,
    };
  }

  private emit(userId: string, record: StoredState): void {
    if (!userId) return;
    const payload: AiStatePayload = {
      accountId: record.accountId,
      chatId: record.chatId,
      state: record.state,
      since: record.since,
      runId: record.runId,
      messageId: record.messageId,
      part: record.part,
      total: record.total,
    };
    this.realtime.emitToUser(userId, 'ai.state', payload);
  }
}
