import { Buffer } from 'node:buffer';
import type { TelegramClient } from '@mtcute/node';
import type { UserModel } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
import type {
  TdlibAuthClient,
  TdlibAuthState,
  TdlibAuthUser,
  TdlibProxyInput,
} from './tdlib-auth.client.js';
import { mapTdlibError, TdlibAuthService } from './tdlib-auth.service.js';
import type { TdlibAuthView } from './tdlib-auth.service.js';
import { parseQrLoginToken } from '../tdlib/poc.js';
import { SessionCryptoService } from '../telegram/session-crypto.service.js';

const USER = { id: 'user-1' } as unknown as UserModel;

/** 32-byte token, exactly what Telegram puts into a QR link. */
const TOKEN = Buffer.alloc(32, 7);
const QR_LINK = `tg://login?token=${TOKEN.toString('base64url')}`;

const ACCOUNT_VIEW = {
  id: 'acc-1',
  tgUserId: '42',
  firstName: 'Test',
  lastName: null,
  username: null,
  phoneMasked: null,
  isActive: true,
  createdAt: new Date(0).toISOString(),
  lastUsedAt: null,
  deviceProfile: null,
  sessions: [],
};

class FakeTdlibClient implements TdlibAuthClient {
  handler: ((state: TdlibAuthState) => void) | null = null;
  parameters: unknown[] = [];
  proxy: TdlibProxyInput | null = null;
  passwordChecks: string[] = [];
  codeChecks: string[] = [];
  phones: string[] = [];
  destroyed = 0;
  started = 0;
  me: TdlibAuthUser = {
    id: 42,
    firstName: 'Test',
    lastName: null,
    username: 'test',
    phone: '+15551234567',
  };

  /** Password that `right-password` accepts; anything else is rejected. */
  readonly expectedPassword = 'right-password';

  async start(): Promise<void> {
    this.started += 1;
  }

  onAuthorizationState(handler: (state: TdlibAuthState) => void): () => void {
    this.handler = handler;
    return () => {
      this.handler = null;
    };
  }

  async setTdlibParameters(parameters: unknown): Promise<void> {
    this.parameters.push(parameters);
    this.emit({ _: 'authorizationStateWaitPhoneNumber' });
  }

  async requestQrCodeAuthentication(): Promise<void> {
    this.emit({
      _: 'authorizationStateWaitOtherDeviceConfirmation',
      link: QR_LINK,
    });
  }

  async setAuthenticationPhoneNumber(phone: string): Promise<void> {
    this.phones.push(phone);
    this.emit({ _: 'authorizationStateWaitCode' });
  }

  async checkAuthenticationCode(code: string): Promise<void> {
    this.codeChecks.push(code);
    if (code !== '12345') {
      throw { code: 400, message: 'PHONE_CODE_INVALID' };
    }
  }

  async checkAuthenticationPassword(password: string): Promise<void> {
    this.passwordChecks.push(password);
    if (password !== this.expectedPassword && password !== 'stored-pass') {
      throw { code: 400, message: 'PASSWORD_HASH_INVALID' };
    }
  }

  async setProxy(proxy: TdlibProxyInput): Promise<void> {
    this.proxy = proxy;
  }

  async getMe(): Promise<TdlibAuthUser> {
    return this.me;
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
    this.handler = null;
  }

  emit(state: TdlibAuthState): void {
    this.handler?.(state);
  }
}

interface Harness {
  service: TdlibAuthService;
  client: FakeTdlibClient;
  crypto: SessionCryptoService;
  account: Record<string, unknown>;
  mtcute: { call: ReturnType<typeof vi.fn> };
  attach: ReturnType<typeof vi.fn>;
  adopt: ReturnType<typeof vi.fn>;
  prisma: {
    telegramAccount: {
      findFirst: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    proxy: { findFirst: ReturnType<typeof vi.fn> };
  };
}

function createHarness(
  account: Record<string, unknown> = {
    id: 'acc-1',
    userId: 'user-1',
    cloudPasswordEncrypted: null,
    sessions: [],
  },
): Harness {
  const crypto = new SessionCryptoService({
    sessionMasterKey: Buffer.alloc(32, 5),
  } as never);
  const client = new FakeTdlibClient();
  const mtcute = { call: vi.fn(async () => ({})) };
  const attach = vi.fn(async () => ({
    account: ACCOUNT_VIEW,
    sessionId: 'session-1',
    isNewAccount: true,
    isNewSession: true,
  }));
  const adopt = vi.fn(
    async (_dirs: unknown, sessionId: string) => `/sessions/${sessionId}`,
  );

  const prisma = {
    telegramAccount: {
      findFirst: vi.fn(async () => account),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(account, data);
        return account;
      }),
    },
    proxy: { findFirst: vi.fn(async () => null) },
  };

  const accounts = {
    resolveSession: vi.fn(async () => ({
      account,
      session: {
        id: 'mtcute-session',
        engine: 'mtcute',
        label: 'Desktop',
        proxyId: null,
        revokedAt: null,
        createdAt: new Date(0),
      },
      client: mtcute as unknown as TelegramClient,
    })),
  };

  const sessions = { attachTdlibSession: attach };
  const tdClients = {
    temporaryDirectories: (id: string) => ({
      root: `/attempts/${id}`,
      databaseDirectory: `/attempts/${id}/db`,
      filesDirectory: `/attempts/${id}/files`,
    }),
    sessionDirectories: (id: string) => ({
      root: `/sessions/${id}`,
      databaseDirectory: `/sessions/${id}/db`,
      filesDirectory: `/sessions/${id}/files`,
    }),
    ensureDirectories: vi.fn(async () => undefined),
    generateDatabaseKey: () => 'database-key',
    parameters: () => ({ _: 'setTdlibParameters' }),
    adoptDirectory: adopt,
    tdlibProfile: () => ({ apiId: 1234 }),
  };

  const factory = { create: vi.fn(async () => client) };
  const proxies = { credentialsFor: vi.fn() };

  const service = new TdlibAuthService(
    prisma as never,
    accounts as never,
    sessions as never,
    crypto,
    tdClients as never,
    factory as never,
    proxies as never,
  );

  return {
    service,
    client,
    crypto,
    account,
    mtcute,
    attach,
    adopt,
    prisma,
  };
}

