import { afterEach, describe, expect, it } from 'bun:test';
import { configuredModel, isContextHygieneWrapped } from './config';

const ENV_KEYS = [
  'EVE_LLM_BASE_URL',
  'EVE_LLM_API_KEY',
  'EVE_LLM_MODEL',
  'AI_BASE_URL',
  'AI_API_KEY',
  'AI_MODEL',
  'EVE_MODEL',
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
});

describe('configuredModel', () => {
  it('wraps the gateway string branch so hygiene is never silently off', () => {
    process.env.EVE_MODEL = 'deepseek/deepseek-v4.1-flash';

    const model = configuredModel();

    expect(typeof model).toBe('object');
    expect(isContextHygieneWrapped(model)).toBe(true);
    expect(model.provider).toBe('gateway');
    expect(model.modelId).toBe('deepseek/deepseek-v4.1-flash');
  });

  it('wraps the OpenAI-compatible provider branch', () => {
    process.env.EVE_LLM_BASE_URL = 'http://127.0.0.1:9/v1';
    process.env.EVE_LLM_API_KEY = 'test-key';
    process.env.EVE_LLM_MODEL = 'deepseek-v4.1-flash';

    const model = configuredModel();

    expect(isContextHygieneWrapped(model)).toBe(true);
    expect(model.modelId).toBe('deepseek-v4.1-flash');
  });

  it('wraps the built-in default model', () => {
    const model = configuredModel();

    expect(isContextHygieneWrapped(model)).toBe(true);
    expect(model.provider).toBe('gateway');
  });
});
