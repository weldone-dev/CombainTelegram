/**
 * Shared contracts for the deterministic persona engine.
 *
 * Everything here is plain data: no classes, no framework types, no I/O.
 * The Eve channel converts NestJS rows (ISO dates, int scores) into these
 * shapes and converts decisions back into Nest actions.
 */

export type Stage =
  | 'met-irl-got-tg'
  | 'tg-given-cold'
  | 'tg-given-warming'
  | 'convinced'
  | 'first-date-done'
  | 'dating-early'
  | 'dating-stable'
  | 'long-term'
  | 'dumped';

export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type NotificationMode = 'muted' | 'normal' | 'priority';
export type MessageStyle = 'one-liners' | 'balanced' | 'bursty' | 'longform';
export type InitiativeLevel = 'low' | 'medium' | 'high';
export type LifeSharingLevel = 'low' | 'medium' | 'high';

export interface CommunicationProfile {
  notifications: NotificationMode;
  messageStyle: MessageStyle;
  initiative: InitiativeLevel;
  lifeSharing: LifeSharingLevel;
}

export interface BusySlot {
  label: string;
  /** Empty/undefined means every day. */
  days?: Weekday[];
  /** Local time, "HH:MM". `from === to` is invalid and ignored. */
  from: string;
  /** Local time, "HH:MM"; may be earlier than `from` to cross midnight. */
  to: string;
  /** Window in which she may glance at the phone, default [5, 15]. */
  checkAfterMin?: [number, number];
}

/**
 * Persona configuration. Mirrors `EvePersona` + optional `busySchedule`
 * (the Nest row stores communication as JSON and has no busy schedule yet).
 */
export interface PersonaConfig {
  /** Stable database id; used only for diagnostics. */
  id?: string;
  name: string;
  age: number;
  nationality?: string;
  /** IANA timezone, e.g. "Europe/Moscow". */
  timezone: string;
  stage: Stage;
  /** Local hour 0..23. Default 23. */
  sleepFrom?: number;
  /** Local hour 0..23. Default 8. `from === to` means "never sleeps". */
  sleepTo?: number;
  /** Base chance to wake up at night, default 0.05. */
  nightWakeChance?: number;
  /** 0..100, default 35. */
  ignoreTendency?: number;
  communication?: Partial<CommunicationProfile>;
  vibe?: string;
  busySchedule?: BusySlot[];
}

/** Alias kept for call sites that talk about "the profile". */
export type Profile = PersonaConfig;

export type PresencePattern =
  | 'phone-attached'
  | 'burst-checker'
  | 'rare-checker'
  | 'evening-only'
  | 'phone-attached-night';

export interface PresenceProfile {
  pattern: PresencePattern;
  sleepFrom: number;
  sleepTo: number;
  /** Average minutes between Telegram checks while awake. */
  checkEveryMin: number;
  /** How long one check lasts, in minutes. */
  onlineWindowMin: number;
  /** Chance that an offline notification is noticed immediately. */
  offlineReplyChance: number;
  /** Chance to wake up during sleep hours. */
  nightWakeChance: number;
}

export interface BusyState {
  label: string;
  /** Local "HH:MM" when the slot ends. */
  until: string;
  /** Minutes until the next phone check. */
  checkAfterMin: number;
}

export interface PresenceState {
  online: boolean;
  asleep: boolean;
  nightAwake: boolean;
  /** Seconds until the next possible check when offline. 0 online. */
  nextCheckSec: number;
  /** Local hour 0..23. */
  localHour: number;
  /** Ready-to-use Russian hint for the generation prompt. */
  hint: string;
  busy?: BusyState;
  /** Notification was noticed while offline. */
  notificationSeen?: boolean;
  /** Pattern copied from the profile for diagnostics. */
  pattern: PresencePattern;
  coldActive: boolean;
  forcedWake: boolean;
}

/** Five coarse phases of the simulated 26..32-day cycle. */
export type CyclePhase = 'menstrual' | 'follicular' | 'ovulation' | 'luteal' | 'pms';

/**
 * Deterministic hormone/cycle snapshot, see `hormones.ts`.
 *
 * The numeric fields are effect multipliers consumed by `behavior.ts` and
 * `presence.ts`; they are not plasma levels.
 */
export interface HormoneState {
  /** 1..cycleLength. */
  cycleDay: number;
  /** Personal cycle length, 26..32. */
  cycleLength: number;
  phase: CyclePhase;
  /** Normalized 0..1 input (relationship annoyance/cringe/conflict). */
  stressLoad: number;
  /** Whole days the cycle was delayed by stress, 0..3. */
  stressDelayDays: number;
  /** 0..1, how warm and affectionate she feels. */
  affection: number;
  /** 0..1. */
  irritability: number;
  /** 0..1. */
  libido: number;
  /** -1..1, daily energy bias. */
  energy: number;
  /** Multiplier for the chance to reply / recover a silent decision. */
  replyChanceMultiplier: number;
  /** Multiplier for the chance to ignore or leave on read. */
  ignoreChanceMultiplier: number;
  /** Multiplier for the reply delay in seconds. */
  delayMultiplier: number;
  /** Multiplier for the number of bubbles in a reply. */
  bubbleMultiplier: number;
  /** Warmer phases make flirting natural. */
  flirt: boolean;
  /** Period/PMS: short, dry answers are in character. */
  shortReplies: boolean;
}

