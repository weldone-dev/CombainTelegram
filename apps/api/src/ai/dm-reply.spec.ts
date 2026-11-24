import { describe, expect, it } from 'vitest';
import { MAX_REPLY_PART_CHARS, MAX_REPLY_PARTS, parseReply } from './dm-reply.js';

describe('parseReply', () => {
  it('returns one part for plain text', () => {
    expect(parseReply('  Привет, как дела?  ')).toEqual([
      { text: 'Привет, как дела?' },
    ]);
  });

  it('keeps multi-line plain text in one part', () => {
    expect(parseReply('Привет.\nЭто второе предложение.')).toEqual([
      { text: 'Привет.\nЭто второе предложение.' },
    ]);
  });

  it('splits parts on a line that is exactly ---', () => {
    expect(parseReply('Первый\n\n---\n\nВторой')).toEqual([
      { text: 'Первый' },
      { text: 'Второй' },
    ]);
  });

  it('accepts padding around the separator line', () => {
    expect(parseReply('Первый\n  ---  \nВторой')).toEqual([
      { text: 'Первый' },
      { text: 'Второй' },
    ]);
  });

  it('reads [#N] at the start of the first line', () => {
    expect(parseReply('[#2] Отвечаю на второе')).toEqual([
      { text: 'Отвечаю на второе', messageIndex: 2 },
    ]);
  });

  it('reads [#N] on its own line', () => {
    expect(parseReply('[#3]\nОтвечаю на третье')).toEqual([
      { text: 'Отвечаю на третье', messageIndex: 3 },
    ]);
  });

  it('attaches the index to the matching part only', () => {
    expect(parseReply('Просто ответ\n---\n[#2] Ответ на второе')).toEqual([
      { text: 'Просто ответ' },
      { text: 'Ответ на второе', messageIndex: 2 },
    ]);
  });

  it('ignores a zero index', () => {
    expect(parseReply('[#0] Странный индекс')).toEqual([
      { text: 'Странный индекс' },
    ]);
  });

  it('extracts a «» quote line', () => {
    expect(
      parseReply('[#1] Да, я помню\nцитата: «встречаемся в семь»\nВсё в силе.'),
    ).toEqual([
      {
        text: 'Да, я помню\nВсё в силе.',
        messageIndex: 1,
        quote: 'встречаемся в семь',
      },
    ]);
  });

  it('extracts a straight-quote line', () => {
    expect(parseReply('Хорошо\nцитата: "номер 5"\nСделаю')).toEqual([
      { text: 'Хорошо\nСделаю', quote: 'номер 5' },
    ]);
  });

  it('extracts a curly-quote line', () => {
    expect(parseReply('Хорошо\nЦитата: “номер 5”')).toEqual([
      { text: 'Хорошо', quote: 'номер 5' },
    ]);
  });

  it('treats a > block as the quote', () => {
    expect(parseReply('> Скинь адрес\nЗаписал')).toEqual([
      { text: 'Записал', quote: 'Скинь адрес' },
    ]);
  });

  it('joins consecutive > lines into one quote', () => {
    expect(parseReply('Ок\n> первая строка\n> вторая строка')).toEqual([
      { text: 'Ок', quote: 'первая строка вторая строка' },
    ]);
  });

  it('keeps a > line in the text when an explicit quote already exists', () => {
    expect(parseReply('цитата: «раз»\n> раз\nПонял')).toEqual([
      { text: '> раз\nПонял', quote: 'раз' },
    ]);
  });

  it('drops empty parts', () => {
    expect(parseReply('Первый\n---\n\n---\nВторой\n---')).toEqual([
      { text: 'Первый' },
      { text: 'Второй' },
    ]);
  });

  it('drops a part that has a quote but no text', () => {
    expect(parseReply('Первый\n---\nцитата: «только цитата»')).toEqual([
      { text: 'Первый' },
    ]);
  });

  it('caps the number of parts', () => {
    const raw = Array.from({ length: 8 }, (_, i) => `часть ${i + 1}`).join(
      '\n---\n',
    );
    const parts = parseReply(raw);
    expect(parts).toHaveLength(MAX_REPLY_PARTS);
    expect(parts[0]?.text).toBe('часть 1');
    expect(parts[MAX_REPLY_PARTS - 1]?.text).toBe(
      `часть ${MAX_REPLY_PARTS}`,
    );
  });

  it('caps the length of one part without splitting characters', () => {
    const emoji = '😀';
    const parts = parseReply(emoji.repeat(MAX_REPLY_PART_CHARS + 10));
    expect([...(parts[0]?.text ?? '')]).toHaveLength(MAX_REPLY_PART_CHARS);
    expect(parts[0]?.text.endsWith(emoji)).toBe(true);
  });

  it('strips a code fence around the whole reply', () => {
    expect(parseReply('```\nПервый\n---\nВторой\n```')).toEqual([
      { text: 'Первый' },
      { text: 'Второй' },
    ]);
  });

  it('strips a code fence with a language tag', () => {
    expect(parseReply('```text\nПривет\n```')).toEqual([{ text: 'Привет' }]);
  });

  it('falls back to the whole text when nothing parses', () => {
    expect(parseReply('---\n---')).toEqual([{ text: '---\n---' }]);
  });

  it('returns nothing for an empty reply', () => {
    expect(parseReply('')).toEqual([]);
    expect(parseReply('   \n\n  ')).toEqual([]);
    expect(parseReply('```\n\n```')).toEqual([]);
  });
});
