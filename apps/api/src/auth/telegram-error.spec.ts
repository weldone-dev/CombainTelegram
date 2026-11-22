import { HttpException } from '@nestjs/common';
import { tl } from '@mtcute/node';
import { setLogSink } from '../logs/log-sink.js';
import { mapTelegramError, raiseTelegramError } from './telegram-error.js';

function rpc(code: number, text: string): tl.RpcError {
  return new tl.RpcError(code, text as never);
}

describe('Telegram error mapping', () => {
  it('maps FLOOD_WAIT_X to FLOOD_WAIT with retryAfter', () => {
    const mapped = mapTelegramError(rpc(420, 'FLOOD_WAIT_42'));
    expect(mapped.code).toBe('FLOOD_WAIT');
    expect(mapped.status).toBe(429);
    expect(mapped.retryAfter).toBe(42);

    const premium = mapTelegramError(rpc(420, 'FLOOD_PREMIUM_WAIT_7'));
    expect(premium.retryAfter).toBe(7);
  });

  it.each([
    ['PHONE_CODE_INVALID', 'CODE_INVALID', 400],
    ['PHONE_CODE_EMPTY', 'CODE_INVALID', 400],
    ['PHONE_CODE_EXPIRED', 'CODE_EXPIRED', 400],
    ['PHONE_NUMBER_INVALID', 'PHONE_INVALID', 400],
    ['PHONE_NUMBER_BANNED', 'PHONE_BANNED', 403],
    ['PHONE_NUMBER_FLOOD', 'PHONE_FLOOD', 429],
    ['SESSION_PASSWORD_NEEDED', 'PASSWORD_REQUIRED', 400],
    ['PASSWORD_HASH_INVALID', 'PASSWORD_INVALID', 400],
    ['SIGN_UP_REQUIRED', 'SIGNUP_REQUIRED', 400],
    ['CHAT_WRITE_FORBIDDEN', 'CHAT_WRITE_FORBIDDEN', 403],
    ['CHAT_ADMIN_REQUIRED', 'CHAT_ADMIN_REQUIRED', 403],
    ['CHANNEL_PRIVATE', 'CHANNEL_PRIVATE', 403],
    ['CHAT_FORBIDDEN', 'CHAT_FORBIDDEN', 403],
    ['CHAT_RESTRICTED', 'CHAT_RESTRICTED', 403],
    ['CHAT_SEND_MEDIA_FORBIDDEN', 'CHAT_SEND_MEDIA_FORBIDDEN', 403],
    ['USER_BANNED_IN_CHANNEL', 'USER_BANNED_IN_CHANNEL', 403],
    ['MESSAGE_ID_INVALID', 'MESSAGE_ID_INVALID', 400],
    ['MESSAGE_EDIT_TIME_EXPIRED', 'MESSAGE_EDIT_TIME_EXPIRED', 400],
    ['PEER_ID_INVALID', 'PEER_ID_INVALID', 400],
  ])('maps %s to %s', (telegramText, expectedCode, expectedStatus) => {
    const mapped = mapTelegramError(rpc(400, telegramText));
    expect(mapped.code).toBe(expectedCode);
    expect(mapped.status).toBe(expectedStatus);
  });

  it('keeps an unknown RPC error opaque', () => {
    const mapped = mapTelegramError(rpc(400, 'SOMETHING_NEW_FROM_TELEGRAM'));
    expect(mapped.code).toBe('TELEGRAM_ERROR');
    expect(mapped.status).toBe(502);
    expect(mapped.message).not.toContain('api_hash');
  });

  it('maps opentele2 flow errors by their code', () => {
    expect(
      mapTelegramError({ code: 'OT_NO_PASSWORD_PROVIDED', message: 'x' }).code,
    ).toBe('PASSWORD_REQUIRED');
    expect(
      mapTelegramError({ code: 'OT_PASSWORD_INCORRECT', message: 'x' }).code,
    ).toBe('PASSWORD_INVALID');
    expect(
      mapTelegramError({ code: 'OT_SIGN_UP_REQUIRED', message: 'x' }).code,
    ).toBe('SIGNUP_REQUIRED');
    expect(
      mapTelegramError({ code: 'OT_TDATA_LOAD_FAILED_PASSCODE', message: 'x' })
        .code,
    ).toBe('TDATA_BAD_PASSCODE');
  });

  it('falls back to TELEGRAM_ERROR for plain errors', () => {
    const mapped = mapTelegramError(new Error('socket hang up'));
    expect(mapped.code).toBe('TELEGRAM_ERROR');
    expect(mapped.status).toBe(502);
  });

  it('raiseTelegramError throws the { code, message } body', () => {
    try {
      raiseTelegramError(rpc(420, 'FLOOD_WAIT_3'));
      throw new Error('expected raiseTelegramError to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const http = error as HttpException;
      expect(http.getStatus()).toBe(429);
      expect(http.getResponse()).toMatchObject({
        code: 'FLOOD_WAIT',
        retryAfter: 3,
      });
    }
  });

  it('raiseTelegramError logs the raw Telegram response', () => {
    const entries: Array<Record<string, unknown>> = [];
    setLogSink((entry) => entries.push(entry as never));
    try {
      expect(() =>
        raiseTelegramError(rpc(400, 'SOMETHING_UNMAPPED')),
      ).toThrow();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        source: 'telegram',
        telegramError: 'SOMETHING_UNMAPPED',
        errorCode: 'TELEGRAM_ERROR',
      });
      expect(entries[0]?.telegramResponse).toMatchObject({ code: 400 });
    } finally {
      setLogSink(null);
    }
  });
});
