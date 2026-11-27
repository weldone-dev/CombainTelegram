/**
 * Framework-agnostic persona engine tool configuration.
 *
 * Deliberately does not import `eve` or any Nest code: `agent/tools/
 * persona-tool.ts` attaches it once with `defineTool` from `eve/tools` (and
 * other runners can use the JSON Schema directly). All behaviour is pure and
 * local; the tool never performs network I/O.
 *
 * Lives under `agent/lib/` because every file in `agent/tools/` is discovered
 * as one Eve tool and must default-export a valid `defineTool` value.
 */

import {
  applyMoodDelta,
  buildSystemPrompt,
  clampScore,
  computePresenceProfile,
  computePresenceState,
  decideBehavior,
  decideStageTransition,
  emptyConflict,
  findStage,
  planAgendaTick,
  sanitizeAutonomousItems,
  toEpochMs,
  updateConflictFromMood,
  validateDailyLife,
  localDateKey,
} from './persona';
import type {
  AgendaItem,
  BehaviorContext,
  BehaviorDecision,
  BusySlot,
  ConflictState,
  ConversationTurn,
  DailyLife,
  MemoryContext,
  PersonaConfig,
  PresencePattern,
  PresenceState,
  PromptInput,
  RelationshipScore,
  Weekday,
} from './persona';

type JsonRecord = Record<string, unknown>;

export interface PersonaToolConfig {
  name: string;
  description: string;
  inputSchema: JsonRecord;
  execute: (input: unknown) => Promise<unknown>;
}

const ACTIONS = [
  'presence',
  'decide',
  'stage',
  'agenda',
  'autonomous',
  'prompt',
  'mood',
] as const;

