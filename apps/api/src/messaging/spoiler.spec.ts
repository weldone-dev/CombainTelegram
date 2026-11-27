import { describe, expect, it } from 'vitest';
import { parseSpoilers } from './spoiler.js';

describe('parseSpoilers', () => {
  it('returns the text unchanged without markers', () => {
    expect(parseSpoilers('привет')).toEqual({ text: 'привет', spans: [] });
  });

  it('strips paired markers and keeps the inner span', () => {
    const parsed = parseSpoilers('я ||скучаю|| по тебе');
    expect(parsed.text).toBe('я скучаю по тебе');
    expect(parsed.spans).toEqual([{ offset: 2, length: 6 }]);
  });

  it('keeps an unpaired marker literal', () => {
    const parsed = parseSpoilers('||не закрыла');
    expect(parsed.text).toBe('||не закрыла');
    expect(parsed.spans).toEqual([]);
  });
});
