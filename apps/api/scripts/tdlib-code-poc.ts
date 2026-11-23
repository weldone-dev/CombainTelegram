#!/usr/bin/env bun
/**
 * TDLib "code bridge" POC (path B).
 *
 * Logs a brand-new TDLib client (official Telegram Android profile) into the
 * same account as an existing mtcute/desktop session without touching that
 * session:
 *
 *   1. mtcute already holds an authorized session for the account.
 *   2. TDLib starts and asks for a phone number.
 *   3. TDLib sends that phone number; Telegram sends a login code.
 *   4. The code arrives as a service message from 777000 in the existing
 *      mtcute session, which forwards it to TDLib.
 *   5. If cloud password (2FA) is enabled, the password is passed as well.
 *   6. TDLib becomes authorized. The old session is never logged out.
 *
 * Usage:
 *   bun scripts/tdlib-code-poc.ts --account <id> [--password <2fa>]
 *                                 [--timeout <s>] [--dir <path>] [--keep]
 */
import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Update } from 'tdlib-native/types';
import { buildTdlibParameters, parseQrLoginToken } from '../src/tdlib/poc.js';

const SERVICE_ACCOUNT_ID = 777000;
const DEFAULT_TIMEOUT_S = 180;

interface CliOptions {
  help: boolean;
  accountId?: string;
  password?: string;
  mode: 'code' | 'qr';
  timeoutMs: number;
  baseDir: string;
  keep: boolean;
}

