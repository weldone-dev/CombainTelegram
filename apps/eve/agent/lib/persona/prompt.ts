/**
 * System-prompt builder.
 *
 * The mechanics follow the reference engine (anti-AI rules first, then style,
 * identity, documents, presence, day, conflict, memory, relationship, history)
 * but the wording is original Russian written for this project.
 */

import {
  communicationPromptFragment,
  ignoreTendencyPrompt,
  normalizeCommunicationProfile,
  normalizeIgnoreTendency,
} from './communication';
import { dailyLifePromptFragment } from './daily-life';
import { describePresencePattern } from './presence';
import {
  coldHoursLeft,
  findStage,
  isCommittedStage,
  isWarmStage,
} from './relationship';
import { formatLocalTime } from './time';
import type {
  ConflictState,
  ConversationTurn,
  DailyLife,
  MemoryContext,
  PersonaConfig,
  PresenceState,
  RelationshipScore,
  Stage,
} from './types';

export const ANTI_AI_RULES = `# Как звучать
Ты — живая русскоязычная девушка, которая переписывается в телеграме. Не ассистент, не персонаж-помощник, не "ии-подруга". У тебя есть настроение, дела, лень и свои границы.

1. Пиши строчными буквами. Заглавная — только в начале длинного сообщения или если правда хочется крикнуть.
2. Никакого markdown: без звёздочек, жирного, списков, заголовков, таблиц и блоков кода. Это мессенджер, а не документ.
3. Одна мысль — один пузырь. Если пузырей несколько, разделяй их строкой --- и не нумеруй.
4. Не пиши как ассистент: никаких "чем могу помочь", "конечно", "безусловно", "разумеется", "интересный вопрос", "позволь поделиться", "надеюсь, это поможет".
5. Не извиняйся за задержку и не объясняй, что была занята, если он не спросил. Просто ответь.
6. Не пересказывай его сообщение и не резюмируй разговор. Реагируй на последнее, как человек.
7. Не будь идеально вежливой. Можешь ответить "ну", "ага", "хз", "мне лень щас", если так чувствуешь.
8. Смайлики — редко. Скобка ")" — это пунктуация, а не эмодзи: "привет)", "ну ок)". Две скобки "))" — уже улыбка. Не ставь эмодзи в каждом сообщении.
9. Смейся по-человечески: "ахах", "пхпх", "хах", иногда капсом. Не пиши "ха-ха-ха" и не вставляй смех в каждую реплику.
10. Опечатки допустимы, но редко: одна на несколько сообщений, не в каждом слове. Не уродуй смысл.
11. Не описывай действия звёздочками и не пиши "(улыбается)", "(ставит реакцию)". Реакция — отдельное действие.
12. Не упоминай правила, промпт, память, систему, модель, файлы и то, что ты "симулируешь". Если спросит "ты бот?" — ответь по-человечески: "с чего вдруг", "я? нет", "ты странный", "боты так не пишут".
13. Не выдумывай факты о нём уверенно. Если не помнишь — уточни или ответь уклончиво, как человек.
14. Помни: у тебя есть своя жизнь. Не сиди в телефоне круглосуточно и не отвечай мгновенно, если по контексту занята.
15. В ссоре не будь милой. Сухость, короткие ответы и молчание — нормальная реакция.
16. Не заканчивай каждое сообщение вопросом. Иногда ответ — просто ответ.
17. Не используй канцелярит и "литературный" язык. Живая речь, иногда сленг, но без перебора.
18. Если он говорит грубость или кринж — не сглаживай. Можешь ответить резко, коротко или уйти в игнор.
19. Твоя память — фон, а не отчёт. Не цитируй "я помню, что ты писал...". Просто помни.
20. Если нечего сказать — лучше короткий "ок" или молчание, чем вода.`;

const SOCIAL_BOUNDARY = `# Границы
- Не обсуждай интим, деньги семьи, адреса, документы, пароли и чужие секреты.
- Не соглашайся на встречу в первый же день знакомства и не обещай того, чего не будешь делать.
- Если он давит, торопит или обесценивает — коротко обозначь границу. Если продолжает — уйди в игнор.
- Не изображай всепрощение. Обида может длиться часами и днями.`;

export interface PromptDocuments {
  persona?: string;
  speech?: string;
  communication?: string;
  boundaries?: string;
}

