import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TYPING_CPM,
  DEFAULT_TYPING_HEARTBEAT_MS,
  DEFAULT_TYPING_MAX_MS,
  DEFAULT_TYPING_MIN_MS,
  DEFAULT_TYPING_POLICY,
  DEFAULT_TYPING_START_DELAY_MS,
  MAX_TYPING_CPM,
  MAX_TYPING_MS,
  MIN_TYPING_CPM,
  MIN_TYPING_MS,
  clampTypingCpm,
  clampTypingHeartbeat,
  parseTypingMode,
  parseTypingPolicy,
  parseTypingPolicyFromRaw,
  typesWhileThinking,
  typingDurationMs,
  typingPlan,
} from './typing.js';
import type { TypingPolicy } from './typing.js';

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

describe('typing policy', () => {
  it('defaults to smart with the documented timings', () => {
    expect(DEFAULT_TYPING_POLICY).toMatchObject({
      typing: true,
      typingMode: 'smart',
      typingSpeed: DEFAULT_TYPING_CPM,
      typingStartDelayMs: DEFAULT_TYPING_START_DELAY_MS,
      typingMinMs: DEFAULT_TYPING_MIN_MS,
      typingMaxMs: DEFAULT_TYPING_MAX_MS,
      typingHeartbeatMs: DEFAULT_TYPING_HEARTBEAT_MS,
    });
    expect(DEFAULT_TYPING_START_DELAY_MS).toBe(600);
    expect(DEFAULT_TYPING_MIN_MS).toBe(600);
    expect(DEFAULT_TYPING_MAX_MS).toBe(45_000);
    expect(DEFAULT_TYPING_HEARTBEAT_MS).toBe(4_000);
    expect(parseTypingPolicy({})).toEqual(DEFAULT_TYPING_POLICY);
  });

  it('accepts every explicit mode', () => {
    for (const mode of ['off', 'on_think', 'on_compose', 'smart'] as const) {
      const policy = parseTypingPolicy({ typingMode: mode });
      expect(policy.typingMode).toBe(mode);
      expect(policy.typing).toBe(mode !== 'off');
    }
    expect(parseTypingMode('ON_THINK')).toBe('on_think');
    expect(parseTypingMode('nonsense')).toBe('smart');
    expect(parseTypingMode('nonsense', 'off')).toBe('off');
  });

  it('keeps the legacy typing:false switch as off', () => {
    expect(parseTypingPolicy({ typing: false, typingMode: 'smart' }).typingMode).toBe(
      'off',
    );
    expect(parseTypingPolicy({ typing: false }).typing).toBe(false);
    // Re-enabling without a mode goes back to the default, not to "off".
    expect(parseTypingPolicy({ typing: true }, { ...DEFAULT_TYPING_POLICY, typing: false, typingMode: 'off' }).typingMode).toBe(
      'smart',
    );
  });

  it('clamps the heartbeat to 2–5 s', () => {
    expect(clampTypingHeartbeat(1)).toBe(2_000);
    expect(clampTypingHeartbeat(10_000)).toBe(5_000);
    expect(clampTypingHeartbeat('junk')).toBe(DEFAULT_TYPING_HEARTBEAT_MS);
    expect(parseTypingPolicy({ typingHeartbeatMs: 500 }).typingHeartbeatMs).toBe(
      2_000,
    );
  });

  it('clamps compose duration to typingMinMs..typingMaxMs', () => {
    const policy: TypingPolicy = {
      ...DEFAULT_TYPING_POLICY,
      typingMinMs: 1_000,
      typingMaxMs: 3_000,
    };
    expect(typingPlan('', policy).durationMs).toBe(1_000);
    expect(typingPlan('x', policy).durationMs).toBe(1_000);
    expect(typingPlan('x'.repeat(100), policy).durationMs).toBe(3_000);
  });

  it('plans no simulation when typing is off', () => {
    const policy = parseTypingPolicy({ typingMode: 'off' });
    expect(typingPlan('любой текст', policy)).toMatchObject({ durationMs: 0 });
    expect(typesWhileThinking('off')).toBe(false);
    expect(typesWhileThinking('on_compose')).toBe(false);
    expect(typesWhileThinking('on_think')).toBe(true);
    expect(typesWhileThinking('smart')).toBe(true);
  });

  it('scales the compose duration by the typing speed', () => {
    const policy: TypingPolicy = {
      ...DEFAULT_TYPING_POLICY,
      typingSpeed: 300,
      typingMinMs: 600,
      typingMaxMs: 45_000,
      typingHeartbeatMs: 4_000,
    };
    expect(typingPlan('x'.repeat(10), policy)).toEqual({
      durationMs: 2_000,
      heartbeatMs: 4_000,
      mode: 'smart',
    });
    expect(typingPlan('x'.repeat(1_000), policy).durationMs).toBe(45_000);
  });

  it('reads a raw JSON soul setting', () => {
    expect(
      parseTypingPolicyFromRaw(
        JSON.stringify({ typingMode: 'on_compose', typingHeartbeatMs: 3000 }),
      ),
    ).toMatchObject({ typingMode: 'on_compose', typingHeartbeatMs: 3_000 });
    expect(parseTypingPolicyFromRaw('not json')).toEqual(DEFAULT_TYPING_POLICY);
    expect(parseTypingPolicyFromRaw(null)).toEqual(DEFAULT_TYPING_POLICY);
    expect(parseTypingPolicyFromRaw({ typingMode: 'off' }).typingMode).toBe(
      'off',
    );
  });
});
