import { ConfigService } from '@nestjs/config';
import { SessionCryptoService } from './session-crypto.service.js';
import { TelegramConfigService } from './telegram.config.js';

function makeService(env: Record<string, unknown> = {}): SessionCryptoService {
  const config = new TelegramConfigService(new ConfigService(env));
  return new SessionCryptoService(config);
}

function flip(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes);
  copy[0] ^= 0xff;
  return copy;
}

describe('SessionCryptoService', () => {
  it('encrypts and decrypts with the matching AAD', () => {
    const crypto = makeService();

    const envelope = crypto.encrypt('mtcute-session-string', 'session:acc_1');
    expect(Buffer.from(envelope.cipher).toString('utf8')).not.toContain(
      'mtcute-session-string',
    );

    const plaintext = crypto.decrypt(envelope, 'session:acc_1').toString('utf8');
    expect(plaintext).toBe('mtcute-session-string');
  });

  it('uses a fresh DEK and nonce for every record', () => {
    const crypto = makeService();

    const a = crypto.encrypt('same', 'session:acc_1');
    const b = crypto.encrypt('same', 'session:acc_1');

    expect(Buffer.from(a.dekWrapped).equals(Buffer.from(b.dekWrapped))).toBe(
      false,
    );
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(Buffer.from(a.cipher).equals(Buffer.from(b.cipher))).toBe(false);
  });

  it('rejects a record decrypted under another AAD', () => {
    const crypto = makeService();
    const envelope = crypto.encrypt('+15551234567', 'phone:acc_1');

    expect(() => crypto.decrypt(envelope, 'phone:acc_2')).toThrow();
    expect(() => crypto.decrypt(envelope, 'session:acc_1')).toThrow();
  });

  it('detects tampering with the ciphertext', () => {
    const crypto = makeService();
    const envelope = crypto.encrypt('payload', 'session:acc_1');

    expect(() =>
      crypto.decrypt({ ...envelope, cipher: flip(envelope.cipher) }, 'session:acc_1'),
    ).toThrow();
  });

  it('detects tampering with nonce, tag and wrapped DEK', () => {
    const crypto = makeService();
    const envelope = crypto.encrypt('payload', 'session:acc_1');

    expect(() =>
      crypto.decrypt({ ...envelope, nonce: flip(envelope.nonce) }, 'session:acc_1'),
    ).toThrow();
    expect(() =>
      crypto.decrypt({ ...envelope, tag: flip(envelope.tag) }, 'session:acc_1'),
    ).toThrow();
    expect(() =>
      crypto.decrypt(
        { ...envelope, dekWrapped: flip(envelope.dekWrapped) },
        'session:acc_1',
      ),
    ).toThrow();
    expect(() =>
      crypto.decrypt({ ...envelope, dekNonce: flip(envelope.dekNonce) }, 'session:acc_1'),
    ).toThrow();
    expect(() =>
      crypto.decrypt({ ...envelope, dekTag: flip(envelope.dekTag) }, 'session:acc_1'),
    ).toThrow();
  });

  it('round-trips the packed envelope used for the account phone number', () => {
    const crypto = makeService();
    const envelope = crypto.encrypt('+15551234567', 'phone:acc_1');

    const packed = crypto.serialize(envelope);
    const unpacked = crypto.deserialize(packed);
    expect(crypto.decrypt(unpacked, 'phone:acc_1').toString('utf8')).toBe(
      '+15551234567',
    );

    const tampered = new Uint8Array(packed);
    tampered[tampered.length - 1] ^= 0x01;
    expect(() => crypto.deserialize(tampered)).toThrow();
  });

  it('accepts a 32-byte base64 master key and rejects other lengths', () => {
    const key = Buffer.alloc(32, 7).toString('base64');
    const config = new TelegramConfigService(
      new ConfigService({ TELEGRAM_SESSION_MASTER_KEY: key }),
    );
    expect(config.sessionMasterKey).toHaveLength(32);

    const broken = new TelegramConfigService(
      new ConfigService({ TELEGRAM_SESSION_MASTER_KEY: 'not-a-key' }),
    );
    expect(() => broken.sessionMasterKey).toThrow();

    const production = new TelegramConfigService(
      new ConfigService({ NODE_ENV: 'production' }),
    );
    expect(() => production.sessionMasterKey).toThrow();
  });
});