type Action = (typeof ACTIONS)[number];

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function num(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function ms(value: unknown, fallback: number): number {
  return toEpochMs(value) ?? fallback;
}

/** Deterministic PRNG for tool calls: the same seed gives the same decision. */
export function seededRand(seed: number): () => number {
  let state = Math.trunc(seed) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseConfig(value: unknown): PersonaConfig {
  const raw = record(value);
  const stage = findStage(str(raw.stage, 'tg-given-warming')).id;
  const config: PersonaConfig = {
    name: str(raw.name, 'Аня'),
    age: num(raw.age, 22),
    timezone: str(raw.timezone, 'Europe/Moscow'),
    stage,
    sleepFrom: num(raw.sleepFrom, 23),
    sleepTo: num(raw.sleepTo, 8),
    nightWakeChance: num(raw.nightWakeChance, 0.05),
    ignoreTendency: num(raw.ignoreTendency, 35),
  };
  if (typeof raw.id === 'string') config.id = raw.id;
  if (typeof raw.nationality === 'string') config.nationality = raw.nationality;
  if (typeof raw.vibe === 'string') config.vibe = raw.vibe;
  const communication = record(raw.communication);
  if (Object.keys(communication).length > 0) {
    config.communication = {
      notifications: communication.notifications as
        | 'muted'
        | 'normal'
        | 'priority'
        | undefined,
      messageStyle: communication.messageStyle as
        | 'one-liners'
        | 'balanced'
        | 'bursty'
        | 'longform'
        | undefined,
      initiative: communication.initiative as
        | 'low'
        | 'medium'
        | 'high'
        | undefined,
      lifeSharing: communication.lifeSharing as
        | 'low'
        | 'medium'
        | 'high'
        | undefined,
    };
  }
  const busy = list(raw.busySchedule)
    .map((entry) => parseBusySlot(entry))
    .filter((slot): slot is BusySlot => slot !== null);
  if (busy.length > 0) config.busySchedule = busy;
  return config;
}

function parseBusySlot(value: unknown): BusySlot | null {
  const raw = record(value);
  const from = str(raw.from);
  const to = str(raw.to);
  if (!/^\d{1,2}:\d{2}$/.test(from) || !/^\d{1,2}:\d{2}$/.test(to)) return null;
  const days = list(raw.days).filter(
    (day): day is Weekday =>
      typeof day === 'string' && ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].includes(day),
  );
  const range = list(raw.checkAfterMin);
  const slot: BusySlot = {
    label: str(raw.label, 'занята'),
    from,
    to,
  };
  if (days.length > 0) slot.days = days;
  if (range.length === 2) {
    slot.checkAfterMin = [num(range[0], 5), num(range[1], 15)];
  }
  return slot;
}

function parseScore(value: unknown): RelationshipScore {
  return clampScore(record(value) as Partial<RelationshipScore>);
}

function parseConversation(value: unknown): ConversationTurn[] {
  return list(value)
    .map((entry) => {
      const raw = record(entry);
      const role = raw.role === 'assistant' ? 'assistant' : raw.role === 'user' ? 'user' : null;
      const content = str(raw.content);
      if (!role || !content) return null;
      const turn: ConversationTurn = { role, content };
      if (typeof raw.ts === 'number') turn.ts = raw.ts;
      return turn;
    })
    .filter((turn): turn is ConversationTurn => turn !== null);
}

function parseConflict(value: unknown): ConflictState | null {
  if (!value || typeof value !== 'object') return null;
  const raw = record(value);
  const level = Math.max(0, Math.min(4, Math.round(num(raw.level, 0))));
  const state: ConflictState = {
    level: level as ConflictState['level'],
    history: list(raw.history)
      .map((entry) => {
        const item = record(entry);
        return {
          ts: str(item.ts),
          note: str(item.note),
          deltaLevel: num(item.deltaLevel, 0),
        };
      })
      .filter((entry) => entry.ts || entry.note),
  };
  if (typeof raw.coldUntil === 'string') state.coldUntil = raw.coldUntil;
  if (typeof raw.reason === 'string') state.reason = raw.reason;
  if (typeof raw.since === 'string') state.since = raw.since;
  return state;
}

const PATTERNS: PresencePattern[] = [
  'phone-attached',
  'burst-checker',
  'rare-checker',
  'evening-only',
  'phone-attached-night',
];

function parsePresence(
  value: unknown,
  config: PersonaConfig,
  now: number,
): PresenceState {
  const profile = computePresenceProfile(config);
  const raw = value ? record(value) : null;
  if (!raw) {
    return computePresenceState(config, profile, { now });
  }
  const pattern = PATTERNS.includes(raw.pattern as PresencePattern)
    ? (raw.pattern as PresencePattern)
    : profile.pattern;
  return {
    online: bool(raw.online),
    asleep: bool(raw.asleep),
    nightAwake: bool(raw.nightAwake),
    nextCheckSec: num(raw.nextCheckSec, 0),
    localHour: num(raw.localHour, new Date(now).getUTCHours()),
    hint: str(raw.hint),
    pattern,
    coldActive: bool(raw.coldActive),
    forcedWake: bool(raw.forcedWake),
    ...(raw.notificationSeen !== undefined
      ? { notificationSeen: bool(raw.notificationSeen) }
      : {}),
    ...(raw.busy && typeof raw.busy === 'object'
      ? {
          busy: {
            label: str(record(raw.busy).label, 'занята'),
            until: str(record(raw.busy).until, ''),
            checkAfterMin: num(record(raw.busy).checkAfterMin, 5),
          },
        }
      : {}),
  };
}

function parseAgendaItem(value: unknown, index: number): AgendaItem | null {
  const raw = record(value);
  const about = str(raw.about).trim();
  const pingAt = toEpochMs(raw.pingAt);
  if (!about || pingAt === null) return null;
  const state =
    raw.state === 'fired' || raw.state === 'cancelled' || raw.state === 'rescheduled'
      ? raw.state
      : 'pending';
  const kind =
    raw.kind === 'user-event' || raw.kind === 'user-event-followup'
      ? raw.kind
      : 'proactive-life';
  const importance = Math.max(1, Math.min(3, Math.round(num(raw.importance, 1))));
  return {
    id: str(raw.id, `item_${index}`),
    about: about.slice(0, 120),
    reason: str(raw.reason).slice(0, 160),
    pingAt,
    kind,
    state,
    attempts: Math.max(0, Math.round(num(raw.attempts, 0))),
    history: list(raw.history)
      .filter((line): line is string => typeof line === 'string')
      .slice(-30),
    importance: importance as AgendaItem['importance'],
    createdAt: ms(raw.createdAt, pingAt),
    ...(toEpochMs(raw.userEventTime) !== null
      ? { userEventTime: toEpochMs(raw.userEventTime)! }
      : {}),
    ...(typeof raw.chatId === 'string' || typeof raw.chatId === 'number'
      ? { chatId: String(raw.chatId) }
      : {}),
  };
}

function parseDailyLife(
  value: unknown,
  config: PersonaConfig,
  now: number,
): DailyLife | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = record(value);
  return validateDailyLife(raw, {
    dateLocal: str(raw.dateLocal, localDateKey(now, config.timezone)),
  }).value;
}

