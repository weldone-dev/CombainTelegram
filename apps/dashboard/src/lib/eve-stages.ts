/**
 * Дубликат `apps/eve/agent/lib/persona/relationship.ts` (`STAGE_PRESETS`):
 * id + русский label в том же порядке. Неизвестная стадия в Nest падает в
 * `tg-given-cold`, поэтому список держим ровно как в движке.
 *
 * Общий модуль для формы персоны (`/eve`) и карточки отношений в панели чата.
 */
export const EVE_STAGES = [
  { id: "met-irl-got-tg", label: "Познакомились вживую, дала телеграм" },
  { id: "tg-given-cold", label: "Дала телеграм, но холодна" },
  { id: "tg-given-warming", label: "Дала телеграм, оттаивает" },
  { id: "convinced", label: "Убедил, что с тобой интересно" },
  { id: "first-date-done", label: "Сходили на одно свидание" },
  { id: "dating-early", label: "Только начали встречаться" },
  { id: "dating-stable", label: "Стабильная пара" },
  { id: "long-term", label: "Давно вместе" },
  { id: "dumped", label: "Отшила" },
] as const;

/** Русский label стадии; неизвестный id возвращается как есть. */
export function eveStageLabel(stage: string): string {
  return EVE_STAGES.find((item) => item.id === stage)?.label ?? stage;
}
