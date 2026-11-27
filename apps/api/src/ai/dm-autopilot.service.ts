import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type {
  MessageMediaView,
  MessageView,
} from '../messaging/message-view.js';
import type { SoulModel, TelegramAccountModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
import { apiError, notFound } from '../common/api-error.js';
import { AiAccessService } from '../ai-access/ai-access.service.js';
import type { AiAccessDecision } from '../ai-access/ai-access.service.js';
import { AiChatSkillsService } from '../ai-chat/ai-chat-skills.service.js';
import { AiRunsService } from './ai-runs.service.js';
import { DefaultUserService } from '../user-context/default-user.service.js';
import { MessagingService } from '../messaging/messaging.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { UpdatesService } from '../realtime/updates.service.js';
import { TdUpdatesService } from '../tdlib/td-updates.service.js';
import { emitLog } from '../logs/log-sink.js';
import { AgentService } from './agent.service.js';
import { MemoryService } from './memory.service.js';
import { SoulsService, parseSoulSettings } from './souls.service.js';
import { PresenceService } from './presence.service.js';
import { SpeechService } from './speech.service.js';
import type { TypingMode, TypingPolicy } from './typing.js';
import { typesWhileThinking, typingPlan } from './typing.js';
import { MAX_BUBBLES, applyPartsPolicy, parseReply } from './dm-reply.js';
import type { ReplyPart } from './dm-reply.js';
import { ChatStateService, isActiveState } from './chat-state.service.js';
import type { ChatAiState } from './chat-state.service.js';
import {
  isAudioMedia,
  isRecentDate,
  mentionsVoice,
  pickRecentAudio,
  replyTargetId,
} from './voice-lookup.js';
import type { AiThinkingPayload } from './ai.types.js';

interface MessageNewPayload {
  accountId?: unknown;
  chatId?: unknown;
  /** Forum topic / comment thread, when the engine reports one. */
  threadId?: unknown;
  messageThreadId?: unknown;
  message?: Partial<MessageView>;
}

interface IncomingText {
  id: number;
  text: string;
  media?: MessageMediaView | null;
  /** Message this item replies to, when the peer quoted something. */
  replyToId?: number | null;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  accountId: string;
  chatId: number;
  message: MessageView;
  senderName: string;
  token: number;
  /** Consecutive messages that arrived before the reply started. */
  texts: IncomingText[];
}

/** How many consecutive messages one reply is allowed to cover. */
const MAX_BURST = 5;
/** Biggest image forwarded to a vision model, bytes. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** How many images one reply may carry. */
const MAX_IMAGES = 2;
/** The last photo stays available for a follow-up question this long. */
const LAST_IMAGE_TTL_MS = 3 * 60_000;
/** The last voice transcript stays available for a follow-up this long. */
const LAST_VOICE_TTL_MS = 3 * 60_000;
/** Longest voice transcript forwarded to the model, characters. */
const MAX_VOICE_CHARS = 1500;
/** How many recent messages an on-demand voice lookup reads. */
const VOICE_LOOKUP_WINDOW = 50;
/** A voice note older than this is not what a follow-up is asking about. */
const VOICE_LOOKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** A per-message transcript is reused for this long, milliseconds. */
const VOICE_TRANSCRIPT_TTL_MS = 24 * 60 * 60 * 1000;
/** Upper bound of the per-message transcript cache. */
const VOICE_TRANSCRIPT_MAX = 500;
/** Placeholder for a voice note that could not be transcribed. */
const VOICE_FAILED_TEXT =
  '[голосовое сообщение, расшифровать не удалось]';
/**
 * Instruction added when the peer asked about a voice note that could not be
 * turned into text. It forbids invented technical excuses explicitly, because
 * models love to answer "I have no headphones / the sound is off".
 */
const VOICE_FAILED_NOTE =
  'Голосовое не удалось расшифровать. Не придумывай причины вроде отсутствия наушников, микрофона или звука — просто скажи, что не расслышал, и попроси написать текстом.';
/** Deltas reach the dashboard at most this often, milliseconds. */
const THINKING_DELTA_INTERVAL_MS = 100;
/** …and are never smaller than this many characters. */
const THINKING_DELTA_MIN_CHARS = 16;

/**
 * Words that mean the peer is asking about a picture. Used to warn the model
 * when the text talks about an image but no image was attached. The phrase
 * "что тут находится" is the usual way a picture question arrives with no
 * photo attached, so it is matched as well.
 */
const PICTURE_WORDS = [
  'картинк',
  'скрин',
  'фото',
  'изображен',
  'снимок',
  'видишь ли',
  'что тут находится',
  'picture',
  'screenshot',
  'photo',
  'image',
];

/** Whether the incoming texts clearly refer to a picture. */
function mentionsPicture(texts: IncomingText[]): boolean {
  return texts.some((item) => {
    const text = item.text.toLowerCase();
    return PICTURE_WORDS.some((word) => text.includes(word));
  });
}

/** Whether the media is a picture a vision model can look at. */
function isImageMedia(media: MessageMediaView | null | undefined): boolean {
  if (!media || !media.downloadable) return false;
  const mime = (media.mimeType ?? '').toLowerCase();
  if (media.kind === 'photo') return true;
  // A static webp sticker is already an image; a `.tgs`/`.webm` one is not.
  if (media.kind === 'sticker') return mime.startsWith('image/');
  return media.kind === 'document' && mime.startsWith('image/');
}

/**
 * Whether the media has to become a frame collage before a vision model can
 * judge it: animated stickers/emoji, GIFs and round video notes. Static
 * pictures are sent as-is by {@link isImageMedia}.
 */
function needsFrameCollage(media: MessageMediaView | null | undefined): boolean {
  if (!media || !media.downloadable) return false;
  if (media.kind === 'animation' || media.kind === 'video_note') return true;
  return media.kind === 'sticker' && !isImageMedia(media);
}

/** Instruction added when an animated sticker/GIF collage is attached. */
const STICKER_FRAMES_NOTE =
  'Собеседник прислал стикер/анимированное эмодзи/GIF — ниже кадры по порядку; пойми эмоцию/шутку и ответь уместно.';

/** Per-burst voice transcripts, keyed by message id. */
interface VoiceResult {
  transcripts: Map<number, string>;
  /** At least one audio message could not be turned into text. */
  failed: boolean;
}

/** One audio message a follow-up question points at. */
interface VoiceReference {
  messageId: number;
  /** Empty when the lookup found audio but it could not be transcribed. */
  text: string;
  source: 'fresh' | 'cached' | 'onDemand' | 'failed';
}

interface TypingState {
  userId: string;
  accountId: string;
  chatId: number;
  token: number;
  startedAt: number;
  /** Pending delayed start (`smart` waits after the read receipt). */
  startTimer: ReturnType<typeof setTimeout> | null;
  /** Heartbeat that refreshes the action; `null` until the start fires. */
  timer: ReturnType<typeof setInterval> | null;
}

/** What one generation cycle produced; mutated by {@link generateCycle}. */
interface Generation {
  /** Agent run that produced the text, `null` when the cycle stopped early. */
  runId: string | null;
  /** Raw model text, kept for `superseded` reporting. */
  text: string;
  /** Bubbles that survived the parts policy. */
  parts: ReplyPart[];
  reasoning: string | null;
  /** Incoming messages of the burst, after voice transcription. */
  items: IncomingText[];
  /** A newer message (or explicit action) took the chat over. */
  superseded: boolean;
  /** Skills the run used, for the reply log. */
  skills: { slugs: string[]; source: string };
}

/** Result of {@link DmAutopilotService.generateReply}. */
export interface GenerateReplyResult {
  runId: string | null;
  parts: Array<{
    text: string;
    /** Incoming message the bubble should reply to, when known. */
    replyToMessageId: number | null;
    quote?: string;
  }>;
  reasoning: string | null;
  state: ChatAiState;
  superseded: boolean;
  /** The same incoming message was already generated recently. */
  duplicate: boolean;
  /** The chat/topic is blocked; nothing was generated. */
  blocked: boolean;
}

/** Input of {@link DmAutopilotService.generateReply}. */
export interface GenerateReplyInput {
  userId: string;
  accountId: string;
  chatId: number;
  threadId?: number;
  /** Incoming message the answer should reply to; also the dedupe key. */
  messageId?: number;
  /** Owner instruction instead of the peer burst (n8n). */
  prompt?: string;
  /** Bubbles the answer may use; 1–3, defaults to the soul setting. */
  maxParts?: number;
}

/** Response of {@link DmAutopilotService.sendText} (n8n `send-text`). */
export interface SendTextResult {
  messageIds: number[];
  state: ChatAiState;
  /** Total time spent showing "typing…", milliseconds. */
  typingMs: number;
}

/** What one generation cycle is asked to do. */
interface ReplyJob {
  userId: string;
  accountId: string;
  chatId: number;
  /** Forum topic / comment thread; `0` = whole chat. */
  threadId: number;
  soul: SoulModel;
  senderName: string;
  /** Run token; a newer message bumps it and cancels this run. */
  token: number;
  /** Incoming messages of the burst; empty when `promptOverride` is used. */
  texts: IncomingText[];
  /**
   * Owner-issued instruction instead of a peer burst (n8n Action API). When
   * set, it replaces the assembled incoming prompt and nothing is stored as a
   * user turn: the owner is not the peer.
   */
  promptOverride?: string;
  /** Default message to reply to when a part names no incoming message. */
  replyToId?: number | null;
  /** Store the incoming texts as user turns (false for prompt overrides). */
  storeIncoming: boolean;
  /** Legacy draft mode: store a draft instead of sending it. */
  draft: boolean;
  /** Generate and return the text without sending anything. */
  returnText: boolean;
  /** Bubble cap of this run; overrides the soul setting when set. */
  maxParts?: number;
}

/** What one generation cycle produced; mutated by `produceReply`. */
interface ReplyOutcome {
  /** A newer message (or an explicit action) took the chat over. */
  superseded: boolean;
  /** Generated text, joined with a blank line between bubbles. */
  text: string;
  /** Telegram ids of the bubbles that were actually sent. */
  messageIds: number[];
  runId: string | null;
}

/** `AI_WORKFLOW_STRICT` and friends: `1`/`true` mean on. */
function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value?.toLowerCase() === 'true';
}

/**
 * Default prompt of a workflow-initiated reply when n8n sends no text: the
 * model decides what to say next from the stored history.
 */
const WORKFLOW_DEFAULT_PROMPT =
  'Напиши следующее сообщение собеседнику по смыслу переписки.';

const BATCH_MS = 1500;
const MAX_AGE_MS = 120_000;
/** The same incoming message is never generated twice in this window. */
export const GENERATE_DEDUPE_TTL_MS = 15 * 60 * 1000;
/** LRU cap of the `generateReply` dedupe map. */
export const GENERATE_DEDUPE_LIMIT = 2_000;
/** Short pause between the bubbles of a multi-message reply, milliseconds. */
const PART_PAUSE_MIN_MS = 200;
const PART_PAUSE_MAX_MS = 400;
/** How long a fetched peer profile stays fresh, milliseconds. */
const PEER_PROFILE_TTL_MS = 10 * 60_000;
/**
 * How long one `AiAccessService.accessFor` decision is reused, milliseconds.
 *
 * The autopilot sees every incoming message, so the gate must not hit the DB
 * four times per message. A plain TTL cache (no cross-service invalidation) is
 * enough: a block added from the dashboard starts applying within 10 s, and
 * the cache is keyed per account+chat+thread.
 */
