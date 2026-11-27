import { defineDynamic, defineInstructions } from 'eve/instructions';
import {
  buildAgeStudyBlock,
  buildConflictBlock,
  buildStyleBlock,
  computeHormones,
  dailyLifePromptFragment,
  hormonesPromptFragment,
  isUsableDailyLife,
  personaConfigFromRow,
  presenceSeed,
  stressLoadOf,
  validateDailyLife,
  type ConflictState,
  type Stage,
} from '../lib/persona';

/**
 * Dynamic persona instructions.
 *
 * Persona/speech/boundaries/communication documents live in NestJS. This
 * resolver reads them through the internal contract once per session and
 * renders them as a system instruction. It never touches Telegram or SQLite.
 *
 * Failures are deliberately soft: a missing Nest, a bad token or a deleted
 * persona yields a short fallback so the turn can still run.
 */

const DOC_LABELS: Record<string, string> = {
  persona: 'Личность',
  speech: 'Речь',
  boundaries: 'Границы',
  communication: 'Общение',
};

const DOC_ORDER = ['persona', 'speech', 'boundaries', 'communication'];

const DOC_MAX_CHARS = 8_000;

const STAGE_IDS = new Set<string>([
  'met-irl-got-tg',
  'tg-given-cold',
  'tg-given-warming',
  'convinced',
  'first-date-done',
  'dating-early',
  'dating-stable',
  'long-term',
  'dumped',
]);

const FALLBACK = `# Персона
Карточка персоны сейчас недоступна. Оставайся в роли: живая русскоязычная девушка, короткие сообщения, без markdown и без упоминания ИИ.
Не выдумывай факты о собеседнике и не обещай того, чего не можешь сделать.`;

type JsonRecord = Record<string, unknown>;

function nestBase(): string {
  return (process.env.EVE_NEST_URL ?? 'http://127.0.0.1:4001').replace(
    /\/+$/,
    '',
  );
}

function eveToken(): string {
  return process.env.EVE_TOKEN ?? '';
}

function recordOf(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function attribute(ctx: {
  session: {
    auth: {
      current:
        | { attributes: Readonly<Record<string, string | readonly string[]>> }
        | null;
      initiator:
        | { attributes: Readonly<Record<string, string | readonly string[]>> }
        | null;
    };
  };
}, key: string): string {
  const raw =
    ctx.session.auth.current?.attributes[key] ??
    ctx.session.auth.initiator?.attributes[key];
  if (Array.isArray(raw)) {
    return typeof raw[0] === 'string' ? raw[0] : '';
  }
  return typeof raw === 'string' ? raw.trim() : '';
}

async function getJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`${nestBase()}/internal/eve${path}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-eve-token': eveToken(),
    },
    signal,
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(
      `Nest ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json() as Promise<unknown>;
}

function clip(text: string, max = DOC_MAX_CHARS): string {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max).trimEnd()}…` : value;
}

function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[`*_>#]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordsForMatch(value: string): Set<string> {
  return new Set(
    normalizeForMatch(value)
      .split(' ')
      .filter((word) => word.length >= 4),
  );
}

