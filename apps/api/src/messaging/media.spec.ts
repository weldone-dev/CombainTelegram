import {
  MAX_MEDIA_BYTES,
  assertMediaDownloadSize,
  assertMediaUpload,
  contentDisposition,
  isImageMime,
  isInlineSafeMime,
  mediaKindForMime,
  normalizeMimeType,
  sanitizeFileName,
} from './media.js';

describe('media MIME helpers', () => {
  it('treats image/* as photos and everything else as documents', () => {
    expect(mediaKindForMime('image/jpeg')).toBe('photo');
    expect(mediaKindForMime('IMAGE/PNG')).toBe('photo');
    expect(mediaKindForMime('application/pdf')).toBe('document');
    expect(mediaKindForMime(null)).toBe('document');
    expect(mediaKindForMime(undefined)).toBe('document');
    expect(isImageMime('image/webp')).toBe(true);
    expect(isImageMime('video/mp4')).toBe(false);
  });
});

describe('media response MIME allow-list', () => {
  it('only lets raster images render inline', () => {
    expect(isInlineSafeMime('image/jpeg')).toBe(true);
    expect(isInlineSafeMime('IMAGE/PNG')).toBe(true);
    expect(isInlineSafeMime('image/webp')).toBe(true);
    expect(isInlineSafeMime('image/gif')).toBe(true);
    expect(isInlineSafeMime('image/svg+xml')).toBe(false);
    expect(isInlineSafeMime('text/html')).toBe(false);
    expect(isInlineSafeMime('application/pdf')).toBe(false);
    expect(isInlineSafeMime(null)).toBe(false);
  });

  it('rejects header-breaking or malformed MIME values', () => {
    expect(normalizeMimeType('application/pdf')).toBe('application/pdf');
    expect(normalizeMimeType(' Text/HTML ')).toBe('text/html');
    expect(normalizeMimeType('image/svg+xml; charset=utf-8')).toBe(
      'application/octet-stream',
    );
    expect(normalizeMimeType('image/jpeg\r\nX-Evil: 1')).toBe(
      'application/octet-stream',
    );
    expect(normalizeMimeType('not-a-mime')).toBe('application/octet-stream');
    expect(normalizeMimeType(null)).toBe('application/octet-stream');
  });
});

describe('media filename helpers', () => {
  it('drops directories and control characters', () => {
    expect(sanitizeFileName('..\\secret\\photo.jpg', 'file')).toBe('photo.jpg');
    expect(sanitizeFileName('/tmp/a/b.pdf', 'file')).toBe('b.pdf');
    expect(sanitizeFileName('bad\u0000name.txt', 'file')).toBe('badname.txt');
    expect(sanitizeFileName('', 'fallback.bin')).toBe('fallback.bin');
    expect(sanitizeFileName('..', 'fallback.bin')).toBe('fallback.bin');
    expect(sanitizeFileName(null, 'fallback.bin')).toBe('fallback.bin');
  });

  it('builds a safe inline/attachment disposition with UTF-8 names', () => {
    expect(contentDisposition('photo.jpg', true)).toBe(
      'inline; filename="photo.jpg"; filename*=UTF-8\'\'photo.jpg',
    );
    expect(contentDisposition('отчёт.pdf', false)).toContain(
      'attachment; filename="_____.pdf"',
    );
    expect(contentDisposition('отчёт.pdf', false)).toContain(
      `filename*=UTF-8''${encodeURIComponent('отчёт.pdf')}`,
    );
    // Quotes and newlines must never escape the header value.
    expect(contentDisposition('a"b\r\nc.txt', false)).not.toContain('\n');
    expect(contentDisposition('a"b\r\nc.txt', false)).toContain(
      'filename="a_bc.txt"',
    );
  });

  it('slices by code points and escapes RFC 5987 attr-chars', () => {
    // 254 ASCII chars followed by an emoji: the cut must not split its pair.
    const name = `${'a'.repeat(254)}😀`;
    const sanitized = sanitizeFileName(name, 'file');
    expect(Array.from(sanitized)).toHaveLength(255);
    expect(() => contentDisposition(sanitized, false)).not.toThrow();

    const disposition = contentDisposition("it's (a) *file*.txt", false);
    expect(disposition).not.toMatch(/filename\*=UTF-8''[^;]*['()*]/);
    expect(disposition).toContain('%27');
    expect(disposition).toContain('%28');
    expect(disposition).toContain('%29');
    expect(disposition).toContain('%2A');
  });
});

describe('upload size validation', () => {
  it('rejects empty files as VALIDATION_ERROR', () => {
    expect(() => assertMediaUpload(0)).toThrow(/must not be empty/);
    try {
      assertMediaUpload(0);
    } catch (error) {
      expect((error as { getResponse(): unknown }).getResponse()).toMatchObject(
        {
          code: 'VALIDATION_ERROR',
        },
      );
    }
  });

  it('rejects files above the 50 MB limit as PAYLOAD_TOO_LARGE', () => {
    expect(() => assertMediaUpload(MAX_MEDIA_BYTES + 1)).toThrow(/at most/);
    try {
      assertMediaUpload(MAX_MEDIA_BYTES + 1);
    } catch (error) {
      expect((error as { getResponse(): unknown }).getResponse()).toMatchObject(
        {
          code: 'PAYLOAD_TOO_LARGE',
        },
      );
      expect((error as { getStatus(): number }).getStatus()).toBe(413);
    }
  });

  it('accepts a normal file', () => {
    expect(() => assertMediaUpload(1024)).not.toThrow();
  });
});

describe('download size validation', () => {
  it('rejects media above the limit before downloading as MEDIA_TOO_LARGE', () => {
    expect(() => assertMediaDownloadSize(MAX_MEDIA_BYTES + 1)).toThrow(
      /at most/,
    );
    try {
      assertMediaDownloadSize(MAX_MEDIA_BYTES + 1);
    } catch (error) {
      expect((error as { getResponse(): unknown }).getResponse()).toMatchObject(
        { code: 'MEDIA_TOO_LARGE' },
      );
      expect((error as { getStatus(): number }).getStatus()).toBe(413);
    }
  });

  it('allows unknown and in-limit sizes', () => {
    expect(() => assertMediaDownloadSize(null)).not.toThrow();
    expect(() => assertMediaDownloadSize(MAX_MEDIA_BYTES)).not.toThrow();
  });
});
