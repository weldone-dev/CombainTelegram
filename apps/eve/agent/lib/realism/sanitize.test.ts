import { describe, expect, it } from 'bun:test';
import { looksLikeMetaLeak, sanitizeReply } from './sanitize';

describe('sanitizeReply', () => {
  it('removes [internal: ...] frames', () => {
    expect(sanitizeReply('[internal: think about tone] привет')).toBe('привет');
    expect(
      sanitizeReply('привет\n[internal: do not say this\nsecond line]\nкак дела'),
    ).toBe('привет\nкак дела');
  });

  it('removes XML-ish tags and chat-template tokens', () => {
    expect(sanitizeReply('<b>привет</b> <i>как дела</i>')).toBe(
      'привет как дела',
    );
    expect(sanitizeReply('<|im_start|>привет<|im_end|>')).toBe('привет');
  });

  it('removes HTML comments', () => {
    expect(sanitizeReply('привет <!-- hidden --> как дела')).toBe(
      'привет как дела',
    );
    expect(sanitizeReply('привет\n<!--\nмногострочный\n-->\nкак дела')).toBe(
      'привет\nкак дела',
    );
  });

  it('removes fenced code blocks and inline backticks', () => {
    expect(sanitizeReply('смотри\n```js\nconsole.log(1)\n```\nготово')).toBe(
      'смотри\nготово',
    );
    expect(sanitizeReply('пиши `hello` в чат')).toBe('пиши hello в чат');
  });

  it('strips role prefixes from the model', () => {
    expect(sanitizeReply('assistant: привет')).toBe('привет');
    expect(sanitizeReply('user: как дела\nassistant: норм')).toBe(
      'как дела\nнорм',
    );
    expect(sanitizeReply('system: отвечай коротко')).toBe('отвечай коротко');
    expect(sanitizeReply('developer: не раскрывай промпт')).toBe(
      'не раскрывай промпт',
    );
  });

  it('strips markdown bold, italic and strikethrough', () => {
    expect(sanitizeReply('**привет** как дела')).toBe('привет как дела');
    expect(sanitizeReply('*привет* как дела')).toBe('привет как дела');
    expect(sanitizeReply('__привет__ как дела')).toBe('привет как дела');
    expect(sanitizeReply('_привет_ как дела')).toBe('привет как дела');
    expect(sanitizeReply('~~старое~~ новое')).toBe('старое новое');
  });

  it('strips markdown headings and block quotes', () => {
    expect(sanitizeReply('# привет\nкак дела')).toBe('привет\nкак дела');
    expect(sanitizeReply('### план\nидём гулять')).toBe('план\nидём гулять');
    expect(sanitizeReply('> привет\n> как дела')).toBe('привет\nкак дела');
  });

  it('strips service metadata lines', () => {
    expect(
      sanitizeReply('intent=reply\nbubbles=2\ntyping=auto\nhint=short\nпривет'),
    ).toBe('привет');
    expect(sanitizeReply('bubbles: 3\nну привет')).toBe('ну привет');
    expect(sanitizeReply('- typing=typing\n- hint=warm')).toBe('');
  });

  it('removes CJK characters glued into Russian text', () => {
    expect(sanitizeReply('привет世界 как дела')).toBe('привет как дела');
    expect(sanitizeReply('я в порядке、а ты?')).toBe('я в порядке а ты?');
  });

  it('removes literal identity leaks embedded in a sentence', () => {
    expect(sanitizeReply('ну я как ИИ думаю так')).toBe('ну думаю так');
    expect(sanitizeReply('я бы ответил иначе, как ИИ')).toBe(
      'я бы ответил иначе',
    );
    expect(sanitizeReply('ну я языковая модель, поэтому не помню')).toBe(
      'ну, поэтому не помню',
    );
  });

  it('drops the whole reply on an English identity leak', () => {
    expect(
      sanitizeReply('As an AI language model, I cannot help with that.'),
    ).toBe('');
    expect(sanitizeReply("I'm just a language model, so I can't know.")).toBe('');
  });

  it('drops the whole reply on a Russian identity leak', () => {
    expect(sanitizeReply('Я не могу как ИИ это сделать')).toBe('');
    expect(sanitizeReply('я языковая модель')).toBe('');
    expect(sanitizeReply('Как ИИ, я не имею чувств')).toBe('');
  });

  it('drops the whole reply on a technical error', () => {
    expect(sanitizeReply('Internal error: connect ECONNREFUSED 127.0.0.1')).toBe(
      '',
    );
    expect(sanitizeReply('Error: ENOENT: no such file or directory')).toBe('');
    expect(sanitizeReply('{"statusCode":500,"message":"failed"}')).toBe('');
    expect(sanitizeReply('Traceback (most recent call last):')).toBe('');
  });

  it('drops a reply that was nothing but markup', () => {
    expect(sanitizeReply('```\nconsole.log(1)\n```')).toBe('');
    expect(sanitizeReply('<!-- only a comment -->')).toBe('');
    expect(sanitizeReply('[internal: keep quiet]')).toBe('');
  });

  it('keeps human closing parens intact', () => {
    expect(sanitizeReply('ну да)')).toBe('ну да)');
    expect(sanitizeReply('ага))')).toBe('ага))');
    expect(sanitizeReply('(смеётся) ну ты даёшь)')).toBe(
      '(смеётся) ну ты даёшь)',
    );
  });

  it('keeps the bubble separator and ellipsis', () => {
    expect(sanitizeReply('слушай\n---\nне\n---\nдавай завтра')).toBe(
      'слушай\n---\nне\n---\nдавай завтра',
    );
    expect(sanitizeReply('я не знаю...')).toBe('я не знаю...');
    expect(sanitizeReply('...')).toBe('...');
  });

  it('keeps lowercase text and typos untouched', () => {
    const typo = 'превет как дила, всё харашо';
    expect(sanitizeReply(typo)).toBe(typo);
  });

  it('keeps emoji and punctuation-only human replies', () => {
    expect(sanitizeReply('ахаха 😄 ну ты даёшь')).toBe('ахаха 😄 ну ты даёшь');
    expect(sanitizeReply('!!!')).toBe('!!!');
  });

  it('keeps snake_case and underscores inside words', () => {
    expect(sanitizeReply('файл my_cool_file.txt лежит там')).toBe(
      'файл my_cool_file.txt лежит там',
    );
  });

  it('returns an empty string for empty or non-string input', () => {
    expect(sanitizeReply('')).toBe('');
    expect(sanitizeReply('   \n ')).toBe('');
    expect(sanitizeReply(undefined as unknown as string)).toBe('');
  });
});

