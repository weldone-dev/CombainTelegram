import {
  extractFirstUrl,
  normalizeUsername,
  parseChatInfoKind,
  parseDeleteMessageOptions,
  parseDeleteOptions,
  parseFolderId,
  parseLimit,
  parseMessageIds,
  parseOptionalBoolean,
  parseOptionalMessageId,
  parsePollOptions,
  parseReactionEmoji,
  parseSearchQuery,
  parseThumbFlag,
  parseTranslateLanguage,
} from './params.js';

describe('username normalisation', () => {
  it.each([
    ['alice', 'alice'],
    ['@alice', 'alice'],
    [' t.me/alice ', 'alice'],
    ['https://t.me/alice', 'alice'],
    ['http://t.me/alice/', 'alice'],
    ['https://t.me/alice?single', 'alice'],
    ['telegram.me/alice', 'alice'],
    ['HTTPS://T.ME/Alice', 'Alice'],
  ])('normalises %s to %s', (input, expected) => {
    expect(normalizeUsername(input)).toBe(expected);
  });

  it('rejects empty input', () => {
    expect(() => normalizeUsername('')).toThrow(/username must not be empty/);
    expect(() => normalizeUsername('   ')).toThrow(/username must not be empty/);
    expect(() => normalizeUsername(undefined)).toThrow(/username is required/);
  });

  it('rejects invite links and invalid characters', () => {
    expect(() => normalizeUsername('https://t.me/+abc')).toThrow(
      /invalid characters/,
    );
    expect(() => normalizeUsername('name-with-dash')).toThrow(
      /invalid characters/,
    );
  });
});

describe('search and forward validation', () => {
  it('trims search queries and enforces the length window', () => {
    expect(parseSearchQuery('  hello  ')).toBe('hello');
    expect(() => parseSearchQuery('   ')).toThrow(/must not be empty/);
    expect(() => parseSearchQuery('x'.repeat(257))).toThrow(/at most 256/);
  });

  it('parses message id arrays', () => {
    expect(parseMessageIds([1, '2'])).toEqual([1, 2]);
    expect(() => parseMessageIds([])).toThrow(/must not be empty/);
    expect(() => parseMessageIds([0])).toThrow(/positive integer/);
    expect(() => parseMessageIds(Array.from({ length: 101 }, (_, i) => i + 1)))
      .toThrow(/at most 100/);
    expect(() => parseMessageIds('1')).toThrow(/must be an array/);
  });

  it('parses optional reply ids', () => {
    expect(parseOptionalMessageId(undefined)).toBeUndefined();
    expect(parseOptionalMessageId('7')).toBe(7);
    expect(() => parseOptionalMessageId(0)).toThrow(/positive integer/);
  });
});

describe('folder and boolean params', () => {
  it('parses folder ids', () => {
    expect(parseFolderId(undefined)).toBeUndefined();
    expect(parseFolderId('')).toBeUndefined();
    expect(parseFolderId('3')).toBe(3);
    expect(parseFolderId(0)).toBe(0);
    expect(() => parseFolderId('-1')).toThrow(/must not be negative/);
  });

  it('parses query-string booleans', () => {
    expect(parseOptionalBoolean('true', 'archived')).toBe(true);
    expect(parseOptionalBoolean('1', 'archived')).toBe(true);
    expect(parseOptionalBoolean('false', 'archived')).toBe(false);
    expect(parseOptionalBoolean('0', 'archived')).toBe(false);
    expect(parseOptionalBoolean(true, 'archived')).toBe(true);
    expect(parseOptionalBoolean(undefined, 'archived')).toBeUndefined();
    expect(() => parseOptionalBoolean('yes', 'archived')).toThrow(
      /must be a boolean/,
    );
  });
});

describe('delete chat params', () => {
  it('deletes only on the current account side by default', () => {
    expect(parseDeleteOptions()).toEqual({
      revoke: false,
      clearHistory: false,
    });
    expect(parseDeleteOptions({})).toEqual({
      revoke: false,
      clearHistory: false,
    });
  });

  it('requires an explicit revoke=true for delete-for-everyone', () => {
    expect(parseDeleteOptions({ revoke: 'true' })).toEqual({
      revoke: true,
      clearHistory: false,
    });
    expect(parseDeleteOptions({ revoke: '1', clearHistory: 'true' })).toEqual({
      revoke: true,
      clearHistory: true,
    });
    expect(parseDeleteOptions({ revoke: 'false' })).toEqual({
      revoke: false,
      clearHistory: false,
    });
  });

  it('rejects non-boolean flags', () => {
    expect(() => parseDeleteOptions({ revoke: 'yes' })).toThrow(
      /revoke must be a boolean/,
    );
  });
});

