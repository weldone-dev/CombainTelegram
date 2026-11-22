import { Injectable } from '@nestjs/common';
import { profile } from 'opentele2';
import type { ApiProfile } from 'opentele2';
import { initConnectionOptions } from 'opentele2/mtcute';
import type { InitConnectionOptions } from 'opentele2/mtcute';
import type { ClientPlatform } from './telegram.config.js';
import { TelegramConfigService } from './telegram.config.js';
import { apiError, notConfigured } from '../common/api-error.js';

/** Public profile keys accepted by every auth endpoint. */
const PROFILES = {
  desktop: 'TelegramDesktop',
  mobile: 'TelegramAndroid',
  'android-x': 'TelegramAndroidX',
  ios: 'TelegramIOS',
  macos: 'TelegramMacOS',
  'web-a': 'TelegramWeb_A',
  'web-k': 'TelegramWeb_K',
  webogram: 'Webogram',
} as const;

export type ProfileKey = keyof typeof PROFILES;

export const PROFILE_KEYS = Object.keys(PROFILES) as ProfileKey[];

export interface ResolvedProfile {
  key: ProfileKey;
  platform: ClientPlatform;
  /** opentele2 API profile: api id/hash + initConnection device fields. */
  api: ApiProfile;
  /** Ready-made `initConnectionOptions` for `@mtcute/node`. */
  init: InitConnectionOptions;
}

const PLATFORM: Record<ProfileKey, ClientPlatform> = {
  desktop: 'desktop',
  mobile: 'mobile',
  'android-x': 'mobile',
  ios: 'mobile',
  macos: 'desktop',
  'web-a': 'web',
  'web-k': 'web',
  webogram: 'web',
};

/**
 * Turns a profile key (`desktop`, `mobile`, ...) into concrete API credentials
 * and `initConnection` device fields.
 *
 * `TELEGRAM_API_MODE=official` (default) uses opentele2's bundled official
 * client profiles. `custom` uses the operator's own `api_id` / `api_hash` plus
 * `TELEGRAM_DEVICE_*` fields.
 */
@Injectable()
export class ClientProfileService {
  private readonly cache = new Map<string, ResolvedProfile>();

  constructor(private readonly config: TelegramConfigService) {}

  resolve(key?: string): ResolvedProfile {
    if (!this.config.isConfigured) throw notConfigured();

    const requested = key ?? this.config.defaultProfile;
    if (!(requested in PROFILES)) {
      throw apiError(
        'PROFILE_UNKNOWN',
        `Unknown client profile "${String(requested)}"`,
        400,
        { details: { allowed: PROFILE_KEYS } },
      );
    }

    const profileKey = requested as ProfileKey;
    const cacheKey = `${this.config.mode}:${profileKey}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const api = this.buildApiProfile(profileKey);
    const resolved: ResolvedProfile = {
      key: profileKey,
      platform: PLATFORM[profileKey],
      api,
      init: initConnectionOptions(api),
    };
    this.cache.set(cacheKey, resolved);
    return resolved;
  }

  /**
   * Telegram Desktop's official profile, used when reading tdata: the auth key
   * in a `tdata` folder was created with Telegram Desktop's own api id, so the
   * matching credentials must be presented to Telegram regardless of
   * `TELEGRAM_API_MODE`.
   */
  resolveTdataProfile(): ResolvedProfile {
    const cacheKey = 'tdata:TelegramDesktop';
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const api = profile('TelegramDesktop');
    const resolved: ResolvedProfile = {
      key: 'desktop',
      platform: 'desktop',
      api,
      init: initConnectionOptions(api),
    };
    this.cache.set(cacheKey, resolved);
    return resolved;
  }

  private buildApiProfile(key: ProfileKey): ApiProfile {
    if (this.config.mode === 'custom') {
      const apiId = this.config.customApiId;
      const apiHash = this.config.customApiHash;
      if (apiId === undefined || apiHash === undefined) {
        throw notConfigured();
      }
      const device = this.config.customDevice;
      return {
        apiId,
        apiHash,
        deviceModel: device.deviceModel,
        systemVersion: device.systemVersion,
        appVersion: device.appVersion,
        langCode: device.langCode,
        systemLangCode: device.systemLangCode,
        langPack: device.langPack,
      };
    }

    return profile(PROFILES[key]);
  }
}
