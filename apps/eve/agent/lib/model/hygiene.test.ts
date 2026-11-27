import { describe, expect, test } from 'bun:test';
import {
  CONTEXT_MAX_OUTPUT_TOKENS,
  CONTEXT_TEMPERATURE,
  contextHygieneMiddleware,
  filterPrompt,
  filterReasoningStream,
  stripInternalLines,
} from './hygiene';

describe('stripInternalLines', () => {
  test('removes a frame glued to his message', () => {
    expect(
      stripInternalLines(
        '[internal: intent=reply; bubbles=1]\n[internal: это ответ на «ок».]\nпривет, как ты?',
      ),
    ).toBe('привет, как ты?');
  });

  test('removes a closed inline frame', () => {
    expect(
      stripInternalLines('ок [internal: он прислал фото] смотри'),
    ).toBe('ок  смотри');
  });
});

describe('filterPrompt', () => {
  test('drops reasoning from assistant history and service-only user turns', () => {
    const prompt = filterPrompt([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'The user says it is a test' },
          { type: 'text', text: 'да никак, сижу с кофе' },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: '[internal: intent=reply]' }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'stage=convinced; interest=12; trust=8',
          },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'ну что там?' }],
      },
    ]);

    expect(prompt).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'да никак, сижу с кофе' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'ну что там?' }],
      },
    ]);
  });

  test('keeps a mixed old message but strips the frame lines', () => {
    const prompt = filterPrompt([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[internal: hint=занята]\nя на съёмке, позже',
          },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ок' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'ну что?' }],
      },
    ]);
    expect(prompt).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: 'я на съёмке, позже' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ок' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'ну что?' }],
      },
    ]);
  });

  test('never drops the current input even if it looks like a frame', () => {
    const prompt = filterPrompt([
      {
        role: 'user',
        content: [{ type: 'text', text: '[internal: привет]' }],
      },
    ]);
    expect(prompt).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '[internal: привет]' }],
      },
    ]);
  });
});

describe('reasoning stream filter', () => {
  test('never forwards reasoning parts to the harness', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'reasoning-start', id: 'r' });
        controller.enqueue({ type: 'reasoning-delta', id: 'r', delta: 'hmm' });
        controller.enqueue({ type: 'reasoning-end', id: 'r' });
        controller.enqueue({ type: 'text-delta', id: 't', delta: 'ок' });
        controller.close();
      },
    });
    const parts: unknown[] = [];
    for await (const part of filterReasoningStream(stream)) parts.push(part);
    expect(parts).toEqual([{ type: 'text-delta', id: 't', delta: 'ок' }]);
  });
});

describe('call options', () => {
  test('sets the girl-agent temperature and output ceiling', async () => {
    const params = {
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'привет' }] }],
      temperature: 0.2,
    };
    const result = await contextHygieneMiddleware.transformParams!({
      type: 'stream',
      params: params as never,
      model: {} as never,
    });
    expect(result.temperature).toBe(CONTEXT_TEMPERATURE);
    expect(result.maxOutputTokens).toBe(CONTEXT_MAX_OUTPUT_TOKENS);
  });
});
