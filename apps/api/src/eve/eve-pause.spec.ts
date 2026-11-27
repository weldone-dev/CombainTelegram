import { afterEach, describe, expect, it, vi } from 'vitest';
import { bubblePauseMs } from './eve.service.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('bubblePauseMs', () => {
  it('is zero for the first bubble', () => {
    expect(bubblePauseMs(0, 'привет')).toBe(0);
    expect(bubblePauseMs(-1, 'привет')).toBe(0);
  });

  it('stays inside the 400-1800 ms bounds', () => {
    for (const text of ['ок', 'x'.repeat(60), 'x'.repeat(500)]) {
      const pause = bubblePauseMs(1, text);
      expect(pause).toBeGreaterThanOrEqual(400);
      expect(pause).toBeLessThanOrEqual(1800);
    }
  });

  it('waits longer for longer previous text', () => {
    expect(bubblePauseMs(1, 'x'.repeat(80))).toBeGreaterThan(
      bubblePauseMs(1, 'ок'),
    );
  });

  it('caps long text at 1800 ms', () => {
    expect(bubblePauseMs(1, 'x'.repeat(5000))).toBe(1800);
  });

  it('is disabled by EVE_BUBBLE_PAUSE_MS=0', () => {
    vi.stubEnv('EVE_BUBBLE_PAUSE_MS', '0');
    expect(bubblePauseMs(1, 'x'.repeat(200))).toBe(0);
    expect(bubblePauseMs(2, 'x'.repeat(200))).toBe(0);
  });

  it('uses a fixed pause when EVE_BUBBLE_PAUSE_MS is set', () => {
    vi.stubEnv('EVE_BUBBLE_PAUSE_MS', '900');
    expect(bubblePauseMs(1, 'ок')).toBe(900);
    expect(bubblePauseMs(1, 'x'.repeat(500))).toBe(900);
  });

  it('clamps an explicit pause to the bounds', () => {
    vi.stubEnv('EVE_BUBBLE_PAUSE_MS', '50');
    expect(bubblePauseMs(1, 'ок')).toBe(400);
    vi.stubEnv('EVE_BUBBLE_PAUSE_MS', '9000');
    expect(bubblePauseMs(1, 'ок')).toBe(1800);
  });
});
