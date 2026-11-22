import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PushSubscriptionModel } from '@repo/database';
import type { Subscription } from 'rxjs';
import * as webpush from 'web-push';
import { apiError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { ClientManagerService } from '../telegram/client-manager.service.js';

/** Maximum notification body length, in characters. */
export const PUSH_BODY_LIMIT = 120;

/** One notification as it is sent to the browser (`sw.js` reads this shape). */
export interface PushPayload {
  title: string;
  body: string;
  chatId: number;
  accountId: string;
  tag: string;
}

/** Subscription fields accepted by `PUT /push/subscribe`. */
export interface PushSubscribeInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushTestResult {
  sent: number;
  failed: number;
}

/** The part of a `message.new` realtime event that push cares about. */
export interface PushMessageSource {
  accountId: string;
  chatId: number;
  text: string;
  mediaType?: string | null;
  outgoing?: boolean;
}

export interface PushPayloadContext {
  accountName?: string | null;
  chatTitle?: string | null;
}

const MEDIA_PLACEHOLDERS: Record<string, string> = {
  photo: 'Фото',
  video: 'Видео',
  document: 'Файл',
  audio: 'Аудио',
  voice: 'Голосовое сообщение',
  sticker: 'Стикер',
  animation: 'GIF',
  location: 'Геопозиция',
  contact: 'Контакт',
  poll: 'Опрос',
};

/** Human-readable placeholder for a media-only message. */
export function mediaPlaceholder(mediaType: string | null | undefined): string {
  if (!mediaType) return 'Новое сообщение';
  return MEDIA_PLACEHOLDERS[mediaType] ?? 'Медиа';
}

/** Collapses whitespace and cuts the text to `limit` characters. */
export function truncatePushBody(
  text: string,
  limit = PUSH_BODY_LIMIT,
): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/**
 * Notification payload for an incoming message.
 *
 * The chat title is used alone; when the account name is known it is prefixed
 * so several attached accounts stay distinguishable in the OS notification.
 */
export function buildPushPayload(
  source: PushMessageSource,
  context: PushPayloadContext = {},
): PushPayload {
  const body = truncatePushBody(
    source.text || mediaPlaceholder(source.mediaType),
  );
  const chatTitle = context.chatTitle?.trim() || `Чат ${source.chatId}`;
  const accountName = context.accountName?.trim();
  return {
    title: accountName ? `${accountName}: ${chatTitle}` : chatTitle,
    body,
    chatId: source.chatId,
    accountId: source.accountId,
    tag: `chat:${source.chatId}`,
  };
}

/**
 * Per-chat and per-user send limits.
 *
 * `allow` is a read-only check so a muted chat does not consume the budget;
 * `record` is called once a notification is actually delivered.
 */
export class PushThrottle {
  private readonly chats = new Map<string, number>();
  private readonly users = new Map<string, number[]>();

  constructor(
    private readonly chatWindowMs = 10_000,
    private readonly userWindowMs = 60_000,
    private readonly userLimit = 20,
  ) {}

  allow(userId: string, chatId: number, now = Date.now()): boolean {
    const last = this.chats.get(`${userId}:${chatId}`);
    if (last !== undefined && now - last < this.chatWindowMs) return false;

    const recent = this.recentFor(userId, now);
    return recent.length < this.userLimit;
  }

  record(userId: string, chatId: number, now = Date.now()): void {
    this.chats.set(`${userId}:${chatId}`, now);
    const recent = this.recentFor(userId, now);
    recent.push(now);
    this.users.set(userId, recent);
    this.prune(now);
  }

  reset(): void {
    this.chats.clear();
    this.users.clear();
  }

  private recentFor(userId: string, now: number): number[] {
    const recent = this.users.get(userId) ?? [];
    return recent.filter((at) => now - at < this.userWindowMs);
  }

  /** Keeps the maps small; runs on every record, which is at most 20/min. */
  private prune(now: number): void {
    for (const [key, at] of this.chats) {
      if (now - at >= this.chatWindowMs) this.chats.delete(key);
    }
    for (const [userId, times] of this.users) {
      const recent = times.filter((at) => now - at < this.userWindowMs);
      if (recent.length === 0) this.users.delete(userId);
      else this.users.set(userId, recent);
    }
  }
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface VapidResolution {
  enabled: boolean;
  config: VapidConfig | null;
  missing: string[];
}

const DEFAULT_VAPID_SUBJECT = 'mailto:admin@localhost';

/**
 * Decides whether Web Push is configured. Both keys are required; the subject
 * falls back to a local mailto so key rotation does not need a third variable.
 */
export function resolveVapidConfig(
  env: Record<string, string | undefined>,
): VapidResolution {
  const publicKey = env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = env.VAPID_PRIVATE_KEY?.trim();
  const subject = env.VAPID_SUBJECT?.trim() || DEFAULT_VAPID_SUBJECT;

  const missing: string[] = [];
  if (!publicKey) missing.push('VAPID_PUBLIC_KEY');
  if (!privateKey) missing.push('VAPID_PRIVATE_KEY');
  if (missing.length > 0) {
    return { enabled: false, config: null, missing };
  }
  return {
    enabled: true,
    config: { publicKey: publicKey!, privateKey: privateKey!, subject },
    missing,
  };
}

interface DialogState {
  title: string | null;
  muted: boolean;
}

/** Resolves to `fallback` when `promise` takes longer than `ms`. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isGoneSubscription(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
}

/**
 * Web Push delivery for incoming messages.
 *
 * Subscriptions live in SQLite (one row per browser/device endpoint). The
 * service listens on the in-process realtime bus, so it only sees events that
 * an already-running updates loop produced; it never opens Telegram clients.
 */
@Injectable()
export class PushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushService.name);
  private readonly throttle = new PushThrottle();
  private vapid: VapidResolution;
  private readonly accountNames = new Map<string, string>();
  private events?: Subscription;

  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeService,
    private readonly clients: ClientManagerService,
  ) {
    this.vapid = resolveVapidConfig({
      VAPID_PUBLIC_KEY: config.get<string>('VAPID_PUBLIC_KEY'),
      VAPID_PRIVATE_KEY: config.get<string>('VAPID_PRIVATE_KEY'),
      VAPID_SUBJECT: config.get<string>('VAPID_SUBJECT'),
    });

    let invalidKeys: string | null = null;
    if (this.vapid.enabled && this.vapid.config) {
      try {
        webpush.setVapidDetails(
          this.vapid.config.subject,
          this.vapid.config.publicKey,
          this.vapid.config.privateKey,
        );
      } catch (error) {
        // Malformed keys must not stop the API from booting.
        invalidKeys = (error as Error).message;
        this.vapid = { enabled: false, config: null, missing: [] };
      }
    }

    if (!this.vapid.enabled) {
      const reason = invalidKeys
        ? `VAPID keys are invalid (${invalidKeys})`
        : `${this.vapid.missing.join(', ')} not set`;
      this.logger.warn(
        `Web Push is disabled: ${reason}. Generate keys with "bunx web-push generate-vapid-keys" and put them into apps/api/.env. /push routes answer 503 PUSH_DISABLED.`,
      );
    }
  }

  onModuleInit(): void {
    this.events = this.realtime.events$.subscribe(({ userId, event, payload }) => {
      if (event !== 'message.new') return;
      void this.handleNewMessage(userId, payload).catch((error: unknown) => {
        this.logger.debug(
          `Push for a new message failed: ${(error as Error).message}`,
        );
      });
    });
  }

  onModuleDestroy(): void {
    this.events?.unsubscribe();
    this.events = undefined;
  }

  /** The VAPID public key handed to `pushManager.subscribe`. */
  getPublicKey(): { publicKey: string } {
    if (!this.vapid.enabled || !this.vapid.config) {
      throw apiError(
        'PUSH_DISABLED',
        'Web Push is not configured on this server',
        503,
      );
    }
    return { publicKey: this.vapid.config.publicKey };
  }

  async subscribe(
    userId: string,
    input: PushSubscribeInput,
    userAgent?: string,
  ): Promise<void> {
    this.requireEnabled();
    const parsed = parseSubscription(input);
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: parsed.endpoint },
      create: {
        userId,
        endpoint: parsed.endpoint,
        p256dh: parsed.p256dh,
        auth: parsed.auth,
        userAgent: userAgent?.slice(0, 255) ?? null,
      },
      update: {
        userId,
        p256dh: parsed.p256dh,
        auth: parsed.auth,
        userAgent: userAgent?.slice(0, 255) ?? null,
        lastSeenAt: new Date(),
      },
    });
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    if (typeof endpoint !== 'string' || !endpoint.trim()) {
      throw apiError(
        'PUSH_ENDPOINT_INVALID',
        'endpoint must be a non-empty string',
      );
    }
    await this.prisma.pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  /** Sends a test notification to every subscription of the user. */
  async sendTest(userId: string): Promise<PushTestResult> {
    this.requireEnabled();
    return this.sendToUser(userId, {
      title: 'CombainTelegram',
      body: 'Тестовое push-уведомление',
      chatId: 0,
      accountId: '',
      tag: 'push:test',
    });
  }

  private requireEnabled(): void {
    if (!this.vapid.enabled) {
      throw apiError(
        'PUSH_DISABLED',
        'Web Push is not configured on this server',
        503,
      );
    }
  }

  private async handleNewMessage(userId: string, payload: unknown): Promise<void> {
    if (!this.vapid.enabled) return;

    const event = payload as {
      accountId?: unknown;
      sessionId?: unknown;
      chatId?: unknown;
      message?: {
        text?: unknown;
        outgoing?: unknown;
        mediaType?: unknown;
      };
    };
    const message = event.message;
    if (!message || message.outgoing === true) return;
    if (typeof event.accountId !== 'string') return;
    if (typeof event.chatId !== 'number') return;

    const chatId = event.chatId;
    const accountId = event.accountId;
    if (!this.throttle.allow(userId, chatId)) return;

    const dialog = await this.dialogState(
      typeof event.sessionId === 'string' ? event.sessionId : null,
      chatId,
    );
    if (dialog.muted) return;

    // Throttle again: the dialog lookup may have taken long enough for another
    // event in the same chat to slip through.
    if (!this.throttle.allow(userId, chatId)) return;

    const result = await this.sendToUser(
      userId,
      buildPushPayload(
        {
          accountId,
          chatId,
          text: typeof message.text === 'string' ? message.text : '',
          mediaType:
            typeof message.mediaType === 'string' ? message.mediaType : null,
        },
        {
          accountName: await this.accountName(accountId),
          chatTitle: dialog.title,
        },
      ),
    );
    if (result.sent > 0) this.throttle.record(userId, chatId);
  }

  private async sendToUser(
    userId: string,
    payload: PushPayload,
  ): Promise<PushTestResult> {
    const subscriptions: PushSubscriptionModel[] =
      await this.prisma.pushSubscription.findMany({ where: { userId } });
    if (subscriptions.length === 0) return { sent: 0, failed: 0 };

    const body = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            body,
            { TTL: 3600 },
          );
          sent += 1;
        } catch (error) {
          failed += 1;
          if (isGoneSubscription(error)) {
            await this.prisma.pushSubscription
              .delete({ where: { endpoint: subscription.endpoint } })
              .catch(() => undefined);
          } else {
            this.logger.debug(
              `Push to ${subscription.endpoint.slice(0, 60)}… failed: ${(error as Error).message}`,
            );
          }
        }
      }),
    );

    return { sent, failed };
  }

  /**
   * Chat title and mute flag from the dialog, when a live client exists.
   *
   * This is one bounded RPC. Any failure (no client, no such dialog, timeout)
   * is non-fatal: the notification is still sent with a generic title.
   */
  private async dialogState(
    sessionId: string | null,
    chatId: number,
  ): Promise<DialogState> {
    const fallback: DialogState = { title: null, muted: false };
    if (!sessionId) return fallback;
    const client = this.clients.get(sessionId);
    if (!client) return fallback;

    try {
      const [dialog] = await withTimeout(
        client.getPeerDialogs(chatId),
        1500,
        [] as Awaited<ReturnType<typeof client.getPeerDialogs>>,
      );
      if (!dialog) return fallback;
      return {
        title: dialog.peer.displayName?.trim() || null,
        muted: dialog.isMuted === true,
      };
    } catch {
      return fallback;
    }
  }

  private async accountName(accountId: string): Promise<string | null> {
    const cached = this.accountNames.get(accountId);
    if (cached !== undefined) return cached;

    try {
      const account = await this.prisma.telegramAccount.findUnique({
        where: { id: accountId },
        select: { firstName: true, lastName: true, username: true },
      });
      if (!account) return null;
      const name = [account.firstName, account.lastName]
        .filter((part): part is string => Boolean(part?.trim()))
        .join(' ')
        .trim();
      const label = name || (account.username ? `@${account.username}` : null);
      if (label) this.accountNames.set(accountId, label);
      return label;
    } catch {
      return null;
    }
  }
}

function parseSubscription(input: PushSubscribeInput): {
  endpoint: string;
  p256dh: string;
  auth: string;
} {
  const endpoint = typeof input?.endpoint === 'string' ? input.endpoint.trim() : '';
  const p256dh = typeof input?.keys?.p256dh === 'string' ? input.keys.p256dh.trim() : '';
  const auth = typeof input?.keys?.auth === 'string' ? input.keys.auth.trim() : '';

  if (!endpoint) {
    throw apiError(
      'PUSH_ENDPOINT_INVALID',
      'endpoint must be a non-empty string',
    );
  }
  try {
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw apiError('PUSH_ENDPOINT_INVALID', 'endpoint must be a valid URL');
  }
  if (!p256dh || !auth) {
    throw apiError(
      'PUSH_KEYS_INVALID',
      'keys.p256dh and keys.auth are required',
    );
  }
  return { endpoint, p256dh, auth };
}
