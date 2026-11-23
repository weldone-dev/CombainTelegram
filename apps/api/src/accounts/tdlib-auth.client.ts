import { Injectable } from '@nestjs/common';
import type { Client } from 'tdlib-native';
import type {
  AuthorizationState,
  Update,
  setTdlibParameters$Input,
} from 'tdlib-native/types';
import { TdClientManagerService } from '../tdlib/td-client-manager.service.js';
import type { TdlibDirectories } from '../tdlib/td-client-manager.service.js';

/**
 * The slice of a TDLib authorization state the login flows care about.
 *
 * TDLib types use `_` discriminants plus snake_case fields; this structural
 * shape keeps the state machine testable with a fake client and survives
 * TDLib versions that add more states.
 */
export interface TdlibAuthState {
  _: string;
  /** `tg://login?token=...`, only on `authorizationStateWaitOtherDeviceConfirmation`. */
  link?: string;
}

/** The Telegram side of a TDLib-authorized user, normalized to camelCase. */
export interface TdlibAuthUser {
  id: number;
  firstName: string;
  lastName: string | null;
  username: string | null;
  phone: string | null;
}

export interface TdlibProxyInput {
  server: string;
  port: number;
  kind: 'http' | 'https' | 'socks5';
  username?: string | null;
  secret?: string | null;
  comment?: string;
}

/**
 * Everything the login state machine needs from one TDLib client.
 *
 * Deliberately narrow: no TDLib type leaks into the flow logic, so a fake
 * implementation can drive every auth state in unit tests.
 */
export interface TdlibAuthClient {
  start(): Promise<void>;
  onAuthorizationState(handler: (state: TdlibAuthState) => void): () => void;
  setTdlibParameters(parameters: setTdlibParameters$Input): Promise<void>;
  requestQrCodeAuthentication(): Promise<void>;
  setAuthenticationPhoneNumber(phone: string): Promise<void>;
  checkAuthenticationCode(code: string): Promise<void>;
  checkAuthenticationPassword(password: string): Promise<void>;
  setProxy(proxy: TdlibProxyInput): Promise<void>;
  getMe(): Promise<TdlibAuthUser>;
  destroy(): Promise<void>;
}

/** Thin adapter from `tdlib-native`'s `Client` to `TdlibAuthClient`. */
export class NativeTdlibAuthClient implements TdlibAuthClient {
  private readonly subscriptions: Array<() => void> = [];

  constructor(private readonly client: Client) {}

  start(): Promise<void> {
    return this.client.start();
  }

  onAuthorizationState(handler: (state: TdlibAuthState) => void): () => void {
    const unsubscribe = this.client.updates.subscribe((update: Update) => {
      if (update._ !== 'updateAuthorizationState') return;
      const state = update.authorization_state as AuthorizationState;
      handler(state);
    });
    this.subscriptions.push(unsubscribe);
    return () => {
      unsubscribe();
      const index = this.subscriptions.indexOf(unsubscribe);
      if (index >= 0) this.subscriptions.splice(index, 1);
    };
  }

  async setTdlibParameters(
    parameters: setTdlibParameters$Input,
  ): Promise<void> {
    await this.client.api.setTdlibParameters(parameters);
  }

  async requestQrCodeAuthentication(): Promise<void> {
    await this.client.api.requestQrCodeAuthentication({ other_user_ids: [] });
  }

  async setAuthenticationPhoneNumber(phone: string): Promise<void> {
    await this.client.api.setAuthenticationPhoneNumber({
      phone_number: phone,
      settings: { _: 'phoneNumberAuthenticationSettings' },
    });
  }

  async checkAuthenticationCode(code: string): Promise<void> {
    await this.client.api.checkAuthenticationCode({ code });
  }

  async checkAuthenticationPassword(password: string): Promise<void> {
    await this.client.api.checkAuthenticationPassword({ password });
  }

  async setProxy(proxy: TdlibProxyInput): Promise<void> {
    const type =
      proxy.kind === 'socks5'
        ? ({
            _: 'proxyTypeSocks5',
            username: proxy.username ?? '',
            password: proxy.secret ?? '',
          } as const)
        : ({
            _: 'proxyTypeHttp',
            username: proxy.username ?? '',
            password: proxy.secret ?? '',
            http_only: proxy.kind === 'http',
          } as const);

    await this.client.api.addProxy({
      proxy: {
        _: 'proxy',
        server: proxy.server,
        port: proxy.port,
        type,
      },
      enable: true,
      comment: proxy.comment ?? '',
    });
  }

  async getMe(): Promise<TdlibAuthUser> {
    const me = await this.client.api.getMe({});
    const usernames = me.usernames;
    return {
      id: Number(me.id),
      firstName: me.first_name,
      lastName: me.last_name || null,
      username:
        usernames?.editable_username ||
        usernames?.active_usernames[0] ||
        null,
      phone: me.phone_number || null,
    };
  }

  destroy(): Promise<void> {
    for (const unsubscribe of this.subscriptions.splice(0)) {
      unsubscribe();
    }
    return this.client.destroy();
  }
}

/**
 * Creates the TDLib client behind a login attempt. Split from the service so
 * tests inject a fake client and never load the native addon.
 */
@Injectable()
export class TdlibAuthClientFactory {
  constructor(private readonly tdClients: TdClientManagerService) {}

  async create(directories: TdlibDirectories): Promise<TdlibAuthClient> {
    const client = await this.tdClients.create(directories);
    return new NativeTdlibAuthClient(client);
  }
}
