import { createDecipheriv } from 'node:crypto';
import { FileLocation, tl, type TelegramClient } from '@mtcute/node';
import { apiError } from '../common/api-error.js';
import { MAX_MEDIA_BYTES, assertMediaDownloadSize } from './media.js';

/**
 * Telegram serves files above a size threshold through a separate CDN DC and
 * answers `upload.getFile` with `upload.fileCdnRedirect`. mtcute 0.32 raises
 * `MtUnsupportedError` for that answer, so large documents, photos and some
 * avatars could not be downloaded at all.
 *
 * This helper implements the CDN part of the protocol: it follows the
 * redirect, fetches `upload.getCdnFile` chunks from the CDN DC and decrypts
 * them with AES-256-CTR using the key/IV from the redirect.
 *
 * References: https://core.telegram.org/cdn and tdesktop's
 * `storage/download_manager.cpp`.
 */
export interface DownloadOptions {
  /** Reject before/while buffering more than this many bytes. */
  maxBytes?: number;
  /** Part size in bytes, default 512 KiB, capped at 1 MiB. */
  partSize?: number;
}

/** `upload.getFile` refuses offsets/limits that are not a multiple of 4 KiB. */
const OFFSET_ALIGNMENT = 4096;
/** Telegram's per-request maximum for both `getFile` and `getCdnFile`. */
const MAX_PART_SIZE = 1024 * 1024;
const DEFAULT_PART_SIZE = 512 * 1024;
/** mtcute uses the small connection pool for files up to this size. */
const SMALL_FILE_MAX_SIZE = 128 * 1024;
/** How often a CDN reupload may restart the whole download. */
const MAX_REUPLOADS = 1;

type DownloadClient = Pick<TelegramClient, 'call'> & {
  getPrimaryDcId: () => Promise<number>;
};

type DownloadKind = 'main' | 'download' | 'downloadSmall';

interface NormalizedLocation {
  location: tl.TypeInputFileLocation;
  fileSize?: number;
  dcId?: number;
}

interface UploadFileAnswer {
  _: 'upload.file';
  bytes: Uint8Array;
}

interface CdnRedirectAnswer {
  _: 'upload.fileCdnRedirect';
  dcId: number;
  fileToken: Uint8Array;
  encryptionKey: Uint8Array;
  encryptionIv: Uint8Array;
}

interface CdnFileAnswer {
  _: 'upload.cdnFile';
  bytes: Uint8Array;
}

interface CdnReuploadAnswer {
  _: 'upload.cdnFileReuploadNeeded';
  requestToken: Uint8Array;
}

type GetFileAnswer =
  | UploadFileAnswer
  | CdnRedirectAnswer
  | { _: 'upload.webFile'; size: number; bytes: Uint8Array };

type CdnAnswer = CdnFileAnswer | CdnReuploadAnswer;

/** Normalizes mtcute's `FileLocation` wrapper and raw TL locations. */
async function normalizeLocation(
  input: FileLocation | tl.TypeInputFileLocation,
): Promise<NormalizedLocation | Uint8Array> {
  if (input instanceof FileLocation) {
    const inner =
      typeof input.location === 'function'
        ? input.location()
        : input.location;
    if (inner instanceof Uint8Array) return inner;
    // Web file locations are not used by messaging; reject them clearly.
    if (inner._.startsWith('inputWebFile')) {
      throw apiError(
        'MEDIA_NOT_FOUND',
        'This media location cannot be downloaded over MTProto',
      );
    }
    return {
      location: inner as tl.TypeInputFileLocation,
      fileSize: input.fileSize,
      dcId: input.dcId,
    };
  }
  return { location: input };
}

function partSizeFor(options: DownloadOptions): number {
  const requested = options.partSize ?? DEFAULT_PART_SIZE;
  if (!Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PART_SIZE;
  }
  const capped = Math.min(Math.floor(requested), MAX_PART_SIZE);
  return Math.max(
    OFFSET_ALIGNMENT,
    Math.floor(capped / OFFSET_ALIGNMENT) * OFFSET_ALIGNMENT,
  );
}

