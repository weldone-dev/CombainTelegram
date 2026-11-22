import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { TelegramClient, User } from '@mtcute/node';
import { tl } from '@mtcute/node';
import type { UserModel } from '@repo/database';
import { AuthAttemptStore } from './auth-attempt.store.js';
import type { AuthAttemptView } from './auth-attempt.store.js';
import { mapTelegramError } from './telegram-error.js';
import { emitLog } from '../logs/log-sink.js';
import { AccountSessionsService } from '../accounts/account-sessions.service.js';
import type { AccountView } from '../accounts/account-view.js';
import { ClientManagerService } from '../telegram/client-manager.service.js';
import type { ResolvedProfile } from '../telegram/client-profile.service.js';
import { ClientProfileService } from '../telegram/client-profile.service.js';
import { ProxiesService } from '../proxies/proxies.service.js';
import { apiError } from '../common/api-error.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import {
  optionalString,
  requireDeviceId,
  requireSecret,
  requireString,
} from '../common/validation.js';
import { toTelegramUser } from './phone-auth.service.js';

const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const FIRST_URL_TIMEOUT_MS = 25_000;

export interface QrStartDto {
  deviceId?: unknown;
  profile?: unknown;
  label?: unknown;
  proxyId?: unknown;
}

export interface QrStartView {
  attemptId: string;
  url: string;
  expiresAt: string;
}

export interface QrStatusView {
  status: string;
  url?: string;
  expiresAt?: string;
  error?: string;
  account?: AccountView;
}

interface QrAttempt {
  id: string;
  userId: string;
  deviceId: string;
  label: string | null;
  profile: ResolvedProfile;
  proxyId: string | null;
  client: TelegramClient;
  abort: AbortController;
  status: string;
  url?: string;
  expiresAt?: Date;
  error?: string;
  expiresAtMs: number;
  passwordDeferred?: Deferred<string>;
  passwordAttempts: number;
  account?: AccountView;
  finalized: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
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

/**
 * QR login (`tg://login?token=...`).
 *
 * `signInQr` runs in the background; the endpoint returns as soon as the first
 * URL is exported. The 2FA password is supplied later through a deferred
 * promise, so the same live client survives between HTTP requests. The attempt
 * is sticky to this process; a restart marks it expired.
 */
@Injectable()
export class QrAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(QrAuthService.name);
  private readonly attempts = new Map<string, QrAttempt>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly attemptsStore: AuthAttemptStore,
    private readonly profiles: ClientProfileService,
    private readonly clients: ClientManagerService,
    private readonly accounts: AccountSessionsService,
    private readonly realtime: RealtimeService,
    private readonly proxies: ProxiesService,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async start(user: UserModel, body: QrStartDto): Promise<QrStartView> {
    const deviceId = requireDeviceId(body.deviceId);
    const label = optionalString(body.label, 'label', { max: 64 }) ?? null;
    const profile = this.profiles.resolve(
      optionalString(body.profile, 'profile', { max: 32 }),
    );
    const proxyId =
      optionalString(body.proxyId, 'proxyId', { max: 64 }) ?? null;
    const transport = await this.proxies.transportFor(user.id, proxyId);

    const client = this.clients.createAnonymous(profile, transport, proxyId);
    let row: AuthAttemptView;
    try {
      row = await this.attemptsStore.create({
        userId: user.id,
        method: 'qr',
        status: 'pending',
        ttlMs: ATTEMPT_TTL_MS,
        payload: {
          deviceId,
          profile: profile.key,
          ...(proxyId ? { proxyId } : {}),
        },
      });
    } catch (error) {
      await client.destroy().catch(() => undefined);
      throw error;
    }

    const firstUrl = deferred<string | null>();
    const attempt: QrAttempt = {
      id: row.id,
      userId: user.id,
      deviceId,
      label,
      profile,
      proxyId,
      client,
      abort: new AbortController(),
      status: 'pending',
      expiresAtMs: Date.now() + ATTEMPT_TTL_MS,
      passwordAttempts: 0,
      finalized: false,
    };
    this.attempts.set(row.id, attempt);

    // Background: resolves once the user scans (or rejects on timeout/cancel).
    void this.runLogin(attempt, firstUrl);

    const url = await withTimeout(
      firstUrl.promise,
      FIRST_URL_TIMEOUT_MS,
      null,
    );
    if (!url || !attempt.url || !attempt.expiresAt) {
      await this.abortAttempt(attempt, 'QR_START_FAILED');
      this.attempts.delete(attempt.id);
      throw apiError(
        'QR_START_FAILED',
        'Telegram did not produce a QR login token, try again',
        502,
      );
    }

    return {
      attemptId: attempt.id,
      url: attempt.url,
      expiresAt: attempt.expiresAt.toISOString(),
    };
  }

