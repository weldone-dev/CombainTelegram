import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { SentCode, tl } from '@mtcute/node';
import type { TelegramClient, User } from '@mtcute/node';
import type { UserModel } from '@repo/database';
import { AuthAttemptStore } from './auth-attempt.store.js';
import { raiseTelegramError } from './telegram-error.js';
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
  requirePhone,
  requireSecret,
  requireString,
} from '../common/validation.js';

const ATTEMPT_TTL_MS = 10 * 60 * 1000;

export interface PhoneStartDto {
  phone?: unknown;
  deviceId?: unknown;
  profile?: unknown;
  label?: unknown;
  proxyId?: unknown;
}

export interface PhoneStartView {
  attemptId: string;
  codeType: string;
  timeout: number;
  nextType?: string;
}

export type PhoneVerifyView =
  | { status: 'ok'; account: AccountView }
  | { status: 'password_required' }
  | { status: 'signup_required' };

export interface PhoneCompletedView {
  status: 'ok';
  account: AccountView;
}

export type PhoneResendView = PhoneStartView;

interface PhoneAttempt {
  id: string;
  userId: string;
  phone: string;
  deviceId: string;
  label: string | null;
  profile: ResolvedProfile;
  proxyId: string | null;
  client: TelegramClient;
  phoneCodeHash: string;
  passwordPending: boolean;
  signupPending: boolean;
  passwordAttempts: number;
  expiresAt: number;
}

