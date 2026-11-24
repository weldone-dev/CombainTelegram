import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TYPING_CPM,
  MAX_TYPING_CPM,
  MAX_TYPING_MS,
  MIN_TYPING_CPM,
  MIN_TYPING_MS,
  clampTypingCpm,
  typingDurationMs,
} from './typing.js';

describe('typing simulation', () => {
  it('clamps speed to human bounds and falls back on junk', () => {
    expect(clampTypingCpm(0)).toBe(MIN_TYPING_CPM);
    expect(clampTypingCpm(10_000)).toBe(MAX_TYPING_CPM);
    expect(clampTypingCpm('nope')).toBe(DEFAULT_TYPING_CPM);
    expect(clampTypingCpm(300.4)).toBe(300);
  });

  it('scales duration with text length', () => {
    expect(typingDurationMs(10, 300)).toBe(2_000);
    expect(typingDurationMs(50, 300)).toBe(10_000);
    expect(typingDurationMs(300, 300)).toBe(60_000);
    expect(typingDurationMs(10, 600)).toBe(1_000);
  });

  it('never goes below the minimum or above the cap', () => {
    expect(typingDurationMs(0, 300)).toBe(MIN_TYPING_MS);
    expect(typingDurationMs(1, 600)).toBe(MIN_TYPING_MS);
    expect(typingDurationMs(10_000, 600)).toBe(MAX_TYPING_MS);
  });

  it('respects a slower configured speed', () => {
    expect(typingDurationMs(100, 40)).toBe(MAX_TYPING_MS);
    expect(typingDurationMs(20, 60)).toBe(20_000);
  });
});
