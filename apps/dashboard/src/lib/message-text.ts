export interface MessageTextToken {
  type: "text" | "link";
  /** Rendered text; line breaks stay inside text tokens. */
  value: string;
  /** Offset in the source text, used as a stable React key. */
  offset: number;
  /** Only set for links. */
  href?: string;
}

// http(s) links plus bare t.me links, which Telegram users share constantly.
const LINK_PATTERN = /(https?:\/\/[^\s<>"']+|t\.me\/[^\s<>"']+)/gi;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const URL_PREFIX = /^https?:\/\//i;

function isStandaloneTme(text: string, index: number): boolean {
  // "t.me/x" must not match inside "not.me/..." or "@t.me/...".
  const previous = index > 0 ? text[index - 1] : "";
  return !/[\w@./-]/.test(previous);
}

/**
 * Splits plain message text into text and link tokens without any markdown or
 * HTML parsing, so nothing user-supplied is ever injected as markup.
 */
export function tokenizeMessageText(text: string): MessageTextToken[] {
  const tokens: MessageTextToken[] = [];
  let lastIndex = 0;
  LINK_PATTERN.lastIndex = 0;

  let match = LINK_PATTERN.exec(text);
  while (match) {
    const start = match.index;
    const raw = match[0];
    const isTme = /^t\.me\//i.test(raw);
    if (isTme && !isStandaloneTme(text, start)) {
      match = LINK_PATTERN.exec(text);
      continue;
    }

    // Keep sentence punctuation out of the anchor: "see https://x.dev."
    const value = raw.replace(TRAILING_PUNCTUATION, "");
    if (!value) {
      match = LINK_PATTERN.exec(text);
      continue;
    }

    if (start > lastIndex) {
      tokens.push({
        type: "text",
        value: text.slice(lastIndex, start),
        offset: lastIndex,
      });
    }
    tokens.push({
      type: "link",
      value,
      offset: start,
      href: URL_PREFIX.test(value) ? value : `https://${value}`,
    });
    lastIndex = start + value.length;
    LINK_PATTERN.lastIndex = lastIndex;
    match = LINK_PATTERN.exec(text);
  }

  if (lastIndex < text.length) {
    tokens.push({
      type: "text",
      value: text.slice(lastIndex),
      offset: lastIndex,
    });
  }
  return tokens;
}
