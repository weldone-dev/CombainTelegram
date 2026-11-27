import type { EveChatMessage } from './eve-llm.service.js';
import type {
  EvePersonaGenInput,
  GeneratedPersonaDocs,
} from './eve-persona-gen.service.js';

/**
 * Prompt building and parsing for the LLM-backed persona/daily-life
 * generators. Pure functions only: no Prisma, no network. The deterministic
 * generators stay the fallback whenever parsing here returns `null`.
 *
 * The prompts are deliberately strict about JSON-only output and about the
 * section layout, because a document with a different shape would leak into
 * the turn prompts (`eve-turn.service.ts`) and into the dashboard editor.
 */

const NATIONALITY_LABEL: Record<string, string> = {
  RU: 'Россия',
  UA: 'Украина',
  BY: 'Беларусь',
  KZ: 'Казахстан',
};

const PERSONA_TITLE = '# ';
const SECTION_PREFIX = '## ';

/** Persona document: seven `## ` sections, the same order as the template. */
const PERSONA_SECTIONS = [
  'Бэкграунд',
  'Характер',
  'Что её бесит',
  'Что ей нравится',
  'Тёмные стороны / комплексы',
  'Что считает кринжем',
  'Отношение к парню-кодеру/геймеру/айтишнику',
] as const;

const SPEECH_SECTIONS = [
  'Длина сообщений',
  'Регистр и пунктуация',
  'Эмодзи и смех',
  'Приветствия и короткие реакции',
  'Сленг',
  'Запрещённые слова',
  'Опечатки',
] as const;

const BOUNDARIES_SECTIONS = [
  'Закрытые темы',
  'Токсичное поведение',
  'Red flags',
  'Зелёные флаги',
  'Как быстро раскрывается',
  'Когда обижается',
  'Игнор',
] as const;

const COMMUNICATION_SECTIONS = [
  'Когда пишет',
  'Стиль сообщений',
  'Эмодзи, стикеры, войсы',
  'Что бесит в переписке',
  'Темы, которые заходят',
  'Темы, которые не заходят',
  'Реакция на голосовые, видео и фото',
] as const;

export const LLM_DOC_MAX_CHARS = 8_000;

/** Weekly routine slot; the shape matches `EvePersona.busySchedule` JSON. */
export interface EveBusySlot {
  label: string;
  days?: string[];
  from: string;
  to: string;
  checkAfterMin?: [number, number];
}

const WEEKDAYS = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

function timeOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/** Validates the optional `busySchedule` key of the persona pack. */
export function parseBusyScheduleItems(value: unknown): EveBusySlot[] | null {
  if (!Array.isArray(value)) return null;
  const slots: EveBusySlot[] = [];
  for (const entry of value.slice(0, 12)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const label =
      typeof row.label === 'string'
        ? row.label.replace(/\s+/g, ' ').trim().slice(0, 80)
        : '';
    const from = timeOf(row.from);
    const to = timeOf(row.to);
    if (!label || !from || !to || from === to) continue;
    const days = Array.isArray(row.days)
      ? row.days.filter(
          (day): day is string => typeof day === 'string' && WEEKDAYS.has(day),
        )
      : undefined;
    const check = Array.isArray(row.checkAfterMin) ? row.checkAfterMin : null;
    const checkAfterMin =
      check &&
      check.length === 2 &&
      Number.isFinite(Number(check[0])) &&
      Number.isFinite(Number(check[1]))
        ? ([
            Math.max(0, Math.round(Number(check[0]))),
            Math.max(0, Math.round(Number(check[1]))),
          ] as [number, number])
        : undefined;
    slots.push({
      label,
      ...(days && days.length > 0 ? { days } : {}),
      from,
      to,
      ...(checkAfterMin ? { checkAfterMin } : {}),
    });
  }
  return slots.length > 0 ? slots : null;
}