/** Lets every pending microtask and timer-free promise chain settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function waitFor(
  read: () => Promise<TdlibAuthView>,
  predicate: (view: TdlibAuthView) => boolean,
): Promise<TdlibAuthView> {
  for (let i = 0; i < 25; i += 1) {
    const view = await read();
    if (predicate(view)) return view;
    await flush();
  }
  return read();
}

function responseCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'getResponse' in error) {
    const body = (error as { getResponse(): unknown }).getResponse();
    if (body && typeof body === 'object' && 'code' in body) {
      return String((body as { code: unknown }).code);
    }
  }
  return undefined;
}

describe('mapTdlibError', () => {
  it('maps a rejected cloud password without echoing it', () => {
    const mapped = mapTdlibError(
      new Error('PASSWORD_HASH_INVALID secret-value'),
      'password',
    );
    expect(mapped.code).toBe('TDLIB_PASSWORD_INVALID');
    expect(mapped.status).toBe(400);
    expect(mapped.message).not.toContain('secret-value');
  });

  it('maps a missing native addon to TDLIB_UNAVAILABLE', () => {
    const mapped = mapTdlibError(new Error('tdjson addon failed to load'), 'flow');
    expect(mapped.code).toBe('TDLIB_UNAVAILABLE');
    expect(mapped.status).toBe(503);
  });

  it('maps every other failure to TDLIB_AUTH_FAILED', () => {
    expect(mapTdlibError(new Error('boom'), 'flow').code).toBe(
      'TDLIB_AUTH_FAILED',
    );
    expect(mapTdlibError(new Error('PHONE_CODE_INVALID'), 'code').message).toBe(
      'TDLib rejected the login code',
    );
  });
});

describe('TdlibAuthService new-account QR flow', () => {
  it('goes starting -> qr_pending -> awaiting_password -> ready', async () => {
    const { service, client, crypto, attach, prisma } = createHarness();
    const starting = service.start(USER, { method: 'qr', label: 'TDLib' });
    await flush();
    client.emit({ _: 'authorizationStateWaitTdlibParameters' });
    const view = await starting;

    expect(view.status).toBe('qr_pending');
    expect(view.qrLink).toBe(QR_LINK);
    expect(client.parameters).toHaveLength(1);

    client.emit({ _: 'authorizationStateWaitPassword' });
    await flush();
    const waiting = await service.status(USER, view.attemptId);
    expect(waiting.status).toBe('awaiting_password');
    expect(waiting.needsPassword).toBe(true);

    await expect(
      service.password(USER, view.attemptId, 'wrong'),
    ).rejects.toSatisfy(
      (error: unknown) => responseCode(error) === 'TDLIB_PASSWORD_INVALID',
    );
    expect(client.passwordChecks).toEqual(['wrong']);

    client.emit({ _: 'authorizationStateWaitPassword' });
    await flush();
    await service.password(USER, view.attemptId, client.expectedPassword);
    expect(client.passwordChecks).toEqual(['wrong', 'right-password']);

    client.emit({ _: 'authorizationStateReady' });
    await flush();

    const ready = await waitFor(
      () => service.status(USER, view.attemptId),
      (status) => status.status === 'ready',
    );
    expect(ready.status).toBe('ready');
    expect(ready.account?.id).toBe('acc-1');
    expect(client.destroyed).toBe(1);
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: view.attemptId,
        tdlibPath: `/sessions/${view.attemptId}`,
        apiId: 1234,
        phone: '+15551234567',
      }),
    );

    // A user-submitted password that worked is stored encrypted.
    const stored = prisma.telegramAccount.update.mock.calls.find(
      ([call]: [{ data?: Record<string, unknown> }]) =>
        typeof call.data?.cloudPasswordEncrypted !== 'undefined' &&
        call.data?.cloudPasswordEncrypted !== null,
    );
    expect(stored).toBeDefined();
    const envelope = crypto.deserialize(
      stored![0].data.cloudPasswordEncrypted as Uint8Array,
    );
    expect(crypto.decrypt(envelope, 'cloud:acc-1').toString('utf8')).toBe(
      client.expectedPassword,
    );
  });
});

describe('TdlibAuthService migration flow', () => {
  it('approves the TDLib QR token with the mtcute session and keeps it', async () => {
    const { service, client, mtcute, attach } = createHarness({
      id: 'acc-1',
      userId: 'user-1',
      cloudPasswordEncrypted: null,
      sessions: [
        {
          id: 'mtcute-session',
          engine: 'mtcute',
          label: 'Desktop',
          proxyId: null,
          revokedAt: null,
          createdAt: new Date(0),
        },
      ],
    });

    const starting = service.migrate(USER, 'acc-1');
    await flush();
    client.emit({ _: 'authorizationStateWaitTdlibParameters' });
    const view = await starting;

    await flush();
    expect(view.status).toBe('qr_pending');
    expect(mtcute.call).toHaveBeenCalledTimes(1);
    expect(mtcute.call).toHaveBeenCalledWith({
      _: 'auth.acceptLoginToken',
      token: parseQrLoginToken(QR_LINK).token,
    });

    client.emit({ _: 'authorizationStateReady' });
    await flush();

    const ready = await waitFor(
      () => service.migrateStatus(USER, 'acc-1', view.attemptId),
      (status) => status.status === 'ready',
    );
    expect(ready.status).toBe('ready');
    expect(attach).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: view.attemptId,
        tdlibPath: `/sessions/${view.attemptId}`,
      }),
    );
    // The old session is only used as approver, never logged out.
    expect(mtcute.call).toHaveBeenCalledTimes(1);
    expect(client.destroyed).toBe(1);
  });

  it('auto-submits the stored cloud password once instead of prompting', async () => {
    const crypto = new SessionCryptoService({
      sessionMasterKey: Buffer.alloc(32, 5),
    } as never);
    const envelope = crypto.serialize(
      crypto.encrypt('stored-pass', 'cloud:acc-1'),
    );
    const { service, client } = createHarness({
      id: 'acc-1',
      userId: 'user-1',
      cloudPasswordEncrypted: envelope,
      sessions: [
        {
          id: 'mtcute-session',
          engine: 'mtcute',
          label: 'Desktop',
          proxyId: null,
          revokedAt: null,
          createdAt: new Date(0),
        },
      ],
    });

    const starting = service.migrate(USER, 'acc-1');
    await flush();
    client.emit({ _: 'authorizationStateWaitTdlibParameters' });
    const view = await starting;

    client.emit({ _: 'authorizationStateWaitPassword' });
    await flush();

    expect(client.passwordChecks).toEqual(['stored-pass']);
    const waiting = await service.migrateStatus(
      USER,
      'acc-1',
      view.attemptId,
    );
    expect(waiting.needsPassword).toBeUndefined();
  });
});

describe('TdlibAuthService phone flow', () => {
  it('accepts the code and maps an invalid code', async () => {
    const { service, client } = createHarness();
    const starting = service.start(USER, {
      method: 'phone',
      phone: '+1 555 123 4567',
    });
    await flush();
    client.emit({ _: 'authorizationStateWaitTdlibParameters' });
    const view = await starting;

    expect(view.status).toBe('awaiting_code');
    expect(client.phones).toEqual(['+15551234567']);

    await expect(
      service.submitCode(USER, view.attemptId, '00000'),
    ).rejects.toSatisfy(
      (error: unknown) => responseCode(error) === 'TDLIB_AUTH_FAILED',
    );
    await service.submitCode(USER, view.attemptId, '12345');
    expect(client.codeChecks).toEqual(['00000', '12345']);
  });
});

describe('cloud password storage', () => {
  it('stores, reports and clears the password with cloud:<accountId> AAD', async () => {
    const { service, crypto, account } = createHarness();

    expect(await service.cloudPasswordStatus(USER, 'acc-1')).toEqual({
      stored: false,
    });
    expect(await service.setCloudPassword(USER, 'acc-1', 'my-secret')).toEqual({
      stored: true,
    });

    const envelope = crypto.deserialize(account.cloudPasswordEncrypted as Uint8Array);
    expect(crypto.decrypt(envelope, 'cloud:acc-1').toString('utf8')).toBe(
      'my-secret',
    );

    expect(await service.cloudPasswordStatus(USER, 'acc-1')).toEqual({
      stored: true,
    });
    expect(await service.clearCloudPassword(USER, 'acc-1')).toEqual({
      stored: false,
    });
    expect(account.cloudPasswordEncrypted).toBeNull();
  });
});
