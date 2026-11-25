/** Human typing speed bounds, characters per minute. */
export const MIN_TYPING_CPM = 40;
export const MAX_TYPING_CPM = 600;
export const DEFAULT_TYPING_CPM = 300;

/** Upper bound for one typing simulation; very long texts are not held forever. */
export const MAX_TYPING_MS = 60_000;
export const MIN_TYPING_MS = 600;

/**
 * When a "typing…" action is shown:
 * - `off` — never;
 * - `on_think` — right after the message is read, while the model thinks;
 * - `on_compose` — only while a ready text is being "typed", never during the
 *   LLM call;
 * - `smart` — after `typingStartDelayMs` past the read receipt, so both the
 *   thinking and the composing phase show it (default).
 */
export type TypingMode = 'off' | 'on_think' | 'on_compose' | 'smart';

export const TYPING_MODES: readonly TypingMode[] = [
  'off',
  'on_think',
  'on_compose',
  'smart',
];

/** Default heartbeat: Telegram drops the action after ~5 s. */
export const DEFAULT_TYPING_HEARTBEAT_MS = 4_000;
/** A heartbeat slower than this never keeps the action visible. */
export const MIN_TYPING_HEARTBEAT_MS = 2_000;
export const MAX_TYPING_HEARTBEAT_MS = 5_000;

/** Delay after the read receipt before `smart` starts typing. */
export const DEFAULT_TYPING_START_DELAY_MS = 600;
export const DEFAULT_TYPING_MIN_MS = 600;
export const DEFAULT_TYPING_MAX_MS = 45_000;

/**
 * The explicit typing policy. Stored inside `Soul.settings` (no schema change)
 * and applied by the autopilot, the Action API and `MessagingService`.
 */
export interface TypingPolicy {
  /** Legacy on/off switch; `false` always means `typingMode: 'off'`. */
  typing: boolean;
  typingMode: TypingMode;
  /** Typing simulation speed in characters per minute (40–600). */
  typingSpeed: number;
  /** How long after the read receipt `smart` starts typing, milliseconds. */
  typingStartDelayMs: number;
  /** Lower bound of one compose simulation, milliseconds. */
  typingMinMs: number;
  /** Upper bound of one compose simulation, milliseconds. */
  typingMaxMs: number;
  /** How often the "typing…" action is refreshed, milliseconds. */
  typingHeartbeatMs: number;
}

export const DEFAULT_TYPING_POLICY: TypingPolicy = {
  typing: true,
  typingMode: 'smart',
  typingSpeed: DEFAULT_TYPING_CPM,
  typingStartDelayMs: DEFAULT_TYPING_START_DELAY_MS,
  typingMinMs: DEFAULT_TYPING_MIN_MS,
  typingMaxMs: DEFAULT_TYPING_MAX_MS,
  typingHeartbeatMs: DEFAULT_TYPING_HEARTBEAT_MS,
};

function numberOr(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampMs(value: unknown, fallback: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(numberOr(value, fallback))));
}

export function clampTypingCpm(
  value: unknown,
  fallback = DEFAULT_TYPING_CPM,
): number {
  return clampMs(value, fallback, MIN_TYPING_CPM, MAX_TYPING_CPM);
}

/** Unknown modes fall back to `fallback` instead of silently turning typing off. */
export function parseTypingMode(
  value: unknown,
  fallback: TypingMode = DEFAULT_TYPING_POLICY.typingMode,
): TypingMode {
  if (typeof value !== 'string') return fallback;
  const mode = value.trim().toLowerCase() as TypingMode;
  return TYPING_MODES.includes(mode) ? mode : fallback;
}

/** Heartbeat is clamped to 2–5 s: slower never keeps the action visible. */
export function clampTypingHeartbeat(value: unknown, fallback = DEFAULT_TYPING_HEARTBEAT_MS): number {
  return clampMs(value, fallback, MIN_TYPING_HEARTBEAT_MS, MAX_TYPING_HEARTBEAT_MS);
}

/**
 * Parses the typing keys of a soul settings object. `typing: false` (legacy)
 * wins over the mode and becomes `off`; an explicit `typingMode` wins over the
 * legacy `true` default.
 */
