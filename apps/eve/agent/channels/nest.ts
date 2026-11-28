import { defineChannel, GET, POST } from 'eve/channels';
import type { ChannelFrom } from 'eve/channels';
import {
  classifyDeletion,
  computeHormones,
  computePresenceProfile,
  computePresenceState,
  decideBehavior,
  deletionPromptFragment,
  personaConfigFromRow,
  presenceSeed,
  recordOf,
  stressLoadOf,
  textOf,
  validateDailyLife,
  isUsableDailyLife,
  type BehaviorDecision,
  type ConflictState,
  type ConversationTurn,
  type DailyLife,
  type IncomingRef,
  type PersonaConfig,
  type RelationshipScore,
  type Stage,
} from '../lib/persona';
import {
  decideReaction,
  reactionMoodAllowed,
  reactionMoodDelta,
  reactionPlan,
  type ReactionPlan,
} from '../lib/persona/reaction';
import { sanitizeReply } from '../lib/realism/sanitize';
import { injectTypos, pickTypoIntensity } from '../lib/realism/typos';
import { INJECTION_HINT, looksLikeJailbreak } from '../lib/realism/security';
import {
  dropRepeatedParts,
  pickFiller,
  splitReplyParts,
} from '../lib/realism/repeat';
import { mediaInstruction, mediaRequestHint, requestedMedia } from '../lib/realism/media';

/**
 * NestJS bridge for the Eve channel.
 *
 * Inbound: Nest pushes durable `EveEvent` rows to `POST /eve/v1/nest/events`.
 * Outbound: the channel posts the assistant reply back to `/internal/eve/*`.
 *
 * The address is `personaId:accountId:chatId`; one Eve session = one chat.
 * Telegram, SQLite and the actual sending stay in NestJS.
 */

/**
 * One message of the unanswered series a turn answers.
 *
 * A burst of two or three messages used to reach the model as only the last
 * text: the earlier deferred turns were superseded, so their messages never
 * entered the session. The whole series now travels with the turn.
 */
export interface NestBurstEntry {
  id: number;
  text: string;
}

export interface NestState {
  personaId: string;
  accountId: string;
  chatId: string;
  threadId: number;
  /**
   * This turn is a test/dry run: every outbound call carries the flag back to
   * Nest, which suppresses the Telegram side and logs `[eve][dry-run]`. A real
   * Telegram event never sets it.
   */
  dryRun?: boolean;
  incoming?: string;
  messageId?: number;
  /** Ids of every message this turn answers, oldest first. */
  messageIds?: number[];
  /** The same series with texts, so `turn/apply` can log and count each id. */
  burst?: NestBurstEntry[];
  behavior?: BehaviorDecision;
  applied?: boolean;
  /**
   * Why this turn exists. A deletion reply is different from an inbound one:
   * it must not use an old generation after a newer message arrived.
   */
  origin?: 'inbound' | 'deletion' | 'reaction' | 'proactive' | 'deferred';
  /** Epoch ms when the newest inbound of this chat was delivered. */
  lastInboundAt?: number;
  /** Epoch ms when the deletion turn was queued. */
  deletionAt?: number;
  /**
   * Engine frame of the current turn (`intent=…; bubbles=…`, quote/media
   * hints, proactive/deletion/reaction events). Rendered as a dynamic system
   * block, never glued to his message or stored as user history.
   */
  internal?: string;
  /**
   * Identity of the turn this payload belongs to. Nest treats a repeated
   * `turn/apply` with the same key as a replay, and a late reply whose series
   * an ignore already counted as a new outcome instead of a replay.
   */
  turnKey?: string;
}

/** Old unanswered messages are context, not a transcript: ten is plenty. */
const MAX_BURST = 10;
const MAX_BURST_TEXT = 1_000;

interface NestContext {
  persona?: Record<string, unknown>;
  relationship?: Record<string, unknown>;
  conflict?: Record<string, unknown>;
  history?: { messages?: Array<Record<string, unknown>> };
  dailyLife?: Record<string, unknown> | null;
  memory?: Record<string, unknown> | null;
}

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

const IDEMPOTENCY_KEY_MAX = 256;

