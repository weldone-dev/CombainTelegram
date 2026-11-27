/**
 * Public surface of the deterministic girl-agent persona engine.
 *
 * The Eve channel imports only this file: everything below is pure TypeScript
 * with no `eve`, Nest, database or network dependency. The single optional I/O
 * hook is the `decideWithLlm` callback accepted by `decideBehavior`.
 */

export * from './types';

export {
  clamp,
  clampInt,
  finiteNumber,
  formatLocalTime,
  formatMinutes,
  isHourInRange,
  isMinuteInRange,
  isWeekday,
  localDateKey,
  localParts,
  minutesUntil,
  mod,
  parseTime,
  previousWeekday,
  toEpochMs,
} from './time';

export {
  DEFAULT_COMMUNICATION,
  communicationPromptFragment,
  ignoreTendencyPrompt,
  normalizeCommunicationProfile,
  normalizeIgnoreTendency,
} from './communication';

export {
  normalizeBusySlot,
  parseBusySchedule,
  parseJsonColumn,
  personaConfigFromRow,
  recordOf,
  textOf,
} from './config';

export {
  DELETION_MISSED_AFTER_MS,
  classifyDeletion,
  deletionPromptFragment,
} from './deletion';
export type { DeletionAwareness, DeletionInput } from './deletion';

export {
  PATTERN_DEFAULTS,
  PRESENCE_PATTERNS,
  activeBusySlot,
  busyTransitionHint,
  computePresenceProfile,
  computePresenceState,
  describePresencePattern,
  isAsleep,
  isEvening,
  isNightWindow,
  nightWakeRoll,
  onlineProbability,
  presenceSeed,
  prng,
} from './presence';
export type { BusyMatch, PresenceInput } from './presence';

export {
  CYCLE_BASELINE_LENGTH,
  CYCLE_MAX_LENGTH,
  CYCLE_MIN_LENGTH,
  MAX_STRESS_DELAY_DAYS,
  computeHormones,
  cycleLengthFor,
  hormonesPromptFragment,
  normalizeStressLoad,
  phaseForCycleDay,
  stressDelayDaysFor,
  stressLoadOf,
} from './hormones';

export {
  BEHAVIOR_SYSTEM_PROMPT,
  COLD_IGNORE_CHANCE,
  NIGHT_ANNOYANCE,
  NIGHT_FELL_ASLEEP_CHANCE,
  SLEEP_IGNORE_BASE,
  activeDialogDelay,
  adjustDelay,
  applyDecisionMood,
  applyHormoneBubbles,
  behaviorDecisionPrompt,
  behaviorHint,
  busyDelaySec,
  canRecoverReply,
  countsAsIgnore,
  decideBehavior,
  fallbackDecision,
  hormoneMultiplier,
  ignoreMultiplier,
  normalizeBubbles,
  parseDecisionPayload,
  pickReactionOnly,
  postProcessDecision,
  quietBlockDecision,
  reactionOnlyChance,
  reactionPalette,
  recoverDelay,
  recoverReplyChance,
  sampleBubbles,
  sanitizeReaction,
  sleepIgnoreChance,
  sleepIgnoreMultiplier,
} from './behavior';
export type {
  BehaviorLlmDecider,
  BehaviorLlmRequest,
  ReactionOnlyPlan,
  ReactionPalette,
} from './behavior';

export {
  CONFLICT_COLD_MIN_MS,
  DUMPED_PRESET,
  RELATIONSHIP_LIMITS,
  STAGE_AFTER_RESET,
  STAGE_ORDER,
  STAGE_PRESETS,
  activeConflict,
  applyMoodDelta,
  autoDumped,
  clampScore,
  clampScoreValue,
  coldHoursLeft,
  coldRemainingMs,
  decideStageTransition,
  emptyConflict,
  escalateFromMood,
  findStage,
  isCommittedStage,
  isWarmStage,
  shouldRunStageTransitionCheck,
  softenFromMood,
  stageDefaults,
  stageIndex,
  updateConflictFromMood,
} from './relationship';
export type {
  ConflictClock,
  StageTransitionContext,
  StageTransitionResult,
} from './relationship';

export {
  AGENDA_ABOUT_MAX_LENGTH,
  AGENDA_ABOUT_MIN_LENGTH,
  AGENDA_LIMITS,
  AGENDA_REASON_MAX_LENGTH,
  AGENDA_TICK_MS,
  AUTONOMOUS_HORIZON_MS,
  AUTONOMOUS_MIN_GAP_MS,
  AUTONOMOUS_MIN_LEAD_MS,
  DIALOG_COOLDOWN_MS,
  PROACTIVE_RESPONSE_WINDOW_MS,
  applyProactiveResponse,
  canGenerateAutonomous,
  cancelAllPending,
  cancelItem,
  countPendingSoon,
  dialogCooldownActive,
  dueAgendaItems,
  isDuringSleep,
  isDuringUnavailableBlock,
  isProactiveResponseRecent,
  isQuietTime,
  markAgendaFired,
  maxAutonomousItems,
  nextAllowedTime,
  normalizePingAt,
  planAgendaTick,
  reconcileAfterConflict,
  rescheduleItem,
  sanitizeAutonomousItems,
  selectDueItem,
} from './agenda';
export type {
  AgendaTickContext,
  AgendaTickPlan,
  AutonomousAllowance,
  AutonomousGate,
  AutonomousSanitizeOptions,
  AutonomousSanitizeResult,
  ConflictReconcileResult,
  ProactiveResponseDecision,
  ProactiveResponseOutcome,
  RejectedAgendaItem,
} from './agenda';

export {
  DAILY_LIFE_EVENTS_MAX,
  DAILY_LIFE_MAX_BLOCKS,
  DAILY_LIFE_MIN_BLOCKS,
  DAILY_LIFE_RECENT_DAYS,
  DAILY_LIFE_WANTS_MAX,
  blockAtHour,
  collectRecentEvents,
  currentBlock,
  dailyLifePromptFragment,
  decodeDailyLifeCache,
  emptyDailyLife,
  encodeDailyLifeCache,
  isPhoneAvailable,
  isQuietBlock,
  isUsableDailyLife,
  normalizeDailyLifeBlock,
  parseDailyLifeJson,
  parseHourValue,
  renderDailyLifeHuman,
  validateDailyLife,
} from './daily-life';
export type { DailyLifeIssue, DailyLifeValidation } from './daily-life';

export {
  ANTI_AI_RULES,
  buildAcquaintanceBlock,
  buildAgeStudyBlock,
  buildConflictBlock,
  buildHistory,
  buildIdentityBlock,
  buildMemoryBlock,
  buildPresenceBlock,
  buildPromptMessages,
  buildRelationshipBlock,
  buildStyleBlock,
  buildSystemPrompt,
} from './prompt';
export type {
  PromptDocuments,
  PromptInput,
  PromptMessage,
  PromptMessagesOptions,
} from './prompt';