describe('delete message params', () => {
  it('deletes only for the current account by default', () => {
    expect(parseDeleteMessageOptions()).toEqual({ revoke: false });
    expect(parseDeleteMessageOptions({})).toEqual({ revoke: false });
    expect(parseDeleteMessageOptions({ revoke: undefined })).toEqual({
      revoke: false,
    });
    expect(parseDeleteMessageOptions({ revoke: 'false' })).toEqual({
      revoke: false,
    });
  });

  it('requires an explicit revoke=true for delete-for-everyone', () => {
    expect(parseDeleteMessageOptions({ revoke: 'true' })).toEqual({
      revoke: true,
    });
    expect(parseDeleteMessageOptions({ revoke: '1' })).toEqual({ revoke: true });
    expect(parseDeleteMessageOptions({ revoke: true })).toEqual({
      revoke: true,
    });
    expect(() => parseDeleteMessageOptions({ revoke: 'yes' })).toThrow(
      /revoke must be a boolean/,
    );
  });
});

describe('chat info params', () => {
  it('accepts only known tab kinds', () => {
    expect(parseChatInfoKind('media')).toBe('media');
    expect(parseChatInfoKind('links')).toBe('links');
    expect(parseChatInfoKind('polls')).toBe('polls');
    expect(() => parseChatInfoKind('files')).toThrow(/kind must be one of/);
    expect(() => parseChatInfoKind(undefined)).toThrow(/kind must be one of/);
  });

  it('caps the tab limit at 50', () => {
    expect(parseLimit(undefined, 50)).toBe(50);
    expect(parseLimit('10', 50)).toBe(10);
    expect(parseLimit('500', 50)).toBe(50);
    expect(() => parseLimit('0', 50)).toThrow(/positive integer/);
  });

  it('extracts the first URL and drops trailing punctuation', () => {
    expect(extractFirstUrl('see https://example.com/a?b=1 now')).toBe(
      'https://example.com/a?b=1',
    );
    expect(extractFirstUrl('(https://t.me/channel).')).toBe(
      'https://t.me/channel',
    );
    expect(extractFirstUrl('www.example.com, then more')).toBe(
      'www.example.com',
    );
    expect(extractFirstUrl('no links here')).toBeNull();
    expect(extractFirstUrl('')).toBeNull();
  });
});

describe('message feature params', () => {
  it('parses the thumb flag', () => {
    expect(parseThumbFlag('1')).toBe(true);
    expect(parseThumbFlag('true')).toBe(true);
    expect(parseThumbFlag(undefined)).toBe(false);
    expect(parseThumbFlag('')).toBe(false);
    expect(parseThumbFlag('false')).toBe(false);
    expect(() => parseThumbFlag('yes')).toThrow(/thumb must be a boolean/);
  });

  it('parses reaction emoji, treating empty as a removal', () => {
    expect(parseReactionEmoji('👍')).toBe('👍');
    expect(parseReactionEmoji(' ❤️ ')).toBe('❤️');
    expect(parseReactionEmoji(undefined)).toBeNull();
    expect(parseReactionEmoji(null)).toBeNull();
    expect(parseReactionEmoji('')).toBeNull();
    expect(() => parseReactionEmoji(42)).toThrow(/emoji must be a string/);
    expect(() => parseReactionEmoji('x'.repeat(65))).toThrow(/at most 64/);
  });

  it('parses poll options and the retract form', () => {
    expect(parsePollOptions([0, '2'])).toEqual([0, 2]);
    expect(parsePollOptions([])).toEqual([]);
    expect(parsePollOptions(null)).toBeNull();
    expect(parsePollOptions(undefined)).toBeNull();
    expect(() => parsePollOptions(1)).toThrow(/must be an array/);
    expect(() => parsePollOptions([-1])).toThrow(/non-negative/);
    expect(() => parsePollOptions(['a'])).toThrow(/must be an integer/);
  });

  it('parses translation targets with a ru default', () => {
    expect(parseTranslateLanguage(undefined)).toBe('ru');
    expect(parseTranslateLanguage('')).toBe('ru');
    expect(parseTranslateLanguage('EN')).toBe('en');
    expect(parseTranslateLanguage('de')).toBe('de');
    expect(() => parseTranslateLanguage('english')).toThrow(
      /two-letter language code/,
    );
    expect(() => parseTranslateLanguage('e1')).toThrow(
      /two-letter language code/,
    );
  });
});
