import type { EveChatMessage } from './eve-llm.service.js';

/**
 * Prompts for the two agenda LLM calls.
 *
 * Both are strict JSON and both degrade to the deterministic agenda when the
 * provider is absent or the answer is malformed: the schedule must keep
 * working without a model.
 */

const JSON_ONLY =
  'Ответ — ровно один JSON-объект и ничего больше: без markdown, без пояснений и без текста вокруг.';

export interface AgendaExtractInput {
  personaName: string;
  stage: string;
  stageDescription: string;
  communication: string;
  history: Array<{ role: string; content: string }>;
  incoming: string;
  existing: Array<{ id: string; about: string; pingAt: string; state: string }>;
  recentProactive?: { id: string; about: string; sentAt: string } | null;
  now: string;
  timezone: string;
}

export function buildAgendaExtractMessages(
  input: AgendaExtractInput,
): EveChatMessage[] {
  const history = input.history
    .slice(-8)
    .map((turn) => `${turn.role === 'assistant' ? 'она' : 'он'}: ${turn.content}`)
    .join('\n');
  const existing = input.existing.length
    ? input.existing
        .map((item) => `- id=${item.id} state=${item.state} pingAt=${item.pingAt}: ${item.about}`)
        .join('\n')
    : '(пусто)';

  const system = [
    'Ты — планировщик памяти персоны в Telegram. Твоя задача — вытащить из его сообщения реальные события и обязательства, а не придумать новые.',
    'Не выдумывай события, которых нет в тексте. Если он ничего не назвал — верни {"actions":[]}.',
    JSON_ONLY,
  ].join('\n');

  const user = [
    `Персона: ${input.personaName}. Стадия: ${input.stage} — ${input.stageDescription}.`,
    `Манера общения: ${input.communication}.`,
    `Сейчас: ${input.now} (${input.timezone}).`,
    '',
    'Последние сообщения:',
    history || '(нет)',
    '',
    `Новое сообщение от него: """${input.incoming}"""`,
    '',
    'Текущая агенда:',
    existing,
    input.recentProactive
      ? `\nНедавний проактивный пинг (если его сообщение — ответ на него): id=${input.recentProactive.id}, about="${input.recentProactive.about}", отправлен ${input.recentProactive.sentAt}.`
      : '',
    '',
    'Что можно делать:',
    '- create: он назвал событие в будущем («завтра соревнования», «в пятницу защита») или попросил напомнить. about — короткая заметка от её лица; pingAt — когда уместно спросить, как прошло; userEventTime — когда событие само.',
    '- update: уточнил время/детали существующего пункта.',
    '- cancel: событие отменилось или стало неактуальным.',
    '- noop: ничего не делать.',
    '',
    'Правила:',
    '- pingAt в будущем, не ночью и не больше чем через 14 дней.',
    '- Не дублируй существующие пункты.',
    '- importance: 1 — мелочь, 2 — заметное, 3 — важное для него.',
    '- Если он просто ответил на пинг и тема закрыта — cancel этого пинга.',
    '',
    'Формат:',
    '{"actions":[{"action":"create","about":"спросить, как прошли соревнования","pingAt":"2026-11-28T18:00:00+03:00","userEventTime":"2026-11-28T10:00:00+03:00","reason":"он сам рассказал","importance":2}]}',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export interface AutonomousAgendaInput {
  personaName: string;
  stage: string;
  stageDescription: string;
  score: string;
  communication: string;
  personaDoc: string;
  dailyLife: string;
  history: Array<{ role: string; content: string }>;
  memory: string;
  existing: string[];
  now: string;
  timezone: string;
  maxItems: number;
}

export function buildAutonomousAgendaMessages(
  input: AutonomousAgendaInput,
): EveChatMessage[] {
  const history = input.history
    .slice(-16)
    .map((turn) => `${turn.role === 'assistant' ? 'она' : 'он'}: ${turn.content}`)
    .join('\n');

  const system = [
    'Ты придумываешь, о чём живая девушка сама напишет парню в Telegram в ближайшие часы.',
    'Это её инициатива, а не обслуживание: своя жизнь, настроение, бытовые мелочи, лёгкая тоска.',
    'Не выдумывай события и темы, которых не было в переписке или памяти. Если не за что зацепиться — пиши про свой день.',
    JSON_ONLY,
  ].join('\n');

  const user = [
    `Персона: ${input.personaName}. Стадия: ${input.stage} — ${input.stageDescription}.`,
    `Score отношений: ${input.score}.`,
    `Манера общения: ${input.communication}.`,
    `Сейчас: ${input.now} (${input.timezone}).`,
    `Можно создать 0–${input.maxItems} сообщений на ближайшие 18 часов.`,
    '',
    '# Персона',
    input.personaDoc,
    '',
    '# Её день',
    input.dailyLife,
    '',
    '# Что она помнит о нём',
    input.memory || '(пока ничего — не придумывай факты)',
    '',
    '# Переписка',
    history || '(нет)',
    '',
    `# Уже запланировано: ${input.existing.join('; ') || '(пусто)'}`,
    '',
    'Правила:',
    '- about — короткая фраза, с которой она начнёт («скинуть мем про пары», «спросить, как прошёл созвон»).',
    '- pingAt в будущем, не во сне и не в блоке без телефона, разнос минимум 45 минут.',
    '- Не «как дела» без повода, не липкость на холодной стадии, без дублей.',
    '- Если сегодня писать первой неуместно — {"items":[]}.',
    '',
    'Формат:',
    '{"items":[{"about":"скинуть мем про её пары","reason":"вспомнила разговор","importance":1,"pingAt":"2026-11-27T19:40:00+03:00"}]}',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Extracts the `items` array from either a bare array or `{items: []}`. */
export function parseAgendaItems(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>).items;
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** Extracts the `actions` array from `{actions: []}` or a bare array. */
export function parseAgendaActions(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    const value = (raw as Record<string, unknown>).actions;
    if (Array.isArray(value)) return value;
  }
  return [];
}

export interface AgendaDayBlock {
  fromHour: number;
  toHour: number;
  phoneAvailable: boolean;
}

export interface NormalizedAgendaItem {
  about: string;
  reason: string;
  pingAt: number;
  importance: 1 | 2 | 3;
  userEventTime?: number;
}

export interface NormalizeAgendaOptions {
  now: number;
  timezone: string;
  sleepFrom: number;
  sleepTo: number;
  blocks?: AgendaDayBlock[];
  existing?: string[];
  limit: number;
  horizonMs?: number;
  minGapMs?: number;
}

function localHourOf(ms: number, timezone: string): number {
  try {
    const value = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      hour12: false,
    }).format(new Date(ms));
    const hour = Number(value);
    return Number.isFinite(hour) ? hour % 24 : new Date(ms).getHours();
  } catch {
    return new Date(ms).getHours();
  }
}

function inSleep(hour: number, from: number, to: number): boolean {
  if (from === to) return false;
  return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}

function quiet(ms: number, options: NormalizeAgendaOptions): boolean {
  const hour = localHourOf(ms, options.timezone);
  if (inSleep(hour, options.sleepFrom, options.sleepTo)) return true;
  const block = options.blocks?.find((entry) => {
    if (entry.fromHour === entry.toHour) return false;
    return entry.fromHour < entry.toHour
      ? hour >= entry.fromHour && hour < entry.toHour
      : hour >= entry.fromHour || hour < entry.toHour;
  });
  return block !== undefined && !block.phoneAvailable;
}

function about(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function duplicate(aboutText: string, pool: string[]): boolean {
  const needle = aboutText.toLowerCase();
  return pool.some((value) => {
    const hay = value.toLowerCase();
    return hay.includes(needle) || needle.includes(hay);
  });
}

/**
 * Validates LLM-proposed agenda items: future window, sleep/quiet blocks,
 * duplicates and 45-minute spacing. Invalid entries are dropped, not thrown;
 * the caller still creates the valid ones.
 */
export function normalizeLlmAgendaItems(
  raw: unknown,
  options: NormalizeAgendaOptions,
): { items: NormalizedAgendaItem[]; rejected: number } {
  const list = Array.isArray(raw) ? raw : [];
  const horizon = options.horizonMs ?? 18 * 3_600_000;
  const minGap = options.minGapMs ?? 45 * 60_000;
  const existing = [...(options.existing ?? [])];
  const accepted: NormalizedAgendaItem[] = [];
  let rejected = 0;

  for (const entry of list) {
    if (accepted.length >= Math.max(0, options.limit)) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      rejected += 1;
      continue;
    }
    const row = entry as Record<string, unknown>;
    const text = typeof row.about === 'string' ? about(row.about) : '';
    const pingRaw =
      typeof row.pingAt === 'string' || typeof row.pingAt === 'number'
        ? new Date(row.pingAt).getTime()
        : Number.NaN;
    if (text.length < 3 || !Number.isFinite(pingRaw)) {
      rejected += 1;
      continue;
    }
    if (
      pingRaw < options.now + 5 * 60_000 ||
      pingRaw > options.now + horizon ||
      quiet(pingRaw, options) ||
      duplicate(text, existing) ||
      accepted.some((item) => Math.abs(item.pingAt - pingRaw) < minGap)
    ) {
      rejected += 1;
      continue;
    }
    const importance = Math.round(Number(row.importance ?? 1));
    const importanceValue: 1 | 2 | 3 =
      importance >= 3 ? 3 : importance <= 1 ? 1 : 2;
    const userEventRaw =
      typeof row.userEventTime === 'string' || typeof row.userEventTime === 'number'
        ? new Date(row.userEventTime).getTime()
        : Number.NaN;
    accepted.push({
      about: text,
      reason:
        typeof row.reason === 'string' && row.reason.trim()
          ? row.reason.trim().slice(0, 160)
          : 'самой захотелось написать',
      pingAt: pingRaw,
      importance: importanceValue,
      ...(Number.isFinite(userEventRaw) ? { userEventTime: userEventRaw } : {}),
    });
    existing.push(text);
  }
  return { items: accepted, rejected };
}
