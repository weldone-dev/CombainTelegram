import {
  normalizeUsername,
  parseFolderId,
  parseMessageIds,
  parseOptionalBoolean,
  parseOptionalMessageId,
  parseSearchQuery,
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
