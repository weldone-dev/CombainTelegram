import { createCipheriv } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { FileLocation } from '@mtcute/node';
import type { TelegramClient, tl } from '@mtcute/node';
import { downloadFileBuffer } from './telegram-download.js';

interface RecordedCall {
  method: Record<string, unknown> & { _: string };
  params: Record<string, unknown> | undefined;
}

type Handler = (
  method: Record<string, unknown> & { _: string },
  params: Record<string, unknown> | undefined,
  calls: RecordedCall[],
) => unknown;

function createClient(handler: Handler): {
  client: TelegramClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client = {
    getPrimaryDcId: async () => 2,
    call: async (
      method: Record<string, unknown> & { _: string },
      params?: Record<string, unknown>,
    ) => {
      calls.push({ method, params });
      return handler(method, params, calls);
    },
  } as unknown as TelegramClient;
  return { client, calls };
}

/** Raw TL file location; the fake client never inspects its fields. */
const LOCATION = {
  _: 'inputFileLocation',
  volumeId: 1n,
  localId: 1,
  secret: 1n,
  fileReference: new Uint8Array([1, 2, 3]),
} as unknown as tl.TypeInputFileLocation;

const KEY = new Uint8Array(32).map((_, index) => index);
const IV = new Uint8Array(16).map((_, index) => 0xa0 + index);

function encryptCtr(plain: Uint8Array): Uint8Array {
  const cipher = createCipheriv('aes-256-ctr', KEY, IV);
  return new Uint8Array(cipher.update(plain));
}

function mediaTooLarge(promise: Promise<unknown>): Promise<HttpException> {
  return promise.then(
    () => {
      throw new Error('expected downloadFileBuffer to reject');
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(HttpException);
      return error as HttpException;
    },
  );
}