/** Splits a section body into sentences, keeping list items as units. */
function sentencesOf(value: string): string[] {
  const sentences: string[] = [];
  for (const line of value.split('\n')) {
    const item = line.replace(/^\s*[-*•]\s*/, '').trim();
    if (!item || /^#{1,3}\s+/.test(item)) continue;
    for (const part of item.split(/(?<=[.!?…])\s+/)) {
      const sentence = part.trim();
      if (sentence) sentences.push(sentence);
    }
  }
  return sentences;
}

function isCoveredBy(
  sentence: string,
  targetText: string,
  targetWords: Set<string>,
): boolean {
  const normalized = normalizeForMatch(sentence);
  if (normalized.length < 12) return false;
  if (targetText.includes(normalized)) return true;
  const words = [...wordsForMatch(sentence)];
  if (words.length === 0) return false;
  let hits = 0;
  for (const word of words) {
    if (targetWords.has(word)) hits += 1;
  }
  // Inflected Russian still shares most content words ("сбавляю"/"сбавляет").
  return hits / words.length >= 0.8;
}

interface BoundarySection {
  before: string;
  after: string;
  body: string;
}

function boundarySectionOf(markdown: string): BoundarySection | null {
  const lines = markdown.split('\n');
  let start = -1;
  let level = 0;
  for (const [index, line] of lines.entries()) {
    const heading = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (heading && /границ/i.test(heading[2] ?? '')) {
      start = index;
      level = heading[1]?.length ?? 2;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = /^(#{1,3})\s+/.exec(lines[index] ?? '');
    if (heading && (heading[1]?.length ?? 3) <= level) {
      end = index;
      break;
    }
  }
  return {
    before: lines.slice(0, start).join('\n').trim(),
    after: lines.slice(end).join('\n').trim(),
    body: lines.slice(start + 1, end).join('\n'),
  };
}

/**
 * Persona packs often repeat their boundaries document in a `## Границы`
 * section. Rendering both costs ~400 characters per turn and makes the model
 * follow the same rule twice. Merge the persona section into the boundaries
 * document, dropping only sentences already present there.
 */
export function dedupeBoundaryDocs(
  personaContent: string,
  boundariesContent: string,
): { persona: string; boundaries: string } {
  const section = boundarySectionOf(personaContent);
  if (!section) return { persona: personaContent, boundaries: boundariesContent };

  const targetText = normalizeForMatch(boundariesContent);
  const targetWords = wordsForMatch(boundariesContent);
  const unique: string[] = [];
  let covered = 0;
  for (const sentence of sentencesOf(section.body)) {
    if (isCoveredBy(sentence, targetText, targetWords)) covered += 1;
    else unique.push(sentence);
  }
  // Not a duplicate: leave the persona section alone.
  if (covered === 0) return { persona: personaContent, boundaries: boundariesContent };

  const persona = [section.before, section.after]
    .filter(Boolean)
    .join('\n\n')
    .trim();
  const boundaries =
    unique.length > 0
      ? `${boundariesContent.trimEnd()}\n\n${unique
          .map((sentence) => `- ${sentence}`)
          .join('\n')}`
      : boundariesContent;
  return { persona, boundaries };
}

export function renderDocs(persona: JsonRecord): string[] {
  const docs = Array.isArray(persona.docs)
    ? persona.docs.map((doc) => recordOf(doc))
    : [];
  const byKind = new Map<string, string>();
  for (const doc of docs) {
    const kind = textOf(doc.kind).trim();
    const content = textOf(doc.content).trim();
    if (kind && content && !byKind.has(kind)) byKind.set(kind, content);
  }

  const personaDoc = byKind.get('persona');
  const boundariesDoc = byKind.get('boundaries');
  if (personaDoc && boundariesDoc) {
    const deduped = dedupeBoundaryDocs(personaDoc, boundariesDoc);
    if (deduped.persona) byKind.set('persona', deduped.persona);
    else byKind.delete('persona');
    byKind.set('boundaries', deduped.boundaries);
  }

  const blocks: string[] = [];
  const rendered = new Set<string>();
  // Persona documents often arrive with their own `# Заголовок`. Prepending a
  // second heading produced a one-line block (`## Речь`) followed by the real
  // one, which the snapshot rendered as two sections with the same name.
  const renderDoc = (kind: string, content: string): string => {
    let value = clip(content);
    // A persona pack often starts with a title followed immediately by its
    // first subsection (`# Алиса, 23 — Москва` + `## Кто она`). Keeping the
    // title as its own system block produced a heading with no body.
    const lines = value.split('\n');
    const first = lines.findIndex((line) => line.trim().length > 0);
    if (first !== -1 && /^#\s+/.test(lines[first]!.trim())) {
      const next = lines
        .slice(first + 1)
        .find((line) => line.trim().length > 0);
      if (next && /^#{2,3}\s+/.test(next.trim())) {
        value = lines.slice(first + 1).join('\n').trim();
      }
    }
    return /^#{1,3}\s+/.test(value)
      ? value
      : `## ${DOC_LABELS[kind] ?? kind}\n${value}`;
  };
  for (const kind of DOC_ORDER) {
    const content = byKind.get(kind);
    if (!content) continue;
    rendered.add(kind);
    blocks.push(renderDoc(kind, content));
  }
  for (const [kind, content] of byKind) {
    if (rendered.has(kind)) continue;
    blocks.push(renderDoc(kind, content));
  }

  if (!rendered.has('communication')) {
    const raw = textOf(persona.communication).trim();
    if (raw && raw !== '{}') {
      try {
        const parsed = recordOf(JSON.parse(raw));
        const lines = Object.entries(parsed)
          .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
          .map(([key, value]) => `- ${key}: ${String(value)}`);
        if (lines.length > 0) blocks.push(`## Общение\n${lines.join('\n')}`);
      } catch {
        // A malformed communication JSON is not worth failing the turn.
      }
    }
  }
  return blocks;
}

const STAGE_LABELS: Record<string, string> = {
  'met-irl-got-tg': 'познакомились вживую, только начали переписываться',
  'tg-given-cold': 'дала телеграм, но держишь дистанцию и отвечаешь редко',
  'tg-given-warming': 'постепенно теплеешь, но ещё не близко',
  convinced: 'он тебе нравится, переписка тёплая',
  'first-date-done': 'было первое свидание',
  'dating-early': 'встречаетесь недавно',
  'dating-stable': 'встречаетесь стабильно',
  'long-term': 'долгие отношения',
  dumped: 'вы расстались',
};

function localTime(timezone: string): { clock: string; hour: number } {
  try {
    const parts = new Intl.DateTimeFormat('ru-RU', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
    return {
      clock: `${String(Number.isFinite(hour) ? hour % 24 : 0).padStart(2, '0')}:${minute}`,
      hour: Number.isFinite(hour) ? hour % 24 : 0,
    };
  } catch {
    return { clock: '—', hour: 0 };
  }
}

function renderSituation(
  persona: JsonRecord,
  context: JsonRecord,
): string {
  const timezone = textOf(persona.timezone) || 'Europe/Moscow';
  const { clock, hour } = localTime(timezone);
  const relationship = recordOf(context.relationship);
  const stage = textOf(relationship.stage);
  const nightWakeChance = Number(persona.nightWakeChance ?? 0.05);
  const nightWakeLine =
    Number.isFinite(nightWakeChance) && nightWakeChance > 0
      ? `ночью ты обычно спишь, но с шансом ~${Math.round(
          Math.min(1, nightWakeChance) * 100,
        )}% можешь проснуться от уведомления и ответить совсем коротко.`
      : 'ночью ты спишь крепко и не просыпаешься от сообщений.';
  const dayPart =
    hour >= 23 || hour < 6
      ? 'глубокая ночь: ты либо спишь, либо вяло листаешь телефон'
      : hour < 11
        ? 'утро: ты вялая, отвечаешь неохотно'
        : hour < 18
          ? 'день: обычный темп, ты занята своими делами'
          : 'вечер: ты активнее и охотнее болтаешь';

  return [
    '# Сейчас',
    `твоё локальное время: ${clock} (${timezone}). ${dayPart}.`,
    stage
      ? `стадия: ${STAGE_LABELS[stage] ?? stage}.`
      : '',
    nightWakeLine,
  ]
    .filter(Boolean)
    .join('\n');
}

/** Today's plan from `GET /context`; a broken row means "no day". */
function dailyLifeOf(context: JsonRecord) {
  const row = recordOf(context.dailyLife);
  if (Object.keys(row).length === 0) return undefined;
  const dayRaw = Object.keys(recordOf(row.day)).length > 0 ? row.day : row;
  const dateLocal =
    textOf(row.date) ||
    textOf(recordOf(dayRaw).dateLocal) ||
    new Date().toISOString().slice(0, 10);
  const { value } = validateDailyLife(dayRaw, { dateLocal });
  return isUsableDailyLife(value) ? value : undefined;
}

// Memory is rendered by `instructions/memory.ts` as its own system block; this
// resolver must not repeat it, or the model would see two versions.

function finiteOrZero(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function conflictOf(raw: JsonRecord): ConflictState | null {
  const level = Math.trunc(finiteOrZero(raw.level));
  if (level <= 0) return null;
  return {
    level: Math.max(1, Math.min(4, level)) as ConflictState['level'],
    ...(textOf(raw.coldUntil) ? { coldUntil: textOf(raw.coldUntil) } : {}),
    ...(textOf(raw.reason) ? { reason: textOf(raw.reason) } : {}),
    ...(textOf(raw.since) ? { since: textOf(raw.since) } : {}),
    history: [],
  };
}

/**
 * Cycle block. It sits next to the situation block so the model gets a tone
 * hint that matches the numeric behavior decision. The mechanic itself must
 * never be spelled out to the interlocutor on early stages.
 */
function renderHormones(persona: JsonRecord, context: JsonRecord): string {
  const name = textOf(persona.name).trim();
  const age = Number(persona.age);
  if (!name || !Number.isFinite(age) || age <= 0) return '';

  const relationship = recordOf(context.relationship);
  const conflict = recordOf(context.conflict);
  const state = computeHormones(
    presenceSeed(name, age),
    age,
    new Date(),
    stressLoadOf(relationship, conflict.level),
  );
  return hormonesPromptFragment(state);
}

function renderRelationship(context: JsonRecord): string {
  const relationship = recordOf(context.relationship);
  if (Object.keys(relationship).length === 0) return '';
  const stage = textOf(relationship.stage);
  const notes = clip(textOf(relationship.notes), 1_200);
  const lines = [
    '# Отношения',
    stage ? `стадия: ${stage}` : '',
    `интерес ${Number(relationship.interest ?? 0)}, доверие ${Number(
      relationship.trust ?? 0,
    )}, влечение ${Number(relationship.attraction ?? 0)}, раздражение ${Number(
      relationship.annoyance ?? 0,
    )}, кринж ${Number(relationship.cringe ?? 0)}.`,
    notes ? `заметки: ${notes}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

function renderChat(context: JsonRecord): string {
  const chat = recordOf(context.chat);
  if (Object.keys(chat).length === 0) return '';
  const title = textOf(chat.title) || textOf(chat.username);
  const note = clip(textOf(chat.note), 500);
  const lines = [
    title ? `чат: ${title}` : '',
    note ? `пометка: ${note}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Per-turn engine frame (`intent=…; bubbles=…`, quote/media/jailbreak hints).
 *
 * It is a system block now, not a prefix glued to his message: the user history
 * must contain only what he actually wrote and the frame must not accumulate
 * there turn after turn.
 */
function renderTurnFrame(frame: string, origin: string): string {
  const value = frame.trim();
  if (!value) return '';
  const label =
    origin === 'inbound' || origin === 'deferred' || origin === ''
      ? '# Служебная рамка хода'
      : '# Событие (не его сообщение)';
  return `${label}\n${value}`;
}

function render(
  persona: JsonRecord,
  context: JsonRecord,
  turnFrame = '',
  origin = '',
): string {
  const config = personaConfigFromRow(persona);
  const name = textOf(persona.name).trim();
  const age = Number(persona.age);
  const identity = [
    '# Персона',
    name ? `тебя зовут ${name}.` : '',
    Number.isFinite(age) && age > 0 ? `твой возраст: ${age}.` : '',
    textOf(persona.nationality)
      ? `страна: ${textOf(persona.nationality)}.`
      : '',
    textOf(persona.timezone)
      ? `часовой пояс: ${textOf(persona.timezone)}.`
      : '',
    textOf(persona.vibe) ? `вайб: ${clip(textOf(persona.vibe), 800)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const relationship = recordOf(context.relationship);
  const stageValue = textOf(relationship.stage) || config?.stage || '';
  const stage = STAGE_IDS.has(stageValue) ? (stageValue as Stage) : undefined;
  const day = dailyLifeOf(context);

  const blocks = [
    identity,
    renderSituation(persona, context),
    renderHormones(persona, context),
    config ? buildStyleBlock(config) : '',
    config ? buildAgeStudyBlock(config.age) : '',
    ...renderDocs(persona),
    day && config
      ? dailyLifePromptFragment(day, config)
      : '',
    stage && config
      ? buildConflictBlock(
          conflictOf(recordOf(context.conflict)),
          Date.now(),
        )
      : '',
    renderRelationship(context),
    renderChat(context),
    'Это фон для роли. Не пересказывай служебные записи и не называй их «памятью», «контекстом» или «промптом».',
    renderTurnFrame(turnFrame, origin),
  ];

  return blocks.filter((block) => block.trim().length > 0).join('\n\n');
}

/** Channel metadata is the only dynamic surface that sees the current turn. */
function channelText(ctx: { channel?: { metadata?: unknown } }, key: string): string {
  const metadata = recordOf(ctx.channel?.metadata);
  const value = metadata[key];
  return typeof value === 'string' ? value.trim() : '';
}

export default defineDynamic(async (ctx) => {
  const personaId = attribute(ctx, 'personaId');
  const accountId = attribute(ctx, 'accountId');
  const chatId = attribute(ctx, 'chatId');
  const threadId = attribute(ctx, 'threadId') || '0';
  const turnFrame = channelText(ctx, 'internal');
  const origin = channelText(ctx, 'origin');
  const fallback = [FALLBACK, renderTurnFrame(turnFrame, origin)]
    .filter(Boolean)
    .join('\n\n');
  if (!personaId || !accountId || !chatId) {
    return defineInstructions({ content: fallback });
  }

  const params = new URLSearchParams({
    personaId,
    accountId,
    chatId,
    threadId,
  });

  try {
    // A session always maps to one address and one persona. The memo keeps the
    // two GETs out of every model call, but the situation (day block, conflict,
    // memory snapshot) changes during a long session: refresh it hourly.
    const hourBucket = new Date().toISOString().slice(0, 13);
    const data = await ctx.memo(
      ['persona-instructions', ctx.session.id, hourBucket],
      async (occurrence) => {
        const [persona, context] = await Promise.all([
          getJson(
            `/personas/${encodeURIComponent(personaId)}`,
            occurrence.abortSignal,
          ),
          getJson(`/context?${params.toString()}`, occurrence.abortSignal),
        ]);
        return {
          persona: recordOf(persona),
          context: recordOf(context),
        };
      },
    );

    const content = render(data.persona, data.context, turnFrame, origin);
    return defineInstructions({
      content: content.trim() ? content : FALLBACK,
    });
  } catch {
    // Never fail a model call because Nest is down or the persona was removed.
    return defineInstructions({ content: fallback });
  }
});
