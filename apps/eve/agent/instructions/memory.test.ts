import { describe, expect, test } from 'bun:test';
import { renderMemory } from './memory';

describe('memory system block', () => {
  test('renders palace halls, promises, timeline and episodes without duplicate labels', () => {
    const content = renderMemory({
      relationship: { stage: 'convinced', attraction: 60, trust: 40 },
      facts: [{ text: 'он любит кофе' }],
      timeItems: [
        { text: 'обещал скинуть фото', hall: 'promise' },
        { text: 'не договорили про поездку', hall: 'open-loop' },
      ],
      events: [{ text: 'первое свидание', date: '2026-11-20T10:00:00.000Z' }],
      episodes: [{ text: 'смотрели кадры', date: '2026-11-25' }],
      palace: [
        { text: 'не договорили, куда ехать', hall: 'open_loops' },
        { text: 'после съёмки было тепло', hall: 'feelings' },
      ],
    });

    expect(content).toContain('# Воспоминания о нём');
    expect(content).toContain('Факты о нём:');
    expect(content).toContain('обещал скинуть фото');
    expect(content).toContain('2026-11-20: первое свидание');
    expect(content).toContain('после съёмки было тепло');
    expect(content).toContain('Привязанность:');
    // The palace hall and the time item share the label; it appears once.
    expect(content.match(/Открытые петли:/g)).toHaveLength(1);
  });

  test('drops reasoning and deletion-transcript noise', () => {
    const content = renderMemory({
      facts: [
        { text: 'The user says it is a test\nон любит кофе' },
        { text: '"«люблю тебя» и сразу удалил" --- "ну ты даёшь" Good — подкол' },
      ],
    });
    expect(content).toContain('он любит кофе');
    expect(content).not.toContain('The user says');
    expect(content).not.toContain('Good —');
    expect(content).not.toContain('удалил');
  });

  test('returns an empty string when there is nothing to remember', () => {
    expect(renderMemory({})).toBe('');
  });
});
