/**
 * Bubble splitting for Eve replies.
 *
 * The model is told to separate bubbles with a `---` line, and the behavior
 * layer tells it how many bubbles to produce (`bubbles=N`). Models still drift:
 * some send `a\nb\nc` instead of `a\n---\nb\n---\nc`, some repeat themselves.
 * Both cases are visible in Telegram as AI-ish text, so the transport fixes
 * them instead of trusting the prompt alone.
 */

const LIST_LINE = /^([-*•]\s|>\s|\d+[.)]\s)/;
const MAX_LINE_CHARS = 80;
const MAX_LINES = 6;
const MAX_BUBBLES = 6;

function lines(value: string): string[] {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Splits a reply into bubbles.
 *
 * - `---` on its own line is the canonical separator and always wins.
 * - When the model forgot `---` but wrote several short lines and the behavior
 *   layer asked for more than one bubble, those lines become bubbles.
 * - A single line, long lines, list items and continuation lines ("иду в
 *   магазин,\nкупить хлеба") stay one bubble.
 */
export function splitBubbles(value: string, expected = 0): string[] {
  const explicit = value
    .split(/\n*---\n*/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (explicit.length > 1) return explicit.slice(0, MAX_BUBBLES);

  const single = explicit[0] ?? '';
  if (!single) return [];
  if (expected <= 1) return [single];

  const parts = lines(single);
  if (parts.length < 2 || parts.length > MAX_LINES) return [single];
  if (parts.some((line) => line.length > MAX_LINE_CHARS)) return [single];
  if (parts.some((line) => LIST_LINE.test(line))) return [single];

  const punctuated = parts.every((line) => /[.!?…)]$|\)\)+$/.test(line));
  const continuations = parts
    .slice(0, -1)
    .filter((line) => /,$/.test(line)).length;
  if (continuations >= Math.ceil((parts.length - 1) / 2) && !punctuated) {
    return [single];
  }

  return parts.slice(0, MAX_BUBBLES);
}

function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(value: string): string[] {
  return normalize(value).split(' ').filter((token) => token.length > 1);
}

/** `true` when `short` is mostly made of the words of `long`. */
function containedIn(short: string, long: string): boolean {
  const shortTokens = tokens(short);
  if (shortTokens.length === 0) return false;
  const longTokens = new Set(tokens(long));
  const overlap = shortTokens.filter((token) => longTokens.has(token)).length;
  return overlap / shortTokens.length >= 0.75;
}

/**
 * Removes exact repeats and paraphrases inside one series. The longer, more
 * informative bubble wins and keeps its position.
 */
export function dedupeBubbles(parts: string[]): string[] {
  const kept: string[] = [];
  for (const part of parts) {
    const value = part.trim();
    if (!normalize(value)) continue;
    if (kept.some((item) => normalize(item) === normalize(value))) continue;
    if (kept.some((item) => containedIn(value, item))) continue;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      if (containedIn(kept[index] as string, value)) kept.splice(index, 1);
    }
    kept.push(value);
  }
  return kept;
}
