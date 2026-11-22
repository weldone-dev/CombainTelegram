import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { TelegramConfigService } from './telegram.config.js';

const KEY_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM envelope stored in `TelegramSession` / `TelegramAccount`. */
export interface EncryptedPayload {
  cipher: Uint8Array<ArrayBuffer>;
  nonce: Uint8Array<ArrayBuffer>;
  tag: Uint8Array<ArrayBuffer>;
  dekWrapped: Uint8Array<ArrayBuffer>;
  dekNonce: Uint8Array<ArrayBuffer>;
  dekTag: Uint8Array<ArrayBuffer>;
  keyVersion: number;
}

/** Copies a node Buffer into a plain `Uint8Array<ArrayBuffer>` (Prisma Bytes). */
function bytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

/**
 * Envelope encryption for secrets at rest.
 *
 * Every record gets a random 32-byte DEK. The payload is encrypted with that
 * DEK (AES-256-GCM); the DEK is wrapped with the master key (AES-256-GCM) and
 * the envelope stores the wrapped DEK plus both nonces/tags.
 *
 * `aad` binds the record to its owner: `session:<accountId>` for session keys,
 * `phone:<accountId>` for the encrypted phone number. Moving a blob to another
 * account makes decryption fail.
 */
@Injectable()
export class SessionCryptoService {
  constructor(private readonly config: TelegramConfigService) {}

  encrypt(plaintext: string | Uint8Array, aad: string): EncryptedPayload {
    const data =
      typeof plaintext === 'string'
        ? Buffer.from(plaintext, 'utf8')
        : Buffer.from(plaintext);
    const dek = randomBytes(KEY_BYTES);
    const nonce = randomBytes(NONCE_BYTES);

    const cipher = createCipheriv(ALGORITHM, dek, nonce);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();

    const dekNonce = randomBytes(NONCE_BYTES);
    const wrapCipher = createCipheriv(
      ALGORITHM,
      this.config.sessionMasterKey,
      dekNonce,
    );
    wrapCipher.setAAD(Buffer.from(this.wrapAad(aad), 'utf8'));
    const dekWrapped = Buffer.concat([wrapCipher.update(dek), wrapCipher.final()]);
    const dekTag = wrapCipher.getAuthTag();

    return {
      cipher: bytes(encrypted),
      nonce: bytes(nonce),
      tag: bytes(tag),
      dekWrapped: bytes(dekWrapped),
      dekNonce: bytes(dekNonce),
      dekTag: bytes(dekTag),
      keyVersion: KEY_VERSION,
    };
  }

  decrypt(payload: EncryptedPayload, aad: string): Buffer {
    if (payload.keyVersion !== KEY_VERSION) {
      throw new Error(`Unsupported session key version ${payload.keyVersion}`);
    }

    if (
      payload.nonce.length !== NONCE_BYTES ||
      payload.tag.length !== TAG_BYTES ||
      payload.dekNonce.length !== NONCE_BYTES ||
      payload.dekTag.length !== TAG_BYTES ||
      payload.dekWrapped.length !== KEY_BYTES
    ) {
      throw new Error('Malformed encrypted session payload');
    }

    let dek: Buffer;
    try {
      const unwrap = createDecipheriv(
        ALGORITHM,
        this.config.sessionMasterKey,
        payload.dekNonce,
      );
      unwrap.setAAD(Buffer.from(this.wrapAad(aad), 'utf8'));
      unwrap.setAuthTag(payload.dekTag);
      dek = Buffer.concat([unwrap.update(payload.dekWrapped), unwrap.final()]);
    } catch {
      throw new Error('Session key unwrap failed');
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, dek, payload.nonce);
      decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(payload.tag);
      return Buffer.concat([decipher.update(payload.cipher), decipher.final()]);
    } finally {
      dek.fill(0);
    }
  }

  /**
   * Packs an envelope into one opaque byte blob. Used where the schema has no
   * dedicated DEK columns (the encrypted account phone number).
   */
  serialize(payload: EncryptedPayload): Uint8Array<ArrayBuffer> {
    return new Uint8Array(Buffer.from(
      JSON.stringify({
        v: payload.keyVersion,
        cipher: Buffer.from(payload.cipher).toString('base64'),
        nonce: Buffer.from(payload.nonce).toString('base64'),
        tag: Buffer.from(payload.tag).toString('base64'),
        dekWrapped: Buffer.from(payload.dekWrapped).toString('base64'),
        dekNonce: Buffer.from(payload.dekNonce).toString('base64'),
        dekTag: Buffer.from(payload.dekTag).toString('base64'),
      }),
      'utf8',
    ));
  }

  deserialize(blob: Uint8Array): EncryptedPayload {
    const parsed = JSON.parse(Buffer.from(blob).toString('utf8')) as Record<
      string,
      unknown
    >;
    const read = (value: unknown): Uint8Array<ArrayBuffer> => {
      if (typeof value !== 'string') throw new Error('bad envelope');
      return new Uint8Array(Buffer.from(value, 'base64'));
    };
    const keyVersion = parsed.v;
    if (typeof keyVersion !== 'number') throw new Error('bad envelope');

    return {
      keyVersion,
      cipher: read(parsed.cipher),
      nonce: read(parsed.nonce),
      tag: read(parsed.tag),
      dekWrapped: read(parsed.dekWrapped),
      dekNonce: read(parsed.dekNonce),
      dekTag: read(parsed.dekTag),
    };
  }

  /** Constant-time comparison helper for callers/tests that compare tags. */
  static equal(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  private wrapAad(aad: string): string {
    return `${aad}|dek:v${KEY_VERSION}`;
  }
}