export interface RelationshipScore {
  interest: number;
  trust: number;
  attraction: number;
  annoyance: number;
  cringe: number;
}

export type MoodDelta = Partial<RelationshipScore>;

export interface StageDefaults {
  interest: number;
  trust: number;
  attraction: number;
  annoyance: number;
  cringeTolerance: number;
  /** 0..1 fallback ignore probability. */
  ignoreChance: number;
  /** Fallback delay range in seconds. */
  replyDelaySec: [number, number];
}

export interface StagePreset {
  id: Stage;
  num: number;
  label: string;
  description: string;
  defaults: StageDefaults;
}

export interface ConflictHistoryEntry {
  /** ISO timestamp. */
  ts: string;
  note: string;
  deltaLevel: number;
}

export interface ConflictState {
  level: 0 | 1 | 2 | 3 | 4;
  /** ISO timestamp; absent when there is no active cold period. */
  coldUntil?: string;
  reason?: string;
  since?: string;
  history: ConflictHistoryEntry[];
}

export type AgendaKind = 'user-event' | 'user-event-followup' | 'proactive-life';
export type AgendaState = 'pending' | 'fired' | 'cancelled' | 'rescheduled';
export type AgendaImportance = 1 | 2 | 3;

export interface AgendaItem {
  id: string;
  about: string;
  reason: string;
  /** Epoch ms of the user's event, if he named one. */
  userEventTime?: number;
  /** Epoch ms. The engine works in ms; the channel maps ISO to/from Nest. */
  pingAt: number;
  kind: AgendaKind;
  state: AgendaState;
  attempts: number;
  history: string[];
  importance: AgendaImportance;
  /** Epoch ms. */
  createdAt: number;
  chatId?: string;
}

export type BehaviorIntent =
  | 'reply'
  | 'ignore'
  | 'short'
  | 'left-on-read'
  | 'leave-chat'
  | 'reaction-only';

export type BehaviorSource =
  | 'active-dialog'
  | 'conflict-cold'
  | 'asleep'
  | 'night-wake'
  | 'dumped'
  | 'llm'
  | 'fallback';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
  /** Epoch ms. */
  ts?: number;
}

export interface IncomingRef {
  messageId: number;
  text: string;
}

export interface BehaviorDecision {
  intent: BehaviorIntent;
  shouldReply: boolean;
  shouldRead: boolean;
  /** Seconds, 0..3600 after post-processing. */
  delaySec: number;
  bubbles: number;
  typing: boolean;
  ignoreReason?: string;
  moodDelta: MoodDelta;
  reaction?: string;
  reactionTargetMessageId?: number;
  source: BehaviorSource;
}

export interface MemoryContext {
  /** Stable facts about him. */
  facts?: string;
  /** Episodes of the current/previous days. */
  episodes?: string;
  /** Relationship timeline. */
  timeline?: string;
  attachment?: string;
  openLoops?: string;
  promises?: string;
  /** Rendered memory-palace recall. */
  palace?: string;
  /** Relevant daily summaries. */
  dailySummaries?: string;
  /** Cross-chat memory for non-primary peers. */
  crossChat?: string;
}

/** Daily-life block, see `daily-life.ts`. */
export interface DailyLifeBlock {
  /** Local hour 0..23, inclusive. */
  fromHour: number;
  /** Local hour 0..23, exclusive; earlier than `fromHour` crosses midnight. */
  toHour: number;
  activity: string;
  mood?: string;
  social: 'alone' | 'with-friends' | 'with-family' | 'with-coworkers' | 'in-transit';
  phoneAvailable: boolean;
}

export interface DailyLife {
  /** YYYY-MM-DD in the persona timezone. */
  dateLocal: string;
  weather?: string;
  vibe: string;
  /** Normally 6..9 blocks covering waking hours. */
  blocks: DailyLifeBlock[];
  events: string[];
  wants: string[];
}

export interface BehaviorContext {
  config: PersonaConfig;
  stage?: Stage;
  score: RelationshipScore;
  presence?: PresenceState;
  conflict?: ConflictState | null;
  /** Computed by the caller; defaults to `coldUntil > now`. */
  conflictColdActive?: boolean;
  /** E.g. "пара по матану [no-phone]" from daily-life. */
  blockHint?: string;
  /** Her last reply was < 5 minutes ago. */
  activeDialog?: boolean;
  recentIncomingIds?: IncomingRef[];
  history?: ConversationTurn[];
  incoming?: string;
  dailyLife?: DailyLife;
  memory?: MemoryContext;
  /** Cycle/hormone snapshot; absent keeps the pre-hormone behavior exactly. */
  hormones?: HormoneState;
  /** Epoch ms. Defaults to Date.now(). */
  now?: number;
  /** Injectable PRNG for tests. Defaults to Math.random. */
  rand?: () => number;
}
