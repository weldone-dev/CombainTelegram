import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import type {
  MessageMediaView,
  MessageView,
} from '../messaging/message-view.js';
import type { SoulModel, TelegramAccountModel } from '@repo/database';
import { PrismaService } from '../prisma/prisma.service.js';
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
import { typingDurationMs } from './typing.js';
import { parseReply } from './dm-reply.js';
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
  return (
    media.kind === 'photo' ||
    (media.kind === 'document' &&
      (media.mimeType ?? '').toLowerCase().startsWith('image/'))
  );
}

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
  timer: ReturnType<typeof setInterval>;
}

const BATCH_MS = 1500;
const MAX_AGE_MS = 120_000;
/** Telegram clears a typing action after ~5 s, so refresh it well before that. */
const TYPING_REFRESH_MS = 4_000;
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
    for (const entry of this.typing.values()) clearInterval(entry.timer);
    this.typing.clear();
    for (const timer of this.readTimers) clearTimeout(timer);
    this.readTimers.clear();
    this.accessCache.clear();
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

    const threadId = threadIdOf(data, message);

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
      (message.media?.kind === 'photo' ? '[изображение]' : '') ||
      `[${message.mediaType ?? 'media'}]`;
    if (!text) return;
    const senderName = message.senderName || `Чат ${chatId}`;

    // A human shows the read receipt the moment the message is opened. If the
    // account was offline (idle) it first comes back online, then reads after
    // the configured delay — like picking up the phone.
    const gate = await this.presence.incoming(accountId, chatId);
    if (gate.readDelayMs > 0) {
      const timer = setTimeout(() => {
        this.readTimers.delete(timer);
        void this.markRead(userId, accountId, chatId, message.id);
      }, gate.readDelayMs);
      timer.unref?.();
      this.readTimers.add(timer);
    } else {
      await this.markRead(userId, accountId, chatId, message.id);
    }

    const chatKey = `${accountId}:${chatId}`;
    // A new message always wins: it invalidates the reply that is generating
    // or typing right now, hides "typing…" and restarts after the debounce.
    const token = this.nextToken(chatKey);
    this.cancelTyping(chatKey);
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
    const settings = parseSoulSettings(soul.settings);
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

  /** Starts the "typing…" heartbeat that keeps the action visible. */
  private startTyping(
    chatKey: string,
    token: number,
    userId: string,
    accountId: string,
    chatId: number,
  ): void {
    this.clearTyping(chatKey);
    const send = (): void => {
      void this.messaging
        .sendTyping(userId, accountId, String(chatId), { status: 'typing' })
        .catch(() => undefined);
    };
    send();
    const timer = setInterval(send, TYPING_REFRESH_MS);
    timer.unref?.();
    this.typing.set(chatKey, {
      userId,
      accountId,
      chatId,
      token,
      startedAt: Date.now(),
      timer,
    });
  }

  private clearTyping(chatKey: string): void {
    const state = this.typing.get(chatKey);
    if (!state) return;
    clearInterval(state.timer);
    this.typing.delete(chatKey);
  }

  /** Hides "typing…" for whatever reply owns the chat right now. */
  private cancelTyping(chatKey: string): void {
    const state = this.typing.get(chatKey);
    if (!state) return;
    this.clearTyping(chatKey);
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
    this.clearTyping(chatKey);
    if (!cancel) return;
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
    const soul = await this.souls.model(accountId);
    if (!soul || !isAutopilotMode(soul.mode)) return;
    // Re-check the gate: an explicit access row shadows the soul allowlist, and
    // a block may have appeared while the burst was debouncing.
    const decision = await this.accessDecision(
      userId,
      accountId,
      chatId,
      threadId,
    );
    if (!this.chatAllowed(decision, soul, chatId)) return;
    if (!this.isCurrent(chatKey, token)) return;
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
    const [images, voice] = await Promise.all([
      this.imagesFor(userId, accountId, chatId, imageIds),
      this.transcribeVoices(userId, accountId, chatId, texts),
    ]);
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
    const instruction = [
      images.length > 0
        ? 'Собеседник прислал изображение — посмотри, что на нём, и ответь по смыслу.'
        : '',
      voice.transcripts.size > 0 || reusedVoice
        ? 'Голосовое сообщение уже расшифровано — расшифровка ниже, ответь по её смыслу.'
        : '',
      soul.mode === 'draft'
        ? 'Предложи ответ от лица владельца.'
        : 'Ответь от лица владельца.',
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
    const replyFormat = [
      'Формат ответа:',
      '- 1–3 коротких сообщения; каждое — отдельной частью, части разделяй строкой ---',
      '- если часть отвечает на конкретное входящее сообщение из списка, начни её с [#N] (N — его номер)',
      '- если поможет короткая цитата из сообщения, добавь отдельной строкой: цитата: «...»',
      '- пиши как живой человек: без Markdown, без списков, заголовков и подписи.',
    ].join('\n');
    const prompt =
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

    // Read the history before storing this turn, otherwise the new message
    // would appear twice (in history and in the prompt).
    const history = (await this.memory.recentTurns(accountId, chatId, 10))
      .filter((turn) => turn.role === 'user' || turn.role === 'assistant')
      .map((turn) => ({
        role: turn.role === 'assistant' ? ('assistant' as const) : ('user' as const),
        content: turn.content,
      }));
    if (!this.isCurrent(chatKey, token)) return;
    // Stored before generating: a cancelled run still keeps the incoming
    // messages, so the next reply sees the whole consecutive exchange.
    for (const item of items) {
      await this.memory.append(accountId, chatId, 'user', item.text, {
        messageId: item.id,
      });
    }

    const peerBlock = settings.peerProfile
      ? await this.peerBlock(userId, accountId, chatId)
      : '';
    if (!this.isCurrent(chatKey, token)) return;

    // No "typing…" while the model thinks: the indicator starts only when
    // there is real text to type, which also keeps the thinking phase silent.
    // The reasoning is streamed to the dashboard instead, never to Telegram.
    const thinking = this.thinkingEmitter(userId, accountId, chatId);
    // Per-chat/topic skill override when a row exists, otherwise the soul's
    // set. `replaceSoulSkills` makes the resolved list authoritative, so an
    // override that drops a soul skill is honoured.
    const skills = await this.chatSkills.resolve(accountId, chatId, threadId);
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
      onRunStart: (runId) => thinking.start(runId),
      onReasoningDelta: (text) => thinking.delta(text),
      systemExtra: [
        peerBlock,
        'Это живая переписка. Не упоминай ИИ, инструменты и настройки. Пиши коротко, как в мессенджере: 1–3 сообщения, без Markdown и без кавычек вокруг всего текста.',
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

    if (!this.isCurrent(chatKey, token)) {
      await this.stopTyping(chatKey, token, true);
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.cancel',
        message: `Reply in ${chatId} cancelled before sending`,
        status: 'ok',
        accountId,
        chatId,
        details: { phase: 'generation', token },
      });
      return;
    }

    const parts = parseReply(result.text);
    if (parts.length === 0) {
      await this.stopTyping(chatKey, token, true);
      return;
    }

    if (soul.mode === 'draft') {
      // A draft is one editable text, so the bubbles are joined back together.
      const draftText = parts.map((part) => part.text).join('\n\n');
      await this.stopTyping(chatKey, token, false);
      await this.memory.append(accountId, chatId, 'draft', draftText, {
        runId: result.runId,
      });
      this.realtime.emitToUser(userId, 'ai.draft', {
        accountId,
        chatId,
        text: draftText,
        senderName,
        runId: result.runId,
        reasoning: result.reasoning ?? null,
      });
      return;
    }

    const messageIds: number[] = [];
    const cancelled = async (index: number): Promise<boolean> => {
      if (this.isCurrent(chatKey, token)) return false;
      await this.stopTyping(chatKey, token, true);
      emitLog({
        level: 'debug',
        source: 'ai',
        action: 'dm.autopilot.cancel',
        message: `Reply in ${chatId} cancelled before part ${index + 1} of ${parts.length}`,
        status: 'ok',
        accountId,
        chatId,
        details: {
          phase: 'parts',
          token,
          sent: messageIds.length,
          parts: parts.length,
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
      if (settings.typing) {
        this.startTyping(chatKey, token, userId, accountId, chatId);
        await this.wait(
          typingDurationMs([...part.text].length, settings.typingSpeed),
          chatKey,
          token,
        );
      } else if (index === 0) {
        await this.wait(settings.replyDelayMs, chatKey, token);
      }
      if (await cancelled(index)) return;

      const replyToId =
        part.messageIndex !== undefined
          ? (items[part.messageIndex - 1]?.id ?? message.id)
          : message.id;
      const input: { text: string; replyToId: number; quote?: string } = {
        text: part.text,
        replyToId,
      };
      if (part.quote) input.quote = part.quote;

      const sent = await this.messaging.sendMessage(
        userId,
        accountId,
        String(chatId),
        input,
      );
      messageIds.push(sent.id);
      this.clearTyping(chatKey);
      this.presence.touch(accountId);
      await this.memory.append(accountId, chatId, 'assistant', part.text, {
        messageId: sent.id,
        runId: result.runId,
      });
      this.realtime.emitToUser(userId, 'ai.reply', {
        accountId,
        chatId,
        text: part.text,
        message: sent,
        runId: result.runId,
        // Reasoning is shown only in the dashboard bubble; it is never sent to
        // Telegram (only `part.text` goes into `sendMessage`).
        reasoning: result.reasoning ?? null,
      });
    }

    // Remember which bubbles this run produced so the dashboard can attach the
    // reasoning to them. Best-effort: a bookkeeping failure cannot undo a sent
    // reply.
    try {
      await this.agentRuns.attachMessages(result.runId, messageIds);
    } catch (error) {
      this.logger.warn(
        `Could not attach messages to run ${result.runId}: ${(error as Error).message}`,
      );
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
        runId: result.runId,
        senderName,
        messageIds,
        parts: parts.length,
        skillsSource: skills.source,
        skills: skills.slugs,
      },
    });
    void this.memory.maybeCompact(accountId, chatId);
  }
}
