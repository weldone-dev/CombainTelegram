#!/usr/bin/env bun
/**
 * TDLib QR bridge POC.
 *
 * Proves that an existing mtcute account session can authorize a brand-new
 * TDLib client through Telegram's QR login flow:
 *
 *   1. TDLib starts with Telegram Desktop's official profile and asks Telegram
 *      for a QR login token (`requestQrCodeAuthentication`).
 *   2. The existing mtcute session accepts that token
 *      (`auth.acceptLoginToken`), as if the user had scanned the code.
 *   3. TDLib becomes `authorizationStateReady`; `getMe` confirms the identity.
 *
 * This script is deliberately outside the Nest runtime: it boots an application
 * context read-only, touches no module wiring and is not imported by the app.
 *
 * Usage: `bun run tdlib:poc --account <TelegramAccount id> [--help]`
 */
import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { tl } from '@mtcute/node';
import type { AuthorizationState, Update } from 'tdlib-native/types';
import { buildTdlibParameters, parseQrLoginToken } from '../src/tdlib/poc.js';

const DEFAULT_TIMEOUT_MS = 120_000;

interface CliOptions {
  help: boolean;
  accountId?: string;
  timeoutMs: number;
  baseDir: string;
  keep: boolean;
}

class UsageError extends Error {}

function parseTimeout(value: string | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new UsageError(
      `--timeout must be a positive number of seconds, got "${value}"`,
    );
  }
  return Math.round(seconds * 1000);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    accountId: process.env.TD_ACCOUNT_ID,
    timeoutMs:
      process.env.TD_POC_TIMEOUT_MS === undefined
        ? DEFAULT_TIMEOUT_MS
        : parseTimeoutMs(process.env.TD_POC_TIMEOUT_MS),
    baseDir: process.env.TD_POC_DIR ?? tmpdir(),
    keep: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const [flag, inline] = arg.split('=', 2) as [string, string | undefined];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new UsageError(`${flag} requires a value`);
      }
      i += 1;
      return next;
    };

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '--account':
        options.accountId = value();
        break;
      case '--timeout':
        options.timeoutMs = parseTimeout(value());
        break;
      case '--dir':
        options.baseDir = value();
        break;
      case '--keep':
        options.keep = true;
        break;
      default:
        throw new UsageError(`Unknown argument "${arg}"`);
    }
  }

  return options;
}

/** `TD_POC_TIMEOUT_MS` is already milliseconds; `--timeout` is seconds. */
function parseTimeoutMs(value: string): number {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new UsageError(
      `TD_POC_TIMEOUT_MS must be a positive number, got "${value}"`,
    );
  }
  return Math.round(ms);
}

