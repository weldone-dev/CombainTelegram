/**
 * Outgoing-reply sanitization for Eve.
 *
 * The behavior layer asks the model for a short human reply, but models leak
 * their scaffolding into the text: `[internal: ...]` frames, XML tags, code
 * fences, role prefixes, service metadata (`intent=`, `bubbles=`) and whole
 * identity disclaimers ("as an AI language model..."). Sending any of that to
 * a peer breaks the persona, so the transport runs this before splitting the
 * reply into bubbles. A reply that is *only* a leak becomes an empty string:
 * the transport treats it as "nothing to send" instead of posting an excuse.
 *
 * Human quirks are deliberately kept: `)`, `))`, `---`, `...`, lowercase and
 * typos all pass through untouched.
 */

/** `intent=reply`, `bubbles=2`, `typing=auto`, `hint=short`. */
const META_LINE = /^\s*(?:[-*•]\s*)?(?:intent|bubbles|typing|hint)\s*[:=]/i;

/** `system:`, `assistant:`, `developer:`, `user:` at the start of a line. */
const ROLE_PREFIX =
  /^\s*(?:[-*•]\s*)?(?:system|assistant|developer|user)\s*:\s*/i;

const HEADING = /^\s{0,3}#{1,6}\s+/;
const QUOTE = /^\s{0,3}>\s+/;
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const CJK_PUNCTUATION = /[\u3000-\u303f\uff01-\uff60\uffe0-\uffee]/g;
const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * Replies that are an identity disclaimer or a raw technical failure. Matched
 * against the trimmed, lowercased, whitespace-collapsed text, so they only
 * fire when the *whole* reply is the leak.
 */
const META_LEAK_PATTERNS: RegExp[] = [
  /^as an ai(?: language model)?\b/,
  /^as an? (?:large )?language model\b/,
  /^as a (?:large )?language model\b/,
  /^i(?: am|'m) (?:just |simply )?an? (?:ai|artificial intelligence\b|language model\b|large language model\b)/,
  /^i(?: am|'m) (?:sorry|afraid)[, ]+(?:but )?i (?:can't|cannot|can not|won't|am unable)\b/,
  /^i (?:can't|cannot|can not|won't|am unable to) (?:help|assist|continue|provide|answer|respond)\b/,
  /^я (?:—|-|это )?(?:ии(?![\p{L}\p{N}])|искусственн\p{L}*\s+интеллект|языкова\p{L}*\s+модел\p{L}*)/u,
  /^я языкова\p{L}*\s+модел\p{L}*/u,
  /^я не могу (?:как )?(?:ии(?![\p{L}\p{N}])|искусственн\p{L}*\s+интеллект)/u,
  /^как ии(?![\p{L}\p{N}])/u,
  /^(?:внутренняя |техническая )?ошибка\b/u,
  /^(?:internal error|technical error|something went wrong)\b/,
  /^(?:error|exception|traceback)\b/,
  /^stack trace\b/,
  /^\{\s*"(?:error|statuscode|message|detail)"\s*:/,
  /^<\?xml\b/,
  /^<!doctype html\b/,
];

/**
 * Literal leak fragments that can hide inside an otherwise fine reply. The
 * longer phrases come first so `я не могу как ИИ` does not degrade into
 * `я не могу`.
 */
const LEAK_PHRASES: RegExp[] = [
  /(?<![\p{L}\p{N}])я\s+не\s+могу\s+как\s+ии(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])я\s+не\s+могу\s+(?:как\s+)?(?:ии|искусственн\p{L}*\s+интеллект\p{L}*)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])я\s+(?:—|-|это\s+)?языкова\p{L}*\s+модел\p{L}*(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])я\s+как\s+(?:ии|искусственн\p{L}*\s+интеллект\p{L}*)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])как\s+(?:ии|искусственн\p{L}*\s+интеллект\p{L}*)(?![\p{L}\p{N}])/giu,
  /(?<![\p{L}\p{N}])я\s+(?:—|-|это\s+)?(?:ии|искусственн\p{L}*\s+интеллект\p{L}*)(?![\p{L}\p{N}])/giu,
  /\bas an ai(?: language model)?\b/gi,
  /\b(?:i am|i'm) (?:just |simply )?an? (?:ai|language model|large language model)\b/gi,
  /\blarge language model\b/gi,
  /\blanguage model\b/gi,
];

/** `true` when the whole reply is an identity leak or a technical error. */
export function looksLikeMetaLeak(value: string): boolean {
  if (typeof value !== 'string') return false;
  const flat = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!flat) return false;
  return META_LEAK_PATTERNS.some((pattern) => pattern.test(flat));
}

function stripMarkup(value: string): string {
  return (
    value
      // HTML comments, including multi-line ones.
      .replace(/<!--[\s\S]*?-->/g, '')
      // Fenced code blocks: the block itself is technical, not a message.
      .replace(/```[^\n]*\n?[\s\S]*?(?:```|$)/g, '')
      .replace(/~~~[^\n]*\n?[\s\S]*?(?:~~~|$)/g, '')
      // Chat-template special tokens such as <|im_start|>.
      .replace(/<\|[^|>]*\|>/g, '')
      // XML-ish tags with or without attributes.
      .replace(/<\/?[a-zA-Z][\w:.-]*(?:\s[^<>]*)?\/?>/g, '')
      // [internal: ...] frames, closed or left open at the end.
      .replace(/\[\s*internal\s*[:=][\s\S]*?\]/gi, '')
      .replace(/\[\s*internal\s*[:=][\s\S]*$/i, '')
      // Inline code spans keep their text but lose the backticks.
      .replace(/`([^`\n]+)`/g, '$1')
      .replace(/`/g, '')
  );
}

function stripEmphasis(value: string): string {
  return value
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}])__([^_\n]+)__(?![\p{L}\p{N}])/gu, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/(?<![\p{L}\p{N}])_([^_\n]+)_(?![\p{L}\p{N}])/gu, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1');
}

/** Drops service metadata lines and model-authored line markers. */
function cleanLines(value: string): string {
  const kept: string[] = [];
  for (const raw of value.split('\n')) {
    if (META_LINE.test(raw)) continue;
    const line = raw
      .replace(HEADING, '')
      .replace(QUOTE, '')
      .replace(ROLE_PREFIX, '')
      .trim();
    if (!line) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

function tidy(value: string): string {
  return value
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/ +([,.!?…;:])/g, '$1')
    .trim();
}

/**
 * Cleans one outgoing reply. Returns `''` when there is nothing human left to
 * send, which the transport interprets as "drop this reply".
 */
export function sanitizeReply(value: string): string {
  if (typeof value !== 'string') return '';
  const raw = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u200b-\u200d\ufeff]/g, '');
  if (!raw.trim()) return '';
  if (looksLikeMetaLeak(raw)) return '';

  let result = stripMarkup(raw);
  result = stripEmphasis(result);
  result = cleanLines(result);

  let leakRemoved = false;
  for (const pattern of LEAK_PHRASES) {
    const before = result;
    result = result.replace(pattern, ' ');
    if (result !== before) leakRemoved = true;
  }

  // CJK sometimes glues itself to Russian when the model switches languages.
  result = result.replace(CJK_PUNCTUATION, ' ').replace(CJK, ' ');
  result = tidy(result);

  if (leakRemoved) {
    result = result
      .replace(/^[\s,;:.!?—–-]+/u, '')
      .replace(/[\s,;:—–-]+$/u, '')
      .trim();
    // A reply that was nothing but the leak must not turn into punctuation.
    if (!HAS_WORD.test(result)) return '';
  }

  return result;
}
