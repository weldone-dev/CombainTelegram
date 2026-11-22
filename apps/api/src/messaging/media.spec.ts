import {
  MAX_MEDIA_BYTES,
  assertMediaUpload,
  contentDisposition,
  isImageMime,
  mediaKindForMime,
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
