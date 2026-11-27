import { defineDynamic, defineInstructions } from 'eve/instructions';
import { stripInternalLines } from '../lib/model/hygiene';

/**
 * Long-term memory as a system block.
 *
 * Eve's memory provider can only return user-role messages, which is exactly
 * the shape that used to leak `stage=…` and recall fragments into the history.
 * Storage and capture stay in `agent/memory/nest.ts`; this resolver renders
 * the ranked Nest snapshot (`/internal/eve/memory/retrieve`) as instructions
 * for the current turn, with a hard character budget.
 */

type JsonRecord = Record<string, unknown>;

interface MemoryRow {
  text?: unknown;
  hall?: unknown;
  date?: unknown;
  salience?: unknown;
}

const MEMORY_MAX_CHARS = 3_000;
const MAX_FACTS = 6;
const MAX_TIME_ITEMS = 5;
const MAX_EVENTS = 5;
const MAX_EPISODES = 3;
const MAX_DAILY = 2;
const MAX_PALACE = 8;
const MAX_CROSS_CHAT = 2;

const NOISE =
  /^(?:the user|i should|i need|let me|content:|good\s*[—-]|okay,|hmm,|maybe:|now the deleted|the deleted text was|keep it short|avoid lists|no period)/i;
const INLINE_NOISE =
  /\s*(?:Good\s*[—-]|The user says|Now the deleted text|The deleted text was|Content:).*$/i;

const HALL_LABELS: Record<string, string> = {
  promises: 'Обещания',
  open_loops: 'Открытые петли',
  events: 'События',
  feelings: 'Чувства',
  preferences: 'Предпочтения',
  facts: 'Запомнила',
};

function recordOf(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function attr(ctx: {
  session?: { auth?: { current?: unknown } };
}, key: string): string {
  const attributes = recordOf(recordOf(ctx.session?.auth?.current).attributes);
  const raw = attributes[key];
  return typeof raw === 'string' ? raw.trim() : '';
}

function nestBase(): string {
  return (process.env.EVE_NEST_URL ?? 'http://127.0.0.1:4001').replace(
    /\/+$/,
    '',
  );
}

/** Drops engine noise from a stored memory line; never throws. */
function cleanLine(value: unknown): string {
  const raw = textOf(value);
  if (!raw) return '';
  const lines = raw
    .split('\n')
    .map((line) =>
      stripInternalLines(line).replace(INLINE_NOISE, '').trim(),
    )
    .filter((line) => {
      if (line.length === 0 || NOISE.test(line)) return false;
      return !(
        /(?:удалил|deleted)/i.test(line) &&
        /---|«|"|`/.test(line)
      );
    });
  return lines.join('\n').trim();
}

function rowText(row: unknown): string {
  return cleanLine(recordOf(row).text);
}

function rowsOf(value: unknown): MemoryRow[] {
  return Array.isArray(value)
    ? value.filter(
        (row): row is MemoryRow =>
          Boolean(row) && typeof row === 'object' && !Array.isArray(row),
      )
    : [];
}

function turnQuery(ctx: {
  turn?: { input?: readonly { kind?: string; text?: unknown }[] } | null;
}): string {
  const parts = ctx.turn?.input ?? [];
  return parts
    .filter((part) => part.kind === 'text')
    .map((part) => textOf(part.text))
    .join('\n')
    .trim()
    .slice(0, 500);
}

async function fetchMemory(
  personaId: string,
  accountId: string,
  chatId: string,
  threadId: string,
  query: string,
  signal: AbortSignal,
): Promise<JsonRecord | null> {
  // A slow memory endpoint must not hold the answer. The turn signal still
  // cancels immediately when Eve aborts.
  const timeout = AbortSignal.timeout(10_000);
  signal =
    typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeout])
      : timeout;
  const response = await fetch(`${nestBase()}/internal/eve/memory/retrieve`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-eve-token': process.env.EVE_TOKEN ?? '',
    },
    body: JSON.stringify({ personaId, accountId, chatId, threadId, query }),
    signal,
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(
      `Nest /memory/retrieve failed: ${response.status} ${await response.text()}`,
    );
  }
  return recordOf(await response.json());
}

