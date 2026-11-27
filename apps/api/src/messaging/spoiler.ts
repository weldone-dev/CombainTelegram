/**
 * Telegram spoiler markers.
 *
 * The prompt lets a close persona hide one intimate phrase behind `||…||`.
 * Users must never see the pipes themselves: this module strips them and
 * returns UTF-16 spans for the transport (Telegram counts entities in UTF-16
 * code units, not code points).
 */

export interface SpoilerSpan {
  offset: number;
  length: number;
}

export interface ParsedSpoilers {
  text: string;
  spans: SpoilerSpan[];
}

const MARKER = '||';

/**
 * Parses paired `||…||` markers. An unpaired marker is left as literal text so
 * a half-written reply never eats the rest of the message.
 */
export function parseSpoilers(input: string): ParsedSpoilers {
  if (!input.includes(MARKER)) return { text: input, spans: [] };
  let text = '';
  let cursor = 0;
  let openAt = -1;
  const spans: SpoilerSpan[] = [];

  while (cursor < input.length) {
    const index = input.indexOf(MARKER, cursor);
    if (index < 0) break;
    text += input.slice(cursor, index);
    if (openAt < 0) {
      openAt = text.length;
    } else {
      const length = text.length - openAt;
      if (length > 0) spans.push({ offset: openAt, length });
      openAt = -1;
    }
    cursor = index + MARKER.length;
  }
  text += input.slice(cursor);
  if (openAt >= 0) {
    text = `${text.slice(0, openAt)}${MARKER}${text.slice(openAt)}`;
  }
  return { text, spans };
}