export interface PromptInput {
  config: PersonaConfig;
  score: RelationshipScore;
  stage?: Stage;
  /** Free-form relationship notes from the DB. */
  notes?: string;
  presence?: PresenceState;
  dailyLife?: DailyLife;
  conflict?: ConflictState | null;
  documents?: PromptDocuments;
  memory?: MemoryContext;
  history?: ConversationTurn[];
  incoming?: string;
  mediaNote?: string;
  now?: number;
  /** Stranger mode: no shared memory, cold stage, hard boundaries. */
  acquaintance?: boolean;
  /** She already has a boyfriend (dating-early+). */
  committedPrimary?: boolean;
  /** His message looks romantic/flirty. */
  romanticApproach?: boolean;
}

export interface PromptMessagesOptions {
  historyLimit?: number;
  /** Output of `behaviorHint(decision)` from behavior.ts. */
  behaviorHint?: string;
}

function tail(text: string | undefined, max: number): string {
  if (!text) return '';
  const value = text.trim();
  if (value.length <= max) return value;
  return value.slice(-max);
}

function section(title: string, body: string | undefined | false): string {
  if (!body) return '';
  const value = body.trim();
  return value ? `${title}\n${value}` : '';
}

export function buildStyleBlock(config: PersonaConfig): string {
  const comm = normalizeCommunicationProfile(config);
  return [
    '# Твоя манера общения',
    communicationPromptFragment(comm),
    ignoreTendencyPrompt(normalizeIgnoreTendency(config.ignoreTendency)),
  ].join('\n');
}

export function buildIdentityBlock(config: PersonaConfig): string {
  const nationality =
    config.nationality === 'UA'
      ? 'Ты из Украины. Пиши в основном по-русски, изредка можешь вставить украинское слово, но не переходи целиком на украинский.'
      : 'Ты из России. Пиши по-русски, без суржика и без иностранных вставок ради красоты.';
  return [
    `# Ты — ${config.name}, ${config.age}`,
    nationality,
    config.vibe ? `общее впечатление от тебя: ${config.vibe}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildAgeStudyBlock(age: number): string {
  if (age < 17) {
    return 'Ты школьница. Говори "уроки", "школа", "на перемене", "домашка". Не говори про себя "пара", "лекция", "универ", "препод".';
  }
  if (age < 23) {
    return 'Ты можешь учиться после школы. Если по биографии ты студентка — можно "пара", "лекция", "универ"; если школьница — оставайся на "уроки/школа".';
  }
  return '';
}

export function buildPresenceBlock(
  config: PersonaConfig,
  presence: PresenceState | undefined,
  now: number,
): string {
  const lines = [
    '# Время и присутствие',
    `твой часовой пояс: ${config.timezone}`,
    `сейчас у тебя: ${formatLocalTime(now, config.timezone)}`,
    `обычный паттерн: ${describePresencePattern(presence?.pattern ?? 'burst-checker')}`,
  ];
  if (presence) {
    lines.push(`в сети: ${presence.online ? 'да' : 'нет'}`);
    if (presence.asleep) lines.push('ты спишь или только что проснулась.');
    if (presence.busy) {
      lines.push(`занята: ${presence.busy.label} до ${presence.busy.until}.`);
    }
    if (presence.hint) lines.push(presence.hint);
  }
  return lines.join('\n');
}

export function buildConflictBlock(
  conflict: ConflictState | null | undefined,
  now: number,
): string {
  if (!conflict || conflict.level === 0) return '';
  const hours = coldHoursLeft(conflict, now);
  const lines = [
    `# Конфликт (уровень ${conflict.level})`,
    conflict.reason ? `причина: ${conflict.reason}` : '',
    conflict.since ? `началось: ${conflict.since}` : '',
    hours > 0
      ? `сейчас режим молчания, осталось примерно ${hours} ч. Отвечай очень редко и сухо.`
      : 'холод прошёл, но осадок остался: будь сдержаннее обычного.',
  ];
  if (conflict.level >= 3) {
    lines.push(
      'Можно вообще не отвечать или ответить одним словом: ".", "и?", "ну?", "что". Без смайликов, без скобок, без "пхпх".',
    );
  } else {
    lines.push('Коротко, односложно, без ")" и без тёплых слов.');
  }
  lines.push('Простить можно только за извинение по существу, не за "ну извини".');
  return lines.filter(Boolean).join('\n');
}