/** Shared rubric: no assistant voice, Russian, third person descriptions. */
const VOICE_RULES = [
  'Пиши по-русски, живым человеческим языком, без канцелярита и без списков ради списков.',
  'Ты не ассистент и не пишешь от лица ассистента: в документах запрещены «чем могу помочь», «надеюсь, это поможет», «я здесь, чтобы», «интересный вопрос», «позволь поделиться», «как искусственный интеллект», «безусловно», «разумеется» и любые вежливые формулы поддержки.',
  'Описывай персонажа в третьем лице («она», «ей»), а не обращайся к читателю.',
  'Персонаж — обычная живая девушка из России/СНГ, а не идеальная девушка из рекламы: у неё есть недостатки, лень, тревоги и странности.',
  'Никакого markdown-кода и никаких ```-блоков: только обычный markdown с заголовками и списками.',
].join(' ');

const JSON_ONLY_RULE =
  'Ответ — ровно один JSON-объект и ничего больше: без пояснений до и после, без markdown-ограждений, без комментариев. Все значения строк — обычные строки с переносами внутри как \\n.';

function personaName(name: string): string {
  return name.trim() || 'Она';
}

function personaAge(age: number): number {
  return Math.max(16, Math.min(60, Math.round(age) || 22));
}

function nationalityLabel(nationality: string): string {
  const code = (nationality || 'RU').toUpperCase();
  return NATIONALITY_LABEL[code] ?? code;
}

function sectionsBlock(title: string, sections: readonly string[], hints: string[]): string {
  return [
    `«${title}» — заголовок \`# ...\` и ровно 7 разделов, строго в этом порядке и с этими названиями:`,
    ...sections.map((section, index) => `- ${SECTION_PREFIX}${section} — ${hints[index] ?? ''}`),
  ].join('\n');
}

/**
 * One request for all four persona documents. Four documents are ~3-5k
 * characters total, which fits `maxTokens` (~2800) with Russian text; a
 * truncated answer fails JSON parsing and falls back to the template.
 */