async function nestGet(path: string): Promise<unknown> {
  const response = await fetch(`${nestBase()}/internal/eve${path}`, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-eve-token': eveToken(),
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(
      `Nest ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json() as Promise<unknown>;
}

function configOf(persona: Record<string, unknown>): PersonaConfig | null {
  return personaConfigFromRow(persona);
}

/**
 * Today's life from `GET /context`. Nest stores the normalized day JSON; a
 * corrupted row degrades to "no day" instead of failing the turn.
 */
function dailyLifeOf(context: NestContext): DailyLife | undefined {
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

/** Current daily-life block label, used as the behavior `blockHint`. */
function blockHintOf(day: DailyLife | undefined, timezone: string): string | undefined {
  if (!day) return undefined;
  const date = new Date();
  let hour = date.getHours();
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        hour12: false,
      }).format(date),
    ) % 24;
  } catch {
    // Keep the host hour when the timezone is unknown.
  }
  const block = day.blocks.find((candidate) => {
    if (candidate.fromHour === candidate.toHour) return false;
    return candidate.fromHour < candidate.toHour
      ? hour >= candidate.fromHour && hour < candidate.toHour
      : hour >= candidate.fromHour || hour < candidate.toHour;
  });
  if (!block) return undefined;
  return block.phoneAvailable
    ? block.activity
    : `${block.activity} [телефон недоступен]`;
}

function scoreOf(relationship: Record<string, unknown>): RelationshipScore {
  return {
    interest: Number(relationship.interest ?? 0),
    trust: Number(relationship.trust ?? 0),
    attraction: Number(relationship.attraction ?? 0),
    annoyance: Number(relationship.annoyance ?? 0),
    cringe: Number(relationship.cringe ?? 0),
  };
}

function conflictOf(raw: Record<string, unknown>): ConflictState | null {
  if (Object.keys(raw).length === 0) return null;
  const level = Number(raw.level ?? 0);
  if (!Number.isFinite(level) || level <= 0) return null;
  let history: ConflictState['history'] = [];
  const serialized = textOf(raw.history);
  if (serialized) {
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (Array.isArray(parsed)) {
        history = parsed as ConflictState['history'];
      }
    } catch {
      // Keep an empty history; the level/cold state is still useful.
    }
  }
  return {
    level: Math.max(1, Math.min(4, level)) as ConflictState['level'],
    coldUntil: textOf(raw.coldUntil) || undefined,
    reason: textOf(raw.reason) || undefined,
    history,
  };
}

function turnsOf(context: NestContext): ConversationTurn[] {
  const rows = Array.isArray(context.history?.messages)
    ? [...context.history.messages].reverse()
    : [];
  const turns: ConversationTurn[] = [];
  for (const row of rows) {
    const content = textOf(row.text).trim();
    if (!content) continue;
    const ts = Date.parse(textOf(row.date));
    turns.push({
      role: row.outgoing === true ? 'assistant' : 'user',
      content,
      ...(Number.isFinite(ts) ? { ts } : {}),
    });
  }
  return turns;
}

/**
 * The messages of his the model has not answered yet: everything incoming
 * after her last outgoing message, plus the current message when Nest has not
 * stored it in the history snapshot yet. `history` is newest first.
 *
 * This is the text a superseded deferred turn used to throw away: the previous
 * turn is dropped in Nest, but its message stays unanswered in the chat, so the
 * next turn has to answer the whole series.
 */
function burstOf(
  context: NestContext,
  message: Record<string, unknown>,
  text: string,
): NestBurstEntry[] {
  const rows = Array.isArray(context.history?.messages)
    ? context.history.messages
    : [];
  const currentId = Number(message.id);
  const hasCurrent = Number.isSafeInteger(currentId) && currentId > 0;
  const series: NestBurstEntry[] = [];
  for (const row of rows) {
    if (row.outgoing === true) break;
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    // A message that arrived after this one is a newer event with its own
    // turn; it must not be answered twice by this series.
    if (hasCurrent && id > currentId) continue;
    const content = textOf(row.text).trim() || mediaPrefix(row);
    if (!content) continue;
    series.push({ id, text: content.slice(0, MAX_BURST_TEXT) });
  }
  series.reverse();
  if (hasCurrent) {
    if (!series.some((entry) => entry.id === currentId)) {
      series.push({ id: currentId, text });
    }
  }
  return series.slice(-MAX_BURST);
}

/** The series as one prompt block, each message labelled with its id. */
function burstTextOf(burst: NestBurstEntry[]): string {
  return burst
    .map((entry) => `он(${entry.id}): ${entry.text}`)
    .join('\n');
}

/** Union of two series, newest text per id, oldest first. */
function mergeBursts(
  left: NestBurstEntry[],
  right: NestBurstEntry[],
): NestBurstEntry[] {
  const byId = new Map<number, NestBurstEntry>();
  for (const entry of left) byId.set(entry.id, entry);
  for (const entry of right) byId.set(entry.id, entry);
  return [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_BURST);
}

/** Validates a `burst` array from a Nest payload (deferred turn or action). */
function burstOfBody(body: Record<string, unknown>): NestBurstEntry[] {
  return sanitizeBurst(body.burst) ?? [];
}

/** Filters a persisted/transport `burst` value; drops anything malformed. */
function sanitizeBurst(value: unknown): NestBurstEntry[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const byId = new Map<number, NestBurstEntry>();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const id = Number(row.id);
    const text = textOf(row.text).trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !text) continue;
    byId.set(id, { id, text: text.slice(0, MAX_BURST_TEXT) });
  }
  const burst = [...byId.values()]
    .sort((a, b) => a.id - b.id)
    .slice(-MAX_BURST);
  return burst.length > 0 ? burst : undefined;
}

async function decide(
  state: NestState,
  text: string,
  message: Record<string, unknown>,
): Promise<{ decision: BehaviorDecision; hint: string; burst: NestBurstEntry[] } | null> {
  const params = new URLSearchParams({
    personaId: state.personaId,
    accountId: state.accountId,
    chatId: state.chatId,
    threadId: String(state.threadId),
  });
  const context = (await nestGet(
    `/context?${params.toString()}`,
  )) as NestContext;
  const persona = recordOf(context.persona);
  const config = configOf(persona);
  if (!config) return null;

  const relationship = recordOf(context.relationship);
  const stage = STAGE_IDS.has(textOf(relationship.stage))
    ? (textOf(relationship.stage) as Stage)
    : config.stage;
  const score = scoreOf(relationship);
  const conflict = conflictOf(recordOf(context.conflict));
  const history = turnsOf(context);
  const dailyLife = dailyLifeOf(context);
  const profile = computePresenceProfile(config);
  const now = Date.now();
  const stressLoad = stressLoadOf(score, conflict?.level);
  const hormones = computeHormones(
    presenceSeed(config.name, config.age),
    config.age,
    new Date(now),
    stressLoad,
  );
  const lastHer = history
    .filter((turn) => turn.role === 'assistant' && turn.ts)
    .map((turn) => turn.ts ?? 0)
    .sort((a, b) => b - a)[0];
  // Active dialog is her own last outgoing message in the last five minutes
  // (girl-agent runtime.ts). His messages must not create the shortcut: a burst
  // of his messages or a follow-up would otherwise bypass sleep, busy and
  // quiet-block gates. `recentExchangeCount` counts her replies, i.e. real
  // exchanges, not his messages.
  const recentExchangeCount = history.filter(
    (turn) =>
      turn.role === 'assistant' &&
      turn.ts !== undefined &&
      now - turn.ts < 60 * 60_000,
  ).length;
  const presence = computePresenceState(config, profile, {
    now,
    conflict,
    hormones,
    lastUserMsgTs: Date.parse(textOf(message.date)) || now,
    lastHerReplyTs: lastHer,
    recentExchangeCount,
  });
  // Sleep always wins over the active-dialog shortcut: at 03:00 a reply two
  // minutes ago is not a reason to answer instantly.
  const activeDialog =
    !presence.asleep &&
    lastHer !== undefined &&
    now - lastHer < 5 * 60_000;
  // The current message is the natural reaction target even when Nest has not
  // stored it in the history snapshot yet.
  const incomingRefs = recentIncomingRefs(context);
  const currentId = Number(message.id);
  if (
    Number.isSafeInteger(currentId) &&
    currentId > 0 &&
    !incomingRefs.some((ref) => ref.messageId === currentId)
  ) {
    incomingRefs.push({ messageId: currentId, text: text.slice(0, 120) });
  }

  return {
    decision: await decideBehavior({
      config,
      stage,
      score,
      presence,
      conflict,
      history,
      incoming: text,
      dailyLife,
      activeDialog,
      ...(blockHintOf(dailyLife, config.timezone)
        ? { blockHint: blockHintOf(dailyLife, config.timezone) }
        : {}),
      recentIncomingIds: incomingRefs,
      now,
      hormones,
    }),
    hint: presence.hint,
    burst: burstOf(context, message, text),
  };
}

/** Relationship snapshot the reaction policy needs, read from `GET /context`. */
interface ReactionContext {
  stage: Stage;
  conflict: ConflictState | null;
  score: RelationshipScore;
  lastHerMessageAt?: number;
  lastIncomingMessageId?: number;
}

/**
 * Reads the frozen relationship snapshot for a reaction. Only called after the
 * cheap checks (positive emoji on her message) pass, so a reaction in a group
 * or a thumb-down never costs a context fetch.
 */
async function reactionContext(state: NestState): Promise<ReactionContext> {
  const params = new URLSearchParams({
    personaId: state.personaId,
    accountId: state.accountId,
    chatId: state.chatId,
    threadId: String(state.threadId),
  });
  const context = (await nestGet(
    `/context?${params.toString()}`,
  )) as NestContext;
  const persona = recordOf(context.persona);
  const config = configOf(persona);
  const relationship = recordOf(context.relationship);
  const stage = STAGE_IDS.has(textOf(relationship.stage))
    ? (textOf(relationship.stage) as Stage)
    : (config?.stage ?? 'tg-given-warming');
  const history = turnsOf(context);
  const lastHerMessageAt = history
    .filter((turn) => turn.role === 'assistant' && turn.ts)
    .map((turn) => turn.ts ?? 0)
    .sort((a, b) => b - a)[0];
  const lastIncoming = lastIncomingMessageId(context);

  return {
    stage,
    conflict: conflictOf(recordOf(context.conflict)),
    score: scoreOf(relationship),
    ...(lastHerMessageAt !== undefined ? { lastHerMessageAt } : {}),
    ...(lastIncoming !== undefined ? { lastIncomingMessageId: lastIncoming } : {}),
  };
}

/** Newest message of his in the context history (the history is newest first). */
function lastIncomingMessageId(context: NestContext): number | undefined {
  const rows = Array.isArray(context.history?.messages)
    ? context.history.messages
    : [];
  for (const row of rows) {
    if (row.outgoing === true) continue;
    const id = Number(row.id);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return undefined;
}

/** Last few incoming messages with ids, for reaction targeting. */
function recentIncomingRefs(context: NestContext): IncomingRef[] {
  const rows = Array.isArray(context.history?.messages)
    ? context.history.messages
    : [];
  const refs: IncomingRef[] = [];
  for (const row of rows) {
    if (row.outgoing === true) continue;
    const id = Number(row.id);
    const text = textOf(row.text).trim();
    if (!Number.isSafeInteger(id) || id <= 0 || !text) continue;
    refs.push({ messageId: id, text: text.slice(0, 120) });
    if (refs.length >= 8) break;
  }
  return refs.reverse();
}

function mediaPrefix(message: Record<string, unknown>): string {
  const media = recordOf(message.media);
  const kind = textOf(media.kind) || textOf(media.type);
  if (!kind) return '';
  const labels: Record<string, string> = {
    photo: '[он прислал фото]',
    sticker: '[он прислал стикер]',
    voice: '[он прислал голосовое]',
    video: '[он прислал видео]',
    video_note: '[он прислал кружок]',
    document: '[он прислал документ]',
  };
  return labels[kind] ?? `[он прислал ${kind}]`;
}

/** Reply/forward hints: the model needs the quoted text, not just an id. */
function quotedContextHint(message: Record<string, unknown>): string {
  const reply = recordOf(message.replyTo);
  const replyText =
    textOf(reply.text).trim() || textOf(message.replyToText).trim();
  if (replyText) {
    return `[internal: это ответ на сообщение «${replyText.slice(0, 180)}».]`;
  }
  const forwarded = textOf(message.forwardedFrom).trim();
  if (forwarded) {
    return `[internal: он переслал сообщение из «${forwarded.slice(0, 80)}».]`;
  }
  return '';
}

/** Incoming attachment kind for media-specific instructions. */
function mediaKindOf(message: Record<string, unknown>): string {
  const media = recordOf(message.media);
  return textOf(media.kind) || textOf(media.type);
}

/** Incoming media that can be shown to a vision model. */
interface MediaRef {
  messageId: number;
  mimeType: string;
  /** Nest renders a frame collage instead of the raw file. */
  frames: boolean;
}

const IMAGE_MEDIA = new Set(['photo', 'sticker']);
const VIDEO_MEDIA = new Set(['video', 'video_note']);
/** Same ceiling as the Nest preview pipeline: 5 MB per image. */
const MAX_MEDIA_BYTES = 5 * 1024 * 1024;

function mediaRefOf(media: unknown, messageId: number): MediaRef | null {
  const info = recordOf(media);
  const kind = textOf(info.kind) || textOf(info.type);
  const mimeType = textOf(info.mimeType);
  if (!messageId) return null;
  // A ref stored by the delayed queue: `{ messageId, mimeType, frames }`.
  if (typeof info.frames === 'boolean' && mimeType) {
    return { messageId, mimeType, frames: info.frames };
  }
  if (!kind) return null;
  // Animated stickers and every video become a 3x3 frame collage, exactly like
  // the dashboard preview does: the model sees the motion, not one frame.
  if (VIDEO_MEDIA.has(kind) || (kind === 'sticker' && info.isAnimated === true)) {
    return { messageId, mimeType: 'image/jpeg', frames: true };
  }
  if (IMAGE_MEDIA.has(kind) || mimeType.startsWith('image/')) {
    return {
      messageId,
      mimeType: mimeType || 'image/jpeg',
      frames: false,
    };
  }
  return null;
}

/**
 * Fetches the bytes from Nest and turns them into an Eve file part. The model
 * provider never fetches a URL itself, so the channel downloads locally and
 * sends the bytes with the turn. Any failure keeps the text-only turn.
 */
async function mediaPart(
  state: NestState,
  ref: MediaRef,
): Promise<{ type: 'file'; data: Uint8Array; mediaType: string } | null> {
  const base = `/accounts/${encodeURIComponent(state.accountId)}/chats/${encodeURIComponent(
    state.chatId,
  )}/messages/${ref.messageId}`;
  const path = ref.frames ? `${base}/frames` : `${base}/media`;
  try {
    const response = await fetch(`${nestBase()}${path}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_MEDIA_BYTES) {
      return null;
    }
    const mediaType = (response.headers.get('content-type') ?? ref.mimeType)
      .split(';')[0]
      ?.trim();
    return {
      type: 'file',
      data: new Uint8Array(buffer),
      mediaType: mediaType || 'image/jpeg',
    };
  } catch {
    return null;
  }
}