describe('downloadFileBuffer', () => {
  it('follows a CDN redirect and decrypts AES-256-CTR chunks', async () => {
    const plain = Buffer.from(
      'Telegram CDN payload that spans more than one request chunk.',
    );
    const encrypted = encryptCtr(plain);
    const partSize = 4096;

    const { client, calls } = createClient((method, _params) => {
      if (method._ === 'upload.getFile') {
        return {
          _: 'upload.fileCdnRedirect',
          dcId: 4,
          fileToken: new Uint8Array([9, 9]),
          encryptionKey: KEY,
          encryptionIv: IV,
          fileHashes: [],
        };
      }
      if (method._ === 'upload.getCdnFile') {
        const offset = Number(method.offset);
        const limit = Number(method.limit);
        return {
          _: 'upload.cdnFile',
          bytes: encrypted.subarray(offset, offset + limit),
        };
      }
      throw new Error(`unexpected method ${method._}`);
    });

    const result = await downloadFileBuffer(
      client,
      new FileLocation(LOCATION, plain.byteLength, 2),
      { partSize },
    );

    expect(result.equals(plain)).toBe(true);
    expect(calls.map((call) => call.method._)).toEqual([
      'upload.getFile',
      'upload.getCdnFile',
    ]);
    // The plain `getFile` call advertises CDN support, the CDN one targets
    // the redirect's DC with the file token.
    expect(calls[0]?.params).toMatchObject({
      dcId: 2,
      kind: 'main',
      maxRetryCount: Infinity,
    });
    expect(calls[0]?.method).toMatchObject({ cdnSupported: true, offset: 0 });
    expect(calls[1]?.params).toMatchObject({ dcId: 4, kind: 'download' });
    expect(calls[1]?.method).toMatchObject({
      fileToken: new Uint8Array([9, 9]),
      offset: 0,
      limit: partSize,
    });
  });

  it('decrypts a multi-chunk CDN stream in order', async () => {
    const plain = new Uint8Array(10_000).map((_, index) => index % 251);
    const encrypted = encryptCtr(plain);
    const partSize = 4096;

    const { client } = createClient((method, _params) => {
      if (method._ === 'upload.getFile') {
        return {
          _: 'upload.fileCdnRedirect',
          dcId: 4,
          fileToken: new Uint8Array([1]),
          encryptionKey: KEY,
          encryptionIv: IV,
          fileHashes: [],
        };
      }
      const offset = Number(method.offset);
      const limit = Number(method.limit);
      return {
        _: 'upload.cdnFile',
        bytes: encrypted.subarray(offset, offset + limit),
      };
    });

    const result = await downloadFileBuffer(
      client,
      new FileLocation(LOCATION, plain.byteLength, 2),
      { partSize },
    );

    expect(result.equals(Buffer.from(plain))).toBe(true);
  });

  it('returns inline Uint8Array locations as a copied buffer', async () => {
    const inline = new Uint8Array([7, 8, 9]);
    const { client, calls } = createClient(() => {
      throw new Error('no network call expected');
    });

    const result = await downloadFileBuffer(
      client,
      new FileLocation(inline),
    );

    expect(result).toEqual(Buffer.from(inline));
    expect(result.buffer).not.toBe(inline.buffer);
    expect(calls).toHaveLength(0);
  });

  it('rejects a known file size over maxBytes before any request', async () => {
    const { client, calls } = createClient(() => {
      throw new Error('no network call expected');
    });

    const error = await mediaTooLarge(
      downloadFileBuffer(client, new FileLocation(LOCATION, 10_000, 2), {
        maxBytes: 1_000,
      }),
    );

    expect(error.getResponse()).toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    expect(calls).toHaveLength(0);
  });

  it('rejects while streaming an unknown-size file over maxBytes', async () => {
    const { client, calls } = createClient((method, _params) => {
      if (method._ !== 'upload.getFile') {
        throw new Error(`unexpected method ${method._}`);
      }
      const offset = Number(method.offset);
      return {
        _: 'upload.file',
        bytes: new Uint8Array(4096).fill(offset === 0 ? 1 : 2),
      };
    });

    const error = await mediaTooLarge(
      downloadFileBuffer(client, LOCATION, {
        maxBytes: 5_000,
        partSize: 4096,
      }),
    );

    expect(error.getResponse()).toMatchObject({ code: 'MEDIA_TOO_LARGE' });
    // The second chunk would push the buffer over the cap.
    expect(calls).toHaveLength(2);
  });

  it('stops an unknown-size file on a short chunk', async () => {
    const { client, calls } = createClient((method, _params) => {
      if (method._ !== 'upload.getFile') {
        throw new Error(`unexpected method ${method._}`);
      }
      const offset = Number(method.offset);
      return {
        _: 'upload.file',
        bytes:
          offset === 0
            ? new Uint8Array(4096).fill(1)
            : new Uint8Array(123).fill(2),
      };
    });

    const result = await downloadFileBuffer(client, LOCATION, {
      partSize: 4096,
    });

    expect(result.byteLength).toBe(4096 + 123);
    expect(result.subarray(0, 2)).toEqual(Buffer.from([1, 1]));
    expect(result.subarray(-1)).toEqual(Buffer.from([2]));
    expect(calls).toHaveLength(2);
  });

  it('retries a reupload once, then fails clearly', async () => {
    const { client, calls } = createClient((method, _params) => {
      if (method._ === 'upload.getFile') {
        return {
          _: 'upload.fileCdnRedirect',
          dcId: 4,
          fileToken: new Uint8Array([5]),
          encryptionKey: KEY,
          encryptionIv: IV,
          fileHashes: [],
        };
      }
      if (method._ === 'upload.getCdnFile') {
        return {
          _: 'upload.cdnFileReuploadNeeded',
          requestToken: new Uint8Array([Number(method.offset ?? 0)]),
        };
      }
      if (method._ === 'upload.reuploadCdnFile') {
        return [];
      }
      throw new Error(`unexpected method ${method._}`);
    });

    const error = await mediaTooLarge(
      downloadFileBuffer(client, new FileLocation(LOCATION, 1_000, 2)),
    );

    expect(error.getResponse()).toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    expect(
      calls.filter((call) => call.method._ === 'upload.reuploadCdnFile'),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.method._ === 'upload.getCdnFile'),
    ).toHaveLength(2);
  });

  it('succeeds after one CDN reupload', async () => {
    const plain = Buffer.from('reuploaded CDN payload');
    const encrypted = encryptCtr(plain);
    let reuploads = 0;

    const { client } = createClient((method, _params) => {
      if (method._ === 'upload.getFile') {
        return {
          _: 'upload.fileCdnRedirect',
          dcId: 4,
          fileToken: new Uint8Array([6]),
          encryptionKey: KEY,
          encryptionIv: IV,
          fileHashes: [],
        };
      }
      if (method._ === 'upload.getCdnFile') {
        if (reuploads === 0) {
          return {
            _: 'upload.cdnFileReuploadNeeded',
            requestToken: new Uint8Array([1]),
          };
        }
        const offset = Number(method.offset);
        const limit = Number(method.limit);
        return {
          _: 'upload.cdnFile',
          bytes: encrypted.subarray(offset, offset + limit),
        };
      }
      if (method._ === 'upload.reuploadCdnFile') {
        reuploads += 1;
        return [];
      }
      throw new Error(`unexpected method ${method._}`);
    });

    const result = await downloadFileBuffer(
      client,
      new FileLocation(LOCATION, plain.byteLength, 2),
    );

    expect(result.equals(plain)).toBe(true);
    expect(reuploads).toBe(1);
  });

  it('retries a chunk on FILE_MIGRATE and switches DC', async () => {
    let migrated = false;
    const { client, calls } = createClient((method, params) => {
      if (method._ !== 'upload.getFile') {
        throw new Error(`unexpected method ${method._}`);
      }
      if (!migrated && params?.dcId === 2) {
        migrated = true;
        throw new Error('Telegram API error 303: FILE_MIGRATE_5');
      }
      return { _: 'upload.file', bytes: new Uint8Array([1, 2, 3]) };
    });

    const result = await downloadFileBuffer(client, LOCATION, {
      partSize: 4096,
    });

    expect(result).toEqual(Buffer.from([1, 2, 3]));
    expect(calls.map((call) => call.params?.dcId)).toEqual([2, 5]);
  });
});