function parsePromptInput(raw: JsonRecord): PromptInput {
  const config = parseConfig(raw.config);
  const stage = raw.stage === undefined ? config.stage : findStage(str(raw.stage)).id;
  const input: PromptInput = {
    config,
    score: parseScore(raw.score),
    stage,
    now: num(raw.now, Date.now()),
  };
  if (typeof raw.notes === 'string') input.notes = raw.notes;
  if (typeof raw.incoming === 'string') input.incoming = raw.incoming;
  if (typeof raw.mediaNote === 'string') input.mediaNote = raw.mediaNote;
  if (typeof raw.acquaintance === 'boolean') input.acquaintance = raw.acquaintance;
  if (typeof raw.committedPrimary === 'boolean') {
    input.committedPrimary = raw.committedPrimary;
  }
  if (typeof raw.romanticApproach === 'boolean') {
    input.romanticApproach = raw.romanticApproach;
  }
  if (raw.presence) input.presence = parsePresence(raw.presence, config, input.now!);
  if (raw.conflict) input.conflict = parseConflict(raw.conflict);
  if (raw.dailyLife) input.dailyLife = parseDailyLife(raw.dailyLife, config, input.now!);
  if (raw.documents) input.documents = record(raw.documents) as PromptInput['documents'];
  if (raw.memory) input.memory = record(raw.memory) as MemoryContext;
  if (raw.history) input.history = parseConversation(raw.history);
  return input;
}

function parseContext(raw: JsonRecord, config: PersonaConfig, now: number): BehaviorContext {
  const presence = raw.presence
    ? parsePresence(raw.presence, config, now)
    : undefined;
  const ctx: BehaviorContext = {
    config,
    stage: raw.stage === undefined ? config.stage : findStage(str(raw.stage)).id,
    score: parseScore(raw.score),
    now,
  };
  if (presence) ctx.presence = presence;
  if (raw.conflict) ctx.conflict = parseConflict(raw.conflict);
  if (typeof raw.conflictColdActive === 'boolean') {
    ctx.conflictColdActive = raw.conflictColdActive;
  }
  if (typeof raw.activeDialog === 'boolean') ctx.activeDialog = raw.activeDialog;
  if (typeof raw.blockHint === 'string') ctx.blockHint = raw.blockHint;
  if (typeof raw.incoming === 'string') ctx.incoming = raw.incoming;
  if (raw.history) ctx.history = parseConversation(raw.history);
  if (raw.dailyLife) ctx.dailyLife = parseDailyLife(raw.dailyLife, config, now);
  if (raw.memory) ctx.memory = record(raw.memory) as MemoryContext;
  if (raw.recentIncomingIds) {
    ctx.recentIncomingIds = list(raw.recentIncomingIds)
      .map((entry) => record(entry))
      .filter((entry) => Number.isFinite(Number(entry.messageId)))
      .map((entry) => ({ messageId: Number(entry.messageId), text: str(entry.text) }));
  }
  if (typeof raw.seed === 'number') ctx.rand = seededRand(raw.seed);
  return ctx;
}

function countRejected(
  result: ReturnType<typeof sanitizeAutonomousItems>,
): Array<{ about: string; reason: string }> {
  return result.rejected;
}