/** Last image per chat, so "что на фото?" right after the photo still works. */
const LAST_IMAGE_TTL_MS = 10 * 60_000;
const lastImageByChat = new Map<string, { ref: MediaRef; at: number }>();

/** Toxic reactions move mood at most once per window per chat. */
const reactionMoodAt = new Map<string, number>();

/**
 * Deletion policy limits. A single Telegram `message.deleted` may be a history
 * cleanup (dozens of ids) and Telegram replays a growing list; one comment per
 * chat per window is enough.
 */
const DELETION_BULK_IDS = 5;
const DELETION_STALE_MS = 10 * 60_000;
const DELETION_COMMENT_WINDOW_MS = 15 * 60_000;
/** Last deletion comment per chat, so replays do not produce a reply each. */
const deletionReplyAt = new Map<string, number>();
/** Deletion deliveries that have not started their turn yet. */
const deletionDeliveries = new Map<string, number>();
/** Deletion turns by turn id, so `content.completed` can tell them apart. */
const deletionTurns = new Map<string, number>();

/** Last behavior decision per chat, for `GET /eve/v1/nest/why`. */const lastDecisionByChat = new Map<
  string,
  {
    at: string;
    intent: string;
    shouldReply: boolean;
    ignoreReason?: string;
    delaySec: number;
    reaction?: string;
    source?: string;
  }
>();

function rememberDecision(state: NestState, decision: BehaviorDecision): void {
  const key = chatKey(state);
  lastDecisionByChat.set(key, {
    at: new Date().toISOString(),
    intent: decision.intent,
    shouldReply: decision.shouldReply,
    ...(decision.ignoreReason ? { ignoreReason: decision.ignoreReason } : {}),
    delaySec: decision.delaySec,
    ...(decision.reaction ? { reaction: decision.reaction } : {}),
    source: decision.source,
  });
  if (lastDecisionByChat.size > 500) {
    const oldest = lastDecisionByChat.keys().next().value;
    if (oldest) lastDecisionByChat.delete(oldest);
  }
}

/** Last bubbles she sent per chat, for anti-repetition (newest last). */
const recentRepliesByChat = new Map<string, string[]>();

function rememberReplies(state: NestState, parts: string[]): void {
  const key = chatKey(state);
  const previous = recentRepliesByChat.get(key) ?? [];
  recentRepliesByChat.set(key, [...previous, ...parts].slice(-8));
  if (recentRepliesByChat.size > 500) {
    const oldest = recentRepliesByChat.keys().next().value;
    if (oldest) recentRepliesByChat.delete(oldest);
  }
}

function recentReplies(state: NestState): string[] {
  return recentRepliesByChat.get(chatKey(state)) ?? [];
}

function chatKey(state: NestState): string {
  return `${state.personaId}:${state.accountId}:${state.chatId}`;
}

/**
 * `/agenda/extract` runs an LLM in Nest. In a fast exchange one extraction per
 * message would queue several identical calls, so it is throttled per chat.
 */
const AGENDA_EXTRACT_WINDOW_MS = 5 * 60_000;
const agendaExtractAt = new Map<string, number>();

function agendaAllowed(state: NestState): boolean {
  const key = chatKey(state);
  const now = Date.now();
  const previous = agendaExtractAt.get(key);
  if (previous !== undefined && now - previous < AGENDA_EXTRACT_WINDOW_MS) {
    return false;
  }
  agendaExtractAt.set(key, now);
  if (agendaExtractAt.size > 500) {
    const oldest = agendaExtractAt.keys().next().value;
    if (oldest) agendaExtractAt.delete(oldest);
  }
  return true;
}

function rememberImage(state: NestState, ref: MediaRef | null): void {
  if (!ref) return;
  const key = chatKey(state);
  lastImageByChat.set(key, { ref, at: Date.now() });
  if (lastImageByChat.size > 500) {
    const oldest = lastImageByChat.keys().next().value;
    if (oldest) lastImageByChat.delete(oldest);
  }
}

function recentImage(state: NestState): MediaRef | null {
  const cached = lastImageByChat.get(chatKey(state));
  if (!cached) return null;
  return Date.now() - cached.at <= LAST_IMAGE_TTL_MS ? cached.ref : null;
}

/**
 * Test hook: the per-chat caches above are module state, so a spec that drives
 * many turns must reset them to stay independent of the previous test.
 */
export function resetChannelCaches(): void {
  lastImageByChat.clear();
  reactionMoodAt.clear();
  lastDecisionByChat.clear();
  recentRepliesByChat.clear();
  agendaExtractAt.clear();
  deletionReplyAt.clear();
  deletionDeliveries.clear();
  deletionTurns.clear();
}

/** Builds the turn content: text plus an image, when there is one. */
async function turnContent(
  state: NestState,
  outgoing: string,
  ref: MediaRef | null,
): Promise<string | Array<{ type: 'text'; text: string } | { type: 'file'; data: Uint8Array; mediaType: string }>> {
  if (!ref) return outgoing;
  const part = await mediaPart(state, ref);
  return part ? [{ type: 'text' as const, text: outgoing }, part] : outgoing;
}

function behaviorPrefix(decision: BehaviorDecision, hint: string): string {
  const parts = [
    `intent=${decision.intent}`,
    `bubbles=${decision.bubbles}`,
    `typing=${decision.typing ? 'true' : 'false'}`,
  ];
  if (hint) parts.push(`hint=${hint}`);
  return `[internal: ${parts.join('; ')}]`;
}

/** Maps the behavior source to the queue reason Nest stores. */
function delayReason(decision: BehaviorDecision): string {
  if (decision.source === 'asleep' || decision.source === 'night-wake') {
    return 'sleep';
  }
  return 'delay';
}

/** Rebuilds the behavior frame for a deferred turn from Nest's stored payload. */
function turnPrefix(behavior: Record<string, unknown>, hint: string): string {
  const intent = textOf(behavior.intent);
  if (!intent) return hint ? `[internal: hint=${hint}]` : '';
  return behaviorPrefix(behavior as unknown as BehaviorDecision, hint);
}

function nestBase(): string {
  return (process.env.EVE_NEST_URL ?? 'http://127.0.0.1:4001').replace(
    /\/+$/,
    '',
  );
}

function eveToken(): string {
  return process.env.EVE_TOKEN ?? '';
}

