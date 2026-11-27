/**
 * Anti-repetition at the transport edge.
 *
 * The model can reuse a line it liked one turn ago; people notice that
 * instantly. Bubbles are compared with her last few messages in the same chat,
 * and a fully repeated answer is replaced with a short neutral filler instead
 * of silence.
 */

const SEPARATOR = /^\s*---\s*$/m;

/**
 * Shortest bubble that may be matched by containment. "не" inside "не знаю"
 * is not a repetition: personas live on short bubbles, and substring matching
 * them was eating real answers. Below this length only exact equality counts.
 */
const CONTAINMENT_MIN_LENGTH = 8;

/** Splits a reply into bubbles exactly like the channel marker. */
export function splitReplyParts(text: string): string[] {
  return text
    .split(SEPARATOR)
    .map((part) => part.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, 6);
}

/** Comparison form: letters/digits only, lowercase, no emoji/punctuation. */
export function comparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 240);
}

/** Readable form, used only to measure length including spaces. */
function visibleText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 240);
}

export const NEUTRAL_FILLERS = ['ок', 'ага', 'ну ок', 'ясно', 'понял'] as const;

const FILLERS = new Set(NEUTRAL_FILLERS.map((value) => comparableText(value)));

/**
 * Drops bubbles that already appeared in her recent messages. Neutral
 * acknowledgements ("ок", "ага") are exempt: repeating them is natural.
 */
export function dropRepeatedParts(
  parts: string[],
  recent: Iterable<string>,
): string[] {
  const seen = new Map<string, number>();
  for (const value of recent) {
    for (const part of splitReplyParts(value)) {
      const key = comparableText(part);
      if (key) seen.set(key, visibleText(part).length);
    }
  }
  return parts.filter((part) => {
    const key = comparableText(part);
    if (!key) return false;
    if (FILLERS.has(key)) return true;
    if (seen.has(key)) return false;
    // Containment only for long bubbles: short ones ("да", "не", "ну") are
    // ordinary vocabulary, not a repeated phrase.
    const length = visibleText(part).length;
    if (length < CONTAINMENT_MIN_LENGTH) return true;
    return ![...seen].some(
      ([existing, existingLength]) =>
        existingLength >= CONTAINMENT_MIN_LENGTH &&
        (existing.includes(key) || key.includes(existing)),
    );
  });
}

/** Last-resort bubble when the sanitizer left nothing to send. */
export function pickFiller(rng: () => number = Math.random): string {
  const index = Math.floor(rng() * NEUTRAL_FILLERS.length);
  return NEUTRAL_FILLERS[Math.min(NEUTRAL_FILLERS.length - 1, Math.max(0, index))]!;
}