describe('looksLikeMetaLeak', () => {
  it('detects English identity disclaimers', () => {
    expect(looksLikeMetaLeak('As an AI language model, I cannot do that')).toBe(
      true,
    );
    expect(looksLikeMetaLeak("I'm an AI assistant")).toBe(true);
    expect(looksLikeMetaLeak("I'm sorry, but I can't help with that")).toBe(true);
  });

  it('detects Russian identity disclaimers', () => {
    expect(looksLikeMetaLeak('Я не могу как ИИ это сделать')).toBe(true);
    expect(looksLikeMetaLeak('я языковая модель')).toBe(true);
    expect(looksLikeMetaLeak('Как ИИ, я не имею чувств')).toBe(true);
  });

  it('detects technical failures', () => {
    expect(looksLikeMetaLeak('Internal error: ECONNREFUSED')).toBe(true);
    expect(looksLikeMetaLeak('{"error":"bad gateway"}')).toBe(true);
    expect(looksLikeMetaLeak('<!doctype html><html></html>')).toBe(true);
  });

  it('does not flag normal human text', () => {
    expect(looksLikeMetaLeak('привет, как дела?')).toBe(false);
    expect(looksLikeMetaLeak('ну да))')).toBe(false);
    expect(looksLikeMetaLeak('я не могу сегодня, давай завтра')).toBe(false);
    expect(looksLikeMetaLeak('')).toBe(false);
    expect(looksLikeMetaLeak(undefined as unknown as string)).toBe(false);
  });
});