export function buildPersonaDocsMessages(
  persona: EvePersonaGenInput,
): EveChatMessage[] {
  const name = personaName(persona.name);
  const age = personaAge(persona.age);
  const country = nationalityLabel(persona.nationality);
  const vibe = persona.vibe?.trim();

  const system = [
    'Ты — редактор персонажей для реалистичного собеседника в Telegram.',
    VOICE_RULES,
    'Твоя задача — написать четыре markdown-документа персонажа так, чтобы они были самодостаточными, конкретными и не противоречили друг другу.',
    JSON_ONLY_RULE,
  ].join('\n\n');

  const user = [
    `Персонаж: ${name}, ${age} лет, ${country}.`,
    vibe ? `Общее впечатление (вайб): ${vibe}.` : 'Общее впечатление: обычная девушка без пафоса.',
    '',
    'Верни JSON с четырьмя ключами: persona, speech, boundaries, communication. Значения — готовые markdown-строки.',
    'Каждый документ: 500–1400 символов, не больше 8000 символов. Не раздувай текст, лучше конкретика.',
    '',
    sectionsBlock('persona', PERSONA_SECTIONS, [
      '2–4 предложения: город, учёба или работа, с кем и где живёт, как говорит по-русски.',
      'ровно 5 пунктов, каждый — черта характера с бытовой деталью.',
      'ровно 5 пунктов: конкретные мелочи, которые её раздражают.',
      'ровно 5 пунктов: музыка, сериалы, еда, прогулки, мемы — без общих слов.',
      '3–4 пункта: комплексы, страхи и неудобные черты, которые она не признаёт вслух.',
      'ровно 5 пунктов: что она считает кринжем в общении и поведении.',
      '1–2 предложения: спокойно, с интересом или с раздражением относится к программистам/геймерам и почему.',
    ]),
    '',
    sectionsBlock('speech', SPEECH_SECTIONS, [
      'длина сообщений, разбивка на пузыри, как разделяет мысли.',
      'строчные буквы, точки, скобки «)», многоточия — что они значат.',
      'как редко использует эмодзи, как смеётся («ахах», «пхпх»).',
      '5–7 примеров коротких пар «вопрос → ответ» в её манере.',
      '5–8 слов или выражений, которые она реально использует, и как умеренно.',
      'слова и обороты, которые она не говорит никогда (в том числе ассистентские).',
      'как и как часто допускает опечатки, без потери смысла.',
    ]),
    '',
    sectionsBlock('boundaries', BOUNDARIES_SECTIONS, [
      'закрытые темы, о которых она не говорит или говорит одной фразой.',
      'какое поведение считает токсичным и что делает, когда его продавливают.',
      '5–7 тревожных сигналов в человеке.',
      '5–7 признаков нормального, безопасного общения.',
      'как быстро и при каких условиях она открывается.',
      'из-за чего обижается и как это выглядит.',
      'когда и на сколько может пропасть из переписки.',
    ]),
    '',
    sectionsBlock('communication', COMMUNICATION_SECTIONS, [
      'в какое время суток активна, как быстро отвечает.',
      'короткие сообщения, живая речь, без заголовков и списков в чате.',
      'эмодзи, стикеры, голосовые — когда и как.',
      '3–5 вещей, которые бесят в переписке.',
      '5–7 тем, на которые она реагирует охотно.',
      '5–7 тем, которые она сворачивает или избегает.',
      'как реагирует на голосовые, видео и фото.',
    ]),
    '',
    'Дополнительно верни ключ busySchedule — недельное расписание занятости (учёба/работа/тренировки/встречи), 3–6 слотов.',
    'Формат: [{"label":"пары","days":["mon","tue","wed","thu","fri"],"from":"09:00","to":"14:00","checkAfterMin":[5,15]}].',
    'days — только mon,tue,wed,thu,fri,sat,sun; from/to — "HH:MM"; phoneAvailable=false по смыслу — это слот, когда она реально не у телефона. Без пересечений и без часов сна.',
    '',
    'Формат ответа (ключи именно такие, значения — строки):',
    '{"persona":"# ...\\n\\n## Бэкграунд\\n...","speech":"# ...","boundaries":"# ...","communication":"# ...","busySchedule":[...]}',
    '',
    'Ничего кроме этого JSON-объекта в ответе быть не должно.',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export interface EveDailyLifePromptInput {
  name: string;
  age: number;
  nationality: string;
  dateLocal: string;
  vibe?: string | null;
  sleepFrom?: number;
  sleepTo?: number;
  lifeSharing?: string;
}

export const DAILY_LIFE_SOCIAL_VALUES = [
  'alone',
  'with-friends',
  'with-family',
  'with-coworkers',
  'in-transit',
] as const;

/** One day plan as strict JSON; Nest normalizes/clamps the answer. */
export function buildDailyLifeMessages(
  input: EveDailyLifePromptInput,
): EveChatMessage[] {
  const name = personaName(input.name);
  const age = personaAge(input.age);
  const country = nationalityLabel(input.nationality);
  const lifeSharing = input.lifeSharing ?? 'medium';
  const sleepFrom = Number.isFinite(input.sleepFrom) ? input.sleepFrom : 23;
  const sleepTo = Number.isFinite(input.sleepTo) ? input.sleepTo : 8;

  const system = [
    'Ты придумываешь один обычный день для реалистичного русского чат-персонажа.',
    VOICE_RULES,
    'День должен быть бытовым и конкретным: учёба или работа, дорога, еда, домашние дела, встречи, усталость. Без приключений, драмы и идеальности.',
    JSON_ONLY_RULE,
  ].join('\n\n');

  const user = [
    `Персонаж: ${name}, ${age} лет, ${country}.`,
    input.vibe?.trim() ? `Вайб персонажа: ${input.vibe.trim()}.` : '',
    `Дата: ${input.dateLocal}.`,
    `Обычно спит с ${sleepFrom}:00 до ${sleepTo}:00 — планируй только часы бодрствования, но часы в ответе всегда 0–23.`,
    `Насколько она делится своей жизнью: ${lifeSharing} (low — мало событий и больше времени одна, high — больше людей и мелких событий).`,
    '',
    'Верни JSON строго такой формы:',
    '{"weather":"пасмурно","vibe":"обычный день","blocks":[{"fromHour":8,"toHour":11,"activity":"пара по истории","mood":"сонно","social":"with-coworkers","phoneAvailable":false}],"events":["..."],"wants":["..."]}',
    '',
    'Правила:',
    `- blocks: от 4 до 8 блоков, отсортированы по fromHour по возрастанию, fromHour и toHour — целые числа 0–23.`,
    `- social — строго одно из значений: ${DAILY_LIFE_SOCIAL_VALUES.join(', ')}. Других значений быть не может.`,
    '- phoneAvailable — булево: false, когда она на парах, на работе, в душе, спит или занята так, что не ответит.',
    '- activity — короткая фраза по-русски в её стиле, без кавычек-ёлочек вокруг всего блока.',
    '- mood — одно-два слова по-русски.',
    '- events — 2–4 коротких события дня (зачёт, встреча, очередь, покупка).',
    '- wants — 2–4 коротких желания (кофе, поспать, погулять, поговорить с ним).',
    '- Никаких дат внутри событий, никаких объяснений, только JSON.',
  ]
    .filter((line) => line !== '')
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Tolerant JSON extraction: strips fences and picks the outer object. */
export function parseLlmJson(raw: string): Record<string, unknown> | null {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(text);
  if (fence?.[1]) text = fence[1].trim();
  if (!text.startsWith('{')) {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    text = text.slice(start, end + 1);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function normalizeDoc(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Some providers escape newlines twice; the prompt already asks for real
  // strings, so only repair a literal "\n" that JSON kept as text.
  const text = value.replace(/\\n/g, '\n').trim();
  if (!text) return null;
  if (text.length > LLM_DOC_MAX_CHARS) return null;
  if (!text.startsWith(PERSONA_TITLE)) return null;
  return text;
}

function h2Sections(markdown: string): string[] {
  const lines = markdown.split('\n');
  const sections: string[] = [];
  let current: string[] | null = null;
  for (const line of lines) {
    if (line.startsWith(SECTION_PREFIX)) {
      if (current) sections.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) sections.push(current.join('\n'));
  return sections;
}

function bulletCount(section: string): number {
  return section
    .split('\n')
    .slice(1)
    .filter((line) => /^\s*[-*]\s+\S/.test(line)).length;
}

/**
 * Structural check shared by all four documents: an H1 and seven H2 sections.
 * Persona bullet counts are enforced too, because the turn prompt relies on
 * those lists being real lists (5/5/5/3-4/5).
 */
function validDoc(
  markdown: string,
  persona: boolean,
): boolean {
  const sections = h2Sections(markdown);
  if (sections.length !== 7) return false;
  if (!sections.every((section) => section.length > SECTION_PREFIX.length)) {
    return false;
  }
  if (!persona) return true;

  const background = sections[0];
  if (!background || background.length < 80) return false;
  const expected = [5, 5, 5, null, 5];
  const indexes = [1, 2, 3, 4, 5];
  for (let index = 0; index < indexes.length; index++) {
    const count = bulletCount(sections[indexes[index]!]!);
    const want = expected[index];
    if (want === null) {
      if (count < 3 || count > 4) return false;
    } else if (count !== want) {
      return false;
    }
  }
  return true;
}

/** Returns `null` when the model produced a partial or malformed pack. */
export function parsePersonaDocs(raw: string): GeneratedPersonaDocs | null {
  const value = parseLlmJson(raw);
  if (!value) return null;

  const persona = normalizeDoc(value.persona);
  const speech = normalizeDoc(value.speech);
  const boundaries = normalizeDoc(value.boundaries);
  const communication = normalizeDoc(value.communication);
  if (!persona || !speech || !boundaries || !communication) return null;

  if (!validDoc(persona, true)) return null;
  if (!validDoc(speech, false)) return null;
  if (!validDoc(boundaries, false)) return null;
  if (!validDoc(communication, false)) return null;

  const busySchedule = parseBusyScheduleItems(value.busySchedule);
  return {
    persona,
    speech,
    boundaries,
    communication,
    ...(busySchedule ? { busySchedule } : {}),
  };
}
