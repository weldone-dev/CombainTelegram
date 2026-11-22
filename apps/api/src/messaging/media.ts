import { HttpStatus } from '@nestjs/common';
import { apiError } from '../common/api-error.js';

/** Hard limit for one uploaded file (multipart `file`). */
export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

/** Downloaded files are kept in memory briefly to make scrolling cheap. */
export const MEDIA_CACHE_TTL_MS = 5 * 60 * 1000;
export const MEDIA_CACHE_MAX_ENTRIES = 20;

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

/** Last path segment of a client-supplied name, without control characters. */
export function sanitizeFileName(
  name: string | null | undefined,
  fallback: string,
): string {
  if (typeof name !== 'string') return fallback;
  const base = name
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.split('')
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join('')
    .trim();
  if (!base || base === '.' || base === '..') return fallback;
  return base.slice(0, 255);
}

/**
 * `Content-Disposition` value with an ASCII fallback and RFC 5987 UTF-8 name.
 * Header-breaking quotes, backslashes and newlines are stripped from both.
 */
export function contentDisposition(fileName: string, inline: boolean): string {
  const safe = sanitizeFileName(fileName, 'file');
  const ascii = safe.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
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
