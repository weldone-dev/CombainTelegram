import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

export type ApiMode = 'official' | 'custom';
export type ClientPlatform = 'desktop' | 'mobile' | 'web';

/** Device fields used by `TELEGRAM_API_MODE=custom`. */
export interface CustomDeviceConfig {
  deviceModel: string;
  systemVersion: string;
  appVersion: string;
  langCode: string;
  systemLangCode: string;
  langPack: string;
}

function int(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Reads every Telegram-related setting once.
 *
 * Nothing here talks to Telegram: the service is constructed at boot, but the
 * app must still start without credentials. Missing custom credentials make the
 * service "not configured", which the auth layer turns into `NOT_CONFIGURED`
 * (503) instead of a boot failure.
 */
@Injectable()
export class TelegramConfigService {
  private readonly logger = new Logger(TelegramConfigService.name);
  private readonly config: ConfigService;
  private masterKey?: Buffer;

  readonly mode: ApiMode;
  readonly defaultProfile: string;
  readonly customApiId?: number;
  readonly customApiHash?: string;
  readonly customDevice: CustomDeviceConfig;
  readonly maxAccountsPerUser: number;
  readonly maxSessionsPerAccount: number;
  readonly tmpDir: string;
  readonly defaultUserId: string;
  readonly isConfigured: boolean;

  constructor(config: ConfigService) {
    this.config = config;
    this.mode = config.get('TELEGRAM_API_MODE') === 'custom' ? 'custom' : 'official';
    this.defaultProfile = text(config.get('TELEGRAM_DEFAULT_PROFILE')) ?? 'desktop';

    const apiId = text(config.get<string>('TELEGRAM_API_ID'));
    this.customApiId = apiId ? int(apiId, 0) || undefined : undefined;
    this.customApiHash = text(config.get<string>('TELEGRAM_API_HASH'));

    this.customDevice = {
      deviceModel: text(config.get('TELEGRAM_DEVICE_MODEL')) ?? 'Desktop',
      systemVersion: text(config.get('TELEGRAM_SYSTEM_VERSION')) ?? 'Linux x86_64',
      appVersion: text(config.get('TELEGRAM_APP_VERSION')) ?? '1.0.0',
      langCode: text(config.get('TELEGRAM_LANG_CODE')) ?? 'en',
      systemLangCode:
        text(config.get('TELEGRAM_SYSTEM_LANG_CODE')) ??
        text(config.get('TELEGRAM_LANG_CODE')) ??
        'en',
      langPack: text(config.get('TELEGRAM_LANG_PACK')) ?? '',
    };

    this.maxAccountsPerUser = Math.max(
      1,
      int(config.get('MAX_ACCOUNTS_PER_USER'), 25),
    );
    this.maxSessionsPerAccount = Math.max(
      1,
      int(config.get('MAX_SESSIONS_PER_ACCOUNT'), 10),
    );

    const tmp = text(config.get('TELEGRAM_TMP_DIR'));
    this.tmpDir = tmp
      ? resolve(tmp)
      : join(tmpdir(), 'combain-telegram');
    this.defaultUserId = text(config.get('DEFAULT_USER_ID')) ?? 'local';

    this.isConfigured =
      this.mode === 'official' ||
      (this.customApiId !== undefined && this.customApiHash !== undefined);

    if (this.mode === 'custom' && !this.isConfigured) {
      this.logger.warn(
        'TELEGRAM_API_MODE=custom but TELEGRAM_API_ID / TELEGRAM_API_HASH are missing: Telegram login endpoints will answer NOT_CONFIGURED.',
      );
    }
    if (this.mode === 'official') {
      this.logger.warn(
        'Using official Telegram app API profiles (Telegram Desktop / Android). This violates Telegram API ToS 2.1 (own api_id) and raises ban risk.',
      );
    }
  }

  /**
   * AES-256 master key for session encryption.
   *
   * `TELEGRAM_SESSION_MASTER_KEY` must be 32 bytes, base64 (generate with
   * `openssl rand -base64 32`). Outside production a deterministic development
   * key is used so the app boots without secrets; production fails closed.
   */
  get sessionMasterKey(): Buffer {
    if (this.masterKey) return this.masterKey;

    const raw = text(this.config.get<string>('TELEGRAM_SESSION_MASTER_KEY'));
    if (raw) {
      const key = Buffer.from(raw, 'base64');
      if (key.length !== 32) {
        throw new Error(
          'TELEGRAM_SESSION_MASTER_KEY must be 32 bytes encoded as base64',
        );
      }
      this.masterKey = key;
      return key;
    }

    if (this.config.get('NODE_ENV') === 'production') {
      throw new Error(
        'TELEGRAM_SESSION_MASTER_KEY is required in production (32 bytes, base64)',
      );
    }

    this.logger.warn(
      'TELEGRAM_SESSION_MASTER_KEY is not set; using a deterministic development key',
    );
    this.masterKey = createHash('sha256')
      .update('combain-telegram-development-session-key')
      .digest();
    return this.masterKey;
  }
}