@Injectable()
export class PhoneAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(PhoneAuthService.name);
  private readonly attempts = new Map<string, PhoneAttempt>();
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

  async start(user: UserModel, body: PhoneStartDto): Promise<PhoneStartView> {
    const phone = requirePhone(body.phone);
    const deviceId = requireDeviceId(body.deviceId);
    const label = optionalString(body.label, 'label', { max: 64 }) ?? null;
    const profile = this.profiles.resolve(
      optionalString(body.profile, 'profile', { max: 32 }),
    );
    const proxyId =
      optionalString(body.proxyId, 'proxyId', { max: 64 }) ?? null;
    const transport = await this.proxies.transportFor(user.id, proxyId);

    const client = this.clients.createAnonymous(profile, transport, proxyId);
    try {
      const sent = await client.sendCode({ phone });

      if (!(sent instanceof SentCode)) {
        // Already authorized (future auth token path). No code is needed, but
        // this endpoint returns code metadata, so ask the caller to retry with
        // a fresh deviceId instead of silently creating a session.
        throw apiError(
          'ALREADY_AUTHORIZED',
          'This device is already authorized, use another deviceId',
          409,
        );
      }

      const attemptId = await this.createAttempt(user.id, {
        phone,
        deviceId,
        profile,
        proxyId,
      });

      const attempt: PhoneAttempt = {
        id: attemptId,
        userId: user.id,
        phone,
        deviceId,
        label,
        profile,
        proxyId,
        client,
        phoneCodeHash: sent.phoneCodeHash,
        passwordPending: false,
        signupPending: false,
        passwordAttempts: 0,
        expiresAt: Date.now() + ATTEMPT_TTL_MS,
      };
      this.attempts.set(attemptId, attempt);

      return {
        attemptId,
        codeType: mapCodeType(sent.type),
        timeout: sent.timeout,
        ...(sent.nextType !== 'none' ? { nextType: sent.nextType } : {}),
      };
    } catch (error) {
      await client.destroy().catch(() => undefined);
      throw error;
    }
  }

  async verify(
    user: UserModel,
    attemptId: unknown,
    code: unknown,
  ): Promise<PhoneVerifyView> {
    const attempt = await this.requireAttempt(user.id, attemptId);
    if (attempt.passwordPending) {
      throw apiError(
        'PASSWORD_REQUIRED',
        'This attempt is waiting for the two-step verification password',
        409,
      );
    }
    const phoneCode = requireString(code, 'code', { max: 16 });

    try {
      const me = await attempt.client.signIn({
        phone: attempt.phone,
        phoneCodeHash: attempt.phoneCodeHash,
        phoneCode,
      });
      return await this.finish(attempt, me);
    } catch (error) {
      if (isRpc(error, 'SESSION_PASSWORD_NEEDED')) {
        attempt.passwordPending = true;
        await this.attemptsStore.update(attempt.id, {
          status: 'password_required',
        });
        return { status: 'password_required' };
      }
      if (isRpc(error, 'SIGN_UP_REQUIRED')) {
        attempt.signupPending = true;
        await this.attemptsStore.update(attempt.id, {
          status: 'password_required',
          error: 'SIGNUP_REQUIRED',
        });
        return { status: 'signup_required' };
      }
      raiseTelegramError(error);
    }
  }

  async password(
    user: UserModel,
    attemptId: unknown,
    password: unknown,
  ): Promise<PhoneCompletedView> {
    const attempt = await this.requireAttempt(user.id, attemptId);
    if (!attempt.passwordPending) {
      throw apiError(
        'ATTEMPT_STATE',
        'This attempt is not waiting for a password',
        409,
      );
    }
    const secret = requireSecret(password, 'password', { max: 512 });

    try {
      const me = await attempt.client.checkPassword(secret);
      return await this.finish(attempt, me);
    } catch (error) {
      if (isRpc(error, 'PASSWORD_HASH_INVALID')) {
        attempt.passwordAttempts += 1;
        if (attempt.passwordAttempts >= 3) {
          await this.discard(attempt, 'TOO_MANY_PASSWORD_ATTEMPTS');
          throw apiError(
            'ATTEMPT_EXPIRED',
            'Too many invalid password attempts, start over',
            410,
          );
        }
      }
      raiseTelegramError(error);
    }
  }

  async signup(
    user: UserModel,
    attemptId: unknown,
    firstName: unknown,
    lastName: unknown,
  ): Promise<PhoneCompletedView> {
    const attempt = await this.requireAttempt(user.id, attemptId);
    if (!attempt.signupPending) {
      throw apiError(
        'ATTEMPT_STATE',
        'This attempt is not waiting for a sign-up',
        409,
      );
    }
    const first = requireString(firstName, 'firstName', { min: 1, max: 64 });
    const last = optionalString(lastName, 'lastName', { max: 64 }) ?? '';

    try {
      const authorization = await attempt.client.call({
        _: 'auth.signUp',
        phoneNumber: attempt.phone,
        phoneCodeHash: attempt.phoneCodeHash,
        firstName: first,
        lastName: last,
      });

      if (authorization._ === 'auth.authorizationSignUpRequired') {
        throw apiError(
          'SIGNUP_REQUIRED',
          'Telegram still requires a sign-up for this phone number',
        );
      }

      await attempt.client.notifyLoggedIn(authorization);
      const me = await attempt.client.getMe();
      return await this.finish(attempt, me);
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async resend(user: UserModel, attemptId: unknown): Promise<PhoneResendView> {
    const attempt = await this.requireAttempt(user.id, attemptId);

    try {
      const sent = await attempt.client.resendCode({
        phone: attempt.phone,
        phoneCodeHash: attempt.phoneCodeHash,
      });
      attempt.phoneCodeHash = sent.phoneCodeHash;
      attempt.expiresAt = Date.now() + ATTEMPT_TTL_MS;

      return {
        attemptId: attempt.id,
        codeType: mapCodeType(sent.type),
        timeout: sent.timeout,
        ...(sent.nextType !== 'none' ? { nextType: sent.nextType } : {}),
      };
    } catch (error) {
      raiseTelegramError(error);
    }
  }

  async cancel(user: UserModel, attemptId: unknown): Promise<{ cancelled: boolean }> {
    const attempt = await this.requireAttempt(user.id, attemptId);
    void attempt.client
      .call({
        _: 'auth.cancelCode',
        phoneNumber: attempt.phone,
        phoneCodeHash: attempt.phoneCodeHash,
      })
      .catch(() => undefined);

    await this.discard(attempt, 'CANCELLED');
    return { cancelled: true };
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweeper);
    const clients = [...this.attempts.values()].map((attempt) => attempt.client);
    this.attempts.clear();
    await Promise.allSettled(clients.map((client) => client.destroy()));
  }

  private async finish(
    attempt: PhoneAttempt,
    me: User,
  ): Promise<PhoneCompletedView> {
    const account = await this.complete(
      attempt.userId,
      attempt.client,
      attempt.profile,
      attempt.deviceId,
      attempt.label,
      attempt.phone,
      me,
      attempt.proxyId,
    );

    this.attempts.delete(attempt.id);
    await this.attemptsStore
      .update(attempt.id, {
        status: 'ok',
        error: null,
        payload: { accountId: account.id },
      })
      .catch(() => undefined);
    this.realtime.emitToUser(attempt.userId, 'auth.done', {
      attemptId: attempt.id,
      account,
    });

    return { status: 'ok', account };
  }

  private async complete(
    userId: string,
    client: TelegramClient,
    profile: ResolvedProfile,
    deviceId: string,
    label: string | null,
    phone: string,
    me: User | tl.RawUser,
    proxyId: string | null,
  ): Promise<AccountView> {
    const session = await client.exportSession();
    const dcId = await client.getPrimaryDcId();
    const user = toTelegramUser(me);

    const attached = await this.accounts.attachSession({
      userId,
      deviceId,
      label,
      profile,
      session,
      apiId: profile.api.apiId,
      apiHash: profile.api.apiHash,
      init: profile.init,
      dcId,
      tgUser: user,
      phone,
      proxyId,
    });

    // The client that just logged in becomes the live client for this session.
    await this.clients.adopt(attached.sessionId, client);
    return attached.account;
  }

  private async createAttempt(
    userId: string,
    data: {
      phone: string;
      deviceId: string;
      profile: ResolvedProfile;
      proxyId: string | null;
    },
  ): Promise<string> {
    const view = await this.attemptsStore.create({
      userId,
      method: 'phone',
      status: 'code_sent',
      ttlMs: ATTEMPT_TTL_MS,
      payload: {
        phoneTail: data.phone.slice(-4),
        deviceId: data.deviceId,
        profile: data.profile.key,
        ...(data.proxyId ? { proxyId: data.proxyId } : {}),
      },
    });
    return view.id;
  }

  private async requireAttempt(
    userId: string,
    attemptId: unknown,
  ): Promise<PhoneAttempt> {
    const id = requireString(attemptId, 'attemptId', { max: 64 });
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.userId !== userId) {
      const row = await this.attemptsStore.get(id);
      if (!row || row.userId !== userId) {
        throw apiError('ATTEMPT_NOT_FOUND', 'Login attempt not found', 404);
      }
      throw apiError(
        'ATTEMPT_EXPIRED',
        'This login attempt can no longer be completed, start over',
        410,
      );
    }
    if (attempt.expiresAt <= Date.now()) {
      await this.discard(attempt, 'TIMEOUT');
      throw apiError(
        'ATTEMPT_EXPIRED',
        'This login attempt has expired, start over',
        410,
      );
    }
    return attempt;
  }

  private async discard(attempt: PhoneAttempt, reason: string): Promise<void> {
    this.attempts.delete(attempt.id);
    await attempt.client.destroy().catch(() => undefined);
    await this.attemptsStore.expire(attempt.id, reason).catch(() => undefined);
    this.realtime.emitToUser(attempt.userId, 'auth.failed', {
      attemptId: attempt.id,
      error: reason,
    });
  }

  private sweep(): void {
    const now = Date.now();
    for (const attempt of this.attempts.values()) {
      if (attempt.expiresAt > now) continue;
      this.attempts.delete(attempt.id);
      this.logger.debug(`Expiring phone login attempt ${attempt.id}`);
      void attempt.client.destroy().catch(() => undefined);
      void this.attemptsStore.expire(attempt.id, 'TIMEOUT').catch(() => undefined);
      this.realtime.emitToUser(attempt.userId, 'auth.failed', {
        attemptId: attempt.id,
        error: 'TIMEOUT',
      });
    }
  }
}

export function mapCodeType(type: string): string {
  switch (type) {
    case 'app':
      return 'app';
    case 'sms':
    case 'sms_word':
    case 'sms_phrase':
      return 'sms';
    case 'call':
      return 'call';
    case 'flash_call':
    case 'missed_call':
      return 'flash';
    default:
      return 'other';
  }
}

function isRpc(
  error: unknown,
  text: 'SESSION_PASSWORD_NEEDED' | 'SIGN_UP_REQUIRED' | 'PASSWORD_HASH_INVALID',
): boolean {
  return tl.RpcError.is(error, text);
}

export function toTelegramUser(me: User | tl.RawUser): {
  id: number | bigint;
  firstName: string;
  lastName: string | null;
  username: string | null;
} {
  if ('firstName' in me && typeof me.firstName === 'string') {
    return {
      id: me.id,
      firstName: me.firstName,
      lastName: me.lastName ?? null,
      username: me.username ?? null,
    };
  }

  const raw = me as tl.RawUser;
  return {
    id: raw.id,
    firstName: raw.firstName ?? '',
    lastName: raw.lastName ?? null,
    username: raw.username ?? null,
  };
}
