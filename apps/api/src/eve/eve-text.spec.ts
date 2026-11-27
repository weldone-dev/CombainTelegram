import { describe, expect, it } from 'vitest';
import { dedupeBubbles, splitBubbles } from './eve-text.js';

describe('splitBubbles', () => {
  it('splits on the canonical separator', () => {
    expect(splitBubbles('слушай\n---\nне\n---\nдавай завтра')).toEqual([
      'слушай',
      'не',
      'давай завтра',
    ]);
  });

  it('keeps a single bubble when the behavior layer expects one', () => {
    expect(splitBubbles('норм\nа ты', 1)).toEqual(['норм\nа ты']);
  });

  it('turns short lines into bubbles when several are expected', () => {
    expect(splitBubbles('слушай\nне\nдавай завтра', 3)).toEqual([
      'слушай',
      'не',
      'давай завтра',
    ]);
  });

  it('does not split a deliberate paragraph', () => {
    const paragraph =
      'я сегодня проснулась в семь утра, потому что сосед опять сверлил стену и не давал спать\nи потом весь день ходила как варёная';
    expect(splitBubbles(paragraph, 3)).toEqual([paragraph]);
  });

  it('does not split structured text', () => {
    const list = 'вот что было\n- созвон\n- отчёт\n- ещё созвон';
    expect(splitBubbles(list, 3)).toEqual([list]);
  });

  it('does not split a sentence continued through commas', () => {
    const text = 'иду в магазин,\nкупить хлеба\nи заодно кофе';
    expect(splitBubbles(text, 3)).toEqual([text]);
  });

  it('caps the series length', () => {
    const many = Array.from({ length: 12 }, (_, index) => `п${index}`).join(
      '\n---\n',
    );
    expect(splitBubbles(many).length).toBe(6);
  });
});

describe('dedupeBubbles', () => {
  it('drops an exact repeat', () => {
    expect(dedupeBubbles(['привет', 'привет', 'как ты'])).toEqual([
      'привет',
      'как ты',
    ]);
  });

  it('drops a bubble that repeats the longer one', () => {
    expect(
      dedupeBubbles(['я вчера ходила в кино с подругой', 'ходила в кино']),
    ).toEqual(['я вчера ходила в кино с подругой']);
  });

  it('keeps distinct bubbles in order', () => {
    expect(dedupeBubbles(['ок', 'а ты?', 'ну такое'])).toEqual([
      'ок',
      'а ты?',
      'ну такое',
    ]);
  });
});