  async status(user: UserModel, attemptId: unknown): Promise<QrStatusView> {
    const id = requireString(attemptId, 'attemptId', { max: 64 });
    const attempt = this.attempts.get(id);
    if (attempt && attempt.userId === user.id) {
      return this.view(attempt);
    }

    const row = await this.attemptsStore.get(id);
    if (!row || row.userId !== user.id) {
      throw apiError('ATTEMPT_NOT_FOUND', 'QR login attempt not found', 404);
    }
    return {
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
    };
  }

  async password(
    user: UserModel,
    attemptId: unknown,
    password: unknown,
  ): Promise<{ status: string }> {
    const attempt = await this.requireAttempt(user.id, attemptId);
    const secret = requireSecret(password, 'password', { max: 512 });

    if (attempt.passwordAttempts >= 3) {
      await this.abortAttempt(attempt, 'TOO_MANY_PASSWORD_ATTEMPTS');
      throw apiError(
        'ATTEMPT_EXPIRED',
        'Too many invalid password attempts, start over',
        410,
      );
    }

    const pending = attempt.passwordDeferred;
    if (!pending) {
      throw apiError(
        'ATTEMPT_STATE',
        'This attempt is not waiting for a password',
        409,
      );
    }

    attempt.passwordDeferred = undefined;
    pending.resolve(secret);
    return { status: 'password_submitted' };
  }