export function renderMemory(data: JsonRecord): string {
  const sections = new Map<string, string[]>();
  const seen = new Set<string>();

  // Sections with the same label merge instead of repeating (`open_loops`
  // arrives both as a time item and as a palace hall).
  const addSection = (title: string, lines: string[]): void => {
    const unique = lines
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    if (unique.length === 0) return;
    sections.set(title, [...(sections.get(title) ?? []), ...unique]);
  };

  const facts = rowsOf(data.facts)
    .map(rowText)
    .filter(Boolean)
    .slice(0, MAX_FACTS);
  addSection('Факты о нём', facts);

  const timeItems = rowsOf(data.timeItems);
  const promises = timeItems
    .filter((row) => textOf(recordOf(row).hall) === 'promise')
    .map(rowText)
    .filter(Boolean)
    .slice(0, MAX_TIME_ITEMS);
  addSection('Обещания', promises);
  const openLoops = timeItems
    .filter((row) => textOf(recordOf(row).hall) === 'open-loop')
    .map(rowText)
    .filter(Boolean)
    .slice(0, MAX_TIME_ITEMS);
  addSection('Открытые петли', openLoops);

  const events = rowsOf(data.events)
    .map((row) => {
      const text = rowText(row);
      if (!text) return '';
      const date = textOf(recordOf(row).date).slice(0, 10);
      return date ? `${date}: ${text}` : text;
    })
    .filter(Boolean)
    .slice(0, MAX_EVENTS);
  addSection('Таймлайн', events);

  const relationship = recordOf(data.relationship);
  if (Object.keys(relationship).length > 0) {
    const attraction = Number(relationship.attraction ?? 0);
    const trust = Number(relationship.trust ?? 0);
    const stage = textOf(relationship.stage);
    const closeness =
      attraction + trust >= 120
        ? 'уже близко, можно тепло и прямо'
        : attraction + trust >= 60
          ? 'теплеет, но ещё осторожно'
          : 'дистанция, не раскрывайся слишком быстро';
    addSection('Привязанность', [
      `${closeness}${stage ? ` (${stage})` : ''}; влечение ${attraction}/100, доверие ${trust}/100`,
    ]);
  }

  const episodes = rowsOf(data.episodes)
    .map((row) => {
      const text = rowText(row);
      const date = textOf(recordOf(row).date).slice(0, 10);
      return text ? (date ? `${date}: ${text}` : text) : '';
    })
    .filter(Boolean)
    .slice(0, MAX_EPISODES);
  addSection('Эпизоды', episodes);

  const daily = rowsOf(data.daily)
    .map((row) => {
      const text = rowText(row);
      const date = textOf(recordOf(row).date).slice(0, 10);
      return text ? (date ? `${date}: ${text}` : text) : '';
    })
    .filter(Boolean)
    .slice(0, MAX_DAILY);
  addSection('Дневник', daily);

  const byHall = new Map<string, string[]>();
  for (const row of rowsOf(data.palace)) {
    const text = rowText(row);
    if (!text) continue;
    const hall = textOf(recordOf(row).hall) || 'facts';
    const list = byHall.get(hall) ?? [];
    if (list.length < MAX_PALACE) list.push(text);
    byHall.set(hall, list);
  }
  for (const [hall, lines] of byHall) {
    addSection(HALL_LABELS[hall] ?? hall, lines);
  }

  const crossChat = rowsOf(data.crossChat)
    .map(rowText)
    .filter(Boolean)
    .slice(0, MAX_CROSS_CHAT);
  addSection('Из других чатов', crossChat);

  if (sections.size === 0) return '';
  let used = 0;
  const rendered: string[] = [];
  for (const [title, lines] of sections) {
    // Plain labels, not markdown headings: the snapshot partitions the system
    // prompt by `#` headings, and a heading without a body would become an
    // empty block. One named memory block is easier to read.
    const block = `${title}:\n${lines.map((line) => `- ${line}`).join('\n')}`;
    if (used + block.length > MEMORY_MAX_CHARS) continue;
    used += block.length;
    rendered.push(block);
  }
  return [
    '# Воспоминания о нём',
    'Это твои собственные воспоминания о нём и о вас. Используй их естественно, не пересказывай списком и не называй «памятью» или «контекстом».',
    ...rendered,
    'Свежее важнее старого. Если факт противоречит тому, что он говорит сейчас, верь ему и не спорь о записях.',
  ].join('\n\n');
}

export default defineDynamic(async (ctx) => {
  const personaId = attr(ctx, 'personaId');
  const accountId = attr(ctx, 'accountId');
  const chatId = attr(ctx, 'chatId');
  if (!personaId || !accountId || !chatId) return null;
  const threadId = attr(ctx, 'threadId') || '0';
  const query = turnQuery(ctx);

  try {
    const data = await ctx.memo(
      ['memory-instructions', ctx.turn?.id ?? null],
      async (occurrence) =>
        fetchMemory(
          personaId,
          accountId,
          chatId,
          threadId,
          query,
          occurrence.abortSignal,
        ),
    );
    if (!data) return null;
    const content = renderMemory(data);
    return content ? defineInstructions({ content }) : null;
  } catch {
    // A memory outage must not fail the answer.
    return null;
  }
});
