import { HttpStatus } from '@nestjs/common';
import { apiError } from '../common/api-error.js';

/** Hard limit for one uploaded or downloaded file. */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** Downloaded files are kept in memory briefly to make scrolling cheap. */
export const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000;
/**
 * Thumbnails are tiny and change rarely, so their cache entry lives ten times
 * longer than a full download.
 */
export const MEDIA_THUMB_CACHE_TTL_MS = 30 * 60 * 1000;
/** Thumbnails above this size fall back to the full media download. */
export const MAX_MEDIA_THUMB_BYTES = 2 * 1024 * 1024;
/** Biggest thumbnail width served by `?thumb=1`. */
export const MAX_THUMB_WIDTH = 320;
/** Total bytes the download cache may hold; oldest entries are pruned first. */
export const MEDIA_CACHE_MAX_BYTES = 200 * 1024 * 1024;
/** Responses above this size are streamed back but never cached. */
export const MEDIA_CACHE_MAX_ENTRY_BYTES = 10 * 1024 * 1024;

/**
 * Raster image types that browsers may render inline. Everything else,
 * including `image/svg+xml`, is served as an `attachment`: `mimeType` comes
 * from the *sender*, so an `image/*` allow-all would let a peer run script on
 * the API origin.
 */
export const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

/** `type/subtype` with no parameters, whitespace or header-breaking chars. */
const MIME_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;

export const DEFAULT_MIME_TYPE = 'application/octet-stream';

/**
 * Returns a header-safe MIME type or `application/octet-stream`. Peer-supplied
 * values may contain CR/LF, parameters or garbage, none of which may reach
 * `Content-Type` verbatim.
 */
export function normalizeMimeType(
  mimeType: string | null | undefined,
  fallback: string = DEFAULT_MIME_TYPE,
): string {
  if (typeof mimeType !== 'string') return fallback;
  const value = mimeType.trim();
  if (!value || value.length > 255 || !MIME_PATTERN.test(value)) return fallback;
  return value.toLowerCase();
}

/** Photo vs document choice for an uploaded file, based on its MIME type. */
export function mediaKindForMime(
  mimeType: string | null | undefined,
): 'photo' | 'document' {
  return isImageMime(mimeType) ? 'photo' : 'document';
}

export function isImageMime(mimeType: string | null | undefined): boolean {
  return (
    typeof mimeType === 'string' && mimeType.toLowerCase().startsWith('image/')
  );
}

/** Whether a MIME type may be rendered inline (raster images only). */
export function isInlineSafeMime(mimeType: string | null | undefined): boolean {
  return INLINE_IMAGE_MIMES.has(normalizeMimeType(mimeType, ''));
}

/** Last path segment of a client-supplied name, without control characters. */
export function sanitizeFileName(
  name: string | null | undefined,
  fallback: string,
): string {
  if (typeof name !== 'string') return fallback;
  const segment = name.replace(/\\/g, '/').split('/').pop() ?? '';
  // Slice by code points so a 255-unit cut can never split a surrogate pair.
  const base = Array.from(segment)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();
  if (!base || base === '.' || base === '..') return fallback;
  return Array.from(base).slice(0, 255).join('');
}

/**
 * RFC 5987 `attr-char` value. `encodeURIComponent` leaves `'()*` unescaped,
 * which is not allowed there.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition` value with an ASCII fallback and RFC 5987 UTF-8 name.
 * Header-breaking quotes, backslashes and newlines are stripped from both.
 */
export function contentDisposition(fileName: string, inline: boolean): string {
  const safe = sanitizeFileName(fileName, 'file');
  const ascii = safe.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_');
  let encoded: string;
  try {
    encoded = encodeRfc5987(safe);
  } catch {
    // A lone surrogate cannot be percent-encoded; the ASCII form is safe.
    encoded = encodeRfc5987(ascii);
  }
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** Structural view of mtcute photos/documents for thumbnail picking. */
export interface ThumbnailableLike {
  getThumbnail?: (type: string) => unknown;
  thumbnails?: ReadonlyArray<{ width?: unknown; isVideo?: unknown }>;
}

function thumbWidth(thumb: { width?: unknown }): number | null {
  return typeof thumb.width === 'number' && Number.isFinite(thumb.width)
    ? thumb.width
    : null;
}

/**
 * Best preview thumbnail for `?thumb=1`: the 320px box (`m`) when Telegram
 * has it, otherwise the largest known size at or below
 * {@link MAX_THUMB_WIDTH}, otherwise the largest size available. Video and
 * unsized (strip/outline) sizes are used only as a last resort. Never throws:
 * getters on real media classes can reject.
 */
export function pickThumbnail(
  media: ThumbnailableLike | null | undefined,
): unknown | null {
  if (!media) return null;
  try {
    if (typeof media.getThumbnail === 'function') {
      const preferred = media.getThumbnail('m');
      if (preferred) return preferred;
    }
  } catch {
    // Fall through to the thumbnail list.
  }

  const list = Array.isArray(media.thumbnails) ? [...media.thumbnails] : [];
  if (list.length === 0) return null;

  const sized = list
    .filter((thumb) => thumb && !thumb.isVideo && thumbWidth(thumb) !== null)
    .sort((a, b) => (thumbWidth(b) ?? 0) - (thumbWidth(a) ?? 0));

  const withinLimit = sized.find(
    (thumb) => (thumbWidth(thumb) ?? 0) <= MAX_THUMB_WIDTH,
  );
  if (withinLimit) return withinLimit;
  if (sized[0]) return sized[0];
  return list.find((thumb) => !thumb.isVideo) ?? list[0] ?? null;
}

export function assertMediaUpload(size: number): void {
  if (!Number.isFinite(size) || size <= 0) {
    throw apiError('VALIDATION_ERROR', 'file must not be empty');
  }
  if (size > MAX_MEDIA_BYTES) {
    throw apiError(
      'PAYLOAD_TOO_LARGE',
      `file must be at most ${MAX_MEDIA_BYTES} bytes`,
      HttpStatus.PAYLOAD_TOO_LARGE,
    );
  }
}

/**
 * Download-side guard: called before any bytes are fetched, because Telegram
 * documents can be gigabytes and `downloadAsBuffer` would keep them in memory.
 */
export function assertMediaDownloadSize(size: number | null | undefined): void {
  if (typeof size === 'number' && Number.isFinite(size) && size > MAX_MEDIA_BYTES) {
    throw apiError(
      'MEDIA_TOO_LARGE',
      `media must be at most ${MAX_MEDIA_BYTES} bytes`,
      HttpStatus.PAYLOAD_TOO_LARGE,
      { details: { size, limit: MAX_MEDIA_BYTES } },
    );
  }
}
