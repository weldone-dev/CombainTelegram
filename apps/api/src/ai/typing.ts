/** Human typing speed bounds, characters per minute. */
export const MIN_TYPING_CPM = 40;
export const MAX_TYPING_CPM = 600;
export const DEFAULT_TYPING_CPM = 300;

/** Upper bound for one typing simulation; very long texts are not held forever. */
export const MAX_TYPING_MS = 60_000;
export const MIN_TYPING_MS = 600;

export function clampTypingCpm(
  value: unknown,
  fallback = DEFAULT_TYPING_CPM,
): number {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_TYPING_CPM, Math.max(MIN_TYPING_CPM, Math.round(number)));
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
