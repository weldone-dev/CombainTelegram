import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import {
  decodeBase64Url,
  parseQrLoginToken,
  QR_LOGIN_PREFIX,
} from './qr-token.js';

/** 32-byte token, what Telegram actually puts into a QR link. */
const TOKEN = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
const TOKEN_B64 = TOKEN.toString('base64url');

describe('decodeBase64Url', () => {
  it('decodes unpadded base64url', () => {
    expect(Buffer.from(decodeBase64Url(TOKEN_B64))).toEqual(TOKEN);
  });

  it('accepts padded base64url', () => {
    expect(Buffer.from(decodeBase64Url(`${TOKEN_B64}==`))).toEqual(TOKEN);
  });

  it('rejects empty, non-base64url and non-canonical input', () => {
    expect(() => decodeBase64Url('')).toThrow(/empty/);
    expect(() => decodeBase64Url('not base64url!')).toThrow(/base64url/);
    // 'a' alone decodes to zero bits, which must not become a bogus token.
    expect(() => decodeBase64Url('a')).toThrow(/canonical|zero bytes/);
  });
});

describe('parseQrLoginToken', () => {
  it('parses tg://login?token=...', () => {
    const parsed = parseQrLoginToken(`${QR_LOGIN_PREFIX}${TOKEN_B64}`);
    expect(parsed.base64url).toBe(TOKEN_B64);
    expect(Buffer.from(parsed.token)).toEqual(TOKEN);
  });

  it('ignores extra query parameters', () => {
    const parsed = parseQrLoginToken(
      `tg://login?foo=bar&token=${TOKEN_B64}&dc=2`,
    );
    expect(Buffer.from(parsed.token)).toEqual(TOKEN);
  });

  it('rejects a link of the wrong shape', () => {
    expect(() => parseQrLoginToken('')).toThrow(/empty/);
    expect(() => parseQrLoginToken('https://example.com/?token=abc')).toThrow(
      /tg:\/\/login/,
    );
    expect(() => parseQrLoginToken('tg://login?token=')).toThrow(/no token/);
    expect(() => parseQrLoginToken(`tg://login?token=${TOKEN_B64}!`)).toThrow(
      /base64url/,
    );
  });

  it('rejects a token with an implausible length', () => {
    const short = Buffer.alloc(8, 7).toString('base64url');
    expect(() => parseQrLoginToken(`${QR_LOGIN_PREFIX}${short}`)).toThrow(
      /length/,
    );
  });
});