  async cancel(
    user: UserModel,
    attemptId: unknown,
  ): Promise<{ cancelled: boolean }> {
    const attempt = await this.requireAttempt(user.id, attemptId);
    if (attempt.status === 'ok') {
      throw apiError(
        'ATTEMPT_COMPLETED',
        'This QR login already completed and cannot be cancelled',
        409,
      );
    }
    await this.abortAttempt(attempt, 'CANCELLED');
    this.attempts.delete(attempt.id);
    return { cancelled: true };
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweeper);
    const attempts = [...this.attempts.values()];
    this.attempts.clear();
    await Promise.allSettled(
      attempts.map(async (attempt) => {
        attempt.passwordDeferred?.resolve('');
        attempt.abort.abort();
        if (!attempt.finalized) await attempt.client.destroy();
      }),
    );
  }

  private async runLogin(
    attempt: QrAttempt,
    firstUrl: Deferred<string | null>,
  ): Promise<void> {
    try {
      const me = await attempt.client.signInQr({
        onUrlUpdated: (url, expires) => {
          attempt.url = url;
          attempt.expiresAt = expires;
          attempt.status = 'pending';
          attempt.expiresAtMs = Math.max(
            attempt.expiresAtMs,
            expires.getTime() + 60_000,
          );
          firstUrl.resolve(url);
          this.realtime.emitToUser(attempt.userId, 'auth.qr.updated', {
            attemptId: attempt.id,
            url,
            expiresAt: expires.toISOString(),
          });
        },
        onQrScanned: () => {
          attempt.status = 'scanned';
          this.realtime.emitToUser(attempt.userId, 'auth.qr.scanned', {
            attemptId: attempt.id,
          });
        },
        password: () => this.nextPassword(attempt),
        invalidPasswordCallback: async () => {
          attempt.passwordAttempts += 1;
          attempt.passwordDeferred = undefined;
          attempt.status = 'password_required';
          attempt.error = 'PASSWORD_INVALID';
          this.realtime.emitToUser(attempt.userId, 'auth.password_required', {
            attemptId: attempt.id,
            error: 'PASSWORD_INVALID',
          });
          await this.attemptsStore
            .update(attempt.id, {
              status: 'password_required',
              error: 'PASSWORD_INVALID',
            })
            .catch(() => undefined);
        },
        abortSignal: attempt.abort.signal,
      });

      await this.finalize(attempt, me);
    } catch (error) {
      firstUrl.resolve(null);
      if (attempt.finalized) return;

      const aborted = attempt.abort.signal.aborted;
      const mapped = mapTelegramError(error);
      const rpc = tl.RpcError.is(error)
        ? { code: error.code, text: error.text, stack: error.stack?.slice(0, 4000) }
        : undefined;
      emitLog({
        level: aborted ? 'info' : 'error',
        source: 'auth',
        action: 'auth.qr.flow',
        message: aborted
          ? 'QR login was cancelled'
          : `QR login failed: ${rpc?.text ?? mapped.message}`,
        status: aborted ? 'ok' : 'failed',
        attemptId: attempt.id,
        userId: attempt.userId,
        proxyId: attempt.proxyId,
        errorCode: aborted ? 'CANCELLED' : mapped.code,
        telegramError: rpc?.text,
        telegramResponse: rpc,
        details: { mapped: { ...mapped } },
      });
      const expired =
        aborted ||
        mapped.code === 'QR_TIMEOUT' ||
        mapped.code === 'QR_EXPIRED' ||
        mapped.code === 'FLOOD_WAIT';
      attempt.status = expired ? 'expired' : 'failed';
      attempt.error = aborted ? 'CANCELLED' : mapped.code;
      await this.attemptsStore
        .update(attempt.id, {
          status: expired ? 'expired' : 'failed',
          error: attempt.error,
        })
        .catch(() => undefined);
      this.realtime.emitToUser(attempt.userId, 'auth.failed', {
        attemptId: attempt.id,
        error: attempt.error,
      });
      await attempt.client.destroy().catch(() => undefined);
    }
  }

  private nextPassword(attempt: QrAttempt): Promise<string> {
    attempt.status = 'password_required';
    if (!attempt.passwordDeferred) {
      attempt.passwordDeferred = deferred<string>();
    }
    void this.attemptsStore
      .update(attempt.id, { status: 'password_required' })
      .catch(() => undefined);
    this.realtime.emitToUser(attempt.userId, 'auth.password_required', {
      attemptId: attempt.id,
    });
    return attempt.passwordDeferred.promise;
  }

  private async finalize(attempt: QrAttempt, me: User): Promise<void> {
    const session = await attempt.client.exportSession();
    const dcId = await attempt.client.getPrimaryDcId();
    const attached = await this.accounts.attachSession({
      userId: attempt.userId,
      deviceId: attempt.deviceId,
      label: attempt.label,
      profile: attempt.profile,
      session,
      apiId: attempt.profile.api.apiId,
      apiHash: attempt.profile.api.apiHash,
      init: attempt.profile.init,
      dcId,
      tgUser: toTelegramUser(me),
      proxyId: attempt.proxyId,
    });

    await this.clients.adopt(attached.sessionId, attempt.client);
    attempt.finalized = true;
    attempt.status = 'ok';
    attempt.error = undefined;
    attempt.account = attached.account;
    attempt.url = undefined;
    await this.attemptsStore
      .update(attempt.id, {
        status: 'ok',
        error: null,
        payload: { accountId: attached.account.id },
      })
      .catch(() => undefined);
    this.realtime.emitToUser(attempt.userId, 'auth.done', {
      attemptId: attempt.id,
      account: attached.account,
    });
  }

  private async abortAttempt(
    attempt: QrAttempt,
    reason: string,
  ): Promise<void> {
    attempt.passwordDeferred?.resolve('');
    attempt.abort.abort();
    attempt.status = 'expired';
    attempt.error = reason;
    attempt.finalized = true;
    await attempt.client.destroy().catch(() => undefined);
    await this.attemptsStore
      .expire(attempt.id, reason)
      .catch(() => undefined);
    this.realtime.emitToUser(attempt.userId, 'auth.failed', {
      attemptId: attempt.id,
      error: reason,
    });
  }

  private async requireAttempt(
    userId: string,
    attemptId: unknown,
  ): Promise<QrAttempt> {
    const id = requireString(attemptId, 'attemptId', { max: 64 });
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.userId !== userId) {
      const row = await this.attemptsStore.get(id);
      if (!row || row.userId !== userId) {
        throw apiError('ATTEMPT_NOT_FOUND', 'QR login attempt not found', 404);
      }
      throw apiError(
        'ATTEMPT_EXPIRED',
        'This QR login attempt can no longer be completed, start over',
        410,
      );
    }
    if (attempt.expiresAtMs <= Date.now()) {
      await this.abortAttempt(attempt, 'TIMEOUT');
      throw apiError(
        'ATTEMPT_EXPIRED',
        'This QR login attempt has expired, start over',
        410,
      );
    }
    return attempt;
  }

  private view(attempt: QrAttempt): QrStatusView {
    return {
      status: attempt.status,
      ...(attempt.url ? { url: attempt.url } : {}),
      ...(attempt.expiresAt
        ? { expiresAt: attempt.expiresAt.toISOString() }
        : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
      ...(attempt.account ? { account: attempt.account } : {}),
    };
  }

  private sweep(): void {
    const now = Date.now();
    for (const attempt of this.attempts.values()) {
      if (attempt.expiresAtMs > now) continue;
      this.attempts.delete(attempt.id);
      if (attempt.finalized) continue;

      this.logger.debug(`Expiring QR login attempt ${attempt.id}`);
      attempt.passwordDeferred?.resolve('');
      attempt.abort.abort();
      void attempt.client.destroy().catch(() => undefined);
      void this.attemptsStore
        .expire(attempt.id, 'TIMEOUT')
        .catch(() => undefined);
      this.realtime.emitToUser(attempt.userId, 'auth.failed', {
        attemptId: attempt.id,
        error: 'TIMEOUT',
      });
    }
  }
}
