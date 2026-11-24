/**
 * Parsing of a model reply into the messages the autopilot sends.
 *
 * The model is asked for 1–3 short messages separated by a line `---`, each
 * optionally prefixed with `[#N]` (which incoming message it answers) and
 * optionally carrying a short quote line. Real models drift, so the parser is
 * deliberately forgiving: anything it cannot understand becomes plain text.
 */

/** One outbound message of an autopilot reply. */
export interface ReplyPart {
  text: string;
  /** 1-based index into the incoming burst this part answers. */
  messageIndex?: number;
  /** Short quote from that incoming message. */
  quote?: string;
}

/** A reply never becomes more than a few bubbles, even if the model rambles. */
export const MAX_REPLY_PARTS = 5;
/** Telegram's own text limit; anything longer is truncated, not sent as-is. */
export const MAX_REPLY_PART_CHARS = 4000;

/** A line that is exactly `---` separates two messages. */
const PART_SEPARATOR = /^\s*---\s*$/;
/** `[#2]` on its own line. */
const INDEX_ALONE = /^\[#(\d+)\]\s*$/;
/** `[#2] Текст` at the start of the first line. */
const INDEX_INLINE = /^\[#(\d+)\]\s+(.+)$/;
/** `цитата: «...»`, `цитата: "..."`, `Quote: ...`. */
const QUOTE_LINE = /^(?:цитата|quote)\s*:\s*(.+)$/iu;
/** `> ...`: the markdown-ish way of writing a quote line. */
const QUOTE_BLOCK_LINE = /^>\s?(.*)$/;

/** Opening/closing quote pairs stripped from a quote value. */
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['«', '»'],
  ['"', '"'],
  ['“', '”'],
  ['„', '“'],
  ['„', '”'],
  ['‘', '’'],
  ['`', '`'],
];

/** Truncates by code points so an emoji is never split in half. */
function capChars(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? chars.slice(0, max).join('') : text;
}

/**
 * Removes a code fence that wraps the whole value (` ``` ` or ` ```text `).
 * Only fences that open on the first line and close on the last one count, so
 * a fragment of a larger block is left alone.
 */
function stripFence(raw: string): string {
  let text = raw.trim();
  while (text.startsWith('```') && text.length > 6) {
    const lines = text.split('\n');
    if (lines.length < 2) break;
    if (!lines[lines.length - 1]?.trim().startsWith('```')) break;
    text = lines.slice(1, -1).join('\n').trim();
  }
  return text;
}

/** `«цитата»`, `"цитата"` and friends become the bare quote text. */
function unwrapQuote(value: string): string {
  let text = value.trim().replace(/^>\s?/, '').trim();
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      text = text.slice(open.length, text.length - close.length).trim();
      break;
    }
  }
  return text;
}

/** `1` → `1`; a zero or garbage index means "no specific message". */
function toMessageIndex(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const index = Number.parseInt(raw, 10);
  return Number.isSafeInteger(index) && index > 0 ? index : undefined;
}

/** Splits a reply into its `---`-separated blocks. */
function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const line of text.split('\n')) {
    if (PART_SEPARATOR.test(line)) {
      blocks.push(current.join('\n'));
      current = [];
    } else {
      current.push(line);
    }
  }
  blocks.push(current.join('\n'));
  return blocks;
}

/** One `---` block: index marker, quote line and the message text. */
function parsePart(raw: string): ReplyPart | null {
  const lines = stripFence(raw).split('\n');

  let messageIndex: number | undefined;
  const head = lines[0]?.trim() ?? '';
  const alone = INDEX_ALONE.exec(head);
  if (alone) {
    messageIndex = toMessageIndex(alone[1]);
    lines.shift();
  } else {
    const inline = INDEX_INLINE.exec(head);
    if (inline) {
      messageIndex = toMessageIndex(inline[1]);
      lines[0] = inline[2] ?? '';
    }
  }

  let quote: string | undefined;
  const remaining: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const explicit = QUOTE_LINE.exec(trimmed);
    if (explicit) {
      if (quote === undefined) {
        quote = unwrapQuote(explicit[1] ?? '');
      }
      continue;
    }
    remaining.push(line);
  }

  // A `>` block is a quote too. Only the first block counts: the rest of the
  // message stays text, so a stray marker cannot eat a whole reply.
  if (quote === undefined) {
    const start = remaining.findIndex((line) =>
      QUOTE_BLOCK_LINE.test(line.trim()),
    );
    if (start >= 0) {
      const quoted: string[] = [];
      let end = start;
      while (end < remaining.length) {
        const match = QUOTE_BLOCK_LINE.exec(remaining[end]?.trim() ?? '');
        if (!match) break;
        quoted.push((match[1] ?? '').trim());
        end += 1;
      }
      remaining.splice(start, end - start);
      const joined = quoted.filter(Boolean).join(' ');
      if (joined) quote = joined;
    }
  }

  const text = remaining.join('\n').trim();
  if (!text) return null;

  const part: ReplyPart = { text: capChars(text, MAX_REPLY_PART_CHARS) };
  if (messageIndex !== undefined) part.messageIndex = messageIndex;
  if (quote) part.quote = quote;
  return part;
}

/**
 * Parses a model reply into the messages to send. A reply without any markers
 * is one plain message; unparseable markup falls back to the whole text.
 */
export function parseReply(raw: string): ReplyPart[] {
  const text = stripFence(String(raw ?? '').replace(/\r\n?/g, '\n'));
  if (!text) return [];

  const parts = splitBlocks(text)
    .map(parsePart)
    .filter((part): part is ReplyPart => part !== null)
    .slice(0, MAX_REPLY_PARTS);

  if (parts.length === 0) {
    return [{ text: capChars(text, MAX_REPLY_PART_CHARS) }];
  }
  return parts;
}
