import { HttpException, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { TelegramClient } from '@mtcute/node';
import type {
  TelegramAccountModel,
  TelegramSessionModel,
  UserModel,
} from '@repo/database';
import { AccountsService } from './accounts.service.js';
import { AccountSessionsService } from './account-sessions.service.js';
import type { AccountView } from './account-view.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';
import { ProxyTransportService } from '../telegram/proxy-transport.service.js';
import { TdClientManagerService } from '../tdlib/td-client-manager.service.js';
import type { TdlibDirectories } from '../tdlib/td-client-manager.service.js';
import { parseQrLoginToken } from '../tdlib/poc.js';
import { apiError, conflict, notFound } from '../common/api-error.js';
import {
  optionalString,
  requirePhone,
  requireSecret,
  requireString,
} from '../common/validation.js';
import { emitLog } from '../logs/log-sink.js';
import { TdlibAuthClientFactory } from './tdlib-auth.client.js';
import type {
  TdlibAuthClient,
  TdlibAuthState,
  TdlibAuthUser,
} from './tdlib-auth.client.js';

/** Login attempts live in memory only; a restart turns them into 404s. */
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
/** How long `start` waits for the first QR link / code / password prompt. */
const FIRST_PROGRESS_TIMEOUT_MS = 10_000;
const MAX_CODE_ATTEMPTS = 3;
const MAX_PASSWORD_ATTEMPTS = 3;

export type TdlibAuthStatus =
  | 'starting'
  | 'qr_pending'
  | 'awaiting_code'
  | 'awaiting_password'
  | 'ready'
  | 'failed'
  | 'expired';

export type TdlibAuthMethod = 'qr' | 'phone';

export interface TdlibAuthView {
  attemptId: string;
  status: TdlibAuthStatus;
  qrLink?: string;
  error?: string;
  needsPassword?: boolean;
  account?: AccountView;
}

export interface TdlibStartDto {
  method?: unknown;
  phone?: unknown;
  proxyId?: unknown;
  label?: unknown;
}

export interface TdlibMigrateDto {
  label?: unknown;
}

export type TdlibErrorContext =
  | 'start'
  | 'flow'
  | 'code'
  | 'password'
  | 'finalize';

export interface MappedTdlibError {
  code: string;
  message: string;
  status: number;
}

const PASSWORD_INVALID: MappedTdlibError = {
  code: 'TDLIB_PASSWORD_INVALID',
  message: 'TDLib rejected the cloud password',
  status: 400,
};

const TDLIB_UNAVAILABLE: MappedTdlibError = {
  code: 'TDLIB_UNAVAILABLE',
  message: 'TDLib is not available on this server',
  status: 503,
};

/**
 * Maps any TDLib/native failure onto the stable `apiError` contract.
 *
 * The returned message is fixed and never echoes the original error: TDLib
 * errors can mention the submitted value, and the value may be a password.
 */
export function mapTdlibError(
  error: unknown,
  context: TdlibErrorContext = 'flow',
): MappedTdlibError {
  const raw = errorText(error);

  if (
    context === 'password' ||
    /PASSWORD_HASH_INVALID|PASSWORD_INVALID|PASSWORD_EMPTY/i.test(raw)
  ) {
    return { ...PASSWORD_INVALID };
  }
  if (
    context === 'start' ||
    /addon|tdjson|native module|Cannot find module|MODULE_NOT_FOUND/i.test(raw)
  ) {
    return { ...TDLIB_UNAVAILABLE };
  }
  return {
    code: 'TDLIB_AUTH_FAILED',
    message:
      context === 'code'
        ? 'TDLib rejected the login code'
        : context === 'finalize'
          ? 'The TDLib login finished but the account could not be stored'
          : 'TDLib login failed',
    status: 502,
  };
}

/** Reads an error message without `String(obj)` turning it into `[object Object]`. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

/** Preserves our own HTTP errors (ACCOUNT_LIMIT, PROXY_DISABLED, ...). */
function describeError(
  error: unknown,
  context: TdlibErrorContext,
): MappedTdlibError {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (body && typeof body === 'object' && 'code' in body) {
      const record = body as { code?: unknown; message?: unknown };
      return {
        code: String(record.code),
        message:
          typeof record.message === 'string'
            ? record.message
            : 'Request failed',
        status: error.getStatus(),
      };
    }
  }
  return mapTdlibError(error, context);
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

interface TdlibAttempt {
  id: string;
  userId: string;
  kind: 'migrate' | 'new';
  /** Set for migrations: the account whose mtcute session approves the QR. */
  accountId?: string;
  method: TdlibAuthMethod;
  phone: string | null;
  label: string | null;
  proxyId: string | null;
  client: TdlibAuthClient;
  dirs: TdlibDirectories;
  databaseKey: string;
  status: TdlibAuthStatus;
  qrLink?: string;
  error?: string;
  needsPassword: boolean;
  codeAttempts: number;
  passwordAttempts: number;
  /** Cloud password from the account row, tried once automatically. */
  storedPassword?: string;
  storedPasswordTried: boolean;
  /** A user-submitted password accepted by TDLib, stored on success. */
  passwordToStore?: string;
  account?: AccountView;
  finalized: boolean;
  clientClosed: boolean;
  cleanupDone: boolean;
  adoptedPath?: string;
  attached: boolean;
  approver?: TelegramClient;
  me?: TdlibAuthUser;
  expiresAtMs: number;
  firstProgress?: Deferred<void>;
  stateChain: Promise<void>;
}

type AccountWithSessions = TelegramAccountModel & {
  sessions: TelegramSessionModel[];
};

function withTimeout(promise: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * TDLib login and migration.
 *
 * Two state machines share one in-memory attempt map:
 *
 * - `migrate` authorizes a new TDLib client for an account that already has an
 *   mtcute session, by approving TDLib's QR link from that session
 *   (`auth.acceptLoginToken`). The mtcute session is never logged out.
 * - `new` logs a brand-new account in with QR or phone + code.
 *
 * Every attempt owns one TDLib client and one temporary database folder. When
 * TDLib reaches `authorizationStateReady` the folder is moved to the permanent
 * session path and `AccountSessionsService.attachTdlibSession` writes the
 * account + session rows. TDLib update fields are snake_case (`link`).
 */
@Injectable()
export class TdlibAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(TdlibAuthService.name);
  private readonly attempts = new Map<string, TdlibAttempt>();
  private readonly sweeper: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly accounts: AccountsService,
    private readonly sessions: AccountSessionsService,
    private readonly crypto: SessionCryptoService,
    private readonly tdClients: TdClientManagerService,
    private readonly factory: TdlibAuthClientFactory,
    private readonly proxies: ProxyTransportService,
  ) {
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  // ---------------------------------------------------------------- migration

  /** Starts a TDLib login approved by the account's existing mtcute session. */
  async migrate(
    user: UserModel,
    accountId: string,
    body: TdlibMigrateDto = {},
  ): Promise<TdlibAuthView> {
    const account = await this.requireAccount(user.id, accountId);
    const session = this.pickMtcuteSession(account);
    if (!session) {
      throw conflict(
        'NO_MTCUTE_SESSION',
        'This account has no mtcute session to migrate from',
      );
    }

    const { client: approver } = await this.accounts.resolveSession(
      user.id,
      account.id,
      session.id,
    );

    return this.startAttempt({
      userId: user.id,
      kind: 'migrate',
      method: 'qr',
      accountId: account.id,
      phone: null,
      label:
        optionalString(body.label, 'label', { max: 64 }) ??
        session.label ??
        'TDLib',
      proxyId: session.proxyId ?? null,
      approver,
      storedPassword: this.decryptCloudPassword(account),
    });
  }

  async migrateStatus(
    user: UserModel,
    accountId: string,
    attemptId: string,
  ): Promise<TdlibAuthView> {
    const attempt = this.requireAttempt(user.id, attemptId, accountId);
    return this.view(attempt);
  }

  migratePassword(
    user: UserModel,
    accountId: string,
    attemptId: string,
    password: unknown,
  ): Promise<TdlibAuthView> {
    const attempt = this.requireAttempt(user.id, attemptId, accountId);
    return this.submitPassword(attempt, password);
  }

  async migrateCancel(
    user: UserModel,
    accountId: string,
    attemptId: string,
  ): Promise<{ cancelled: boolean }> {
    const attempt = this.requireAttempt(user.id, attemptId, accountId);
    return this.cancel(attempt);
  }

  // ---------------------------------------------------------------------- new

  async start(user: UserModel, body: TdlibStartDto = {}): Promise<TdlibAuthView> {
    const method = body.method;
    if (method !== 'qr' && method !== 'phone') {
      throw apiError(
        'VALIDATION_ERROR',
        "method must be either 'qr' or 'phone'",
      );
    }
    const phone = method === 'phone' ? requirePhone(body.phone) : null;
    const label = optionalString(body.label, 'label', { max: 64 }) ?? null;
    const proxyId =
      optionalString(body.proxyId, 'proxyId', { max: 64 }) ?? null;
    await this.assertProxy(user.id, proxyId);

    return this.startAttempt({
      userId: user.id,
      kind: 'new',
      method,
      phone,
      label,
      proxyId,
    });
  }

  async status(user: UserModel, attemptId: string): Promise<TdlibAuthView> {
    return this.view(this.requireAttempt(user.id, attemptId));
  }

  async submitCode(
    user: UserModel,
    attemptId: string,
    code: unknown,
  ): Promise<TdlibAuthView> {
    const attempt = this.requireAttempt(user.id, attemptId);
    const value = requireString(code, 'code', { max: 32 });
    if (attempt.status !== 'awaiting_code') {
      throw apiError(
        'ATTEMPT_STATE',
        'This TDLib attempt is not waiting for a login code',
        409,
      );
    }

    try {
      await attempt.client.checkAuthenticationCode(value);
    } catch (error) {
      attempt.codeAttempts += 1;
      const mapped = mapTdlibError(error, 'code');
      this.logFailure(attempt, 'auth.tdlib.code', mapped);
      if (attempt.codeAttempts >= MAX_CODE_ATTEMPTS) {
        await this.failAttempt(attempt, mapped);
      } else {
        attempt.error = mapped.code;
      }
      throw apiError(mapped.code, mapped.message, mapped.status);
    }

    attempt.error = undefined;
    emitLog({
      level: 'info',
      source: 'auth',
      action: 'auth.tdlib.code',
      message: 'Submitted the TDLib login code',
      status: 'ok',
      userId: attempt.userId,
      accountId: attempt.accountId,
      attemptId: attempt.id,
    });
    return this.view(attempt);
  }

  password(
    user: UserModel,
    attemptId: string,
    password: unknown,
  ): Promise<TdlibAuthView> {
    const attempt = this.requireAttempt(user.id, attemptId);
    return this.submitPassword(attempt, password);
  }

  async cancelAttempt(
    user: UserModel,
    attemptId: string,
  ): Promise<{ cancelled: boolean }> {
    const attempt = this.requireAttempt(user.id, attemptId);
    return this.cancel(attempt);
  }

  // ------------------------------------------------------------ cloud password

  async cloudPasswordStatus(
    user: UserModel,
    accountId: string,
  ): Promise<{ stored: boolean }> {
    const account = await this.requireAccount(user.id, accountId);
    return { stored: Boolean(account.cloudPasswordEncrypted) };
  }

  async setCloudPassword(
    user: UserModel,
    accountId: string,
    password: unknown,
  ): Promise<{ stored: boolean }> {
    const account = await this.requireAccount(user.id, accountId);
    const secret = requireSecret(password, 'password', { max: 512 });
    await this.storeCloudPassword(account.id, secret);
    return { stored: true };
  }

  async clearCloudPassword(
    user: UserModel,
    accountId: string,
  ): Promise<{ stored: boolean }> {
    const account = await this.requireAccount(user.id, accountId);
    await this.prisma.telegramAccount.update({
      where: { id: account.id },
      data: {
        cloudPasswordEncrypted: null,
        cloudPasswordNonce: null,
        cloudPasswordTag: null,
      },
    });
    emitLog({
      level: 'info',
      source: 'auth',
      action: 'auth.tdlib.cloud_password',
      message: 'Removed the stored cloud password',
      status: 'ok',
      userId: user.id,
      accountId: account.id,
      details: { stored: false },
    });
    return { stored: false };
  }

  // -------------------------------------------------------------------- flow

  private async startAttempt(input: {
    userId: string;
    kind: 'migrate' | 'new';
    method: TdlibAuthMethod;
    phone: string | null;
    label: string | null;
    proxyId: string | null;
    accountId?: string;
    approver?: TelegramClient;
    storedPassword?: string;
  }): Promise<TdlibAuthView> {
    const id = randomUUID();
    const dirs = this.tdClients.temporaryDirectories(id);
    await this.tdClients.ensureDirectories(dirs);
    const databaseKey = this.tdClients.generateDatabaseKey();

    let client: TdlibAuthClient;
    try {
      client = await this.factory.create(dirs);
    } catch (error) {
      await rm(dirs.root, { recursive: true, force: true }).catch(() => undefined);
      const mapped = mapTdlibError(error, 'start');
      emitLog({
        level: 'error',
        source: 'auth',
        action: 'auth.tdlib.start',
        message: mapped.message,
        status: 'failed',
        userId: input.userId,
        accountId: input.accountId,
        attemptId: id,
        errorCode: mapped.code,
        details: { kind: input.kind, method: input.method },
      });
      throw apiError(mapped.code, mapped.message, mapped.status);
    }

    const attempt: TdlibAttempt = {
      id,
      userId: input.userId,
      kind: input.kind,
      ...(input.accountId ? { accountId: input.accountId } : {}),
      method: input.method,
      phone: input.phone,
      label: input.label,
      proxyId: input.proxyId,
      client,
      dirs,
      databaseKey,
      status: 'starting',
      needsPassword: false,
      codeAttempts: 0,
      passwordAttempts: 0,
      ...(input.storedPassword !== undefined
        ? { storedPassword: input.storedPassword }
        : {}),
      storedPasswordTried: false,
      finalized: false,
      clientClosed: false,
      cleanupDone: false,
      attached: false,
      ...(input.approver ? { approver: input.approver } : {}),
      expiresAtMs: Date.now() + ATTEMPT_TTL_MS,
      firstProgress: deferred<void>(),
      stateChain: Promise.resolve(),
    };

    this.attempts.set(id, attempt);
    client.onAuthorizationState((state) => {
      attempt.stateChain = attempt.stateChain
        .then(() => this.handleState(attempt, state))
        .catch((error: unknown) =>
          this.handleStateFailure(attempt, error).catch(() => undefined),
        );
    });

    emitLog({
      level: 'info',
      source: 'auth',
      action: 'auth.tdlib.start',
      message:
        input.kind === 'migrate'
          ? 'Started a TDLib migration'
          : `Started a TDLib ${input.method} login`,
      status: 'ok',
      userId: attempt.userId,
      accountId: attempt.accountId,
      attemptId: attempt.id,
      proxyId: attempt.proxyId,
      details: { kind: attempt.kind, method: attempt.method },
    });

    void this.runClient(attempt);
    await this.waitForStart(attempt);
    return this.view(attempt);
  }

  private async runClient(attempt: TdlibAttempt): Promise<void> {
    try {
      await attempt.client.start();
      await this.applyProxy(attempt);
    } catch (error) {
      const mapped = describeError(error, 'start');
      this.logFailure(attempt, 'auth.tdlib.start', mapped);
      await this.failAttempt(attempt, mapped);
    }
  }

  /**
   * Serialized state machine. `authorizationStateWaitOtherDeviceConfirmation`
   * can repeat with a refreshed QR link, so each occurrence is handled.
   */
  private async handleState(
    attempt: TdlibAttempt,
    state: TdlibAuthState,
  ): Promise<void> {
    if (
      attempt.finalized ||
      attempt.status === 'failed' ||
      attempt.status === 'expired'
    ) {
      return;
    }

    switch (state._) {
      case 'authorizationStateWaitTdlibParameters':
        await attempt.client.setTdlibParameters(
          this.tdClients.parameters(attempt.dirs, attempt.databaseKey, {
            useCache: false,
          }),
        );
        return;

      case 'authorizationStateWaitPhoneNumber':
        if (attempt.kind === 'new' && attempt.method === 'phone' && attempt.phone) {
          attempt.status = 'awaiting_code';
          this.resolveFirstProgress(attempt);
          await attempt.client.setAuthenticationPhoneNumber(attempt.phone);
        } else {
          await attempt.client.requestQrCodeAuthentication();
        }
        return;

      case 'authorizationStateWaitOtherDeviceConfirmation': {
        const link = state.link;
        if (!link) {
          throw new Error('TDLib sent a QR state without a link');
        }
        attempt.qrLink = link;
        attempt.status = 'qr_pending';
        this.resolveFirstProgress(attempt);
        emitLog({
          level: 'info',
          source: 'auth',
          action: 'auth.tdlib.qr',
          message: 'TDLib is waiting for the QR code to be confirmed',
          status: 'ok',
          userId: attempt.userId,
          accountId: attempt.accountId,
          attemptId: attempt.id,
          details: { kind: attempt.kind },
        });
        if (attempt.kind === 'migrate') {
          await this.approveQr(attempt, link);
        }
        return;
      }

      case 'authorizationStateWaitCode':
        attempt.status = 'awaiting_code';
        attempt.error = undefined;
        this.resolveFirstProgress(attempt);
        return;

      case 'authorizationStateWaitPassword':
        await this.handleWaitPassword(attempt);
        return;

      case 'authorizationStateReady':
        attempt.needsPassword = false;
        await this.finalize(attempt);
        return;

      case 'authorizationStateWaitRegistration':
        throw new Error(
          'This phone number is not registered on Telegram; TDLib cannot register it',
        );

      case 'authorizationStateWaitEmailAddress':
      case 'authorizationStateWaitEmailCode':
        throw new Error('This account requires an email login, which is not supported');

      case 'authorizationStateClosed':
        throw new Error('TDLib closed the client before authorization');

      default:
        return;
    }
  }

  private async approveQr(
    attempt: TdlibAttempt,
    link: string,
  ): Promise<void> {
    if (!attempt.approver) {
      throw new Error('The migration attempt has no mtcute session to approve the QR');
    }
    const { token } = parseQrLoginToken(link);
    await attempt.approver.call({
      _: 'auth.acceptLoginToken',
      token,
    } as Parameters<TelegramClient['call']>[0]);
    emitLog({
      level: 'info',
      source: 'auth',
      action: 'auth.tdlib.qr',
      message: 'Approved the TDLib QR link from the existing mtcute session',
      status: 'ok',
      userId: attempt.userId,
      accountId: attempt.accountId,
      attemptId: attempt.id,
      details: { kind: attempt.kind },
    });
  }

  private async handleWaitPassword(attempt: TdlibAttempt): Promise<void> {
    attempt.status = 'awaiting_password';
    attempt.needsPassword = true;
    this.resolveFirstProgress(attempt);

    if (
      attempt.storedPassword !== undefined &&
      !attempt.storedPasswordTried
    ) {
      attempt.storedPasswordTried = true;
      try {
        await attempt.client.checkAuthenticationPassword(
          attempt.storedPassword,
        );
        // Accepted: the client waits for TDLib to move on to Ready, so it
        // must not prompt for the password it just submitted.
        attempt.needsPassword = false;
        emitLog({
          level: 'info',
          source: 'auth',
          action: 'auth.tdlib.password',
          message: 'Submitted the stored cloud password to TDLib',
          status: 'ok',
          userId: attempt.userId,
          accountId: attempt.accountId,
          attemptId: attempt.id,
        });
        return;
      } catch (error) {
        const mapped = mapTdlibError(error, 'password');
        this.logFailure(attempt, 'auth.tdlib.password', mapped);
        attempt.error = mapped.code;
        attempt.needsPassword = true;
        // Fall through: the user can submit the password manually.
      }
    }
  }

  private async submitPassword(
    attempt: TdlibAttempt,
    raw: unknown,
  ): Promise<TdlibAuthView> {
    const secret = requireSecret(raw, 'password', { max: 512 });
    if (attempt.status !== 'awaiting_password') {
      throw apiError(
        'ATTEMPT_STATE',
        'This TDLib attempt is not waiting for a password',
        409,
      );
    }
    if (attempt.passwordAttempts >= MAX_PASSWORD_ATTEMPTS) {
      await this.failAttempt(attempt, { ...PASSWORD_INVALID });
      throw apiError(PASSWORD_INVALID.code, PASSWORD_INVALID.message, PASSWORD_INVALID.status);
    }

    try {
      await attempt.client.checkAuthenticationPassword(secret);
    } catch (error) {
      attempt.passwordAttempts += 1;
      const mapped = mapTdlibError(error, 'password');
      this.logFailure(attempt, 'auth.tdlib.password', mapped);
      if (attempt.passwordAttempts >= MAX_PASSWORD_ATTEMPTS) {
        await this.failAttempt(attempt, mapped);
      } else {
        attempt.error = mapped.code;
      }
      throw apiError(mapped.code, mapped.message, mapped.status);
    }

    attempt.error = undefined;
    attempt.needsPassword = false;
    if (attempt.kind === 'migrate' && attempt.accountId) {
      await this.storeCloudPasswordQuiet(attempt.accountId, secret);
    } else {
      attempt.passwordToStore = secret;
    }
    emitLog({
      level: 'info',
      source: 'auth',
      action: 'auth.tdlib.password',
      message: 'Submitted the cloud password to TDLib',
      status: 'ok',
      userId: attempt.userId,
      accountId: attempt.accountId,
      attemptId: attempt.id,
    });
    return this.view(attempt);
  }

  private async finalize(attempt: TdlibAttempt): Promise<void> {
    if (attempt.finalized || attempt.clientClosed) return;
    attempt.finalized = true;

    try {
      const me = await attempt.client.getMe();
      attempt.me = me;

      // TDLib keeps its database open while the client lives; close before
      // moving the folder. The attempt client is not in the manager's cache.
      await this.closeClient(attempt);
      attempt.adoptedPath = await this.tdClients.adoptDirectory(
        attempt.dirs,
        attempt.id,
      );

      const attached = await this.sessions.attachTdlibSession({
        userId: attempt.userId,
        deviceId: attempt.id,
        label: attempt.label,
        tgUser: {
          id: me.id,
          firstName: me.firstName,
          lastName: me.lastName,
          username: me.username,
        },
        phone: me.phone ?? attempt.phone,
        tdlibPath: attempt.adoptedPath,
        databaseKey: attempt.databaseKey,
        apiId: this.tdClients.tdlibProfile().apiId,
        proxyId: attempt.proxyId,
      });
      attempt.attached = true;

      if (attempt.passwordToStore !== undefined) {
        await this.storeCloudPasswordQuiet(
          attached.account.id,
          attempt.passwordToStore,
        );
      }

      attempt.account = attached.account;
      attempt.status = 'ready';
      attempt.error = undefined;
      attempt.needsPassword = false;
      attempt.qrLink = undefined;
      attempt.expiresAtMs = Date.now() + ATTEMPT_TTL_MS;
      this.resolveFirstProgress(attempt);

      emitLog({
        level: 'info',
        source: 'auth',
        action: 'auth.tdlib.ready',
        message: `TDLib authorized ${attached.account.id}`,
        status: 'ok',
        userId: attempt.userId,
        accountId: attached.account.id,
        sessionId: attached.sessionId,
        attemptId: attempt.id,
        proxyId: attempt.proxyId,
        details: {
          kind: attempt.kind,
          isNewAccount: attached.isNewAccount,
          mtcuteSessionKept: attempt.kind === 'migrate',
        },
      });
    } catch (error) {
      const mapped = describeError(error, 'finalize');
      this.logFailure(attempt, 'auth.tdlib.ready', mapped);
      attempt.status = 'failed';
      attempt.error = mapped.code;
      attempt.needsPassword = false;
      this.resolveFirstProgress(attempt);
      await this.closeClient(attempt);
      await this.cleanupDirectories(attempt);
    }
  }

  // ----------------------------------------------------------------- cleanup

  private async failAttempt(
    attempt: TdlibAttempt,
    mapped: MappedTdlibError,
  ): Promise<void> {
    if (attempt.status !== 'failed' && attempt.status !== 'expired') {
      attempt.status = 'failed';
      attempt.error = mapped.code;
      this.logFailure(attempt, 'auth.tdlib.failed', mapped);
    }
    attempt.needsPassword = false;
    this.resolveFirstProgress(attempt);
    await this.closeClient(attempt);
    await this.cleanupDirectories(attempt);
  }

  private async cancel(attempt: TdlibAttempt): Promise<{ cancelled: boolean }> {
    if (attempt.status === 'ready') {
      throw conflict(
        'ATTEMPT_COMPLETED',
        'This TDLib login already completed and cannot be cancelled',
      );
    }
    this.attempts.delete(attempt.id);
    attempt.status = 'expired';
    attempt.error = 'CANCELLED';
    attempt.needsPassword = false;
    this.resolveFirstProgress(attempt);
    emitLog({
      level: 'info',
      source: 'auth',
      action: 'auth.tdlib.cancel',
      message: 'TDLib login attempt cancelled',
      status: 'ok',
      userId: attempt.userId,
      accountId: attempt.accountId,
      attemptId: attempt.id,
    });
    await this.closeClient(attempt);
    await this.cleanupDirectories(attempt);
    return { cancelled: true };
  }

  private async expire(attempt: TdlibAttempt): Promise<void> {
    this.attempts.delete(attempt.id);
    if (attempt.finalized) {
      // A finished attempt only loses its report; nothing to clean up.
      return;
    }
    attempt.status = 'expired';
    attempt.error = 'TIMEOUT';
    attempt.needsPassword = false;
    this.resolveFirstProgress(attempt);
    emitLog({
      level: 'info',
      source: 'auth',
      action: 'auth.tdlib.expired',
      message: 'TDLib login attempt expired',
      status: 'ok',
      userId: attempt.userId,
      accountId: attempt.accountId,
      attemptId: attempt.id,
    });
    await this.closeClient(attempt);
    await this.cleanupDirectories(attempt);
  }

  private async closeClient(attempt: TdlibAttempt): Promise<void> {
    if (attempt.clientClosed) return;
    attempt.clientClosed = true;
    await attempt.client.destroy().catch((error: unknown) => {
      this.logger.warn(
        `TDLib destroy failed for attempt ${attempt.id}: ${(error as Error).message}`,
      );
    });
  }

  /** Removes the attempt database: the temp folder, or the adopted one if the attach failed. */
  private async cleanupDirectories(attempt: TdlibAttempt): Promise<void> {
    if (attempt.cleanupDone) return;
    attempt.cleanupDone = true;

    if (attempt.adoptedPath) {
      if (attempt.attached) return;
      await rm(attempt.adoptedPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
      return;
    }
    await rm(attempt.dirs.root, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  private sweep(): void {
    const now = Date.now();
    for (const attempt of this.attempts.values()) {
      if (attempt.expiresAtMs > now) continue;
      void this.expire(attempt).catch((error: unknown) => {
        this.logger.warn(
          `Could not expire TDLib attempt ${attempt.id}: ${(error as Error).message}`,
        );
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.sweeper);
    const attempts = [...this.attempts.values()];
    this.attempts.clear();
    await Promise.allSettled(
      attempts.map(async (attempt) => {
        this.resolveFirstProgress(attempt);
        await this.closeClient(attempt);
        await this.cleanupDirectories(attempt);
      }),
    );
  }

  // ----------------------------------------------------------------- helpers

  private async waitForStart(attempt: TdlibAttempt): Promise<void> {
    if (!attempt.firstProgress) return;
    await withTimeout(attempt.firstProgress.promise, FIRST_PROGRESS_TIMEOUT_MS);
  }

  private resolveFirstProgress(attempt: TdlibAttempt): void {
    attempt.firstProgress?.resolve();
    attempt.firstProgress = undefined;
  }

  private logFailure(
    attempt: TdlibAttempt,
    action: string,
    mapped: MappedTdlibError,
  ): void {
    emitLog({
      level: 'error',
      source: 'auth',
      action,
      message: mapped.message,
      status: 'failed',
      userId: attempt.userId,
      accountId: attempt.accountId,
      attemptId: attempt.id,
      proxyId: attempt.proxyId,
      errorCode: mapped.code,
      details: { kind: attempt.kind, method: attempt.method },
    });
  }

  private view(attempt: TdlibAttempt): TdlibAuthView {
    return {
      attemptId: attempt.id,
      status: attempt.status,
      ...(attempt.qrLink ? { qrLink: attempt.qrLink } : {}),
      ...(attempt.error ? { error: attempt.error } : {}),
      ...(attempt.needsPassword ? { needsPassword: true } : {}),
      ...(attempt.account ? { account: attempt.account } : {}),
    };
  }

  private async applyProxy(attempt: TdlibAttempt): Promise<void> {
    if (!attempt.proxyId) return;
    const proxy = await this.prisma.proxy.findFirst({
      where: { id: attempt.proxyId, userId: attempt.userId },
    });
    if (!proxy) return;

    const credentials = this.proxies.credentialsFor(proxy);
    if (
      credentials.kind !== 'http' &&
      credentials.kind !== 'https' &&
      credentials.kind !== 'socks5'
    ) {
      this.logger.warn(
        `TDLib cannot use proxy kind ${credentials.kind} (attempt ${attempt.id}); using a direct connection`,
      );
      return;
    }

    try {
      await attempt.client.setProxy({
        server: credentials.host,
        port: credentials.port,
        kind: credentials.kind,
        username: credentials.username,
        secret: credentials.secret,
        comment: proxy.name,
      });
    } catch (error) {
      // Never log the proxy secret; the reason is enough.
      this.logger.warn(
        `Could not apply proxy ${proxy.id} to TDLib attempt ${attempt.id}: ${(error as Error).message}`,
      );
      emitLog({
        level: 'warn',
        source: 'proxy',
        action: 'auth.tdlib.proxy',
        message: 'Could not apply the proxy to the TDLib login',
        status: 'failed',
        userId: attempt.userId,
        attemptId: attempt.id,
        proxyId: proxy.id,
        details: { kind: credentials.kind },
      });
    }
  }

  private async assertProxy(
    userId: string,
    proxyId: string | null,
  ): Promise<void> {
    if (!proxyId) return;
    const proxy = await this.prisma.proxy.findFirst({
      where: { id: proxyId, userId },
      select: { id: true },
    });
    if (!proxy) throw notFound('PROXY_NOT_FOUND', 'Proxy not found');
  }

  private pickMtcuteSession(
    account: AccountWithSessions,
  ): TelegramSessionModel | undefined {
    const live = account.sessions.filter(
      (session) => !session.revokedAt && session.engine !== 'tdlib',
    );
    return live.sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    )[0];
  }

  private requireAttempt(
    userId: string,
    attemptId: string,
    accountId?: string,
  ): TdlibAttempt {
    const id = requireString(attemptId, 'attemptId', { max: 64 });
    const attempt = this.attempts.get(id);
    if (
      !attempt ||
      attempt.userId !== userId ||
      (accountId !== undefined && attempt.accountId !== accountId)
    ) {
      throw notFound('ATTEMPT_NOT_FOUND', 'TDLib login attempt not found');
    }
    if (attempt.expiresAtMs <= Date.now()) {
      void this.expire(attempt).catch(() => undefined);
      throw apiError(
        'ATTEMPT_EXPIRED',
        'This TDLib login attempt has expired, start over',
        410,
      );
    }
    return attempt;
  }

  private async requireAccount(
    userId: string,
    accountId: string,
  ): Promise<AccountWithSessions> {
    const id = requireString(accountId, 'accountId', { max: 64 });
    const account = await this.prisma.telegramAccount.findFirst({
      where: { id, userId },
      include: { sessions: true },
    });
    if (!account) {
      throw notFound('ACCOUNT_NOT_FOUND', 'Account not found');
    }
    return account as AccountWithSessions;
  }

  private decryptCloudPassword(
    account: TelegramAccountModel,
  ): string | undefined {
    if (!account.cloudPasswordEncrypted) return undefined;
    try {
      const envelope = this.crypto.deserialize(account.cloudPasswordEncrypted);
      return this.crypto
        .decrypt(envelope, `cloud:${account.id}`)
        .toString('utf8');
    } catch {
      this.logger.warn(
        `Could not decrypt the cloud password of account ${account.id}`,
      );
      return undefined;
    }
  }

  private async storeCloudPassword(
    accountId: string,
    password: string,
  ): Promise<void> {
    const envelope = this.crypto.encrypt(password, `cloud:${accountId}`);
    await this.prisma.telegramAccount.update({
      where: { id: accountId },
      data: {
        // Same shape as the phone number: the whole envelope in one blob.
        cloudPasswordEncrypted: this.crypto.serialize(envelope),
        cloudPasswordNonce: envelope.nonce,
        cloudPasswordTag: envelope.tag,
      },
    });
    emitLog({
      level: 'info',
      source: 'auth',
      action: 'auth.tdlib.cloud_password',
      message: 'Stored the cloud password for automatic 2FA',
      status: 'ok',
      accountId,
      details: { stored: true },
    });
  }

  /** Storing the password must never undo a successful login. */
  private async storeCloudPasswordQuiet(
    accountId: string,
    password: string,
  ): Promise<void> {
    try {
      await this.storeCloudPassword(accountId, password);
    } catch (error) {
      this.logger.warn(
        `Could not store the cloud password of account ${accountId}: ${(error as Error).message}`,
      );
    }
  }

  private async handleStateFailure(
    attempt: TdlibAttempt,
    error: unknown,
  ): Promise<void> {
    if (
      attempt.finalized ||
      attempt.status === 'failed' ||
      attempt.status === 'expired'
    ) {
      return;
    }
    const mapped = describeError(error, 'flow');
    await this.failAttempt(attempt, mapped);
  }
}