function printUsage(): void {
  console.log(`TDLib QR bridge POC (does not change runtime behaviour)

Usage:
  bun run tdlib:poc --account <accountId> [options]
  bun scripts/tdlib-qr-poc.ts --account <accountId> [options]

Options:
  --account <id>   TelegramAccount id owned by DEFAULT_USER_ID (env TD_ACCOUNT_ID)
  --timeout <s>    Per-step timeout in seconds (env TD_POC_TIMEOUT_MS, default 120)
  --dir <path>     Base directory for the throwaway TDLib database (env TD_POC_DIR)
  --keep           Keep the TDLib database after the run
  -h, --help       Print this help and exit

Environment: DEFAULT_USER_ID selects the local user (default "local").
The script never writes account data and never changes the API's stored session.`);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    const details = error as Error & { code?: number; method?: string };
    const suffix = [
      details.code !== undefined ? `code=${details.code}` : undefined,
      details.method !== undefined ? `method=${details.method}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');
    return suffix ? `${error.message} (${suffix})` : error.message;
  }
  return String(error);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  what: string,
  diagnostics: () => string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out after ${timeoutMs} ms waiting for ${what}; ${diagnostics()}`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.accountId) {
    throw new UsageError('--account <id> (or TD_ACCOUNT_ID) is required');
  }

  // Loaded only after --help so the help path never boots Nest or the native addon.
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app.module.js');
  const { AccountsService } =
    await import('../src/accounts/accounts.service.js');
  const { ClientManagerService } =
    await import('../src/telegram/client-manager.service.js');
  const { TelegramConfigService } =
    await import('../src/telegram/telegram.config.js');
  const { profile } = await import('opentele2');
  const { Client, Authenticator } = await import('tdlib-native');
  const { TDLibAddon } = await import('tdlib-native/addon');

  const baseDir = resolve(options.baseDir);
  mkdirSync(baseDir, { recursive: true });
  const workDir = mkdtempSync(join(baseDir, 'tdlib-poc-'));
  const databaseDirectory = join(workDir, 'db');
  const filesDirectory = join(workDir, 'files');
  mkdirSync(databaseDirectory, { recursive: true });
  mkdirSync(filesDirectory, { recursive: true });

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  let tdlib: InstanceType<typeof Client> | undefined;
  let mtcuteSessionId: string | undefined;
  let lastState: AuthorizationState['_'] | 'unknown' = 'unknown';

  try {
    const accounts = app.get(AccountsService);
    const config = app.get(TelegramConfigService);

    const {
      account,
      session,
      client: mtcute,
    } = await accounts.resolveSession(config.defaultUserId, options.accountId);
    mtcuteSessionId = session.id;
    console.log(
      `[poc] using account ${account.id} (@${account.username ?? account.tgUserId}) session ${session.id} (${session.label ?? 'no label'}) as user ${config.defaultUserId}`,
    );

    const profileApi = profile('TelegramDesktop');
    const parameters = buildTdlibParameters(profileApi, {
      databaseDirectory,
      filesDirectory,
    });
    console.log(
      `[poc] TDLib profile: ${profileApi.deviceModel} / ${profileApi.appVersion} (api_id ${profileApi.apiId})`,
    );
    console.log(`[poc] TDLib database: ${databaseDirectory}`);

    const adapter = await TDLibAddon.create();
    Client.disableLogs(adapter);
    tdlib = new Client(adapter);

    const phoneState = deferred<void>();
    const qrLinkState = deferred<string>();
    const readyState = deferred<void>();
    const failure = deferred<never>();
    // Attach a handler immediately so an early rejection never goes unhandled.
    void failure.promise.catch(() => undefined);

    tdlib.updates.subscribe((update: Update) => {
      if (update._ === 'updateConnectionState') {
        console.log(`[tdlib] connection: ${update.state._}`);
        return;
      }
      if (update._ !== 'updateAuthorizationState') return;

      const state = update.authorization_state;
      lastState = state._;
      console.log(`[tdlib] authorization state: ${state._}`);

      switch (state._) {
        case 'authorizationStateWaitTdlibParameters':
        case 'authorizationStateWaitPhoneNumber':
          if (state._ === 'authorizationStateWaitPhoneNumber')
            phoneState.resolve();
          break;
        case 'authorizationStateWaitOtherDeviceConfirmation':
          console.log(`[tdlib] QR link: ${state.link}`);
          qrLinkState.resolve(state.link);
          break;
        case 'authorizationStateReady':
          readyState.resolve();
          break;
        case 'authorizationStateClosed':
        case 'authorizationStateClosing':
        case 'authorizationStateLoggingOut':
          failure.reject(
            new Error(`TDLib closed the client during login (${state._})`),
          );
          break;
        default:
          break;
      }
    });

    const waitFor = <T>(promise: Promise<T>, what: string): Promise<T> =>
      withTimeout(
        Promise.race([promise, failure.promise]),
        options.timeoutMs,
        what,
        () => `last TDLib state: ${lastState}`,
      );

    // Authenticator supplies setTdlibParameters and resolves on Ready. The phone
    // waiter never resolves: this POC goes through QR instead of a phone code.
    const authenticator = Authenticator.create(tdlib)
      .tdlibParameters(parameters)
      .phone(() => new Promise<string>(() => undefined));
    const authenticated = authenticator.authenticate();

    await tdlib.start();
    await waitFor(phoneState.promise, 'authorizationStateWaitPhoneNumber');

    console.log('[poc] requesting a TDLib QR login token');
    await tdlib.api.requestQrCodeAuthentication({ other_user_ids: [] });
    const qrLink = await waitFor(
      qrLinkState.promise,
      'authorizationStateWaitOtherDeviceConfirmation',
    );

    const { token } = parseQrLoginToken(qrLink);
    console.log(
      '[poc] accepting the TDLib QR token on the existing mtcute session',
    );
    await mtcute.call({
      _: 'auth.acceptLoginToken',
      token,
    } as tl.auth.RawAcceptLoginTokenRequest);

    await waitFor(readyState.promise, 'authorizationStateReady');
    await waitFor(authenticated, 'Authenticator completion');

    const me = await tdlib.api.getMe({});
    const username =
      me.usernames?.editable_username ||
      me.usernames?.active_usernames[0] ||
      undefined;
    const result = {
      qrLink,
      authorized: true,
      tdlibUser: {
        id: me.id,
        username,
        firstName: me.first_name,
        lastName: me.last_name,
      },
    };
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`[tdlib-poc] FAILED: ${describeError(error)}`);
    console.error(
      `[tdlib-poc] diagnostic: last TDLib state=${lastState}, account=${options.accountId}, db=${databaseDirectory}`,
    );
    process.exitCode = 1;
  } finally {
    if (tdlib) {
      await tdlib.destroy().catch((error: unknown) => {
        console.error(
          `[tdlib-poc] TDLib destroy failed: ${describeError(error)}`,
        );
      });
    }
    if (mtcuteSessionId) {
      await app
        .get(ClientManagerService)
        .closeSession(mtcuteSessionId)
        .catch((error: unknown) => {
          console.error(
            `[tdlib-poc] mtcute disconnect failed: ${describeError(error)}`,
          );
        });
    }
    await app.close().catch((error: unknown) => {
      console.error(
        `[tdlib-poc] Nest shutdown failed: ${describeError(error)}`,
      );
    });

    if (!options.keep) {
      rmSync(workDir, { recursive: true, force: true });
    } else {
      console.log(`[poc] kept TDLib database at ${workDir}`);
    }
  }

  // The script is a proof, not a daemon: make the exit status explicit.
  process.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
}

main().catch((error: unknown) => {
  if (error instanceof UsageError) {
    console.error(`[tdlib-poc] ${error.message}\n`);
    printUsage();
  } else {
    console.error(`[tdlib-poc] FAILED: ${describeError(error)}`);
  }
  process.exit(1);
});