const ACCESS_CACHE_TTL_MS = 10_000;
/** Upper bound of the access cache; oldest entries are evicted first. */
const ACCESS_CACHE_MAX = 2_000;

/**
 * Thread id of the incoming message: a forum topic / comment-thread id when
 * the engine reports one, otherwise `0` (whole chat).
 *
 * `MessageView` currently carries no topic field (private chats, the only ones
 * the autopilot handles, have no topics), but the realtime payload and future
 * message metadata may expose `threadId` / `messageThreadId`, so both are read
 * defensively.
 */
function threadIdOf(data: MessageNewPayload, message: MessageView): number {
  const candidates: unknown[] = [
    data.threadId,
    data.messageThreadId,
    (message as { threadId?: unknown }).threadId,
    (message as { messageThreadId?: unknown }).messageThreadId,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

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
  /** Bumped on every incoming message; a stale token aborts the old reply. */
  private readonly runs = new Map<string, number>();
  /** Live "typing…" heartbeats per chat. */
  private readonly typing = new Map<string, TypingState>();
  private readonly seen = new Set<string>();
  /** Delayed read receipts for messages that arrived while offline. */
  private readonly readTimers = new Set<ReturnType<typeof setTimeout>>();
  /**
   * Last picture per chat. A photo is often followed by a text question
   * ("что тут?"), which arrives as a separate message with no media of its own.
   */
  private readonly lastImages = new Map<string, { id: number; at: number }>();
  /**
   * Last voice/audio transcript per chat. A follow-up ("что я сказал в этом
   * голосовом?") arrives as plain text with no media of its own.
   */
  private readonly lastVoice = new Map<
    string,
    { text: string; at: number; messageId: number }
  >();
  /**
   * Transcripts of older audio messages, keyed `accountId:chatId:messageId`.
   * A question may come hours after the note, so this outlives the 3-minute
   * prompt cache above and avoids transcribing the same file twice.
   */
  private readonly voiceTranscripts = new Map<
    string,
    { text: string; at: number }
  >();
  private readonly peerProfiles = new Map<
    string,
    { at: number; block: string }
  >();
  /** TTL cache of AI access decisions, keyed `accountId:chatId:threadId`. */
  private readonly accessCache = new Map<
    string,
    { at: number; decision: AiAccessDecision }
  >();
  /**
   * Recently generated messages, `accountId:chatId:messageId -> timestamp`.
   * Guards the n8n `generate` call against a duplicate webhook delivery.
   */
  private readonly generated = new Map<string, number>();

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
    private readonly presence: PresenceService,
    private readonly speech: SpeechService,
    private readonly aiAccess: AiAccessService,
    private readonly agentRuns: AiRunsService,
    private readonly chatSkills: AiChatSkillsService,
    private readonly states: ChatStateService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedChatAccess();
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
    for (const entry of this.typing.values()) {
      if (entry.startTimer) clearTimeout(entry.startTimer);
      if (entry.timer) clearInterval(entry.timer);
    }
    this.typing.clear();
    for (const timer of this.readTimers) clearTimeout(timer);
    this.readTimers.clear();
    this.accessCache.clear();
    this.generated.clear();
    this.voiceTranscripts.clear();
    this.lastVoice.clear();
    this.lastImages.clear();
  }

  /**
   * One-time seed: every chat already listed in a soul's `chatIds` becomes an
   * explicit `AiChatAccess` row, so the dashboard shows the chats that already
   * work without the user re-adding them. Idempotent — existing rows, including
   * a human's `enabled: false`, are never overwritten.
   */
  private async seedChatAccess(): Promise<void> {
    try {
      const souls = (await this.prisma.soul.findMany({
        include: { account: { select: { userId: true } } },
      })) as Array<{
        accountId: string;
        settings: string;
        account: { userId: string };
      }>;
      const wanted = new Map<
        string,
        { userId: string; accountId: string; chatId: number }
      >();
      for (const soul of souls) {
        for (const chatId of parseSoulSettings(soul.settings).chatIds) {
          const key = `${soul.accountId}:${chatId}`;
          if (!wanted.has(key)) {
            wanted.set(key, {
              userId: soul.account.userId,
              accountId: soul.accountId,
              chatId,
            });
          }
        }
      }
      if (wanted.size === 0) {
        emitLog({
          level: 'info',
          source: 'ai',
          action: 'ai.access.seed',
          message: 'Seeded 0 chat access rows (no soul allows a specific chat)',
          status: 'ok',
          details: { created: 0, selected: 0 },
        });
        return;
      }

      const accountIds = [
        ...new Set([...wanted.values()].map((it) => it.accountId)),
      ];
      const existing = (await this.prisma.aiChatAccess.findMany({
        where: { accountId: { in: accountIds } },
        select: { accountId: true, chatId: true, threadId: true },
      })) as Array<{ accountId: string; chatId: bigint; threadId: number }>;
      const known = new Set(
        existing
          .filter((row) => row.threadId === 0)
          .map((row) => `${row.accountId}:${Number(row.chatId)}`),
      );

      let created = 0;
      for (const [key, entry] of wanted) {
        if (known.has(key)) continue;
        await this.prisma.aiChatAccess.upsert({
          where: {
            accountId_chatId_threadId: {
              accountId: entry.accountId,
              chatId: BigInt(entry.chatId),
              threadId: 0,
            },
          },
          create: {
            userId: entry.userId,
            accountId: entry.accountId,
            chatId: BigInt(entry.chatId),
            threadId: 0,
            enabled: true,
          },
          update: {},
        });
        created += 1;
      }

      emitLog({
        level: 'info',
        source: 'ai',
        action: 'ai.access.seed',
        message: `Seeded ${created} chat access rows from soul settings (${wanted.size} chats selected)`,
        status: 'ok',
        details: { created, selected: wanted.size },
      });
    } catch (error) {
      // A seed failure must never keep the autopilot from starting.
      this.logger.warn(
        `Could not seed chat access rows: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Access decision of one chat/topic, cached for {@link ACCESS_CACHE_TTL_MS}.
   *
   * Precedence (also applied by {@link chatAllowed}):
   * block > explicit access row > soul settings (`allowAllChats`/`chatIds`)
   * > deny.
   */
  private async accessDecision(
    userId: string,
    accountId: string,
    chatId: number,
    threadId: number,
  ): Promise<AiAccessDecision> {
    const key = `${accountId}:${chatId}:${threadId}`;
    const cached = this.accessCache.get(key);
    if (cached && Date.now() - cached.at < ACCESS_CACHE_TTL_MS) {
      return cached.decision;
    }
    const decision = await this.aiAccess.accessFor(
      userId,
      accountId,
      chatId,
      threadId,
    );
    this.accessCache.set(key, { at: Date.now(), decision });
    if (this.accessCache.size > ACCESS_CACHE_MAX) {
      const oldest = this.accessCache.keys().next().value;
      if (oldest) this.accessCache.delete(oldest);
    }
    return decision;
  }

  /**
   * Resolves the stored decision against the soul: an explicit access row
   * shadows the soul's own chat selection, and only a missing row falls back
   * to `allowAllChats` / `chatIds`. A block always wins.
   */
  private chatAllowed(
    decision: AiAccessDecision,
    soul: SoulModel,
    chatId: number,
  ): boolean {
    if (decision.block) return false;
    if (decision.access) return decision.access.enabled === true;
    return this.souls.allowsChat(soul, chatId);
  }

  /**
   * Whether the soul may act in this chat/topic. The Action API uses it to
   * keep visible side effects (`read`, `typing`) inside the same scope as
   * automatic replies: a workflow triggered for every incoming message must
   * not mark a stranger's chat read or show "typing…" there.
   */
  async isChatAllowed(
    userId: string,
    accountId: string,
    chatId: number,
    threadId = 0,
  ): Promise<boolean> {
    const soul = await this.souls.model(accountId);
    if (!soul) return false;
    const decision = await this.accessDecision(
      userId,
      accountId,
      chatId,
      threadId,
    );
    return this.chatAllowed(decision, soul, chatId);
  }

  /**
   * Injects a synthetic incoming message into the realtime bus, so the n8n
   * workflow (or the legacy autopilot) reacts exactly as it would to a peer's
   * message. Used by the dashboard's "Тест входящего" button: the reply is a
   * real Telegram message, but the synthetic incoming bubble is local only.
   */
  async simulateIncoming(
    userId: string,
    accountId: string,
    chatId: number,
    text = 'Тестовое входящее сообщение. Ответь коротко.',
  ): Promise<{ queued: true; messageId: number }> {
    await this.requireAccount(userId, accountId);
    const soul = await this.souls.model(accountId);
    if (!soul) {
      throw notFound('SOUL_NOT_FOUND', 'This account has no soul configured');
    }
    if (!(await this.isChatAllowed(userId, accountId, chatId))) {
      throw apiError(
        'CHAT_NOT_ALLOWED',
        'This chat is outside the soul allowlist',
        403,
      );
    }

    // A synthetic id inside Telegram's 32-bit range: it is only a dedupe key
    // and a reply target for the workflow, and it must not look like a
    // negative/service id.
    const messageId = 2_000_000_000 + Math.floor(Math.random() * 90_000_000);
    const message: MessageView = {
      id: messageId,
      chatId,
      text: text.slice(0, 4000),
      date: new Date().toISOString(),
      outgoing: false,
      edited: false,
      senderId: chatId,
      senderName: 'Тест',
      replyToId: null,
      mediaType: null,
      media: null,
      reactions: [],
      poll: null,
      isVoice: false,
      thread: null,
    };
    this.realtime.emitToUser(userId, 'message.new', {
      accountId,
      chatId,
      threadId: 0,
      message,
    });
    emitLog({
      level: 'debug',
      source: 'ai',
      action: 'ai.simulate.incoming',
      message: `Synthetic incoming message ${messageId} queued for ${chatId}`,
      status: 'ok',
      accountId,
      chatId,
      details: { messageId },
    });
    return { queued: true, messageId };
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

    // Eve gate: an account bound to a new girl-agent persona is driven by the
    // Eve channel, not by the legacy DM autopilot. The event is still written
    // to `EveEvent` by `EveEventsService`.
    if (await this.isEveAccount(accountId)) {
      this.nextToken(`${accountId}:${chatId}`);
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.eve',
        message: `Autopilot skipped in ${chatId}: the account is bound to an Eve persona`,
        status: 'ok',
        accountId,
        chatId,
      });
      return;
    }

    const threadId = threadIdOf(data, message);

    // Workflow gate. An account assigned to n8n is driven by its workflow:
    // the autopilot never replies on its own, it only feeds the event outbox
    // (`N8nEventsService`), and n8n decides whether to call `soul-reply`.
    // A newer message still bumps the run token, so an in-flight `replyNow`
    // reports `superseded: true` instead of sending a stale answer.
    // `AI_WORKFLOW_STRICT=1` additionally turns the legacy autopilot off for
    // accounts without a workflow (default off while n8n is being rolled out).
    if (this.workflowGate(account)) {
      this.nextToken(`${accountId}:${chatId}`);
      // The workflow's `generate` call is stateless: it reads the dialogue
      // from memory and receives only a message id. Store the incoming turn
      // here, or the model would answer the previous assistant line instead
      // of the peer's new message.
      try {
        if (
          account.workflowId &&
          (await this.isChatAllowed(userId, accountId, chatId, threadId))
        ) {
          const text =
            typeof message.text === 'string' ? message.text.trim() : '';
          if (text) {
            await this.memory.append(accountId, chatId, 'user', text, {
              messageId: message.id,
            });
          }
        }
      } catch (error) {
        this.logger.warn(
          `Could not store the incoming message ${message.id} in ${chatId}: ${(error as Error).message}`,
        );
      }
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.workflow',
        message: account.workflowId
          ? `Autopilot skipped in ${chatId}: the account is assigned to a workflow`
          : `Autopilot skipped in ${chatId}: AI_WORKFLOW_STRICT is on and no workflow is assigned`,
        status: 'ok',
        accountId,
        chatId,
        details: { workflowId: account.workflowId ?? null },
      });
      return;
    }

    // Access gate, before anything visible happens (typing, read receipt,
    // debounce). A block is a hard drop: the message is never scheduled, read
    // or passed to the agent. Precedence is block > access row > soul
    // settings > deny; see `chatAllowed`.
    const decision = await this.accessDecision(
      userId,
      accountId,
      chatId,
      threadId,
    );
    if (decision.block) {
      // A block is a hard stop: nothing visible may continue in that chat, and
      // an in-flight run must not send after the debounce/model finishes.
      this.nextToken(`${accountId}:${chatId}`);
      this.cancelTyping(`${accountId}:${chatId}`);
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'blocked',
        messageId: message.id,
      });
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.blocked',
        message: `Incoming message in ${chatId} dropped: chat/topic is blocked`,
        status: 'ok',
        accountId,
        chatId,
        details: {
          chatId,
          threadId,
          warnings: decision.warnings,
          reason: decision.block.reason,
        },
      });
      return;
    }

    const soul = await this.souls.model(accountId);
    if (!soul || !isAutopilotMode(soul.mode)) return;
    if (!this.chatAllowed(decision, soul, chatId)) return;

    const key = `${accountId}:${chatId}:${message.id}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.seen.size > 5000) {
      const first = this.seen.values().next().value;
      if (first) this.seen.delete(first);
    }

    const text =
      (message.text || '').trim() ||
      (message.media?.kind === 'photo'
        ? '[изображение]'
        : message.media?.kind === 'sticker'
          ? `[стикер${message.media.emoji ? ` ${message.media.emoji}` : ''}]`
          : message.media?.kind === 'animation'
            ? '[GIF]'
            : message.media?.kind === 'video_note'
              ? '[видеосообщение]'
              : '') ||
      `[${message.mediaType ?? 'media'}]`;
    if (!text) return;
    const senderName = message.senderName || `Чат ${chatId}`;
    const settings = parseSoulSettings(soul.settings);
    const chatKey = `${accountId}:${chatId}`;

    // A newer message takes a live run over: the old one is reported as
    // `superseded` (its "typing…" is hidden below) and the new one starts from
    // `received`, so the dashboard never shows two owners of one chat.
    const previousState = this.states.get(accountId, chatId);
    if (isActiveState(previousState.state)) {
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'superseded',
        runId: previousState.runId,
        messageId: previousState.messageId,
        part: previousState.part,
        total: previousState.total,
        typingMode: settings.typingMode,
      });
    }
    this.states.transition({
      userId,
      accountId,
      chatId,
      state: 'received',
      messageId: message.id,
      typingMode: settings.typingMode,
    });

    // A human shows the read receipt the moment the message is opened. If the
    // account was offline (idle) it first comes back online, then reads after
    // the configured delay — like picking up the phone.
    const markRead = (): void => {
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'read',
        messageId: message.id,
        typingMode: settings.typingMode,
      });
    };
    const gate = await this.presence.incoming(accountId, chatId);
    if (gate.readDelayMs > 0) {
      const timer = setTimeout(() => {
        this.readTimers.delete(timer);
        void this.markRead(userId, accountId, chatId, message.id);
        markRead();
      }, gate.readDelayMs);
      timer.unref?.();
      this.readTimers.add(timer);
    } else {
      await this.markRead(userId, accountId, chatId, message.id);
      markRead();
    }

    // A new message always wins: it invalidates the reply that is generating
    // or typing right now, hides "typing…" and restarts after the debounce.
    const token = this.nextToken(chatKey);
    this.cancelTyping(chatKey);
    // `on_think` starts typing right after the read receipt; `smart` waits
    // `typingStartDelayMs` first. `deliverReply`/`generateCycle` keep the same
    // heartbeat running, so the debounce is part of the thinking phase.
    if (
      soul.mode === 'auto' &&
      typesWhileThinking(settings.typingMode)
    ) {
      this.startTyping(chatKey, token, userId, accountId, chatId, {
        heartbeatMs: settings.typingHeartbeatMs,
        delayMs:
          settings.typingMode === 'smart'
            ? settings.typingStartDelayMs
            : 0,
      });
    }
    const existing = this.pending.get(chatKey);
    if (existing) clearTimeout(existing.timer);
    const texts = [
      ...(existing?.texts ?? []),
      {
        id: message.id,
        text,
        media: message.media,
        replyToId: message.replyToId,
      },
    ].slice(-MAX_BURST);
    this.states.transition({
      userId,
      accountId,
      chatId,
      state: 'waiting',
      messageId: message.id,
      total: texts.length,
      typingMode: settings.typingMode,
    });
    const timer = setTimeout(() => {
      this.pending.delete(chatKey);
      void this.reply(
        userId,
        accountId,
        chatId,
        message,
        senderName,
        token,
        texts,
        threadId,
      ).catch((error) => {
        this.logger.warn(
          `Autopilot reply failed: ${(error as Error).message}`,
        );
      });
    }, Math.min(BATCH_MS, Math.max(200, settings.replyDelayMs)) +
      gate.readDelayMs +
      gate.typingDelayMs);
    this.pending.set(chatKey, {
      timer,
      accountId,
      chatId,
      message,
      senderName,
      token,
      texts,
    });
  }

  /**
   * Describes the peer so the agent knows who it is talking to: the Telegram
   * name, username and profile bio. Cached per account+chat and best-effort —
   * a profile that cannot be fetched is simply left out of the prompt.
   */
  private async peerBlock(
    userId: string,
    accountId: string,
    chatId: number,
  ): Promise<string> {
    const key = `${accountId}:${chatId}`;
    const cached = this.peerProfiles.get(key);
    if (cached && Date.now() - cached.at < PEER_PROFILE_TTL_MS) {
      return cached.block;
    }
    let block = '';
    let hasUsername = false;
    let bioChars = 0;
    try {
      const info = await this.messaging.getChatInfo(
        userId,
        accountId,
        String(chatId),
      );
      const name = info.title || `id ${chatId}`;
      const username = info.username ? ` (@${info.username})` : '';
      const about = info.about?.trim() ?? '';
      hasUsername = Boolean(info.username);
      bioChars = about.length;
      block = [
        `Собеседник в Telegram: ${name}${username}.`,
        about ? `О собеседнике в профиле: ${about}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    } catch (error) {
      this.logger.warn(
        `Could not load the profile of ${chatId}: ${(error as Error).message}`,
      );
      return '';
    }
    emitLog({
      level: 'debug',
      source: 'ai',
      action: 'dm.autopilot.peer',
      message: `Peer profile for ${chatId}: username=${hasUsername ? 'yes' : 'no'}, bio=${bioChars} chars`,
      status: 'ok',
      accountId,
      chatId,
      details: { hasUsername, bioChars },
    });
    this.peerProfiles.set(key, { at: Date.now(), block });
    if (this.peerProfiles.size > 500) {
      const oldest = this.peerProfiles.keys().next().value;
      if (oldest) this.peerProfiles.delete(oldest);
    }
    return block;
  }

  /**
   * Downloads an attached image so the model can look at it. Only photos and
   * image documents under {@link MAX_IMAGE_BYTES} are forwarded; anything else
   * is left as a text placeholder.
   */
  private async imagesFor(
    userId: string,
    accountId: string,
    chatId: number,
    messageIds: number[],
  ): Promise<Array<{ mime: string; data: Buffer }>> {
    const images: Array<{ mime: string; data: Buffer }> = [];
    let total = 0;
    for (const messageId of messageIds.slice(0, MAX_IMAGES)) {
      try {
        const file = await this.messaging.downloadMedia(
          userId,
          accountId,
          String(chatId),
          String(messageId),
        );
        if (!file.mimeType.toLowerCase().startsWith('image/')) continue;
        if (total + file.data.length > MAX_IMAGE_BYTES) {
          emitLog({
            level: 'warn',
            source: 'ai',
            action: 'dm.autopilot.image',
            message: `Skipped an image of ${file.data.length} bytes (limit ${MAX_IMAGE_BYTES})`,
            status: 'failed',
            accountId,
            chatId,
            details: { messageId, bytes: file.data.length },
          });
          continue;
        }
        total += file.data.length;
        images.push({ mime: file.mimeType, data: file.data });
        emitLog({
          level: 'debug',
          source: 'ai',
          action: 'dm.autopilot.image',
          message: `Forwarded ${file.mimeType} image (${file.data.length} bytes) to the model`,
          status: 'ok',
          accountId,
          chatId,
          details: {
            messageId,
            mime: file.mimeType,
            bytes: file.data.length,
          },
        });
      } catch (error) {
        this.logger.warn(
          `Could not download the image of ${messageId}: ${(error as Error).message}`,
        );
      }
    }
    return images;
  }

  /**
   * Downloads one animated sticker/GIF and renders its frame collage, so the
   * model can see the motion instead of a single still. Never throws.
   */
  private async collageImage(
    userId: string,
    accountId: string,
    chatId: number,
    messageId: number,
  ): Promise<{ mime: string; data: Buffer } | null> {
    try {
      const frames = await this.messaging.messageFrames(
        userId,
        accountId,
        String(chatId),
        String(messageId),
      );
      if (!frames.data.length) return null;
      if (frames.data.length > MAX_IMAGE_BYTES) {
        emitLog({
          level: 'warn',
          source: 'ai',
          action: 'dm.autopilot.sticker',
          message: `Skipped a ${frames.data.length}-byte collage (limit ${MAX_IMAGE_BYTES})`,
          status: 'failed',
          accountId,
          chatId,
          details: { messageId, bytes: frames.data.length, frames: false },
        });
        return null;
      }
      return { mime: frames.mimeType || 'image/jpeg', data: frames.data };
    } catch (error) {
      this.logger.warn(
        `Could not render the collage of ${messageId}: ${(error as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Downloads one audio message and runs it through the local speech engine.
   *
   * Never throws: a missing engine, a download failure or an empty transcript
   * comes back as `{ ok: false, reason }` so the caller can tell the model
   * honestly that the audio was not understood.
   */
  private async transcribeMessageAudio(
    userId: string,
    accountId: string,
    chatId: number,
    messageId: number,
  ): Promise<
    | { ok: true; text: string; bytes: number; chars: number; ms: number }
    | { ok: false; bytes: number; chars: 0; ms: number; reason: string }
  > {
    const started = Date.now();
    if (!this.speech.available()) {
      return {
        ok: false,
        bytes: 0,
        chars: 0,
        ms: 0,
        reason: 'no speech engine is installed',
      };
    }
    let bytes = 0;
    try {
      const file = await this.messaging.downloadMedia(
        userId,
        accountId,
        String(chatId),
        String(messageId),
      );
      bytes = file.data.length;
      const result = await this.speech.transcribe({
        data: file.data,
        mimeType: file.mimeType,
        fileName: file.fileName,
      });
      const chars = result?.text.length ?? 0;
      const ms = Date.now() - started;
      if (!result || chars === 0) {
        return { ok: false, bytes, chars: 0, ms, reason: 'empty transcript' };
      }
      const text =
        result.text.length > MAX_VOICE_CHARS
          ? `${result.text.slice(0, MAX_VOICE_CHARS)}…`
          : result.text;
      return { ok: true, text, bytes, chars, ms };
    } catch (error) {
      return {
        ok: false,
        bytes,
        chars: 0,
        ms: Date.now() - started,
        reason: (error as Error).message,
      };
    }
  }

  /**
   * Transcribes every voice note in the burst through the local speech engine.
   *
   * Always resolves: a missing engine, a download failure or an empty
   * transcript marks the batch as failed so the prompt can say honestly that
   * the audio was not understood, and the reply still goes out.
   */
  private async transcribeVoices(
    userId: string,
    accountId: string,
    chatId: number,
    items: IncomingText[],
  ): Promise<VoiceResult> {
    const transcripts = new Map<number, string>();
    let failed = false;
    const audio = items.filter((item) => isAudioMedia(item.media));
    if (audio.length === 0) return { transcripts, failed };
    for (const item of audio) {
      const result = await this.transcribeMessageAudio(
        userId,
        accountId,
        chatId,
        item.id,
      );
      if (!result.ok) {
        failed = true;
        emitLog({
          level: 'warn',
          source: 'ai',
          action: 'dm.autopilot.voice',
          message: `Voice note ${item.id} was not transcribed: ${result.reason}`,
          status: 'failed',
          accountId,
          chatId,
          durationMs: result.ms,
          details: {
            messageId: item.id,
            source: 'failed',
            bytes: result.bytes,
            chars: 0,
            ms: result.ms,
            reason: result.reason,
          },
        });
        continue;
      }
      transcripts.set(item.id, result.text);
      this.rememberVoiceTranscript(accountId, chatId, item.id, result.text);
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.voice',
        message: `Transcribed voice note ${item.id} (${result.chars} chars) in ${result.ms} ms`,
        status: 'ok',
        accountId,
        chatId,
        durationMs: result.ms,
        details: {
          messageId: item.id,
          source: 'fresh',
          bytes: result.bytes,
          chars: result.chars,
          ms: result.ms,
        },
      });
    }
    return { transcripts, failed };
  }

  /** Cached transcript of one audio message, or `null` when absent/expired. */
  private cachedVoiceTranscript(
    accountId: string,
    chatId: number,
    messageId: number,
  ): string | null {
    const key = `${accountId}:${chatId}:${messageId}`;
    const entry = this.voiceTranscripts.get(key);
    if (!entry) return null;
    if (Date.now() - entry.at >= VOICE_TRANSCRIPT_TTL_MS) {
      this.voiceTranscripts.delete(key);
      return null;
    }
    return entry.text;
  }

  /** Stores one transcript for {@link VOICE_TRANSCRIPT_TTL_MS}. */
  private rememberVoiceTranscript(
    accountId: string,
    chatId: number,
    messageId: number,
    text: string,
  ): void {
    const key = `${accountId}:${chatId}:${messageId}`;
    this.voiceTranscripts.set(key, { text, at: Date.now() });
    if (this.voiceTranscripts.size > VOICE_TRANSCRIPT_MAX) {
      const oldest = this.voiceTranscripts.keys().next().value;
      if (oldest) this.voiceTranscripts.delete(oldest);
    }
  }

  /**
   * Message an audio question points at: the quoted message when the peer
   * replied to it, otherwise the newest voice note of the last
   * {@link VOICE_LOOKUP_WINDOW} messages. Only called when the text mentions
   * audio and no fresh transcript exists, and the history is only read when
   * that fails, so a plain chat never pays for this.
   */
  private async audioMessageFor(
    userId: string,
    accountId: string,
    chatId: number,
    texts: IncomingText[],
  ): Promise<{ id: number; date: string } | null> {
    const replyTo = replyTargetId(texts);
    if (replyTo !== null) {
      try {
        const page = await this.messaging.listMessages(
          userId,
          accountId,
          String(chatId),
          { limit: 1, offsetId: replyTo + 1 },
        );
        const quoted = page.messages.find((item) => item.id === replyTo);
        if (
          quoted &&
          isAudioMedia(quoted.media) &&
          isRecentDate(quoted.date, Date.now(), VOICE_LOOKUP_MAX_AGE_MS)
        ) {
          return { id: quoted.id, date: quoted.date };
        }
      } catch (error) {
        this.logger.warn(
          `Could not load the replied message ${replyTo} in ${chatId}: ${(error as Error).message}`,
        );
      }
    }

    let page;
    try {
      page = await this.messaging.listMessages(
        userId,
        accountId,
        String(chatId),
        { limit: VOICE_LOOKUP_WINDOW },
      );
    } catch (error) {
      this.logger.warn(
        `Could not scan the history of ${chatId} for audio: ${(error as Error).message}`,
      );
      emitLog({
        level: 'warn',
        source: 'ai',
        action: 'dm.autopilot.voice',
        message: `Audio lookup in ${chatId} failed: ${(error as Error).message}`,
        status: 'failed',
        accountId,
        chatId,
        details: {
          messageId: replyTo ?? 0,
          source: 'failed',
          reason: (error as Error).message,
        },
      });
      return null;
    }
    const found = pickRecentAudio(
      page.messages,
      Date.now(),
      VOICE_LOOKUP_MAX_AGE_MS,
    );
    return found ? { id: found.id, date: found.date } : null;
  }

  /**
   * Resolves a text-only question about a voice note.
   *
   * Fast path: a transcript from the last {@link LAST_VOICE_TTL_MS} is used as
   * is. Otherwise the audio message the peer means is located in the history,
   * transcribed once and cached for a day. Returns `null` when the text only
   * looked like an audio question but no nearby audio exists, so "скинул файл"
   * is never answered as if it were a voice note.
   */
  private async resolveVoiceFollowUp(
    userId: string,
    accountId: string,
    chatId: number,
    texts: IncomingText[],
  ): Promise<VoiceReference | null> {
    // A burst that already carries audio was transcribed above; a failed note
    // there is reported honestly instead of being downloaded a second time.
    if (texts.some((item) => isAudioMedia(item.media))) return null;
    if (!mentionsVoice(texts)) return null;
    const chatKey = `${accountId}:${chatId}`;

    const fresh = this.lastVoice.get(chatKey);
    if (fresh && Date.now() - fresh.at < LAST_VOICE_TTL_MS) {
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.voice',
        message: `Reused the last voice transcript in ${chatId}`,
        status: 'ok',
        accountId,
        chatId,
        details: {
          messageId: fresh.messageId,
          source: 'fresh',
          reused: true,
          chars: fresh.text.length,
        },
      });
      return {
        messageId: fresh.messageId,
        text: fresh.text,
        source: 'fresh',
      };
    }

    const target = await this.audioMessageFor(userId, accountId, chatId, texts);
    if (!target) return null;

    const cached = this.cachedVoiceTranscript(accountId, chatId, target.id);
    if (cached !== null) {
      this.lastVoice.set(chatKey, {
        text: cached,
        at: Date.now(),
        messageId: target.id,
      });
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.voice',
        message: `Reused the cached transcript of voice note ${target.id} in ${chatId}`,
        status: 'ok',
        accountId,
        chatId,
        details: {
          messageId: target.id,
          source: 'cached',
          chars: cached.length,
        },
      });
      return { messageId: target.id, text: cached, source: 'cached' };
    }

    const result = await this.transcribeMessageAudio(
      userId,
      accountId,
      chatId,
      target.id,
    );
    if (!result.ok) {
      emitLog({
        level: 'warn',
        source: 'ai',
        action: 'dm.autopilot.voice',
        message: `Voice note ${target.id} found on demand was not transcribed: ${result.reason}`,
        status: 'failed',
        accountId,
        chatId,
        durationMs: result.ms,
        details: {
          messageId: target.id,
          source: 'failed',
          bytes: result.bytes,
          chars: 0,
          ms: result.ms,
          reason: result.reason,
        },
      });
      return { messageId: target.id, text: '', source: 'failed' };
    }

    this.rememberVoiceTranscript(accountId, chatId, target.id, result.text);
    this.lastVoice.set(chatKey, {
      text: result.text,
      at: Date.now(),
      messageId: target.id,
    });
    emitLog({
      level: 'info',
      source: 'ai',
      action: 'dm.autopilot.voice',
      message: `Transcribed voice note ${target.id} on demand (${result.chars} chars) in ${result.ms} ms`,
      status: 'ok',
      accountId,
      chatId,
      durationMs: result.ms,
      details: {
        messageId: target.id,
        source: 'onDemand',
        bytes: result.bytes,
        chars: result.chars,
        ms: result.ms,
      },
    });
    return { messageId: target.id, text: result.text, source: 'onDemand' };
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

  /** Bumps the chat token; everything started with an older token is stale. */
  private nextToken(chatKey: string): number {
    const next = (this.runs.get(chatKey) ?? 0) + 1;
    this.runs.set(chatKey, next);
    return next;
  }

  private isCurrent(chatKey: string, token: number): boolean {
    return this.runs.get(chatKey) === token;
  }

  /** True when a newer message already owns the chat state. */
  private otherRunOwns(
    accountId: string,
    chatId: number,
    messageId: number | null,
  ): boolean {
    if (messageId === null) return false;
    const current = this.states.get(accountId, chatId);
    return current.messageId !== null && current.messageId !== messageId;
  }

  /**
   * Marks the run `superseded` unless the chat already belongs to a newer
   * message: a late check of the old run must never clobber the new state.
   */
  private markSuperseded(input: {
    userId: string;
    accountId: string;
    chatId: number;
    runId: string | null;
    messageId: number | null;
    typingMode: TypingMode;
    part?: number;
    total?: number;
  }): void {
    if (this.otherRunOwns(input.accountId, input.chatId, input.messageId)) {
      return;
    }
    this.states.transition({ ...input, state: 'superseded' });
  }

  /** Marks the run failed unless a newer message owns the chat state. */
  private markError(input: {
    userId: string;
    accountId: string;
    chatId: number;
    messageId: number | null;
  }): void {
    if (this.otherRunOwns(input.accountId, input.chatId, input.messageId)) {
      return;
    }
    this.states.transition({ ...input, state: 'error' });
  }

  /**
   * Starts the "typing…" heartbeat that keeps the action visible.
   *
   * `delayMs` postpones the first action (`smart` waits
   * `typingStartDelayMs` after the read receipt); the delay is cancelled with
   * the rest of the state, so a superseded or blocked run never starts typing.
   * `heartbeatMs` is already clamped by the typing policy (2–5 s).
   */
  private startTyping(
    chatKey: string,
    token: number,
    userId: string,
    accountId: string,
    chatId: number,
    options: { heartbeatMs: number; delayMs?: number } = { heartbeatMs: 4_000 },
  ): void {
    this.clearTyping(chatKey);
    const state: TypingState = {
      userId,
      accountId,
      chatId,
      token,
      startedAt: Date.now(),
      startTimer: null,
      timer: null,
    };
    const send = (): void => {
      void this.messaging
        .sendTyping(userId, accountId, String(chatId), { status: 'typing' })
        .catch(() => undefined);
    };
    const begin = (): void => {
      state.startTimer = null;
      // The reply may have been superseded while the delay was running.
      const current = this.typing.get(chatKey);
      if (current !== state || !this.isCurrent(chatKey, token)) return;
      send();
      const timer = setInterval(send, Math.max(2_000, options.heartbeatMs));
      timer.unref?.();
      state.timer = timer;
    };
    this.typing.set(chatKey, state);
    const delay = Math.max(0, options.delayMs ?? 0);
    if (delay > 0) {
      const timer = setTimeout(begin, delay);
      timer.unref?.();
      state.startTimer = timer;
    } else {
      begin();
    }
  }

  /** Starts typing unless it is already running for this token. */
  private ensureTyping(
    chatKey: string,
    token: number,
    userId: string,
    accountId: string,
    chatId: number,
    options: { heartbeatMs: number },
  ): void {
    const state = this.typing.get(chatKey);
    // A heartbeat is already running for this run; nothing to do.
    if (state && state.token === token && state.timer) return;
    // Either no typing yet or a delayed `smart` start is still pending: the
    // text is ready, so show the action right now.
    this.startTyping(chatKey, token, userId, accountId, chatId, options);
  }

  private clearTyping(chatKey: string): void {
    const state = this.typing.get(chatKey);
    if (!state) return;
    if (state.startTimer) clearTimeout(state.startTimer);
    if (state.timer) clearInterval(state.timer);
    this.typing.delete(chatKey);
  }

  /** Hides "typing…" for whatever reply owns the chat right now. */
  private cancelTyping(chatKey: string): void {
    const state = this.typing.get(chatKey);
    if (!state) return;
    // A pending delayed start (`smart`) never showed anything: just drop it.
    const shown = state.timer !== null;
    this.clearTyping(chatKey);
    if (!shown) return;
    emitLog({
      level: 'debug',
      source: 'ai',
      action: 'dm.autopilot.cancel',
      message: `Typing in ${state.chatId} cancelled by a newer message`,
      status: 'ok',
      accountId: state.accountId,
      chatId: state.chatId,
      details: { phase: 'typing', token: state.token },
    });
    void this.messaging
      .sendTyping(state.userId, state.accountId, String(state.chatId), {
        status: 'cancel',
      })
      .catch(() => undefined);
  }

  /**
   * Stops the heartbeat owned by `token` only, so a reply that was cancelled
   * never hides the indicator of the run that replaced it.
   */
  private async stopTyping(
    chatKey: string,
    token: number,
    cancel: boolean,
  ): Promise<void> {
    const state = this.typing.get(chatKey);
    if (!state || state.token !== token) return;
    const shown = state.timer !== null;
    this.clearTyping(chatKey);
    if (!cancel || !shown) return;
    await this.messaging
      .sendTyping(state.userId, state.accountId, String(state.chatId), {
        status: 'cancel',
      })
      .catch(() => undefined);
  }

  /** Sleeps in slices and returns early once the reply is stale. */
  private async wait(
    ms: number,
    chatKey: string,
    token: number,
  ): Promise<void> {
    const end = Date.now() + Math.max(0, ms);
    while (Date.now() < end) {
      if (!this.isCurrent(chatKey, token)) return;
      await sleep(Math.min(250, end - Date.now()));
    }
  }

  /**
   * Emits `ai.thinking` for one reply: `start`, throttled reasoning deltas and
   * a final `done` carrying the complete reasoning. Deltas are at most one per
   * 100 ms and never shorter than 16 characters, so a fast model cannot flood
   * the socket. These events only feed the dashboard; nothing is sent to
   * Telegram.
   */
  private thinkingEmitter(
    userId: string,
    accountId: string,
    chatId: number,
  ): {
    start(runId: string): void;
    delta(text: string): void;
    done(reasoning?: string): void;
  } {
    let runId: string | null = null;
    let pending = '';
    let lastAt = 0;
    const emit = (payload: AiThinkingPayload): void => {
      this.realtime.emitToUser(userId, 'ai.thinking', payload);
    };
    return {
      start: (id: string) => {
        runId = id;
        pending = '';
        lastAt = 0;
        emit({ accountId, chatId, runId: id, phase: 'start' });
      },
      delta: (text: string) => {
        if (!runId || !text) return;
        pending += text;
        if (pending.length < THINKING_DELTA_MIN_CHARS) return;
        const now = Date.now();
        if (now - lastAt < THINKING_DELTA_INTERVAL_MS) return;
        const delta = pending;
        pending = '';
        lastAt = now;
        emit({ accountId, chatId, runId, delta });
      },
      done: (reasoning?: string) => {
        if (!runId) return;
        const id = runId;
        runId = null;
        pending = '';
        emit({
          accountId,
          chatId,
          runId: id,
          phase: 'done',
          reasoning: reasoning ?? null,
        });
      },
    };
  }

  private async reply(
    userId: string,
    accountId: string,
    chatId: number,
    message: MessageView,
    senderName: string,
    token: number,
    texts: IncomingText[],
    threadId = 0,
  ): Promise<void> {
    const chatKey = `${accountId}:${chatId}`;
    if (!this.isCurrent(chatKey, token)) return;
    try {
      const soul = await this.souls.model(accountId);
      if (!soul || !isAutopilotMode(soul.mode)) {
        await this.stopTyping(chatKey, token, true);
        return;
      }
      // The assignment can change between the incoming message and the
      // debounce firing; an account that now belongs to a workflow must stay
      // silent.
      if (await this.workflowGateById(accountId)) {
        await this.stopTyping(chatKey, token, true);
        return;
      }
      // Re-check the gate: an explicit access row shadows the soul allowlist,
      // and a block may have appeared while the burst was debouncing.
      const decision = await this.accessDecision(
        userId,
        accountId,
        chatId,
        threadId,
      );
      if (!this.chatAllowed(decision, soul, chatId)) {
        await this.stopTyping(chatKey, token, true);
        if (decision.block) {
          this.states.transition({
            userId,
            accountId,
            chatId,
            state: 'blocked',
            messageId: message.id,
          });
        }
        return;
      }
      if (!this.isCurrent(chatKey, token)) return;

      const job: ReplyJob = {
        userId,
        accountId,
        chatId,
        threadId,
        soul,
        senderName,
        token,
        texts,
        replyToId: message.id,
        storeIncoming: true,
        draft: soul.mode === 'draft',
        returnText: false,
      };
      const { gen } = await this.generateCycle(job, token);
      if (gen.superseded || gen.parts.length === 0) return;
      const outcome: ReplyOutcome = {
        superseded: false,
        text:
          gen.parts.map((part) => part.text).join('\n\n') || gen.text,
        messageIds: [],
        runId: gen.runId,
      };
      await this.deliverReply(job, token, gen, outcome);
    } catch (error) {
      await this.stopTyping(chatKey, token, true);
      this.markError({
        userId,
        accountId,
        chatId,
        messageId: message.id,
      });
      this.logger.warn(
        `Autopilot reply failed in ${chatId}: ${(error as Error).message}`,
      );
    }
  }

  /**
   * Action API entry point: generate and send one soul reply on request.
   *
   * Reuses the legacy pipeline end to end (presence, rate limits, images and
   * voice context, per-chat skills, typing, multi-bubble sending and memory
   * writes) but skips the soul's chat allowlist: the caller (n8n) already
   * decided that this chat should be answered. A block still wins.
   *
   * A newer incoming message bumps the chat token, so an in-flight run comes
   * back as `{ sent: false, superseded: true }` instead of throwing.
   */
  async replyNow(input: {
    userId: string;
    accountId: string;
    chatId: number;
    threadId?: number;
    prompt?: string;
    replyToMessageId?: number;
    returnText?: boolean;
  }): Promise<{
    sent: boolean;
    superseded: boolean;
    text: string;
    messageIds: number[];
    state: ChatAiState;
  }> {
    const { userId, accountId, chatId } = input;
    await this.requireAccount(userId, accountId);
    const soul = await this.souls.model(accountId);
    if (!soul) {
      throw notFound('SOUL_NOT_FOUND', 'This account has no soul configured');
    }
    const threadId = normaliseThreadId(input.threadId);

    const decision = await this.accessDecision(
      userId,
      accountId,
      chatId,
      threadId,
    );
    if (decision.block) {
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
        403,
      );
    }
    if (!this.chatAllowed(decision, soul, chatId)) {
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'blocked',
      });
      throw apiError(
        'CHAT_NOT_ALLOWED',
        'This chat is outside the soul allowlist',
        403,
      );
    }

    // Presence side effect only: an offline account comes back online like a
    // person picking up the phone. The read delay exists for peer messages,
    // not for an answer the owner asked for through a workflow.
    await this.presence.incoming(accountId, chatId);

    const prompt = input.prompt?.trim();
    const replyToId =
      typeof input.replyToMessageId === 'number' &&
      Number.isSafeInteger(input.replyToMessageId) &&
      input.replyToMessageId > 0
        ? input.replyToMessageId
        : null;
    const job: ReplyJob = {
      userId,
      accountId,
      chatId,
      threadId,
      soul,
      senderName: '',
      token: 0,
      texts: [],
      promptOverride:
        prompt && prompt.length > 0 ? prompt : WORKFLOW_DEFAULT_PROMPT,
      replyToId,
      storeIncoming: false,
      draft: false,
      returnText: input.returnText === true,
    };

    try {
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'received',
        messageId: replyToId,
        typingMode: parseSoulSettings(soul.settings).typingMode,
      });
      const { token, gen } = await this.generateCycle(job);
      const outcome: ReplyOutcome = {
        superseded: gen.superseded,
        text:
          gen.parts.map((part) => part.text).join('\n\n') || gen.text,
        messageIds: [],
        runId: gen.runId,
      };
      if (!gen.superseded && gen.parts.length > 0) {
        await this.deliverReply(job, token, gen, outcome);
      }
      return {
        sent: !outcome.superseded && outcome.messageIds.length > 0,
        superseded: outcome.superseded,
        text: outcome.text,
        messageIds: outcome.messageIds,
        state: this.states.stateOf(accountId, chatId),
      };
    } catch (error) {
      this.markError({
        userId,
        accountId,
        chatId,
        messageId: replyToId,
      });
      throw error;
    }
  }

  /**
   * Generates a reply and returns its bubbles without sending or typing.
   *
   * This is the split the n8n workflow uses: `generateReply` resolves the soul,
   * skills, permissions, memory, history and media context, calls the model and
   * applies the bubble policy; `send-text` (or a human) decides when — and
   * whether — the bubbles go out. `soul-reply` stays as generate + send.
   */
  async generateReply(input: GenerateReplyInput): Promise<GenerateReplyResult> {
    const { userId, accountId, chatId } = input;
    await this.requireAccount(userId, accountId);
    const soul = await this.souls.model(accountId);
    if (!soul) {
      throw notFound('SOUL_NOT_FOUND', 'This account has no soul configured');
    }
    const threadId = normaliseThreadId(input.threadId);
    const messageId =
      typeof input.messageId === 'number' &&
      Number.isSafeInteger(input.messageId) &&
      input.messageId > 0
        ? input.messageId
        : null;

    const dedupeKey =
      messageId === null ? null : `${accountId}:${chatId}:${messageId}`;
    if (dedupeKey && this.alreadyGenerated(dedupeKey)) {
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'n8n.action.duplicate',
        message: `Skipped a duplicate generation for message ${messageId}`,
        status: 'ok',
        accountId,
        chatId,
        details: { kind: 'generate', messageId },
      });
      return {
        runId: null,
        parts: [],
        reasoning: null,
        state: this.states.stateOf(accountId, chatId),
        superseded: false,
        duplicate: true,
        blocked: false,
      };
    }
    if (dedupeKey) this.rememberGenerated(dedupeKey);

    const decision = await this.accessDecision(
      userId,
      accountId,
      chatId,
      threadId,
    );
    if (!this.chatAllowed(decision, soul, chatId)) {
      if (dedupeKey) this.generated.delete(dedupeKey);
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'blocked',
        messageId,
      });
      return {
        runId: null,
        parts: [],
        reasoning: null,
        state: 'blocked',
        superseded: false,
        duplicate: false,
        blocked: true,
      };
    }

    const prompt = input.prompt?.trim();
    const job: ReplyJob = {
      userId,
      accountId,
      chatId,
      threadId,
      soul,
      senderName: '',
      token: 0,
      texts: [],
      promptOverride:
        prompt && prompt.length > 0 ? prompt : WORKFLOW_DEFAULT_PROMPT,
      replyToId: messageId,
      storeIncoming: false,
      draft: false,
      returnText: true,
    };
    // The Action API parameter overrides the soul's own bubble cap.
    if (input.maxParts !== undefined) {
      job.maxParts = normaliseMaxParts(input.maxParts, 1);
    }

    try {
      // Presence is a side effect only: the owner asked for an answer.
      await this.presence.incoming(accountId, chatId);
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'received',
        messageId,
        typingMode: parseSoulSettings(soul.settings).typingMode,
      });
      const { gen } = await this.generateCycle(job);
      if (gen.superseded) {
        if (dedupeKey) this.generated.delete(dedupeKey);
        return {
          runId: gen.runId,
          parts: [],
          reasoning: gen.reasoning,
          state: 'superseded',
          superseded: true,
          duplicate: false,
          blocked: false,
        };
      }
      return {
        runId: gen.runId,
        parts: gen.parts.map((part) => {
          const replyToMessageId =
            part.messageIndex !== undefined
              ? (gen.items[part.messageIndex - 1]?.id ?? messageId)
              : messageId;
          const view: GenerateReplyResult['parts'][number] = {
            text: part.text,
            replyToMessageId: replyToMessageId ?? null,
          };
          if (part.quote) view.quote = part.quote;
          return view;
        }),
        reasoning: gen.reasoning,
        state: this.states.stateOf(accountId, chatId),
        superseded: false,
        duplicate: false,
        blocked: false,
      };
    } catch (error) {
      if (dedupeKey) this.generated.delete(dedupeKey);
      this.markError({
        userId,
        accountId,
        chatId,
        messageId,
      });
      throw error;
    }
  }

  /**
   * Sends ready text bubbles on behalf of the owner (n8n `send-text`).
   *
   * `typing` defaults to `auto`: the soul's typing policy is applied, including
   * the heartbeat, the 2–5 s refresh and the `typingMinMs..typingMaxMs` clamp.
   * A number is an explicit simulation in milliseconds, `off` sends instantly.
   */
  async sendText(input: {
    userId: string;
    accountId: string;
    chatId: number;
    threadId?: number;
    parts: string[];
    replyToId?: number;
    quote?: string;
    typing?: 'auto' | 'off' | number;
  }): Promise<SendTextResult> {
    const { userId, accountId, chatId } = input;
    await this.requireAccount(userId, accountId);
    const threadId = normaliseThreadId(input.threadId);
    const decision = await this.aiAccess.accessFor(
      userId,
      accountId,
      chatId,
      threadId,
    );
    if (decision.block) {
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'blocked',
        messageId: input.replyToId ?? null,
      });
      throw apiError(
        'CHAT_BLOCKED',
        decision.block.reason
          ? `Chat is blocked: ${decision.block.reason}`
          : 'Chat is blocked for the AI',
        403,
      );
    }

    const soul = await this.souls.model(accountId);
    const settings = parseSoulSettings(soul?.settings);
    const parts = input.parts
      .map((part) => part.trim())
      .filter(Boolean)
      .slice(0, MAX_BUBBLES);
    if (parts.length === 0) {
      throw apiError('VALIDATION_ERROR', 'parts must contain text', 400);
    }
    const replyToId =
      typeof input.replyToId === 'number' &&
      Number.isSafeInteger(input.replyToId) &&
      input.replyToId > 0
        ? input.replyToId
        : undefined;

    const chatKey = `${accountId}:${chatId}`;
    this.cancelTyping(chatKey);
    const token = this.nextToken(chatKey);
    const messageId = replyToId ?? null;
    const messageIds: number[] = [];
    let typingMs = 0;

    try {
      for (const [index, text] of parts.entries()) {
        if (!this.isCurrent(chatKey, token)) {
          this.markSuperseded({
            userId,
            accountId,
            chatId,
            runId: null,
            messageId,
            part: index,
            total: parts.length,
            typingMode: settings.typingMode,
          });
          break;
        }
        if (index > 0) {
          await this.wait(
            PART_PAUSE_MIN_MS +
              Math.floor(
                Math.random() * (PART_PAUSE_MAX_MS - PART_PAUSE_MIN_MS),
              ),
            chatKey,
            token,
          );
        }
        const plan = typingPlan(text, settings);
        const fixed =
          typeof input.typing === 'number' && Number.isFinite(input.typing)
            ? Math.min(60_000, Math.max(0, Math.round(input.typing)))
            : null;
        const duration =
          input.typing === 'off'
            ? 0
            : fixed !== null
              ? fixed
              : plan.durationMs;
        if (duration > 0) {
          this.startTyping(chatKey, token, userId, accountId, chatId, {
            heartbeatMs: plan.heartbeatMs,
            delayMs: 0,
          });
          await this.wait(duration, chatKey, token);
          typingMs += duration;
        } else if (index === 0) {
          await this.wait(settings.replyDelayMs, chatKey, token);
        }
        if (!this.isCurrent(chatKey, token)) break;

        this.states.transition({
          userId,
          accountId,
          chatId,
          state: 'sending',
          messageId,
          part: index + 1,
          total: parts.length,
          typingMode: settings.typingMode,
        });
        const inputMessage: {
          text: string;
          replyToId?: number;
          quote?: string;
        } = { text };
        if (index === 0 && replyToId !== undefined) {
          inputMessage.replyToId = replyToId;
          if (input.quote) inputMessage.quote = input.quote;
        }
        const sent = await this.messaging.sendMessage(
          userId,
          accountId,
          String(chatId),
          inputMessage,
        );
        this.clearTyping(chatKey);
        messageIds.push(sent.id);
        this.presence.touch(accountId);
        // Best-effort: the workflow's text still belongs to the conversation.
        await this.memory
          .append(accountId, chatId, 'assistant', text, { messageId: sent.id })
          .catch(() => undefined);
      }

      if (!this.isCurrent(chatKey, token)) {
        return {
          messageIds,
          state: this.states.stateOf(accountId, chatId),
          typingMs,
        };
      }
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'sent',
        messageId,
        part: parts.length,
        total: parts.length,
        typingMode: settings.typingMode,
      });
      return {
        messageIds,
        state: this.states.stateOf(accountId, chatId),
        typingMs,
      };
    } catch (error) {
      this.markError({
        userId,
        accountId,
        chatId,
        messageId,
      });
      throw error;
    }
  }

  /** True when the workflow engine owns the account and AI must stay silent. */
  private workflowGate(account: Pick<TelegramAccountModel, 'workflowId'>): boolean {
    if (account.workflowId) return true;
    return envFlag('AI_WORKFLOW_STRICT');
  }

  /**
   * True when the account is bound to a girl-agent style Eve persona.
   *
   * The query is defensive: an older database without the Eve tables must keep
   * the legacy autopilot working rather than failing every incoming message.
   */
  private async isEveAccount(accountId: string): Promise<boolean> {
    try {
      const row = await this.prisma.evePersonaAccount.findFirst({
        where: { accountId, enabled: true },
        select: { id: true },
      });
      return row !== null;
    } catch {
      return false;
    }
  }

  /** Same gate for a late check where only the account id is at hand. */
  private async workflowGateById(accountId: string): Promise<boolean> {
    const row = (await this.prisma.telegramAccount.findUnique({
      where: { id: accountId },
      select: { workflowId: true },
    })) as Pick<TelegramAccountModel, 'workflowId'> | null;
    return row ? this.workflowGate(row) : false;
  }

  /** Account that belongs to `userId`, or a 404. */
  private async requireAccount(
    userId: string,
    accountId: string,
  ): Promise<TelegramAccountModel> {
    const account = (await this.prisma.telegramAccount.findUnique({
      where: { id: accountId },
    })) as TelegramAccountModel | null;
    if (!account || account.userId !== userId) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Telegram account not found');
    }
    return account;
  }

  /** True while a generation for this key is still fresh. */
  private alreadyGenerated(key: string, now = Date.now()): boolean {
    const at = this.generated.get(key);
    if (at === undefined) return false;
    if (now - at >= GENERATE_DEDUPE_TTL_MS) {
      this.generated.delete(key);
      return false;
    }
    return true;
  }

  /** Reserves a dedupe key before the model runs. */
  private rememberGenerated(key: string, now = Date.now()): void {
    this.generated.delete(key);
    this.generated.set(key, now);
    while (this.generated.size > GENERATE_DEDUPE_LIMIT) {
      const oldest = this.generated.keys().next().value;
      if (oldest === undefined) break;
      this.generated.delete(oldest);
    }
  }

  /**
   * One generation cycle: rate limits, media/voice context, prompt, memory and
   * the LLM call. Sends and types nothing; the returned {@link Generation} is
   * delivered by {@link deliverReply} (or handed to the Action API as is).
   */
  private async generateCycle(
    job: ReplyJob,
    existingToken?: number,
  ): Promise<{ token: number; gen: Generation }> {
    const { userId, accountId, chatId, threadId, soul, senderName, token } =
      job;
    const chatKey = `${accountId}:${chatId}`;
    const texts = job.texts;
    const settings = parseSoulSettings(soul.settings);
    const policy: TypingPolicy = settings;
    const messageId = job.replyToId ?? texts.at(-1)?.id ?? null;
    const runToken = existingToken ?? (token || this.nextToken(chatKey));
    if (existingToken === undefined && token === 0) {
      this.cancelTyping(chatKey);
    }
    const gen: Generation = {
      runId: null,
      text: '',
      parts: [],
      reasoning: null,
      items: [],
      superseded: false,
      skills: { slugs: [], source: 'soul' },
    };
    const maxParts = normaliseMaxParts(job.maxParts, settings.maxParts);
    const canType =
      !job.returnText && !job.draft && policy.typingMode !== 'off';

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
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'idle',
        messageId,
        typingMode: settings.typingMode,
      });
      return { token: runToken, gen };
    }
    if (settings.maxPerChatPerDay > 0 && perChat >= settings.maxPerChatPerDay) {
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'idle',
        messageId,
        typingMode: settings.typingMode,
      });
      return { token: runToken, gen };
    }

    const imageIds = texts
      .filter((item) => isImageMedia(item.media))
      .map((item) => item.id);
    const latestImage = texts.find((item) => isImageMedia(item.media));
    if (latestImage) {
      this.lastImages.set(chatKey, { id: latestImage.id, at: Date.now() });
    } else {
      const cached = this.lastImages.get(chatKey);
      if (cached && Date.now() - cached.at < LAST_IMAGE_TTL_MS) {
        imageIds.push(cached.id);
      }
    }
    // One collage per burst, and only for messages of this burst: the newest
    // animated sticker/emoji/GIF is what the model should react to.
    const animatedItem = [...texts]
      .reverse()
      .find((item) => needsFrameCollage(item.media));
    const [images, voice] = await Promise.all([
      this.imagesFor(userId, accountId, chatId, imageIds),
      this.transcribeVoices(userId, accountId, chatId, texts),
    ]);
    let hasCollage = false;
    if (animatedItem) {
      const collage = await this.collageImage(
        userId,
        accountId,
        chatId,
        animatedItem.id,
      );
      if (collage) {
        // The sticker is the newest thing in the burst: make room for it.
        while (images.length >= MAX_IMAGES) images.shift();
        images.push(collage);
        hasCollage = true;
      }
      emitLog({
        level: hasCollage ? 'debug' : 'warn',
        source: 'ai',
        action: 'dm.autopilot.sticker',
        message: hasCollage
          ? `Attached a frame collage of ${animatedItem.media?.kind} ${animatedItem.id}`
          : `Could not build a frame collage of ${animatedItem.media?.kind} ${animatedItem.id}`,
        status: hasCollage ? 'ok' : 'failed',
        accountId,
        chatId,
        details: {
          messageId: animatedItem.id,
          kind: animatedItem.media?.kind ?? null,
          emoji: animatedItem.media?.emoji ?? null,
          frames: hasCollage,
        },
      });
    }
    if (voice.transcripts.size > 0) {
      const lastEntry = [...voice.transcripts.entries()].at(-1);
      if (lastEntry) {
        this.lastVoice.set(chatKey, {
          text: lastEntry[1],
          at: Date.now(),
          messageId: lastEntry[0],
        });
      }
    }
    // A text-only follow-up may ask about a voice note that was already
    // transcribed — possibly hours ago, when the 3-minute cache above is long
    // gone. The lookup then finds the note in the chat history and transcribes
    // it once, so the model never has to claim it cannot listen to audio.
    const voiceRef =
      voice.transcripts.size > 0
        ? null
        : await this.resolveVoiceFollowUp(
            userId,
            accountId,
            chatId,
            texts,
          );
    const reusedVoice = voiceRef?.text ?? '';
    // Voice notes are replaced by their transcript; untranscribed audio keeps
    // an honest placeholder and the note below tells the model not to invent
    // an excuse.
    const items: IncomingText[] = texts.map((item) => {
      const transcript = voice.transcripts.get(item.id);
      if (transcript) return { ...item, text: `[голосовое] «${transcript}»` };
      if (isAudioMedia(item.media)) return { ...item, text: VOICE_FAILED_TEXT };
      return item;
    });
    gen.items = items;
    // The soul is the account's own persona, not the owner's assistant: naming
    // the owner here made models refuse ("I am Alisa, I won't write for him").
    const soulName = soul.name?.trim() ?? '';
    const selfIntro = soulName
      ? `Ты — ${soulName}, это твоя личная переписка.`
      : 'Это твоя личная переписка.';
    const selfAnswer = soulName
      ? `от своего лица, как ${soulName}`
      : 'от своего лица';
    const instruction = [
      hasCollage ? STICKER_FRAMES_NOTE : '',
      images.length > (hasCollage ? 1 : 0)
        ? 'Собеседник прислал изображение — посмотри, что на нём, и ответь по смыслу.'
        : '',
      voice.transcripts.size > 0 || reusedVoice
        ? 'Голосовое сообщение уже расшифровано — расшифровка ниже, ответь по её смыслу.'
        : '',
      soul.mode === 'draft'
        ? `${selfIntro} Предложи ответ ${selfAnswer}. Не говори о владельце и не предлагай что-то ему передать.`
        : `${selfIntro} Ответь ${selfAnswer}; не говори о владельце и не предлагай что-то ему передать.`,
    ]
      .filter(Boolean)
      .join(' ');
    // Models drift, so the format is spelled out both here and in the system
    // prompt; `parseReply` still accepts plain text when they ignore it.
    // A question about a picture with no picture attached must not be answered
    // from imagination — say honestly that nothing was received.
    const noImageNote =
      images.length === 0 && mentionsPicture(items)
        ? 'Изображения к этому сообщению нет — не выдумывай, что на нём, и не говори, что оно мутное; коротко скажи, что не видишь картинки, и попроси прислать.'
        : '';
    const reusedVoiceNote = reusedVoice
      ? `Собеседник спрашивает про голосовое сообщение, которое уже расшифровано: «${reusedVoice}». Ответь по смыслу этой расшифровки и не говори, что не можешь послушать аудио.`
      : '';
    // With a reused transcript there is nothing to excuse, even if an earlier
    // burst had a failed note. The line names the usual invented excuses so
    // the model cannot fall back on "no headphones / the sound is off".
    const noVoiceNote =
      (voice.failed || voiceRef?.source === 'failed') && !reusedVoice
        ? VOICE_FAILED_NOTE
        : '';
    // One message is the default; `---` is reserved for genuinely separate
    // thoughts, and never produces more bubbles than the policy allows.
    const replyFormat = [
      'Формат ответа:',
      maxParts <= 1
        ? '- одно короткое сообщение; несколько мыслей — в одном сообщении, без ---'
        : `- 1–${maxParts} коротких сообщения; части разделяй строкой --- и только для действительно отдельных мыслей`,
      '- если часть отвечает на конкретное входящее сообщение из списка, начни её с [#N] (N — его номер)',
      '- если поможет короткая цитата из сообщения, добавь отдельной строкой: цитата: «...»',
      '- пиши как живой человек: без Markdown, без списков, заголовков и подписи.',
    ].join('\n');
    const burstPrompt =
      items.length > 1
        ? [
            `Входящие личные сообщения от «${senderName}» подряд:`,
            ...items.map(
              (item, index) => `${index + 1}. ${item.text.slice(0, 2000)}`,
            ),
            '',
            ...(noImageNote ? [noImageNote, ''] : []),
            ...(noVoiceNote ? [noVoiceNote, ''] : []),
            ...(reusedVoiceNote ? [reusedVoiceNote, ''] : []),
            instruction,
            '',
            replyFormat,
          ].join('\n')
        : [
            `Входящее личное сообщение от «${senderName}»:`,
            (items[0]?.text ?? '').slice(0, 4000),
            '',
            ...(noImageNote ? [noImageNote, ''] : []),
            ...(noVoiceNote ? [noVoiceNote, ''] : []),
            ...(reusedVoiceNote ? [reusedVoiceNote, ''] : []),
            instruction,
            '',
            replyFormat,
          ].join('\n');
    // A workflow-initiated run carries an owner instruction instead of a peer
    // burst. The persona and history still come from the soul, so the result
    // reads like any other autopilot reply.
    const prompt =
      job.promptOverride !== undefined
        ? [
            'Задание от владельца для этого чата:',
            job.promptOverride.slice(0, 4000),
            '',
            'Это указание владельца, но ответ в чат пишешь ты сама — от своего лица.',
            '',
            instruction,
            '',
            replyFormat,
          ].join('\n')
        : burstPrompt;

    // Read the history before storing this turn, otherwise the new message
    // would appear twice (in history and in the prompt).
    const history = (await this.memory.recentTurns(accountId, chatId, 10))
      .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
      .map((turn) => ({
        role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: turn.content,
      }));
    if (!this.isCurrent(chatKey, runToken)) {
      gen.superseded = true;
      this.markSuperseded({
        userId,
        accountId,
        chatId,
        runId: gen.runId,
        messageId,
        typingMode: settings.typingMode,
      });
      return { token: runToken, gen };
    }
    // Stored before generating: a cancelled run still keeps the incoming
    // messages, so the next reply sees the whole consecutive exchange. A
    // workflow prompt is the owner speaking, so it is never stored as a peer
    // turn.
    if (job.storeIncoming) {
      for (const item of items) {
        await this.memory.append(accountId, chatId, 'user', item.text, {
          messageId: item.id,
        });
      }
    }

    const peerBlock = settings.peerProfile
      ? await this.peerBlock(userId, accountId, chatId)
      : '';
    if (!this.isCurrent(chatKey, runToken)) {
      gen.superseded = true;
      this.markSuperseded({
        userId,
        accountId,
        chatId,
        runId: gen.runId,
        messageId,
        typingMode: settings.typingMode,
      });
      return { token: runToken, gen };
    }

    // `thinking` is announced before the first LLM round; `smart`/`on_think`
    // also show "typing…" from here (the heartbeat is clamped to 2–5 s). The
    // reasoning itself is streamed to the dashboard, never to Telegram.
    this.states.transition({
      userId,
      accountId,
      chatId,
      state: 'thinking',
      messageId,
      typingMode: settings.typingMode,
    });
    // `off` and `on_compose` stay silent while the model thinks: the latter
    // starts only when there is real text to type (see `deliverReply`).
    if (canType && typesWhileThinking(policy.typingMode)) {
      // The DM autopilot already started the heartbeat right after the read;
      // only the Action API paths (no incoming message) start it here.
      const active = this.typing.get(chatKey);
      if (!active || active.token !== runToken) {
        const delay =
          policy.typingMode === 'smart' ? policy.typingStartDelayMs : 0;
        this.startTyping(chatKey, runToken, userId, accountId, chatId, {
          heartbeatMs: policy.typingHeartbeatMs,
          delayMs: delay,
        });
      }
    }
    const thinking = this.thinkingEmitter(userId, accountId, chatId);
    // Per-chat/topic skill override when a row exists, otherwise the soul's
    // set. `replaceSoulSkills` makes the resolved list authoritative, so an
    // override that drops a soul skill is honoured.
    const skills = await this.chatSkills.resolve(accountId, chatId, threadId);
    gen.skills = { slugs: skills.slugs, source: skills.source };
    const result = await this.agent.run({
      userId,
      accountId,
      chatId,
      source: 'dm',
      prompt,
      images,
      tools: [],
      skillSlugs: skills.slugs,
      replaceSoulSkills: true,
      onRunStart: (runId) => {
        thinking.start(runId);
        gen.runId = runId;
        this.states.transition({
          userId,
          accountId,
          chatId,
          state: 'thinking',
          runId,
          messageId,
          typingMode: settings.typingMode,
        });
      },
      onReasoningDelta: (text) => thinking.delta(text),
      systemExtra: [
        peerBlock,
        'Ты сама ведёшь этот аккаунт. Никогда не говори, что пишешь «за владельца» или «от его лица», и не предлагай пересказать сообщение владельцу.',
        `Это живая переписка. Не упоминай ИИ, инструменты и настройки. Пиши коротко, как в мессенджере: ${maxParts <= 1 ? 'одним сообщением, без ---' : `1–${maxParts} сообщения, --- только для отдельных мыслей`}, без Markdown и без кавычек вокруг всего текста.`,
        'Не будь душной: без морализаторства, нотаций и непрошеных оговорок. Не отказывайся из вежливости, не читай лекций и не объясняй очевидное — отвечай легко и по делу.',
        'Проявляй интерес к собеседнику: цепляйся за детали, задавай конкретный вопрос по его словам, вспоминай, что он говорил раньше. Не превращай это в допрос: один вопрос на сообщение, и не в каждом ответе.',
        'Когда рассказываешь о себе — коротко, живо, с деталью и эмоцией; в конце оставь крючок: спроси его мнение или подколи. Не перетягивай внимание на себя и не читай монолог.',
        'Не выдумывай технических ограничений: не ссылайся на отсутствие наушников, микрофона, звука, камеры или доступа к файлам. Если чего-то действительно не хватает, скажи об этом прямо и попроси прислать нужное.',
        peerBlock
          ? 'Данные собеседника выше взяты из его профиля Telegram. Если он спрашивает свой username, имя или профиль — назови их прямо и не говори, что видишь только имя.'
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      history,
    });
    thinking.done(result.reasoning);

    if (!this.isCurrent(chatKey, runToken)) {
      await this.stopTyping(chatKey, runToken, true);
      gen.superseded = true;
      gen.runId = result.runId;
      gen.text = result.text;
      gen.reasoning = result.reasoning ?? null;
      this.markSuperseded({
        userId,
        accountId,
        chatId,
        runId: result.runId,
        messageId,
        typingMode: settings.typingMode,
      });
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.cancel',
        message: `Reply in ${chatId} cancelled before sending`,
        status: 'ok',
        accountId,
        chatId,
        details: { phase: 'generation', token: runToken },
      });
      return { token: runToken, gen };
    }

    const parsed = applyPartsPolicy(parseReply(result.text), maxParts);
    emitLog({
      level: 'debug',
      source: 'ai',
      action: 'dm.reply.parts',
      message: `Reply parts: ${parsed.raw} raw → ${parsed.parts.length} kept (${parsed.merged ? 'merged' : 'split'}, max ${parsed.maxParts})`,
      status: 'ok',
      accountId,
      chatId,
      details: {
        raw: parsed.raw,
        kept: parsed.parts.length,
        merged: parsed.merged,
        maxParts: parsed.maxParts,
      },
    });
    gen.runId = result.runId;
    gen.text = result.text;
    gen.reasoning = result.reasoning ?? null;
    if (parsed.parts.length === 0) {
      await this.stopTyping(chatKey, runToken, true);
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'idle',
        runId: result.runId,
        messageId,
        typingMode: settings.typingMode,
      });
      return { token: runToken, gen };
    }
    gen.parts = parsed.parts;
    this.states.transition({
      userId,
      accountId,
      chatId,
      state: 'composing',
      runId: result.runId,
      messageId,
      total: parsed.parts.length,
      typingMode: settings.typingMode,
    });
    return { token: runToken, gen };
  }

  /**
   * Sends the bubbles of one generation, applying the typing policy and the
   * per-part state transitions. `returnText` stops after generation (the
   * Action API path) and a draft is stored instead of sent.
   */
  private async deliverReply(
    job: ReplyJob,
    token: number,
    gen: Generation,
    outcome: ReplyOutcome,
  ): Promise<void> {
    const { userId, accountId, chatId, soul, senderName } = job;
    const chatKey = `${accountId}:${chatId}`;
    const settings = parseSoulSettings(soul.settings);
    const policy: TypingPolicy = settings;
    const parts = gen.parts;
    const items = gen.items;
    const partsText = parts.map((part) => part.text).join('\n\n');
    const defaultReplyTo = job.replyToId ?? items.at(-1)?.id ?? 0;
    const messageId = job.replyToId ?? items.at(-1)?.id ?? null;
    const total = parts.length;
    outcome.text = partsText;
    outcome.runId = gen.runId;

    if (job.returnText) return;

    if (job.draft) {
      // A draft is one editable text, so the bubbles are joined back together.
      await this.stopTyping(chatKey, token, false);
      await this.memory.append(accountId, chatId, 'draft', partsText, {
        runId: gen.runId,
      });
      this.realtime.emitToUser(userId, 'ai.draft', {
        accountId,
        chatId,
        text: partsText,
        senderName,
        runId: gen.runId,
        reasoning: gen.reasoning,
      });
      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'idle',
        runId: gen.runId,
        messageId,
        total,
        typingMode: settings.typingMode,
      });
      return;
    }

    const cancelled = async (index: number): Promise<boolean> => {
      if (this.isCurrent(chatKey, token)) return false;
      await this.stopTyping(chatKey, token, true);
      outcome.superseded = true;
      this.markSuperseded({
        userId,
        accountId,
        chatId,
        runId: gen.runId,
        messageId,
        part: index,
        total,
        typingMode: settings.typingMode,
      });
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.cancel',
        message: `Reply in ${chatId} cancelled before part ${index + 1} of ${total}`,
        status: 'ok',
        accountId,
        chatId,
        details: {
          phase: 'parts',
          token,
          sent: outcome.messageIds.length,
          parts: total,
        },
      });
      return true;
    };

    for (const [index, part] of parts.entries()) {
      if (await cancelled(index)) return;

      if (index > 0) {
        // A short pause makes the next bubble arrive as a separate message.
        await this.wait(
          PART_PAUSE_MIN_MS +
            Math.floor(
              Math.random() * (PART_PAUSE_MAX_MS - PART_PAUSE_MIN_MS),
            ),
          chatKey,
          token,
        );
      }
      const plan = typingPlan(part.text, policy);
      if (plan.durationMs > 0) {
        this.ensureTyping(chatKey, token, userId, accountId, chatId, {
          heartbeatMs: plan.heartbeatMs,
        });
        await this.wait(plan.durationMs, chatKey, token);
      } else if (index === 0) {
        await this.wait(settings.replyDelayMs, chatKey, token);
      }
      if (await cancelled(index)) return;

      this.states.transition({
        userId,
        accountId,
        chatId,
        state: 'sending',
        runId: gen.runId,
        messageId,
        part: index + 1,
        total,
        typingMode: settings.typingMode,
      });

      const replyToId =
        part.messageIndex !== undefined
          ? (items[part.messageIndex - 1]?.id ?? defaultReplyTo)
          : defaultReplyTo;
      const input: { text: string; replyToId?: number; quote?: string } = {
        text: part.text,
      };
      if (Number.isSafeInteger(replyToId) && replyToId > 0) {
        input.replyToId = replyToId;
      }
      if (part.quote) input.quote = part.quote;

      const sent = await this.messaging.sendMessage(
        userId,
        accountId,
        String(chatId),
        input,
      );
      outcome.messageIds.push(sent.id);
      this.clearTyping(chatKey);
      this.presence.touch(accountId);
      await this.memory.append(accountId, chatId, 'assistant', part.text, {
        messageId: sent.id,
        runId: gen.runId,
      });
      this.realtime.emitToUser(userId, 'ai.reply', {
        accountId,
        chatId,
        text: part.text,
        message: sent,
        runId: gen.runId,
        // Reasoning is shown only in the dashboard bubble; it is never sent to
        // Telegram (only `part.text` goes into `sendMessage`).
        reasoning: gen.reasoning,
      });
    }

    // Remember which bubbles this run produced so the dashboard can attach the
    // reasoning to them. Best-effort: a bookkeeping failure cannot undo a sent
    // reply.
    if (gen.runId) {
      try {
        await this.agentRuns.attachMessages(gen.runId, outcome.messageIds);
      } catch (error) {
        this.logger.warn(
          `Could not attach messages to run ${gen.runId}: ${(error as Error).message}`,
        );
      }
    }

    emitLog({
      level: 'info',
      source: 'ai',
      action: 'dm.autopilot.reply',
      message: `Autopilot replied in ${chatId}`,
      status: 'ok',
      accountId,
      chatId,
      details: {
        runId: gen.runId,
        senderName,
        messageIds: outcome.messageIds,
        parts: total,
        skillsSource: gen.skills.source,
        skills: gen.skills.slugs,
      },
    });
    this.states.transition({
      userId,
      accountId,
      chatId,
      state: 'sent',
      runId: gen.runId,
      messageId,
      part: total,
      total,
      typingMode: settings.typingMode,
    });
    void this.memory.maybeCompact(accountId, chatId);
  }
}

/** `threadId` of an Action API call: a positive topic id, otherwise `0`. */
function normaliseThreadId(value: unknown): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : 0;
}

/** Bubble cap: 1–3; `undefined` falls back to the soul setting. */
function normaliseMaxParts(
  value: unknown,
  fallback: number | undefined,
): number {
  const base =
    typeof fallback === 'number' && Number.isFinite(fallback) ? fallback : 1;
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return Math.min(3, Math.max(1, Math.round(base)));
  return Math.min(3, Math.max(1, Math.round(number)));
}