export const personaTool: PersonaToolConfig = {
  name: 'persona',
  description:
    'Deterministic girl-agent behaviour engine. Actions: presence (profile + snapshot), decide (reply/ignore/delay/bubbles), stage (relationship transition), agenda (proactive tick), autonomous (sanitize own pings), prompt (system prompt), mood (apply score delta + conflict).',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['action'],
    properties: {
      action: { type: 'string', enum: [...ACTIONS] },
      seed: {
        type: 'number',
        description: 'Optional deterministic PRNG seed for decide/presence.',
      },
      now: { type: 'number', description: 'Epoch ms; defaults to current time.' },
      config: {
        type: 'object',
        description: 'PersonaConfig: name, age, timezone, stage, sleep, communication...',
      },
      score: { type: 'object' },
      stage: { type: 'string' },
      presence: { type: 'object' },
      conflict: { type: 'object' },
      dailyLife: { type: 'object' },
      history: { type: 'array' },
      incoming: { type: 'string' },
      activeDialog: { type: 'boolean' },
      blockHint: { type: 'string' },
      conflictColdActive: { type: 'boolean' },
      recentIncomingIds: { type: 'array' },
      lastUserMsgTs: { type: 'number' },
      lastHerReplyTs: { type: 'number' },
      recentExchangeCount: { type: 'number' },
      forcedWake: { type: 'boolean' },
      herMessagesInStage: { type: 'number' },
      hisMessagesInStage: { type: 'number' },
      ignoresInStage: { type: 'number' },
      hasActiveConflict: { type: 'boolean' },
      items: { type: 'array' },
      lastMessageAt: { type: 'number' },
      limit: { type: 'number' },
      existing: { type: 'array' },
      delta: { type: 'object' },
      documents: { type: 'object' },
      memory: { type: 'object' },
      notes: { type: 'string' },
      mediaNote: { type: 'string' },
      acquaintance: { type: 'boolean' },
      committedPrimary: { type: 'boolean' },
      romanticApproach: { type: 'boolean' },
    },
  },

  async execute(input: unknown): Promise<unknown> {
    const raw = record(input);
    const action = str(raw.action) as Action;
    if (!ACTIONS.includes(action)) {
      throw new Error(`unknown persona action: ${action}`);
    }
    const now = num(raw.now, Date.now());
    const config = parseConfig(raw.config);

    switch (action) {
      case 'presence': {
        const profile = computePresenceProfile(config);
        const state = computePresenceState(config, profile, {
          now,
          lastUserMsgTs: num(raw.lastUserMsgTs, 0),
          lastHerReplyTs: num(raw.lastHerReplyTs, 0),
          recentExchangeCount: num(raw.recentExchangeCount, 0),
          forcedWake: bool(raw.forcedWake),
          conflict: parseConflict(raw.conflict),
          rand: typeof raw.seed === 'number' ? seededRand(raw.seed) : undefined,
        });
        return { profile, state };
      }

      case 'decide': {
        const ctx = parseContext(raw, config, now);
        const decision = await decideBehavior(ctx);
        return decision;
      }

      case 'stage':
        return decideStageTransition({
          currentStage: findStage(str(raw.stage, config.stage)).id,
          score: parseScore(raw.score),
          herMessagesInStage: num(raw.herMessagesInStage, 0),
          hisMessagesInStage: num(raw.hisMessagesInStage, 0),
          ignoresInStage: num(raw.ignoresInStage, 0),
          hasActiveConflict: bool(raw.hasActiveConflict),
        });

      case 'agenda': {
        const presence = parsePresence(raw.presence, config, now);
        const items = list(raw.items)
          .map((item, index) => parseAgendaItem(item, index))
          .filter((item): item is AgendaItem => item !== null);
        return planAgendaTick(items, {
          now,
          config,
          stage: findStage(str(raw.stage, config.stage)).id,
          presence,
          conflict: parseConflict(raw.conflict),
          dailyLife: parseDailyLife(raw.dailyLife, config, now),
          lastMessageAt: num(raw.lastMessageAt, 0),
        });
      }

      case 'autonomous': {
        const existing = list(raw.existing)
          .map((item, index) => parseAgendaItem(item, index))
          .filter((item): item is AgendaItem => item !== null);
        const result = sanitizeAutonomousItems(raw.items, {
          now,
          config,
          dailyLife: parseDailyLife(raw.dailyLife, config, now),
          existing,
          limit: num(raw.limit, 0),
        });
        return { items: result.items, rejected: countRejected(result) };
      }

      case 'prompt':
        return { system: buildSystemPrompt(parsePromptInput(raw)) };

      case 'mood': {
        const score = applyMoodDelta(parseScore(raw.score), record(raw.delta));
        const input = parseConflict(raw.conflict) ?? emptyConflict();
        const conflict = updateConflictFromMood(
          input,
          record(raw.delta),
          score,
          str(raw.incoming),
          { now },
        );
        return { score, conflict, dumped: score.annoyance > 80 && score.interest < -30 };
      }
    }
  },
};

/** Authored Eve tool shape: no `name`, because the file stem names the tool. */
export interface EveToolConfig {
  description: string;
  inputSchema: never;
  execute: (input: unknown) => Promise<unknown>;
}

/**
 * Attach the config to a framework `defineTool`. The Eve app calls this with
 * `defineTool` from `eve/tools`; tests can pass a recording stub.
 *
 * `name` is stripped: Eve derives the tool name from the file path and rejects
 * authored tools that carry one.
 */
export function bindPersonaTool<T>(define: (config: EveToolConfig) => T): T {
  return define({
    description: personaTool.description,
    inputSchema: personaTool.inputSchema as never,
    execute: (input) => personaTool.execute(input),
  });
}

export default personaTool;

export type { BehaviorDecision };