export function parseTypingPolicy(
  source: Record<string, unknown>,
  fallback: TypingPolicy = DEFAULT_TYPING_POLICY,
): TypingPolicy {
  const explicitMode =
    source.typingMode === undefined
      ? undefined
      : parseTypingMode(source.typingMode, fallback.typingMode);
  let mode = explicitMode ?? fallback.typingMode;
  if (source.typing === false) mode = 'off';
  else if (source.typing === true && explicitMode === undefined && mode === 'off') {
    mode = DEFAULT_TYPING_POLICY.typingMode;
  }
  const minMs = clampMs(
    source.typingMinMs,
    fallback.typingMinMs,
    0,
    MAX_TYPING_MS,
  );
  const maxMs = Math.max(
    minMs,
    clampMs(source.typingMaxMs, fallback.typingMaxMs, 0, MAX_TYPING_MS),
  );
  return {
    typing: mode !== 'off',
    typingMode: mode,
    typingSpeed: clampTypingCpm(source.typingSpeed, fallback.typingSpeed),
    typingStartDelayMs: clampMs(
      source.typingStartDelayMs,
      fallback.typingStartDelayMs,
      0,
      30_000,
    ),
    typingMinMs: minMs,
    typingMaxMs: maxMs,
    typingHeartbeatMs: clampTypingHeartbeat(
      source.typingHeartbeatMs,
      fallback.typingHeartbeatMs,
    ),
  };
}

/**
 * Same parser for a raw `Soul.settings` value: JSON text, an object, or junk.
 * Used by callers that read the settings without importing the souls service
 * (the messaging layer must not depend on the AI module).
 */
export function parseTypingPolicyFromRaw(
  raw: unknown,
  fallback: TypingPolicy = DEFAULT_TYPING_POLICY,
): TypingPolicy {
  let source: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        source = parsed as Record<string, unknown>;
      }
    } catch {
      source = {};
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    source = raw as Record<string, unknown>;
  }
  return parseTypingPolicy(source, fallback);
}

/**
 * How long a "typing…" indicator should stay for a message of `chars`
 * characters at `cpm` characters per minute. The speed itself is clamped to
 * human bounds (40–600 cpm), so the indicator always lasts at least
 * `chars / 600` minutes; a 600-char message caps at one minute.
 */
export function typingDurationMs(
  chars: number,
  cpm: number,
  minMs = MIN_TYPING_MS,
  maxMs = MAX_TYPING_MS,
): number {
  const length = Number.isFinite(chars) ? Math.max(0, Math.floor(chars)) : 0;
  const speed = clampTypingCpm(cpm);
  const raw = (length / speed) * 60_000;
  return Math.min(maxMs, Math.max(minMs, Math.round(raw)));
}

/** One compose simulation: how long to show "typing…" for a ready text. */
export interface TypingPlan {
  durationMs: number;
  /** Heartbeat used while the action is shown. */
  heartbeatMs: number;
  mode: TypingMode;
}

/**
 * Explicit plan for one ready bubble. `off` plans no simulation at all; other
 * modes clamp the `length / typingSpeed` estimate to
 * `typingMinMs..typingMaxMs`.
 */
export function typingPlan(
  text: string,
  settings: TypingPolicy,
): TypingPlan {
  const mode = settings.typing ? settings.typingMode : 'off';
  const heartbeatMs = clampTypingHeartbeat(settings.typingHeartbeatMs);
  if (mode === 'off') return { durationMs: 0, heartbeatMs, mode };
  const chars = [...String(text ?? '')].length;
  const speed = clampTypingCpm(settings.typingSpeed);
  const raw = (chars / speed) * 60_000;
  const minMs = Math.max(0, settings.typingMinMs);
  const maxMs = Math.max(minMs, settings.typingMaxMs);
  return {
    durationMs: Math.min(maxMs, Math.max(minMs, Math.round(raw))),
    heartbeatMs,
    mode,
  };
}

/** True when the policy shows "typing…" while the model is still thinking. */
export function typesWhileThinking(mode: TypingMode): boolean {
  return mode === 'on_think' || mode === 'smart';
}