function usage(): void {
  console.log(`TDLib code bridge POC (path B)

Usage:
  bun run tdlib:code-poc --account <accountId> --password <2fa> [options]

Options:
  --account <id>    TelegramAccount id (env TD_ACCOUNT_ID)
  --password <pwd>  Cloud password, if enabled (env TD_PASSWORD)
  --timeout <s>     Overall login timeout (env TD_POC_TIMEOUT_MS, default 180)
  --dir <path>      Base directory for the throwaway TDLib database
  --keep            Keep the TDLib database after the run
  -h, --help        Print this help

Never logs out the existing session.`);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    accountId: process.env.TD_ACCOUNT_ID,
    password: process.env.TD_PASSWORD,
    mode: (process.env.TD_MODE === 'qr' ? 'qr' : 'code') as 'code' | 'qr',
    timeoutMs: Number(process.env.TD_POC_TIMEOUT_MS ?? DEFAULT_TIMEOUT_S * 1000),
    baseDir: process.env.TD_POC_DIR ?? tmpdir(),
    keep: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = (argv[i] as string).split('=', 2) as [
      string,
      string | undefined,
    ];
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} requires a value`);
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
      case '--password':
        options.password = value();
        break;
      case '--mode': {
        const mode = value();
        if (mode !== 'code' && mode !== 'qr') {
          throw new Error('--mode must be "code" or "qr"');
        }
        options.mode = mode;
        break;
      }
      case '--timeout':
        options.timeoutMs = Math.round(Number(value()) * 1000);
        break;
      case '--dir':
        options.baseDir = value();
        break;
      case '--keep':
        options.keep = true;
        break;
      default:
        throw new Error(`Unknown argument "${flag}"`);
    }
  }
  return options;
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (!options.accountId) throw new Error('--account <id> is required');

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('../src/app.module.js');
  const { AccountsService } = await import('../src/accounts/accounts.service.js');
  const { ClientManagerService } =
    await import('../src/telegram/client-manager.service.js');
  const { TelegramConfigService } =
    await import('../src/telegram/telegram.config.js');
  const { profile } = await import('opentele2');
  const { Client } = await import('tdlib-native');
  const { TDLibAddon } = await import('tdlib-native/addon');

  const baseDir = resolve(options.baseDir);
  mkdirSync(baseDir, { recursive: true });
  const workDir = mkdtempSync(join(baseDir, 'tdlib-code-'));
  const databaseDirectory = join(workDir, 'db');
  const filesDirectory = join(workDir, 'files');
  mkdirSync(databaseDirectory, { recursive: true });
  mkdirSync(filesDirectory, { recursive: true });

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });

  let tdlib: InstanceType<typeof Client> | undefined;
  let mtcuteSessionId: string | undefined;
  let removeCodeListener: (() => void) | undefined;
  let lastState = 'unknown';

  try {
    const accounts = app.get(AccountsService);
    const config = app.get(TelegramConfigService);
    const { account, session, client: mtcute } = await accounts.resolveSession(
      config.defaultUserId,
      options.accountId,
    );
    mtcuteSessionId = session.id;

    await mtcute.startUpdatesLoop();
    const me = await mtcute.getMe();
    const phone = me.phoneNumber;
    if (!phone) throw new Error('existing session did not expose a phone number');
    console.log(`[poc] account ${account.id} phone ${phone} (session ${session.id})`);

    const profileApi = profile('TelegramAndroid');
    const parameters = buildTdlibParameters(profileApi, {
      databaseDirectory,
      filesDirectory,
    });
    parameters.use_message_database = true;
    parameters.use_chat_info_database = true;
    console.log(
      `[poc] TDLib profile ${profileApi.deviceModel} / ${profileApi.appVersion} (api_id ${profileApi.apiId})`,
    );

    const adapter = await TDLibAddon.create();
    Client.disableLogs(adapter);
    tdlib = new Client(adapter);

    let codeSeen: string | undefined;
    const codePromise = (async (): Promise<string> => {
      const deadline = Date.now() + options.timeoutMs;
      while (Date.now() < deadline) {
        if (codeSeen) return codeSeen;
        await sleep(250);
      }
      throw new Error('login code never arrived from 777000');
    })();
    void codePromise.catch(() => undefined);

    const onNewMessage = (message: {
      sender?: { id?: number | string } | null;
      text?: string;
    }) => {
      if (String(message.sender?.id) !== String(SERVICE_ACCOUNT_ID)) return;
      const match = /(\d{4,6})/.exec(message.text ?? '');
      if (!match) return;
      codeSeen = match[1];
      console.log(`[poc] login code received from 777000: ${codeSeen}`);
    };
    mtcute.onNewMessage.add(onNewMessage);
    removeCodeListener = () => mtcute.onNewMessage.remove(onNewMessage);

    const finished = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`login timed out (last state ${lastState})`)),
        options.timeoutMs,
      ).unref?.();
    });
    void finished.catch(() => undefined);

    const handleState = async (state: Update & { _: 'updateAuthorizationState' }) => {
      const auth = state.authorization_state;
      lastState = auth._;
      console.log(`[tdlib] auth state: ${auth._}`);

      switch (auth._) {
        case 'authorizationStateWaitTdlibParameters':
          await tdlib?.api.setTdlibParameters(parameters);
          break;
        case 'authorizationStateWaitPhoneNumber':
          if (options.mode === 'qr') {
            console.log('[poc] requesting a QR login token from TDLib');
            await tdlib?.api.requestQrCodeAuthentication({ other_user_ids: [] });
          } else {
            console.log('[poc] submitting phone number to TDLib');
            await tdlib?.api.setAuthenticationPhoneNumber({
              phone_number: phone,
              settings: { _: 'phoneNumberAuthenticationSettings' },
            });
          }
          break;
        case 'authorizationStateWaitOtherDeviceConfirmation': {
          const { token } = parseQrLoginToken(auth.link);
          console.log(`[poc] approving TDLib QR from the existing session: ${auth.link}`);
          await mtcute.call({
            _: 'auth.acceptLoginToken',
            token,
          } as Parameters<typeof mtcute.call>[0]);
          break;
        }
        case 'authorizationStateWaitCode': {
          const code = await codePromise;
          console.log('[poc] submitting login code to TDLib');
          await tdlib?.api.checkAuthenticationCode({ code });
          break;
        }
        case 'authorizationStateWaitPassword':
          if (!options.password) {
            throw new Error('TDLib asked for a 2FA password but none was given');
          }
          console.log('[poc] submitting 2FA password to TDLib');
          await tdlib?.api.checkAuthenticationPassword({
            password: options.password,
          });
          break;
        case 'authorizationStateReady':
          queueMicrotask(() => finish.resolve());
          break;
        case 'authorizationStateWaitRegistration':
          throw new Error('this phone number is not registered');
        case 'authorizationStateClosed':
          throw new Error('TDLib closed the client');
        default:
          break;
      }
    };

    let finish!: { resolve: () => void; reject: (e: unknown) => void };
    const ready = new Promise<void>((res, rej) => {
      finish = { resolve: res, reject: rej };
    });

    tdlib.updates.subscribe((update: Update) => {
      if (update._ !== 'updateAuthorizationState') return;
      void handleState(update).catch((error: unknown) => {
        console.error(`[poc] state handler failed: ${String(error)}`);
        finish.reject(error);
      });
    });

    await tdlib.start();
    await Promise.race([ready, finished]);

    const tdMe = await tdlib.api.getMe({});
    const username =
      tdMe.usernames?.editable_username ??
      tdMe.usernames?.active_usernames[0] ??
      null;
    console.log(
      JSON.stringify(
        {
          ok: true,
          phone,
          tdlibUser: {
            id: tdMe.id,
            username,
            firstName: tdMe.first_name,
            lastName: tdMe.last_name,
          },
          oldSessionUntouched: true,
          databaseDirectory,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(`[poc] FAILED: ${String(error)}`);
    console.error(`[poc] last TDLib state: ${lastState}`);
    process.exitCode = 1;
  } finally {
    removeCodeListener?.();
    if (tdlib) await tdlib.destroy().catch(() => undefined);
    if (mtcuteSessionId) {
      await app
        .get(ClientManagerService)
        .closeSession(mtcuteSessionId)
        .catch(() => undefined);
    }
    await app.close().catch(() => undefined);
    if (options.keep) console.log(`[poc] kept database at ${workDir}`);
    else rmSync(workDir, { recursive: true, force: true });
  }

  process.exit(process.exitCode ?? 0);
}

main().catch((error: unknown) => {
  console.error(`[poc] FAILED: ${String(error)}`);
  process.exit(1);
});