function mediaTooLarge(size: number, limit: number): Error {
  return apiError(
    'MEDIA_TOO_LARGE',
    `media must be at most ${limit} bytes`,
    413,
    { details: { size, limit } },
  );
}

/** Enforces both the caller's cap and the app-wide download limit. */
function assertWithinLimits(size: number | undefined, limit: number): void {
  if (typeof size !== 'number' || !Number.isFinite(size)) return;
  assertMediaDownloadSize(size);
  if (size > limit) throw mediaTooLarge(size, limit);
}

/** DC to retry on for `FILE_MIGRATE_%d`, or `null` for other errors. */
function migratedDc(error: unknown): number | null {
  if (tl.RpcError.is(error) && error.is('FILE_MIGRATE_%d')) {
    return error.newDc ?? null;
  }
  const match =
    error instanceof Error ? /FILE_MIGRATE_(\d+)/.exec(error.message) : null;
  return match ? Number(match[1]) : null;
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw apiError('MEDIA_NOT_FOUND', 'Telegram returned malformed file data');
}

interface ChunkRequest {
  method: Record<string, unknown> & { _: string };
  dcId: number | undefined;
  kind: DownloadKind;
}

/**
 * Calls one `upload.getFile`/`upload.getCdnFile` chunk and retries it on
 * another DC when Telegram answers `FILE_MIGRATE_%d`.
 */
async function callChunk<T>(
  client: DownloadClient,
  request: ChunkRequest,
  setDc: (dcId: number) => void,
): Promise<T> {
  for (;;) {
    try {
      return (await client.call(request.method as unknown as tl.RpcMethod, {
        dcId: request.dcId,
        kind: request.kind,
        maxRetryCount: Infinity,
        floodSleepThreshold: Infinity,
      })) as T;
    } catch (error) {
      const dc = migratedDc(error);
      if (dc === null) throw error;
      setDc(dc);
      request = { ...request, dcId: dc };
    }
  }
}

/** Marker returned by {@link downloadOnce} when the CDN wants a reupload. */
const REUPLOAD = Symbol('cdn-reupload');

interface DownloadAttempt {
  normalized: NormalizedLocation;
  size: number | undefined;
  limit: number;
  partSize: number;
  dcId: number;
  isSmall: boolean;
  client: DownloadClient;
}

/**
 * One sequential pass over the file, from offset 0. Returns the buffer, or
 * {@link REUPLOAD} when Telegram asked the main DC to push the file to the CDN
 * again (the caller then restarts this pass with a fresh AES-CTR state).
 */
