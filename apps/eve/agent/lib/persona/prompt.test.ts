import { describe, expect, test } from 'bun:test';
import {
  ANTI_AI_RULES,
  buildPromptMessages,
  buildSystemPrompt,
} from './prompt';
import type { DailyLife, PersonaConfig, RelationshipScore } from './types';

const NOW = Date.UTC(2026, 10, 27, 9, 0, 0);

const config: PersonaConfig = {
  name: 'Аня',
  age: 22,
  timezone: 'Europe/Moscow',
  stage: 'dating-early',
  communication: { messageStyle: 'balanced', notifications: 'normal' },
  ignoreTendency: 35,
};

const score: RelationshipScore = {
  interest: 70,
  trust: 60,
  attraction: 65,
  annoyance: 5,
  cringe: 0,
};
const day: DailyLife = {
  dateLocal: '2026-11-27',
  vibe: 'спокойный',
  blocks: [
    {
      fromHour: 10,
      toHour: 14,
      activity: 'на парах',
      social: 'with-coworkers',
      phoneAvailable: true,
    },
  ],
  events: ['завалила тест'],
  wants: ['спать'],
};

describe('system prompt', () => {
  test('keeps the priority order: anti-AI first, relationship near the end', () => {
    const prompt = buildSystemPrompt({
      config,
      score,
      now: NOW,
      documents: {
        persona: 'любит кофе и глупые мемы',
        speech: 'пишет коротко',
        boundaries: 'не обсуждает бывших',
      },
      presence: {
        online: false,
        asleep: false,
        nightAwake: false,
        nextCheckSec: 600,
        localHour: 12,
        hint: 'сейчас не в сети, но уведомление увидела',
        pattern: 'burst-checker',
        coldActive: false,
        forcedWake: false,
      },
      dailyLife: day,
      memory: {
        facts: 'его зовут Дима, работает программистом',
        episodes: 'вчера обсуждали кота',
      },
      conflict: {
        level: 2,
        coldUntil: new Date(NOW + 2 * 3_600_000).toISOString(),
        reason: 'обижена',
        since: new Date(NOW - 3_600_000).toISOString(),
        history: [],
      },
      notes: 'недавно поссорились из-за встречи',
    });

    expect(prompt.startsWith(ANTI_AI_RULES.split('\n')[0]!)).toBe(true);
    expect(prompt).toContain('Аня, 22');
    expect(prompt).toContain('любит кофе');
    expect(prompt).toContain('пишет коротко');
    expect(prompt).toContain('не обсуждает бывших');
    expect(prompt).toContain('уведомление увидела');
    expect(prompt).toContain('на парах');
    expect(prompt).toContain('Конфликт (уровень 2)');
    expect(prompt).toContain('его зовут Дима');
    expect(prompt).toContain('Только начали встречаться');
    expect(prompt).toContain('недавно поссорились');

    // Relationship block must come after memory, before the stranger block.
    expect(prompt.indexOf('# Что ты помнишь')).toBeLessThan(
      prompt.indexOf('# Отношения:'),
    );
    // Anti-AI rules must be the very first block.
    expect(prompt.indexOf(ANTI_AI_RULES)).toBe(0);
  });

  test('acquaintance mode drops shared memory and adds a hard boundary', () => {
    const prompt = buildSystemPrompt({
      config,
      score,
      now: NOW,
      acquaintance: true,
      committedPrimary: true,
      romanticApproach: true,
      memory: { facts: 'секретный факт, который нельзя использовать' },
    });
    expect(prompt).toContain('Это не твой парень');
    expect(prompt).toContain('у меня есть парень');
    expect(prompt).toContain('Он подкатывает');
    expect(prompt).not.toContain('секретный факт');
  });

  test('empty optional blocks do not leave blank sections', () => {
    const prompt = buildSystemPrompt({ config, score, now: NOW });
    expect(prompt).not.toContain('## Личность\n\n');
    expect(prompt.trim()).toBe(prompt);
    expect(prompt.length).toBeGreaterThan(1000);
  });
});

describe('prompt messages', () => {
  test('system, trimmed history and current incoming', () => {
    const messages = buildPromptMessages(
      {
        config,
        score,
        now: NOW,
        history: Array.from({ length: 10 }, (_, index) => ({
          role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
          content: `ход ${index}`,
        })),
        incoming: 'привет, как ты?',
      },
      { historyLimit: 4, behaviorHint: 'пузырей=2, разделяй ---' },
    );
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('пузырей=2');
    expect(messages).toHaveLength(1 + 4 + 1);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'привет, как ты?' });
    expect(messages[1]?.content).toBe('ход 6');
  });

  test('current message is not duplicated when history is empty', () => {
    const messages = buildPromptMessages(
      { config, score, now: NOW, incoming: 'ну?' },
      { historyLimit: 10 },
    );
    expect(messages).toHaveLength(2);
    expect(messages[1]?.content).toBe('ну?');
  });
});