async function nest(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${nestBase()}/internal/eve${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-eve-token': eveToken(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      `Nest ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json() as Promise<unknown>;
}

async function applyTurn(
  state: NestState,
  decision: BehaviorDecision | undefined,
  outgoing: string | null,
): Promise<void> {
  if (!decision) return;
  const series =
    Array.isArray(state.burst) && state.burst.length > 0
      ? state.burst
      : state.messageId !== undefined
        ? [{ id: state.messageId, text: state.incoming ?? '' }]
        : [];
  const messageIds =
    Array.isArray(state.messageIds) && state.messageIds.length > 0
      ? state.messageIds
      : series.map((entry) => entry.id);
  await nest('/turn/apply', {
    personaId: state.personaId,
    accountId: state.accountId,
    chatId: state.chatId,
    threadId: state.threadId,
    messageId: state.messageId,
    messageIds: messageIds.length > 0 ? messageIds : undefined,
    messages: series.length > 0 ? series : undefined,
    text: state.incoming,
    incoming: state.incoming,
    reply: outgoing,
    turnKey: state.turnKey,
    origin: state.origin,
    decision,
    dryRun: state.dryRun === true,
  });
}

/** Extracts userbot-style markers and returns the clean text. */
function extractToolMarkers(value: string): { clean: string; actions: string[] } {
  const actions: string[] = [];
  const clean = value
    .replace(/\[(BLOCK|UNBLOCK|READ|STICKER)\]/gi, (_match, action: string) => {
      actions.push(action.toUpperCase());
      return '';
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { clean, actions };
}

async function sendRandomSticker(state: NestState): Promise<void> {
  const data = (await nestGet(
    `/stickers?personaId=${encodeURIComponent(state.personaId)}`,
  )) as Array<{ fileId?: unknown; emoji?: unknown; tags?: unknown }>;
  const stickers = Array.isArray(data)
    ? data.filter(
        (row): row is { fileId: string; emoji?: string; tags?: string } =>
          typeof row.fileId === 'string' && row.fileId.length > 8,
      )
    : [];
  if (stickers.length === 0) return;
  // Prefer a sticker that matches the current mood; fall back to the whole
  // library when nothing is tagged.
  const mood = stickerMood(state.behavior);
  const matched = mood
    ? stickers.filter((row) => {
        const hay = `${textOf(row.emoji)} ${textOf(row.tags)}`.toLowerCase();
        return mood.some((tag) => hay.includes(tag.toLowerCase()));
      })
    : [];
  const pool = matched.length > 0 ? matched : stickers;
  const pick = pool[Math.floor(Math.random() * pool.length)]!;
  await nest('/messages/sticker', {
    personaId: state.personaId,
    accountId: state.accountId,
    chatId: state.chatId,
    threadId: state.threadId,
    fileId: pick.fileId,
    dryRun: state.dryRun === true,
  });
}

/** Emoji/tag hints for the sticker library, from the decision that was made. */
function stickerMood(decision: BehaviorDecision | undefined): string[] {
  if (!decision) return ['😂', '❤', '🙂'];
  if (decision.intent === 'left-on-read' || decision.intent === 'ignore') {
    return [];
  }
  if (decision.moodDelta?.annoyance && decision.moodDelta.annoyance > 0) {
    return ['😐', '🙄'];
  }
  if (decision.intent === 'reply' || decision.intent === 'short') {
    return ['😂', '❤', '🙂'];
  }
  return [];
}

/**
 * Queues (or sends) a reaction independently of the reply. The reaction must
 * fire even when the decision is "do not reply": that is exactly the
 * `reaction-only` intent, and the old early return dropped it.
 */
async function scheduleReaction(
  state: NestState,
  plan: ReactionPlan,
  key: string | undefined,
  shouldReply: boolean,
  delaySec: number,
): Promise<void> {
  if (!plan.targetMessageId) return;
  const delay = Math.round(
    Math.min(30, Math.max(0, delaySec)) * (shouldReply ? 0.3 : 1),
  );
  const reaction = {
    personaId: state.personaId,
    accountId: state.accountId,
    chatId: state.chatId,
    threadId: state.threadId,
    messageId: plan.targetMessageId,
    emoji: plan.emoji,
    dryRun: state.dryRun === true,
  };
  if (delay > 0) {
    // Nest owns the clock: an Eve restart must not lose the reaction.
    await bestEffort(
      nest('/actions', {
        ...reaction,
        kind: 'react',
        delaySec: delay,
        key: key ? `react:${key}` : undefined,
        payload: reaction,
      }),
    );
    return;
  }
  await bestEffort(nest('/messages/react', reaction));
}

async function runToolActions(state: NestState, actions: string[]): Promise<void> {
  for (const action of actions) {
    if (action === 'READ') {
      await nest('/read', {
        personaId: state.personaId,
        accountId: state.accountId,
        chatId: state.chatId,
        threadId: state.threadId,
        dryRun: state.dryRun === true,
      });
    } else if (action === 'BLOCK' || action === 'UNBLOCK') {
      await nest(action === 'BLOCK' ? '/messages/block' : '/messages/unblock', {
        personaId: state.personaId,
        accountId: state.accountId,
        chatId: state.chatId,
        threadId: state.threadId,
        dryRun: state.dryRun === true,
      });
    } else if (action === 'STICKER') {
      await sendRandomSticker(state);
    }
  }
}

/** Side effects such as typing/read must never fail the turn. */
function bestEffort(task: Promise<unknown>): Promise<unknown> {
  return task.catch(() => undefined);
}

function idOf(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim()
    : '';
}

function parseState(body: Record<string, unknown>): NestState | null {
  const personaId = textOf(body.personaId).trim();
  const accountId = textOf(body.accountId).trim();
  const chatId = idOf(body.chatId);
  if (!personaId || !accountId || !chatId) return null;
  return {
    personaId,
    accountId,
    chatId,
    threadId: Number(body.threadId ?? 0) || 0,
    // Always false here: only `/turn` and `/proactive` opt in explicitly, so a
    // real Telegram event can never become a dry run by accident.
    dryRun: false,
  };
}

/**
 * Stable idempotency key for one inbound event.
 *
 * `EveEvent.id` is the primary key. The cursor endpoint replays the same row,
 * so reusing it makes a replay a no-op. When a caller omits the row id (for
 * example a direct test or an older payload) fall back to the provider event
 * dedupe key and then to `(accountId, chatId, messageId)`.
 */
function idempotencyKey(
  body: Record<string, unknown>,
  state: NestState,
): string | undefined {
  const message = recordOf(body.message);
  const raw =
    idOf(body.id) ||
    idOf(body.dedupeKey) ||
    (idOf(message.id)
      ? `message.new:${state.accountId}:${state.chatId}:${state.threadId}:${idOf(message.id)}`
      : '');
  if (!raw) return undefined;
  return raw.length > IDEMPOTENCY_KEY_MAX
    ? raw.slice(0, IDEMPOTENCY_KEY_MAX)
    : raw;
}

/**
 * Identity of one writeback turn. The purpose prefix keeps an inbound, a
 * deferred dispatch and an ignore of the same event apart, while a retry of the
 * same turn repeats the key exactly.
 */
function turnKeyOf(
  purpose: string,
  seed: string | undefined,
): string | undefined {
  const value = textOf(seed).slice(0, 200);
  return value ? `${purpose}:${value}` : undefined;
}

function hasAddress(state: NestState): boolean {
  return Boolean(state.accountId && state.chatId);
}

/**
 * Idempotency key for a reaction-triggered turn. The `EveEvent.id` is the
 * provider-side identity, so a cursor replay cannot start a second turn; the
 * `reaction:` prefix keeps it distinct from any other turn from the same row.
 */
function reactionIdempotencyKey(
  body: Record<string, unknown>,
): string | undefined {
  const raw = idOf(body.id) || idOf(body.dedupeKey);
  if (!raw) return undefined;
  const key = `reaction:${raw}`;
  return key.length > IDEMPOTENCY_KEY_MAX
    ? key.slice(0, IDEMPOTENCY_KEY_MAX)
    : key;
}

function authFor(state: NestState, origin: NestState['origin'] = 'inbound') {
  return {
    authenticator: 'combain',
    principalId: state.personaId,
    principalType: 'user' as const,
    attributes: {
      personaId: state.personaId,
      accountId: state.accountId,
      chatId: state.chatId,
      threadId: String(state.threadId),
      // Why this turn exists. The context snapshot uses it to label the turn
      // without guessing from the text; `deferred` maps to `inbound`.
      kind: origin,
      // Travels to the `turn.settled` snapshot hook, so the stored context is
      // marked as a test turn exactly when its outbound was suppressed.
      dryRun: state.dryRun === true ? 'true' : 'false',
    },
  };
}

/**
 * `message.reaction`: deterministic, never unconditional.
 *
 * The policy gets the frozen relationship/conflict snapshot and decides
 * ignore / react / reply. Only `reply` starts a model turn; a reaction back is
 * one Nest call. A reaction turn carries `applied: true`, so `content.completed`
 * skips `turn/apply`: a reaction is not a new incoming message and must not
 * move the relationship counters twice.
 */
async function handleReaction(
  body: Record<string, unknown>,
  from: ChannelFrom<NestState>,
): Promise<Response> {
  const state = parseState(body);
  if (!state) {
    return Response.json({ ok: false, error: 'bad-address' }, { status: 400 });
  }
  // Real reactions are live by default; a test may drive a dry reaction.
  state.dryRun = body.dryRun === true;

  const emoji = textOf(body.emoji).trim();
  const targetIsMine =
    typeof body.targetIsMine === 'boolean' ? body.targetIsMine : undefined;

  // Cheap gates before the context fetch: a missing emoji, a reaction the
  // persona sent herself, or a reaction on his own message never needs
  // relationship data.
  if (!emoji) return Response.json({ ok: true, ignored: 'reaction:no-emoji' });
  if (body.outgoing === true) {
    return Response.json({ ok: true, ignored: 'reaction:outgoing' });
  }
  if (targetIsMine !== true) {
    return Response.json({ ok: true, ignored: 'reaction:not-mine' });
  }

  const snapshot = await reactionContext(state).catch(() => null);
  if (!snapshot) {
    return Response.json({ ok: true, ignored: 'reaction:no-context' });
  }

  const decision = decideReaction({
    emoji,
    targetIsMine,
    stage: snapshot.stage,
    conflict: snapshot.conflict,
    score: snapshot.score,
    now: Date.now(),
    lastHerMessageAt: snapshot.lastHerMessageAt,
  });
  if (decision.action === 'ignore') {
    // A negative reaction is never answered, but it is not free either: the
    // mood moves silently, throttled per chat so a burst of emoji is not a
    // burst of damage.
    if (decision.moodDelta) {
      const key = chatKey(state);
      const now = Date.now();
      if (reactionMoodAllowed(reactionMoodAt.get(key), now)) {
        reactionMoodAt.set(key, now);
        if (reactionMoodAt.size > 500) {
          const oldest = reactionMoodAt.keys().next().value;
          if (oldest) reactionMoodAt.delete(oldest);
        }
        await bestEffort(
          nest('/state/mood', {
            personaId: state.personaId,
            accountId: state.accountId,
            chatId: state.chatId,
            threadId: state.threadId,
            moodDelta: decision.moodDelta,
            source: 'reaction',
            emoji,
          }),
        );
      }
    }
    return Response.json({
      ok: true,
      ignored: `reaction:${decision.reason}`,
    });
  }

  if (decision.action === 'react') {
    const target = snapshot.lastIncomingMessageId;
    if (!target) return Response.json({ ok: true, ignored: 'reaction:no-target' });
    await bestEffort(
      nest('/messages/react', {
        personaId: state.personaId,
        accountId: state.accountId,
        chatId: state.chatId,
        threadId: state.threadId,
        messageId: target,
        emoji: decision.emoji ?? emoji,
        dryRun: state.dryRun === true,
      }),
    );
    return Response.json({
      ok: true,
      reaction: 'react',
      emoji: decision.emoji ?? emoji,
    });
  }

  const prompt = `[internal: он поставил реакцию на твоё сообщение (${emoji}); можешь коротко отреагировать или промолчать]`;
  const key = reactionIdempotencyKey(body);
  await from(`${state.personaId}:${state.accountId}:${state.chatId}`).send(
    // The event itself is in the system frame; the user turn is a neutral
    // marker so nothing service-shaped is recorded as his words.
    '…',
    {
      auth: authFor(state, 'reaction'),
      // `queue`: a reaction turn must not steer into a reply that is already
      // running. Steering would replace its per-turn fields mid-turn and
      // attribute the answer (and its counters) to the wrong message.
      turnPolicy: 'queue',
      state: {
        ...state,
        incoming: '…',
        internal: prompt,
        applied: true,
        origin: 'reaction',
      },
      ...(key ? { idempotencyKey: key } : {}),
    },
  );
  return Response.json({ ok: true, reaction: 'reply' }, { status: 202 });
}

interface DeletedMessageInfo {
  text?: string;
  receivedAt?: number;
  outgoing?: boolean;
}

/**
 * Newest deleted message of his from the event. Nest enriches the payload with
 * `{ id, text, date }` per deleted id; an older payload without it still
 * classifies by timestamp and lets the model comment without a quote.
 */
function deletedInfoOf(body: Record<string, unknown>): DeletedMessageInfo | null {
  const list = Array.isArray(body.messages)
    ? body.messages.map((entry) => recordOf(entry))
    : Object.keys(recordOf(body.message)).length > 0
      ? [recordOf(body.message)]
      : [];
  if (list.length === 0) {
    // Legacy payload without per-id facts: only the aggregate flag proves the
    // author. Unknown author must stay silent.
    if (body.outgoing !== false) return null;
    const direct = Date.parse(textOf(body.receivedAt));
    return {
      ...(textOf(body.text).trim() ? { text: textOf(body.text).trim() } : {}),
      ...(Number.isFinite(direct) ? { receivedAt: direct } : {}),
      outgoing: false,
    };
  }
  // Only an explicit `outgoing: false` is his message. `undefined` means the
  // process did not see the id (restart or cache eviction) and is not enough
  // evidence for a comment.
  const ours = list.filter((entry) => entry.outgoing === false);
  const row = ours[ours.length - 1];
  if (!row) return null;
  const date = Date.parse(textOf(row.date));
  return {
    ...(textOf(row.text).trim() ? { text: textOf(row.text).trim() } : {}),
    ...(Number.isFinite(date) ? { receivedAt: date } : {}),
    outgoing: false,
  };
}

/** Newest timestamp of the deleted messages, when the payload carries one. */
function newestDeletedAt(body: Record<string, unknown>): number | undefined {
  const dates: number[] = [];
  const direct = Date.parse(textOf(body.receivedAt));
  if (Number.isFinite(direct)) dates.push(direct);
  if (Array.isArray(body.messages)) {
    for (const entry of body.messages) {
      const row = recordOf(entry);
      const date = Date.parse(textOf(row.date));
      if (Number.isFinite(date)) dates.push(date);
    }
  }
  return dates.length > 0 ? Math.max(...dates) : undefined;
}

/**
 * `message.deleted`: saw-and-read → "ты куда удалил", saw-not-read → "покажи
 * что писал", missed → silence. The turn is excluded from relationship
 * counters (`applied: true`): a deletion is not a new incoming message.
 */
async function handleDeletion(
  body: Record<string, unknown>,
  from: ChannelFrom<NestState>,
): Promise<Response> {
  const state = parseState(body);
  if (!state) {
    return Response.json({ ok: false, error: 'bad-address' }, { status: 400 });
  }
  // Real deletions are live by default; a test may drive a dry deletion turn.
  state.dryRun = body.dryRun === true;
  if (body.outgoing === true) {
    return Response.json({ ok: true, ignored: 'deletion:own' });
  }

  // Telegram replays deletions in growing lists. A large list is a history
  // cleanup / cache eviction, not a fresh "he deleted one message"; commenting
  // on it (or on every replay) is spam.
  const ids = Array.isArray(body.messageIds) ? body.messageIds : [];
  if (ids.length > DELETION_BULK_IDS) {
    return Response.json({ ok: true, ignored: 'deletion:bulk' });
  }

  // Even a small deletion must be recent. A replayed row can arrive now while
  // the deleted text is hours old.
  const newest = newestDeletedAt(body);
  if (newest !== undefined && Date.now() - newest > DELETION_STALE_MS) {
    return Response.json({ ok: true, ignored: 'deletion:stale' });
  }

  const info = deletedInfoOf(body);
  if (!info) {
    return Response.json({ ok: true, ignored: 'deletion:no-payload' });
  }
  if (info.outgoing !== false) {
    return Response.json({ ok: true, ignored: 'deletion:author-unknown' });
  }

  // One deletion comment per chat/window. The durable Nest throttle already
  // drops most replays before they reach Eve; this covers cursor replays and
  // events written before the Nest-side gate existed.
  const now = Date.now();
  const throttleKey = chatKey(state);
  const lastComment = deletionReplyAt.get(throttleKey);
  if (
    lastComment !== undefined &&
    now - lastComment < DELETION_COMMENT_WINDOW_MS
  ) {
    return Response.json({ ok: true, ignored: 'deletion:throttled' });
  }
  const params = new URLSearchParams({
    personaId: state.personaId,
    accountId: state.accountId,
    chatId: state.chatId,
    threadId: String(state.threadId),
  });
  const context = (await nestGet(
    `/context?${params.toString()}`,
  ).catch(() => null)) as NestContext | null;
  if (!context) return Response.json({ ok: true, ignored: 'deletion:no-context' });

  const history = turnsOf(context);
  const lastHerMessageAt = history
    .filter((turn) => turn.role === 'assistant' && turn.ts)
    .map((turn) => turn.ts ?? 0)
    .sort((a, b) => b - a)[0];
  const lastAnyAt = history
    .filter((turn) => turn.ts)
    .map((turn) => turn.ts ?? 0)
    .sort((a, b) => b - a)[0];
  const awareness = classifyDeletion({
    ...(info.receivedAt !== undefined ? { receivedAt: info.receivedAt } : {}),
    ...(lastHerMessageAt !== undefined ? { lastHerMessageAt } : {}),
    now,
    activeDialog:
      lastAnyAt !== undefined && now - lastAnyAt < 15 * 60_000,
  });
  const prompt = deletionPromptFragment(awareness, info.text);
  if (!prompt) {
    return Response.json({ ok: true, ignored: `deletion:${awareness}` });
  }

  // `dedupeKey` is the stable provider identity; `id` is a unique row id, so a
  // cursor replay of the same Telegram update would produce a new turn if the
  // id won. Fall back to the row id only for old payloads without a key.
  const rawKey = idOf(body.dedupeKey) || idOf(body.id);
  const key = rawKey ? `deleted:${rawKey}`.slice(0, IDEMPOTENCY_KEY_MAX) : undefined;
  const delivery = await from(
    `${state.personaId}:${state.accountId}:${state.chatId}`,
  ).send(
    // Event, not his words: the quote and the instruction live in the system
    // frame so they never enter the user history.
    '…',
    {
      auth: authFor(state, 'deletion'),
      // `queue`: a deletion comment gets its own turn instead of steering into
      // an answer that is already in flight.
      turnPolicy: 'queue',
      state: {
        ...state,
        incoming: '…',
        internal: prompt,
        applied: true,
        origin: 'deletion',
        deletionAt: now,
        ...(state.lastInboundAt !== undefined
          ? { lastInboundAt: state.lastInboundAt }
          : {}),
      },
      ...(key ? { idempotencyKey: key } : {}),
    },
  );
  // Tie this delivery to its turn: `content.completed` only carries a turn id,
  // and the shared channel state may already belong to a newer inbound.
  const deliveryId = (delivery as { deliveryId?: unknown } | null)?.deliveryId;
  if (typeof deliveryId === 'string' && deliveryId) {
    deletionDeliveries.set(deliveryId, now);
    if (deletionDeliveries.size > 200) {
      const oldest = deletionDeliveries.keys().next().value;
      if (oldest) deletionDeliveries.delete(oldest);
    }
  }
  // Only a turn that actually started consumes the window, so a failed send
  // can be retried by Nest instead of being throttled away.
  deletionReplyAt.set(throttleKey, now);
  if (deletionReplyAt.size > 500) {
    const oldest = deletionReplyAt.keys().next().value;
    if (oldest) deletionReplyAt.delete(oldest);
  }
  return Response.json({ ok: true, deletion: awareness }, { status: 202 });
}

export default defineChannel<NestState, { state: NestState }>({
  state: {
    personaId: '',
    accountId: '',
    chatId: '',
    threadId: 0,
  },

  /**
   * Expose the durable Nest address as `ctx.channel.state` in every handler.
   * `deliver` merges new values from the next inbound message.
   */
  context(state) {
    return { state };
  },

  /**
   * Dynamic instructions read the current turn's engine frame from channel
   * metadata. It is a projection of the same durable state, so it always
   * describes the turn being assembled.
   */
  metadata(state) {
    return {
      personaId: state.personaId,
      accountId: state.accountId,
      chatId: state.chatId,
      threadId: state.threadId,
      origin: state.origin ?? 'inbound',
      internal: state.internal ?? '',
    };
  },

  deliver(payload, ctx) {
    const next = payload.state;
    if (!next) return;
    if (typeof next.personaId === 'string' && next.personaId) {
      ctx.state.personaId = next.personaId;
    }
    if (typeof next.accountId === 'string' && next.accountId) {
      ctx.state.accountId = next.accountId;
    }
    if (typeof next.chatId === 'string' && next.chatId) {
      ctx.state.chatId = next.chatId;
    }
    if (typeof next.threadId === 'number' && Number.isFinite(next.threadId)) {
      ctx.state.threadId = next.threadId;
    }
    // A queued delivery (proactive/reaction/deletion) can be coalesced by Eve
    // with an inbound that has not been applied yet (`takeNext` +
    // `takeFollowingDeliveriesFrom`). Such a delivery carries no inbound of its
    // own, so clearing the per-turn fields here would drop that inbound's
    // `turn/apply` and its counters. Keep the pending inbound payload instead.
    const carriesInbound =
      typeof next.incoming === 'string' &&
      next.incoming.length > 0 &&
      next.applied !== true;
    if (!carriesInbound && ctx.state.applied === false) {
      return;
    }
    // Per-turn fields are assigned on every delivery, never inherited: a
    // proactive or reaction turn must not replay the previous inbound into
    // `turn/apply`. Address fields above are the only long-lived state.
    ctx.state.incoming =
      typeof next.incoming === 'string' && next.incoming ? next.incoming : undefined;
    ctx.state.messageId =
      typeof next.messageId === 'number' && Number.isSafeInteger(next.messageId) && next.messageId > 0
        ? next.messageId
        : undefined;
    ctx.state.messageIds = Array.isArray(next.messageIds)
      ? next.messageIds.filter(
          (id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0,
        )
      : undefined;
    if (!ctx.state.messageIds || ctx.state.messageIds.length === 0) {
      ctx.state.messageIds = undefined;
    }
    ctx.state.burst = sanitizeBurst(next.burst);
    ctx.state.behavior = next.behavior ?? undefined;
    ctx.state.internal =
      typeof next.internal === 'string' && next.internal.trim()
        ? next.internal.trim().slice(0, 4_000)
        : undefined;
    // Per-turn provenance. The timestamps only move forward: a later
    // delivery must not rewind the inbound mark that decides whether a
    // deletion reply is already stale.
    ctx.state.origin = next.origin ?? ctx.state.origin;
    if (
      typeof next.lastInboundAt === 'number' &&
      Number.isFinite(next.lastInboundAt) &&
      next.lastInboundAt > (ctx.state.lastInboundAt ?? 0)
    ) {
      ctx.state.lastInboundAt = next.lastInboundAt;
    }
    if (
      typeof next.deletionAt === 'number' &&
      Number.isFinite(next.deletionAt) &&
      next.deletionAt > (ctx.state.deletionAt ?? 0)
    ) {
      ctx.state.deletionAt = next.deletionAt;
    }
    ctx.state.turnKey =
      typeof next.turnKey === 'string' && next.turnKey
        ? next.turnKey.slice(0, 256)
        : undefined;
    // Per-turn, never sticky: a real inbound clears a test turn's flag.
    ctx.state.dryRun = next.dryRun === true;
    // Per-turn, never sticky: a normal inbound carries `applied: false`, so a
    // later `content.completed` applies counters exactly once for this message.
    ctx.state.applied = next.applied === true;
  },

  routes: [
    POST('/eve/v1/nest/events', async (request, { from }) => {
      let body: Record<string, unknown>;
      try {
        body = recordOf(await request.json());
      } catch {
        return Response.json(
          { ok: false, error: 'invalid-json' },
          { status: 400 },
        );
      }

      // Nest sends only durable, explicitly allowed chats to Eve. A denied
      // chat is acknowledged so the Nest retry loop stops; it never starts a
      // turn.
      if (body.allowed !== true) {
        return Response.json({ ok: true, ignored: 'chat-not-allowed' });
      }

      // Edits and read receipts never start a turn. A deleted message may: the
      // three-branch policy below decides whether she saw it and whether a
      // short in-character comment is warranted.
      const kind = textOf(body.kind);
      if (kind === 'message.deleted') {
        return handleDeletion(body, from);
      }
      if (kind === 'message.edited' || kind === 'message.read') {
        return Response.json({ ok: true, ignored: `kind:${kind}` });
      }

      // A reaction is deterministic: no model turn unless the policy says so.
      if (kind === 'message.reaction') {
        return handleReaction(body, from);
      }

      if (kind && kind !== 'message.new') {
        return Response.json({ ok: true, ignored: `kind:${kind}` });
      }

      const message = recordOf(body.message);
      const rawText = textOf(message.text).trim();
      const media = mediaPrefix(message);
      const text = [media, rawText].filter(Boolean).join(' ').trim();
      if (!text) return Response.json({ ok: true, ignored: 'empty' });

      const state = parseState(body);
      if (!state) {
        return Response.json(
          { ok: false, error: 'bad-address' },
          { status: 400 },
        );
      }

      const address = `${state.personaId}:${state.accountId}:${state.chatId}`;
      const key = idempotencyKey(body, state);
      const mediaInfo = recordOf(message.media);
      const hints = [
        mediaInstruction(mediaKindOf(message)),
        mediaRequestHint(requestedMedia(rawText)),
        quotedContextHint(message),
        looksLikeJailbreak(rawText) ? INJECTION_HINT : '',
      ].filter(Boolean);
      if (
        textOf(mediaInfo.kind) === 'sticker' &&
        textOf(mediaInfo.fileId)
      ) {
        await bestEffort(
          nest('/stickers', {
            personaId: state.personaId,
            fileId: mediaInfo.fileId,
            emoji: mediaInfo.emoji,
            tags: ['received'],
          }),
        );
      }

      // Deterministic policy before a session is created. If she would ignore,
      // sleep, stay cold or is in a quiet block, no model turn is started at
      // all. This is the girl-agent `behavior-tick` gate, not a prompt hint.
      let policy: { decision: BehaviorDecision; hint: string } | null = null;
      // A burst of his messages that are still unanswered: a superseded turn
      // used to drop every text but the last one. The model answers the series.
      let burst: NestBurstEntry[] = [];
      try {
        const decided = await decide(state, text, message);
        if (decided) {
          policy = { decision: decided.decision, hint: decided.hint };
          burst = decided.burst;
        }
      } catch {
        // A missing/broken Nest context must not silently swallow the message;
        // fall through to the model with the plain text.
      }
      if (burst.length === 0) {
        const currentId = Number(message.id);
        burst =
          Number.isSafeInteger(currentId) && currentId > 0
            ? [{ id: currentId, text }]
            : [];
      }
      // Nest already knows the texts of the deferred turns it dropped when this
      // message arrived. The fresh `/context` normally contains them too; this
      // keeps them when it does not (a slow history read or a broken context).
      const superseded = sanitizeBurst(body.supersededBurst);
      if (superseded) burst = mergeBursts(superseded, burst);
      const series = burst.length > 1 ? burstTextOf(burst) : text;
      const policyReaction = policy
        ? reactionPlan(policy.decision, Number(message.id) || undefined)
        : null;
      if (policy) rememberDecision(state, policy.decision);
      // `reaction-only` (and a reaction attached to an ignore) is still an
      // action: send it before the early return decides there is no reply.
      if (policyReaction && policy && !policy.decision.shouldReply) {
        await scheduleReaction(
          state,
          policyReaction,
          key,
          false,
          policy.decision.delaySec,
        );
      }
      if (policy && !policy.decision.shouldReply) {
        if (policy.decision.shouldRead) {
          await bestEffort(
            nest('/read', {
              personaId: state.personaId,
              accountId: state.accountId,
              chatId: state.chatId,
              threadId: state.threadId,
              dryRun: state.dryRun === true,
            }),
          );
        }
        const ignoredState: NestState = {
          ...state,
          incoming: text,
          messageId: Number(message.id) || undefined,
          messageIds: burst.map((entry) => entry.id),
          burst: burst.length > 1 ? burst : undefined,
          behavior: policy.decision,
          origin: 'inbound',
          lastInboundAt: Date.now(),
          turnKey: turnKeyOf('inbound', key),
          // A real Telegram event is never a dry run.
          dryRun: false,
        };
        await bestEffort(applyTurn(ignoredState, policy.decision, null));
        return Response.json({
          ok: true,
          ignored: 'behavior',
          intent: policy.decision.intent,
          reason: policy.decision.ignoreReason ?? null,
          ...(policyReaction ? { reaction: policyReaction.emoji } : {}),
        });
      }

      // The engine frame travels in the channel state, where the dynamic
      // instructions render it as a system block. His message stays clean.
      const internalFrame = [
        policy ? behaviorPrefix(policy.decision, policy.hint) : '',
        ...hints,
      ]
        .filter(Boolean)
        .join('\n');
      const outgoing = series;
      const sendState: NestState = {
        ...state,
        incoming: text,
        messageId: Number(message.id) || undefined,
        messageIds: burst.map((entry) => entry.id),
        burst: burst.length > 1 ? burst : undefined,
        behavior: policy?.decision,
        internal: internalFrame || undefined,
        origin: 'inbound',
        lastInboundAt: Date.now(),
        turnKey: turnKeyOf('inbound', key),
        // A real Telegram event is never a dry run.
        dryRun: false,
        // Explicit: this inbound still has to be applied by `content.completed`.
        applied: false,
      };
      const currentMedia = mediaRefOf(
        message.media,
        Number(message.id) || 0,
      );
      rememberImage(state, currentMedia);
      // A follow-up like "что на фото?" has no media of its own; attach the last
      // image of this chat for a short window, like the Nest media cache does.
      const attachedMedia = currentMedia ?? recentImage(state);

      const send = async () => {
        const content = await turnContent(state, outgoing, attachedMedia);
        return from(address).send(content, {
          auth: authFor(state),
          state: sendState,
          ...(key ? { idempotencyKey: key } : {}),
        });
      };

      if (policyReaction && policy) {
        await scheduleReaction(
          state,
          policyReaction,
          key,
          policy.decision.shouldReply,
          policy.decision.delaySec,
        );
      }

      if (policy && policy.decision.delaySec > 0) {
        // Durable deferred turn. Nest stores it and calls back
        // `POST /eve/v1/nest/turn` when it is due; nothing is kept in memory.
        const queued = recordOf(
          await nest('/actions', {
            kind: 'turn',
            personaId: state.personaId,
            accountId: state.accountId,
            chatId: state.chatId,
            threadId: state.threadId,
            delaySec: policy.decision.delaySec,
            reason: delayReason(policy.decision),
            key: key ? `turn:${key}` : undefined,
            dryRun: state.dryRun === true,
            payload: {
              incoming: text,
              messageId: Number(message.id) || undefined,
              burst: burst.length > 0 ? burst : undefined,
              behavior: policy.decision,
              hint: policy.hint,
              hints,
              idempotencyKey: key,
              media: attachedMedia ?? undefined,
              dryRun: state.dryRun === true,
            },
          }),
        );
        return Response.json(
          {
            ok: true,
            queued: true,
            actionId: textOf(queued.id) || null,
            delaySec: policy.decision.delaySec,
          },
          { status: 202 },
        );
      }

      await send();
      return Response.json({ ok: true }, { status: 202 });
    }),

    // Durable deferred turn: Nest stored it in `EveDelayedAction` and calls
    // this route once `dueAt` has passed. The behavior decision was made when
    // the message arrived, so it is not re-decided here and counters are not
    // applied twice. The reply still flows through `content.completed` →
    // `/messages/send` → `/turn/apply`.
    POST('/eve/v1/nest/turn', async (request, { from }) => {
      const body = recordOf(await request.json());
      const state = parseState(body);
      if (!state) {
        return Response.json(
          { ok: false, error: 'bad-address' },
          { status: 400 },
        );
      }
      // Only this route (and `/proactive`) opts into a dry run. Nest forwards
      // the flag frozen in the delayed row.
      state.dryRun = body.dryRun === true;
      const incoming = textOf(body.incoming).trim();
      if (!incoming) return Response.json({ ok: true, ignored: 'empty' });

      const behavior = recordOf(body.behavior);
      const hint = textOf(body.hint);
      const prefix = turnPrefix(behavior, hint);
      const queuedHints = Array.isArray(body.hints)
        ? body.hints.map((value) => textOf(value)).filter(Boolean)
        : [];
      const key = textOf(body.idempotencyKey);
      const rawMessageId = Number(body.messageId);
      const messageId =
        Number.isSafeInteger(rawMessageId) && rawMessageId > 0
          ? rawMessageId
          : undefined;
      // The unanswered series captured when the message arrived. Nest may also
      // have merged the texts of the superseded deferred turns; both shapes are
      // accepted. Without a burst this is exactly the old single message.
      const burst = burstOfBody(body);
      const seriesRaw = burst.length > 0
        ? burst
        : messageId !== undefined
          ? [{ id: messageId, text: incoming }]
          : [];
      // Nest reads `EveSessionState.lastHisMessageId` right before dispatching a
      // deferred turn. A message can have been answered (or deliberately
      // ignored) while this turn was waiting: answering it again would reply to
      // something she already replied to. Every id at or below the applied one
      // is dropped from the series; when the whole series is stale, no turn
      // runs at all.
      const appliedUpTo = Number(body.lastHisMessageId);
      const lastApplied =
        Number.isSafeInteger(appliedUpTo) && appliedUpTo > 0
          ? Math.trunc(appliedUpTo)
          : 0;
      const series =
        lastApplied > 0
          ? seriesRaw.filter((entry) => entry.id > lastApplied)
          : seriesRaw;
      if (lastApplied > 0 && series.length === 0) {
        return Response.json({ ok: true, ignored: 'turn:already-applied' });
      }
      const seriesText =
        series.length > 1
          ? burstTextOf(series)
          : (series[0]?.text ?? incoming);
      const outgoing = seriesText;
      const internalFrame = [prefix, ...queuedHints]
        .filter(Boolean)
        .join('\n');
      const mediaRef = mediaRefOf(body.media, Number(recordOf(body.media).messageId ?? 0) || 0);

      const content = await turnContent(state, outgoing, mediaRef);
      await from(`${state.personaId}:${state.accountId}:${state.chatId}`).send(
        content,
        {
          auth: authFor(state, 'deferred'),
          state: {
            ...state,
            incoming,
            messageId,
            messageIds:
              series.length > 0 ? series.map((entry) => entry.id) : undefined,
            // Always carry the series (even of one) so `turn/apply` logs the
            // ids that actually remain after the applied-id filter, not a
            // stale `messageId` that was already answered.
            burst: series.length > 0 ? series : undefined,
            behavior: behavior as unknown as BehaviorDecision,
            internal: internalFrame || undefined,
            origin: 'deferred',
            lastInboundAt: Date.now(),
            // A deferred dispatch is its own turn: the stable row id (or the
            // original event key) keeps a retried dispatch a replay, without
            // colliding with the ignore that may have consumed the series.
            turnKey: turnKeyOf(
              'deferred',
              textOf(body.actionId) || key || String(messageId ?? ''),
            ),
            dryRun: state.dryRun === true,
            applied: false,
          },
          ...(key ? { idempotencyKey: key } : {}),
        },
      );
      return Response.json({ ok: true }, { status: 202 });
    }),

    // Proactive turn started by Nest's agenda tick. The model writes the first
    // message; `content.completed` sends it back through the same path.
    POST('/eve/v1/nest/proactive', async (request, { from }) => {
      const body = recordOf(await request.json());
      const state = parseState(body);
      if (!state) {
        return Response.json({ ok: false, error: 'bad-address' }, { status: 400 });
      }
      // Real agenda ticks are live; a test may drive a dry proactive turn.
      state.dryRun = body.dryRun === true;
      const item = recordOf(body.item);
      const about =
        textOf(item.about).trim() ||
        textOf(body.about).trim() ||
        'написать первой';
      const reason = textOf(item.reason).trim() || textOf(body.reason).trim();
      const itemId = textOf(item.id) || textOf(body.id);
      const prompt = [
        '[internal: proactive]',
        `Повод: ${about}.`,
        reason ? `Почему сейчас: ${reason}.` : '',
        'Напиши первое сообщение сама, без обращения к предыдущему вопросу.',
      ]
        .filter(Boolean)
        .join('\n');
      await from(`${state.personaId}:${state.accountId}:${state.chatId}`).send(
        // An event, not a sentence from him: the event text lives in the
        // dynamic system frame and the user turn stays neutral.
        '…',
        {
          auth: authFor(state, 'proactive'),
          // `queue`: writing first must never steer into his answer that is
          // still being generated. A queued delivery starts its own turn.
          turnPolicy: 'queue',
          // A proactive turn is not an inbound: no message of his to apply, no
          // agenda extraction. Per-turn fields are cleared explicitly so a
          // stale `incoming`/`messageId`/`behavior` from the previous inbound
          // can never reach `turn/apply`.
          state: {
            ...state,
            incoming: '',
            messageId: undefined,
            messageIds: undefined,
            burst: undefined,
            behavior: undefined,
            internal: prompt,
            origin: 'proactive',
            dryRun: state.dryRun === true,
            applied: true,
          },
          ...(itemId ? { idempotencyKey: itemId } : {}),
        },
      );
      return Response.json({ ok: true }, { status: 202 });
    }),

    // Diagnostics for the dashboard/agents: why the last incoming message was
    // ignored or delayed, without replaying the model.
    GET('/eve/v1/nest/why', async (request) => {
      const url = new URL(request.url);
      const personaId = url.searchParams.get('personaId') ?? '';
      const accountId = url.searchParams.get('accountId') ?? '';
      const chatId = url.searchParams.get('chatId') ?? '';
      if (!personaId || !accountId || !chatId) {
        return Response.json(
          { ok: false, error: 'bad-address' },
          { status: 400 },
        );
      }
      const key = `${personaId}:${accountId}:${chatId}`;
      return Response.json({
        ok: true,
        decision: lastDecisionByChat.get(key) ?? null,
      });
    }),
  ],

  events: {
    'content.completed'(event, ctx) {
      return deliverCompletedReply(
        event.data,
        ctx.channel.state,
        ctx.waitUntil,
        deletionTurns.get(event.scope?.turnId ?? ''),
      );
    },

    async 'turn.started'(event, ctx) {
      const cause = event.data.cause;
      const deliveryId =
        cause && 'deliveryId' in cause ? cause.deliveryId : undefined;
      if (deliveryId) {
        const deletionAt = deletionDeliveries.get(deliveryId);
        if (deletionAt !== undefined) {
          deletionTurns.set(event.data.turnId, deletionAt);
          deletionDeliveries.delete(deliveryId);
        }
      }
      const state = ctx.channel.state;
      if (!hasAddress(state)) return;
      ctx.waitUntil(
        bestEffort(
          nest('/read', {
            personaId: state.personaId,
            accountId: state.accountId,
            chatId: state.chatId,
            threadId: state.threadId,
            dryRun: state.dryRun === true,
          }),
        ),
      );
      ctx.waitUntil(
        bestEffort(
          nest('/typing', {
            personaId: state.personaId,
            accountId: state.accountId,
            chatId: state.chatId,
            threadId: state.threadId,
            status: 'typing',
            dryRun: state.dryRun === true,
          }),
        ),
      );
    },

    'turn.settled'(event) {
      deletionTurns.delete(event.data.turnId);
    },
  },
});

/**
 * A deletion turn that was overtaken by a newer inbound. Proactive, reaction
 * and inbound turns never have `origin === 'deletion'`, so they are unaffected.
 */
export function isStaleDeletionReply(
  state: NestState,
  turnDeletionAt?: number,
): boolean {
  // `turnDeletionAt` comes from the turn id mapped at `turn.started` and is
  // authoritative: by `content.completed` the shared channel state may already
  // describe a newer inbound that steered into this turn.
  const deletionAt = turnDeletionAt ?? state.deletionAt;
  if (typeof deletionAt !== 'number') return false;
  if (turnDeletionAt === undefined && state.origin !== 'deletion') return false;
  if (turnDeletionAt === undefined && state.applied !== true) return false;
  return (
    typeof state.lastInboundAt === 'number' &&
    state.lastInboundAt > deletionAt
  );
}

/**
 * The live `content.completed` path, exported so an integration test can
 * drive the real channel without booting an Eve session.
 */
export async function deliverCompletedReply(
  data: { phase?: unknown; value?: unknown },
  state: NestState,
  waitUntil: (task: Promise<unknown>) => void,
  turnDeletionAt?: number,
): Promise<void> {
  if (data.phase !== 'reply') return;
      if (!hasAddress(state)) return;
      // A deletion turn generated before a newer inbound must not land after
      // it: the user already moved on, and the old quote reads as a glitch.
      if (isStaleDeletionReply(state, turnDeletionAt)) return;
      const raw = textOf(data.value).trim();
      // An empty model reply is not "silence by choice": send a neutral filler
      // instead of nothing, so the turn always has an answer (reference does a
      // retry and then falls back to a filler).
      const text =
        raw || (state.behavior?.shouldReply === false ? '' : pickFiller());
      if (!text) return;
      const appliedBefore = state.applied === true;
      const { clean, actions } = extractToolMarkers(sanitizeReply(text));

      // A repeated bubble is worse than a boring one: compare with her last
      // messages, and if everything was a repeat fall back to a neutral filler
      // instead of silence.
      const rawParts = splitReplyParts(clean);
      let parts = rawParts.length > 0 ? dropRepeatedParts(rawParts, recentReplies(state)) : [];
      if (parts.length === 0) parts = [pickFiller()];

      // The decision already chose how many bubbles fit this moment; the model
      // may still send more `---` blocks than that. Never send 5 bubbles after
      // deciding on 1 (minimum one, hard cap six).
      const decidedBubbles = Number(state.behavior?.bubbles);
      if (Number.isFinite(decidedBubbles) && decidedBubbles >= 1) {
        parts = parts.slice(
          0,
          Math.min(6, Math.max(1, Math.round(decidedBubbles))),
        );
      }

      // The model writes clean text; people do not. One optional typo per
      // bubble, decided here so the session log and memory stay exact.
      const intensity = pickTypoIntensity({ bubbles: state.behavior?.bubbles });
      const styled = parts.map((part) =>
        injectTypos(part, { intensity }),
      );
      const corrections: Array<{ index: number; text: string }> = [];
      styled.forEach((value, index) => {
        if (value !== parts[index]) {
          corrections.push({ index, text: parts[index]! });
        }
      });

      let messageIds: number[] = [];
      const sent = recordOf(
        await nest('/messages/send', {
          personaId: state.personaId,
          accountId: state.accountId,
          chatId: state.chatId,
          threadId: state.threadId,
          text: styled.join('\n'),
          parts: styled,
          bubbles: state.behavior?.bubbles ?? 0,
          typing: 'auto',
          dryRun: state.dryRun === true,
        }),
      );
      messageIds = Array.isArray(sent.messageIds)
        ? sent.messageIds
            .map((id) => Number(id))
            .filter((id) => Number.isSafeInteger(id) && id > 0)
        : [];
      rememberReplies(state, styled);

      // Self-correction: occasionally notices a typo and edits it 2–8 seconds
      // later through the durable queue, so an Eve restart cannot lose the edit.
      const correction = corrections[0];
      const targetId = correction ? messageIds[correction.index] : undefined;
      if (
        correction &&
        targetId !== undefined &&
        Math.random() < 0.25
      ) {
        await bestEffort(
          nest('/actions', {
            kind: 'edit',
            personaId: state.personaId,
            accountId: state.accountId,
            chatId: state.chatId,
            threadId: state.threadId,
            delaySec: 2 + Math.floor(Math.random() * 7),
            reason: 'self-edit',
            key: `edit:${state.personaId}:${state.accountId}:${state.chatId}:${targetId}`,
            dryRun: state.dryRun === true,
            payload: {
              messageId: targetId,
              text: correction.text,
              dryRun: state.dryRun === true,
            },
          }),
        );
      }

      await bestEffort(runToolActions(state, actions));
      if (
        clean &&
        !actions.includes('STICKER') &&
        Math.random() < 0.08
      ) {
        await bestEffort(sendRandomSticker(state));
      }
      if (!appliedBefore) {
        // Mark the turn before the requests: a repeated `content.completed`
        // for the same inbound must not apply the counters twice.
        state.applied = true;
        await bestEffort(
          applyTurn(state, state.behavior, clean || styled.join('\n') || null),
        );
        // Both writebacks are side channels after the answer is already sent:
        // they must not hold the turn (and the next inbound) hostage.
        waitUntil(
          bestEffort(
            nest('/memory/reflect', {
              personaId: state.personaId,
              accountId: state.accountId,
              chatId: state.chatId,
              threadId: state.threadId,
            }),
          ),
        );
        // One extraction for the whole answered series: the events he mentioned
        // may live in any of the burst messages, not only in the last one.
        const agendaText =
          Array.isArray(state.burst) && state.burst.length > 1
            ? burstTextOf(state.burst)
            : Array.isArray(state.burst) && state.burst.length === 1
              ? state.burst[0]!.text
              : state.incoming;
        if (agendaText && agendaAllowed(state)) {
          // Events he mentioned ("у меня завтра соревнования") and his answer
          // to a recent ping are extracted by Nest's LLM, best effort. This is
          // the expensive one, so it is throttled per chat.
          waitUntil(
            bestEffort(
              nest('/agenda/extract', {
                personaId: state.personaId,
                accountId: state.accountId,
                chatId: state.chatId,
                threadId: state.threadId,
                incoming: agendaText,
              }),
            ),
          );
        }
        // `applied` stays true for the rest of this turn: a second
        // `content.completed` in the same turn (text → tool → final text) must
        // not apply the counters again. The next inbound resets it in
        // `deliver`.
      }
}
