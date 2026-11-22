import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProfileService } from './client-profile.service.js';
import { TelegramConfigService } from './telegram.config.js';

function makeProfileService(env: Record<string, unknown> = {}): ClientProfileService {
  return new ClientProfileService(new TelegramConfigService(new ConfigService(env)));
}

describe('ClientProfileService', () => {
  it('resolves the official desktop profile', () => {
    const profiles = makeProfileService();
    const desktop = profiles.resolve('desktop');

    expect(desktop.key).toBe('desktop');
    expect(desktop.platform).toBe('desktop');
    expect(desktop.api.apiId).toBe(2040);
    expect(desktop.api.deviceModel).toBe('Desktop');
    expect(desktop.init.deviceModel).toBe('Desktop');
  });

  it('resolves the official mobile profile', () => {
    const profiles = makeProfileService();
    const mobile = profiles.resolve('mobile');

    expect(mobile.key).toBe('mobile');
    expect(mobile.platform).toBe('mobile');
    expect(mobile.api.apiId).toBe(6);
    expect(mobile.api.langPack).toBe('android');
    expect(mobile.init.langPack).toBe('android');
  });

  it('uses TELEGRAM_DEFAULT_PROFILE when no key is passed', () => {
    const profiles = makeProfileService({ TELEGRAM_DEFAULT_PROFILE: 'mobile' });
    expect(profiles.resolve().key).toBe('mobile');
  });

  it('rejects an unknown profile with 400 PROFILE_UNKNOWN', () => {
    const profiles = makeProfileService();

    try {
      profiles.resolve('blackberry');
      throw new Error('expected PROFILES to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const http = error as HttpException;
      expect(http.getStatus()).toBe(400);
      const body = http.getResponse() as { code: string; details?: unknown };
      expect(body.code).toBe('PROFILE_UNKNOWN');
    }
  });

  it('uses custom credentials and device fields in custom mode', () => {
    const profiles = makeProfileService({
      TELEGRAM_API_MODE: 'custom',
      TELEGRAM_API_ID: '123456',
      TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef',
      TELEGRAM_DEVICE_MODEL: 'CombainBox',
      TELEGRAM_SYSTEM_VERSION: 'Linux 6.9',
      TELEGRAM_APP_VERSION: '2.4.0',
      TELEGRAM_LANG_CODE: 'de',
    });

    const resolved = profiles.resolve('mobile');
    expect(resolved.api.apiId).toBe(123456);
    expect(resolved.api.apiHash).toBe('0123456789abcdef0123456789abcdef');
    expect(resolved.api.deviceModel).toBe('CombainBox');
    expect(resolved.api.systemVersion).toBe('Linux 6.9');
    expect(resolved.api.appVersion).toBe('2.4.0');
    expect(resolved.api.langCode).toBe('de');
    expect(resolved.init.deviceModel).toBe('CombainBox');
  });

  it('answers 503 NOT_CONFIGURED when custom credentials are missing', () => {
    const profiles = makeProfileService({ TELEGRAM_API_MODE: 'custom' });

    try {
      profiles.resolve('desktop');
      throw new Error('expected NOT_CONFIGURED');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const http = error as HttpException;
      expect(http.getStatus()).toBe(503);
      expect((http.getResponse() as { code: string }).code).toBe(
        'NOT_CONFIGURED',
      );
    }
  });

  it('always exposes the Telegram Desktop profile for tdata import', () => {
    const profiles = makeProfileService({
      TELEGRAM_API_MODE: 'custom',
      TELEGRAM_API_ID: '123456',
      TELEGRAM_API_HASH: '0123456789abcdef0123456789abcdef',
    });

    const desktop = profiles.resolveTdataProfile();
    expect(desktop.api.apiId).toBe(2040);
  });
});
