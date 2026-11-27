import { describe, expect, it } from 'bun:test';
import { injectTypos, pickTypoIntensity } from './typos';

/** Deterministic RNG so the assertions never flake. */
function rng(values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

describe('injectTypos', () => {
  it('does nothing when the intensity is zero', () => {
    expect(injectTypos('привет как дела', { intensity: 0 })).toBe(
      'привет как дела',
    );
  });

  it('skips links and mentions', () => {
    const text = 'смотри https://example.com и пиши @nickname';
    expect(injectTypos(text, { intensity: 1, rng: rng([0]) })).toBe(text);
  });

  it('never corrupts words shorter than three characters', () => {
    const result = injectTypos('ок ну да', { intensity: 1, rng: rng([0]) });
    expect(result).toBe('ок ну да');
  });

  it('corrupts at most one word per reply', () => {
    const text = 'привет как дела сегодня вечером';
    const result = injectTypos(text, { intensity: 1, rng: rng([0]) });
    const changed = result
      .split(' ')
      .filter((word, index) => word !== text.split(' ')[index]);
    expect(changed).toHaveLength(1);
  });

  it('changes a letter instead of the whole word', () => {
    const result = injectTypos('привет', { intensity: 1, rng: rng([0, 0.5, 0]) });
    expect(result).not.toBe('привет');
    expect(result).toHaveLength(6);
    expect(result[0]).toBe('п');
    expect(result[3]).not.toBe('и');
  });
});

describe('pickTypoIntensity', () => {
  it('skips more than half of the replies', () => {
    expect(pickTypoIntensity({ rng: rng([0.1]) })).toBe(0);
    expect(pickTypoIntensity({ rng: rng([0.9]) })).toBeGreaterThan(0);
  });

  it('raises the density for bursts', () => {
    const calm = pickTypoIntensity({ rng: rng([0.9]) });
    const bursty = pickTypoIntensity({ bubbles: 3, rng: rng([0.9]) });
    expect(bursty).toBeGreaterThan(calm);
  });

  it('lowers the density for longform', () => {
    const normal = pickTypoIntensity({ rng: rng([0.9]) });
    const longform = pickTypoIntensity({
      messageStyle: 'longform',
      rng: rng([0.9]),
    });
    expect(longform).toBeLessThan(normal);
  });
});