async function downloadOnce(
  attempt: DownloadAttempt,
  allowReupload: boolean,
): Promise<Buffer | typeof REUPLOAD> {
  const { normalized, size, limit, partSize, isSmall, client } = attempt;
  let { dcId } = attempt;
  let kind: DownloadKind = isSmall
    ? dcId === (await client.getPrimaryDcId())
      ? 'main'
      : 'downloadSmall'
    : 'download';

  const chunks: Buffer[] = [];
  let received = 0;
  let offset = 0;
  let cdn: CdnRedirectAnswer | null = null;
  let decipher: ReturnType<typeof createDecipheriv> | null = null;

  for (;;) {
    if (typeof size === 'number' && offset >= size) break;
    const remaining = typeof size === 'number' ? size - offset : partSize;
    // Round the last partial chunk up to the required 4 KiB alignment; the
    // server never returns more than the remaining bytes.
    const requestSize = Math.min(
      partSize,
      Math.max(
        OFFSET_ALIGNMENT,
        Math.ceil(remaining / OFFSET_ALIGNMENT) * OFFSET_ALIGNMENT,
      ),
    );

    let bytes: Uint8Array;

    if (cdn) {
      const redirect = cdn;
      const answer = await callChunk<CdnAnswer>(
        client,
        {
          method: {
            _: 'upload.getCdnFile',
            fileToken: redirect.fileToken,
            offset,
            limit: requestSize,
          },
          dcId: redirect.dcId,
          kind: 'download',
        },
        (newDc) => {
          redirect.dcId = newDc;
        },
      );

      if (answer._ === 'upload.cdnFileReuploadNeeded') {
        if (!allowReupload) {
          throw apiError(
            'MEDIA_NOT_FOUND',
            'Telegram CDN asked for the file to be reuploaded more than once',
          );
        }
        // The CDN dropped the file; ask the main DC to re-upload it. The
        // caller restarts from offset 0 with a fresh cipher.
        await callChunk<unknown>(
          client,
          {
            method: {
              _: 'upload.reuploadCdnFile',
              fileToken: redirect.fileToken,
              requestToken: answer.requestToken,
            },
            dcId: redirect.dcId,
            kind: 'download',
          },
          (newDc) => {
            redirect.dcId = newDc;
          },
        );
        return REUPLOAD;
      }

      decipher ??= createDecipheriv(
        'aes-256-ctr',
        asBytes(redirect.encryptionKey),
        asBytes(redirect.encryptionIv),
      );
      // AES-256-CTR is a whole-file stream: chunks must be fed strictly in
      // order, which the sequential offset loop guarantees.
      bytes = asBytes(decipher.update(asBytes(answer.bytes)));
    } else {
      const answer = await callChunk<GetFileAnswer>(
        client,
        {
          method: {
            _: 'upload.getFile',
            location: normalized.location,
            offset,
            limit: requestSize,
            cdnSupported: true,
          },
          dcId,
          kind,
        },
        (newDc) => {
          dcId = newDc;
          kind = isSmall ? 'downloadSmall' : 'download';
        },
      );

      if (answer._ === 'upload.fileCdnRedirect') {
        cdn = answer;
        // The encryption stream starts at file offset 0, so a redirect that
        // arrives mid-file restarts the download from the beginning.
        if (received > 0) {
          chunks.length = 0;
          received = 0;
          offset = 0;
        }
        continue;
      }
      bytes = asBytes(answer.bytes);
    }

    const chunk = Buffer.from(bytes);
    const next = received + chunk.byteLength;
    if (next > limit) throw mediaTooLarge(next, limit);
    chunks.push(chunk);
    received = next;
    offset += chunk.byteLength;

    // A short chunk means the file ended (the only signal when the size is
    // unknown). Telegram may also send more than `fileSize`; stop there.
    if (chunk.byteLength < requestSize) break;
  }

  return Buffer.concat(chunks, received);
}

/**
 * Downloads a Telegram file into memory, following `upload.fileCdnRedirect`.
 *
 * `location` may be an mtcute `FileLocation` (media, thumbnails, avatars) or
 * a raw TL `TypeInputFileLocation`. Inline `Uint8Array` locations (stripped
 * thumbnails and vector previews) are returned as-is.
 */
export async function downloadFileBuffer(
  client: TelegramClient,
  location: FileLocation | tl.TypeInputFileLocation,
  options: DownloadOptions = {},
): Promise<Buffer> {
  const downloadClient = client as unknown as DownloadClient;
  const limit = options.maxBytes ?? MAX_MEDIA_BYTES;
  if (!Number.isFinite(limit) || limit <= 0) {
    throw apiError('VALIDATION_ERROR', 'maxBytes must be a positive number');
  }

  const normalized = await normalizeLocation(location);
  if (normalized instanceof Uint8Array) {
    if (normalized.byteLength > limit) {
      throw mediaTooLarge(normalized.byteLength, limit);
    }
    return Buffer.from(normalized);
  }

  const size = normalized.fileSize;
  assertWithinLimits(size, limit);
  const dcId = normalized.dcId ?? (await downloadClient.getPrimaryDcId());
  const attempt: DownloadAttempt = {
    client: downloadClient,
    normalized,
    size,
    limit,
    partSize: partSizeFor(options),
    dcId,
    isSmall:
      (typeof size === 'number' && size <= SMALL_FILE_MAX_SIZE) ||
      normalized.location._ === 'inputPeerPhotoFileLocation',
  };

  for (let reupload = 0; reupload <= MAX_REUPLOADS; reupload++) {
    const result = await downloadOnce(attempt, reupload < MAX_REUPLOADS);
    if (result !== REUPLOAD) return result;
  }

  throw apiError(
    'MEDIA_NOT_FOUND',
    'Telegram CDN asked for the file to be reuploaded more than once',
  );
}