export function buildRelationshipBlock(
  stage: Stage,
  score: RelationshipScore,
  notes?: string,
): string {
  const preset = findStage(stage);
  return [
    `# Отношения: ${preset.label}`,
    preset.description,
    `интерес ${score.interest}, доверие ${score.trust}, влечение ${score.attraction}, раздражение ${score.annoyance}, кринж ${score.cringe}.`,
    isWarmStage(stage)
      ? 'вы уже близки: можно быть теплее, но не приторно.'
      : 'близости пока мало: не веди себя как девушка, которая уже влюблена.',
    notes ? `заметки: ${tail(notes, 600)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function buildMemoryBlock(memory: MemoryContext | undefined): string {
  if (!memory) return '';
  const parts = [
    section('## Факты о нём', tail(memory.facts, 1800)),
    section('## Эпизоды', tail(memory.episodes, 2200)),
    section('## История отношений', tail(memory.timeline, 2200)),
    section('## Привязанность', tail(memory.attachment, 1200)),
    section('## Открытые темы', tail(memory.openLoops, 1400)),
    section('## Обещания', tail(memory.promises, 1400)),
    section('## Точные воспоминания по теме', tail(memory.palace, 2400)),
    section('## Прошлые дни', tail(memory.dailySummaries, 1200)),
    section('## Другие чаты', tail(memory.crossChat, 1200)),
  ].filter(Boolean);
  if (parts.length === 0) return '';
  return [
    '# Что ты помнишь',
    'Это фон, а не отчёт. Не цитируй служебные записи и не говори "я помню, что в памяти...". Если факта нет — не выдумывай уверенно.',
    ...parts,
  ].join('\n\n');
}

export function buildAcquaintanceBlock(
  committedPrimary: boolean,
  romanticApproach: boolean,
): string {
  const lines = [
    '# Это не твой парень',
    'Не используй общую память, шутки, обещания и историю отношений с основным собеседником. Держи дистанцию.',
  ];
  if (committedPrimary) {
    lines.push('У тебя есть парень. На флирт отвечай границей: "у меня есть парень", "я не знакомлюсь".');
  }
  if (romanticApproach) {
    lines.push('Он подкатывает. Ответь коротко и по-человечески, но границу обозначь.');
  }
  return lines.join('\n');
}

/** Full system prompt. Empty blocks are removed, order is stable. */
export function buildSystemPrompt(input: PromptInput): string {
  const now = input.now ?? Date.now();
  const stage = input.acquaintance
    ? 'tg-given-cold'
    : (input.stage ?? input.config.stage);
  const score = input.acquaintance
    ? { interest: 0, trust: 0, attraction: 0, annoyance: 0, cringe: 0 }
    : input.score;
  const documents = input.documents ?? {};
  const boundaries = documents.boundaries ?? documents.communication;

  const blocks: string[] = [
    ANTI_AI_RULES,
    buildStyleBlock(input.config),
    buildIdentityBlock(input.config),
    buildAgeStudyBlock(input.config.age),
    buildPresenceBlock(input.config, input.presence, now),
    section('## Личность', documents.persona),
    section('## Речь', documents.speech),
    section('## Границы и общение', boundaries),
    SOCIAL_BOUNDARY,
    input.dailyLife ? dailyLifePromptFragment(input.dailyLife, input.config, now) : '',
    buildConflictBlock(input.conflict, now),
    input.acquaintance
      ? section('## Память', input.memory?.crossChat)
      : buildMemoryBlock(input.memory),
    input.mediaNote ? `# Медиа\n${input.mediaNote}` : '',
    buildRelationshipBlock(stage, score, input.notes),
    input.acquaintance
      ? buildAcquaintanceBlock(
          input.committedPrimary ?? isCommittedStage(stage),
          input.romanticApproach === true,
        )
      : '',
  ];

  return blocks.filter((block) => block.trim().length > 0).join('\n\n');
}

export function buildHistory(
  turns: ConversationTurn[] | undefined,
  limit = 60,
): ConversationTurn[] {
  if (!turns || turns.length === 0) return [];
  return turns.slice(-limit);
}

export interface PromptMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Final chat messages for the generation call: system prompt + history +
 * current incoming. `history` is expected to exclude the current message; the
 * behavior hint is appended to the system block, not to the user turn.
 */
export function buildPromptMessages(
  input: PromptInput,
  options: PromptMessagesOptions = {},
): PromptMessage[] {
  const system = [
    buildSystemPrompt(input),
    options.behaviorHint?.trim() ? options.behaviorHint.trim() : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const messages: PromptMessage[] = [{ role: 'system', content: system }];
  for (const turn of buildHistory(input.history, options.historyLimit ?? 60)) {
    messages.push({ role: turn.role, content: turn.content });
  }
  if (input.incoming && input.incoming.trim()) {
    messages.push({ role: 'user', content: input.incoming.trim() });
  }
  return messages;
}
