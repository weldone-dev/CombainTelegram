/**
 * Presence: "can she even look at the phone right now?"
 *
 * The profile is deterministic from name + age + communication style + stage.
 * The state is a stateless snapshot computed per incoming message from the
 * local clock, sleep/busy windows, conflict cold period, forced wake and the
 * active-dialog timestamps. Randomness is injected so tests can be exact.
 */

import {
  clamp,
  isHourInRange,
  isMinuteInRange,
  localParts,
  minutesUntil,
  mod,
  parseTime,
  previousWeekday,
  toEpochMs,
  type LocalParts,
} from './time';
import { normalizeCommunicationProfile } from './communication';
import type {
  BusyState,
  BusySlot,
  CommunicationProfile,
  ConflictState,
  HormoneState,
  PersonaConfig,
  PresencePattern,
  PresenceProfile,
  PresenceState,
  Stage,
  Weekday,
} from './types';

// Re-exported so presence tests/callers do not need a second import.
export { isHourInRange, isMinuteInRange, minutesUntil } from './time';

const PRNG_MOD = 233280;

/**
 * Textbook PRNG: seed is derived from the name and age, so the same persona
 * always gets the same presence pattern.
 */
export function presenceSeed(name: string, age: number): number {
  let seed = 0;
  for (const char of name) seed += char.charCodeAt(0);
  return seed + Math.trunc(age);
}

export function prng(seed: number, n: number): number {
  return mod(seed * 9301 + n * 49297, PRNG_MOD) / PRNG_MOD;
}

/**
 * Deterministic night-wake roll, stable for one persona on one night.
 *
 * `computePresenceState` uses it when the caller does not inject `rand`, so a
 * single night cannot flip-flop between asleep and awake on every message
 * (and tests never depend on the wall clock).
 */
export function nightWakeRoll(config: PersonaConfig, now: number): number {
  const day = mod(Math.floor(now / 86_400_000), PRNG_MOD);
  return prng(presenceSeed(config.name, config.age), day);
}

interface PatternDefaults {
  checkEveryMin: (r4: number) => number;
  onlineWindowMin: (r5: number) => number;
  offlineReplyChance: number;
}

export const PATTERN_DEFAULTS: Record<PresencePattern, PatternDefaults> = {
  'phone-attached': {
    checkEveryMin: (r) => 3 + Math.floor(r * 5), // 3..7
    onlineWindowMin: (r) => 30 + Math.floor(r * 60), // 30..89
    offlineReplyChance: 0.85,
  },
  'burst-checker': {
    checkEveryMin: (r) => 15 + Math.floor(r * 20), // 15..34
    onlineWindowMin: (r) => 2 + Math.floor(r * 4), // 2..5
    offlineReplyChance: 0.5,
  },
  'rare-checker': {
    checkEveryMin: (r) => 60 + Math.floor(r * 60), // 60..119
    onlineWindowMin: (r) => 5 + Math.floor(r * 10), // 5..14
    offlineReplyChance: 0.25,
  },
  'evening-only': {
    checkEveryMin: (r) => 45 + Math.floor(r * 30), // 45..74
    onlineWindowMin: (r) => 60 + Math.floor(r * 90), // 60..149
    offlineReplyChance: 0.3,
  },
  'phone-attached-night': {
    checkEveryMin: (r) => 10 + Math.floor(r * 15), // 10..24
    onlineWindowMin: (r) => 20 + Math.floor(r * 40), // 20..59
    offlineReplyChance: 0.55,
  },
};

const PATTERN_ORDER: PresencePattern[] = [
  'phone-attached',
  'burst-checker',
  'rare-checker',
  'evening-only',
  'phone-attached-night',
];

const WARM_STAGES = new Set<Stage>([
  'convinced',
  'first-date-done',
  'dating-early',
  'dating-stable',
  'long-term',
]);

export function computePresenceProfile(config: PersonaConfig): PresenceProfile {
  const seed = presenceSeed(config.name, config.age);
  const r1 = prng(seed, 1);
  const r4 = prng(seed, 4);
  const r5 = prng(seed, 5);
  const communication = normalizeCommunicationProfile(config);

  let pattern = PATTERN_ORDER[Math.floor(r1 * 5)] ?? 'burst-checker';

  // Notification style overrides the seeded pattern.
  if (communication.notifications === 'priority') {
    if (
      communication.messageStyle === 'bursty' ||
      pattern === 'rare-checker' ||
      pattern === 'evening-only'
    ) {
      pattern = 'phone-attached';
    }
  } else if (communication.notifications === 'muted') {
    if (pattern === 'phone-attached') pattern = 'burst-checker';
    else if (pattern === 'phone-attached-night') pattern = 'evening-only';
  }

  const defaults = PATTERN_DEFAULTS[pattern] ?? PATTERN_DEFAULTS['burst-checker'];
  let checkEveryMin = defaults.checkEveryMin(r4);
  let onlineWindowMin = defaults.onlineWindowMin(r5);
  let offlineReplyChance = defaults.offlineReplyChance;

  const sleepFrom = normalizeHour(config.sleepFrom, 23);
  const sleepTo = normalizeHour(config.sleepTo, 8);
  const baseNightWake = normalizeChance(config.nightWakeChance, 0.05);
  let nightWakeChance = baseNightWake;

  if (communication.notifications === 'priority') {
    checkEveryMin = Math.max(2, Math.round(checkEveryMin * 0.35));
    onlineWindowMin = Math.round(onlineWindowMin * 1.35);
    offlineReplyChance = Math.max(
      offlineReplyChance,
      communication.initiative === 'high' ? 0.95 : 0.85,
    );
    nightWakeChance = Math.min(0.35, baseNightWake + 0.05);
  } else if (communication.notifications === 'muted') {
    checkEveryMin = Math.max(2, Math.round(checkEveryMin * 1.5));
    onlineWindowMin = Math.max(1, Math.round(onlineWindowMin * 0.65));
    offlineReplyChance = Math.min(offlineReplyChance, 0.25);
    nightWakeChance = Math.max(0, baseNightWake * 0.4);
  }

  if (WARM_STAGES.has(config.stage)) {
    offlineReplyChance = Math.min(0.98, offlineReplyChance + 0.12);
    checkEveryMin = Math.max(2, Math.round(checkEveryMin * 0.8));
  } else if (config.stage === 'met-irl-got-tg') {
    offlineReplyChance = Math.min(0.9, offlineReplyChance + 0.08);
  }

  return {
    pattern,
    sleepFrom,
    sleepTo,
    checkEveryMin,
    onlineWindowMin,
    offlineReplyChance: clamp(offlineReplyChance, 0, 1),
    nightWakeChance: clamp(nightWakeChance, 0, 1),
  };
}

function normalizeHour(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return mod(Math.trunc(n), 24);
}

function normalizeChance(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, 0, 1);
}

/**
 * Evening window: 18:00 until bedtime. Midnight-aware: with `sleepFrom = 2`
 * the window is 18:00–02:00, with `sleepFrom = 23` it is 18:00–23:00.
 * (The original implementation used `h >= 18 || h < sleepFrom`, which made
 * "evening" true almost all day for the default 23:00 bedtime.)
 */
export function isEvening(hour: number, sleepFrom = 23): boolean {
  const from = mod(Math.trunc(sleepFrom), 24);
  // A bedtime exactly at 18:00 leaves no evening window at all.
  if (from === 18) return false;
  return isHourInRange(hour, 18, from);
}

/** Night-owl gate: 22:00–08:00, crossing midnight. */
export function isNightWindow(hour: number): boolean {
  return isHourInRange(hour, 22, 8);
}

export function isAsleep(profile: PresenceProfile, localHour: number): boolean {
  return isHourInRange(localHour, profile.sleepFrom, profile.sleepTo);
}

export function onlineProbability(profile: PresenceProfile): number {
  return profile.onlineWindowMin / (profile.onlineWindowMin + profile.checkEveryMin);
}

export interface BusyMatch {
  slot: BusySlot;
  remainingMin: number;
  until: string;
}

function dayAllowed(slot: BusySlot, day: Weekday): boolean {
  return !slot.days || slot.days.length === 0 || slot.days.includes(day);
}

/**
 * First active busy slot. Normal windows are `[from, to)` on an allowed day.
 * Windows crossing midnight have an evening part (today's permission) and a
 * morning part (the previous day's permission, e.g. a Friday party lasting
 * into Saturday morning).
 */
export function activeBusySlot(
  slots: BusySlot[] | undefined,
  day: Weekday,
  minuteOfDay: number,
): BusyMatch | null {
  if (!slots || slots.length === 0) return null;
  const minute = mod(Math.trunc(minuteOfDay), 1440);
  const previous = previousWeekday(day);

  for (const slot of slots) {
    const from = parseTime(slot.from);
    const to = parseTime(slot.to);
    if (from === null || to === null || from === to) continue;

    if (from < to) {
      if (dayAllowed(slot, day) && isMinuteInRange(minute, from, to)) {
        return { slot, remainingMin: to - minute, until: slot.to };
      }
      continue;
    }

    // Crosses midnight.
    if (dayAllowed(slot, day) && minute >= from) {
      return { slot, remainingMin: 1440 - minute + to, until: slot.to };
    }
    if (dayAllowed(slot, previous) && minute < to) {
      return { slot, remainingMin: to - minute, until: slot.to };
    }
  }
  return null;
}

export interface PresenceInput {
  /** Epoch ms of his last message; 0/undefined disables active dialog. */
  lastUserMsgTs?: number;
  /** Epoch ms of her last reply; 0/undefined disables active dialog. */
  lastHerReplyTs?: number;
  /** Number of exchanges in the current conversation. */
  recentExchangeCount?: number;
  forcedWake?: boolean;
  conflict?: ConflictState | null;
  /** Optional cycle snapshot; absent keeps the pre-hormone behavior. */
  hormones?: HormoneState;
  /** Epoch ms, defaults to Date.now(). */
  now?: number;
  /** Injectable PRNG, defaults to Math.random. */
  rand?: () => number;
}

const ACTIVE_DIALOG_WINDOW_MS = 15 * 60_000;
const ACTIVE_DIALOG_USER_WINDOW_MS = 5 * 60_000;

export function computePresenceState(
  config: PersonaConfig,
  profile: PresenceProfile,
  input: PresenceInput = {},
): PresenceState {
  const now = input.now ?? Date.now();
  const rand = input.rand ?? Math.random;
  const local = localParts(now, config.timezone);
  const asleep = isAsleep(profile, local.hour);
  const minuteOfDay = local.hour * 60 + local.minute;
  const busySlot = asleep ? null : activeBusySlot(config.busySchedule, local.weekday, minuteOfDay);
  const coldUntilTs = toEpochMs(input.conflict?.coldUntil);
  const coldActive = coldUntilTs !== null && coldUntilTs > now;
  const forcedWake = input.forcedWake === true;
  // Short-circuit exactly like the source: the dice are only rolled when
  // asleep, which keeps the deterministic test sequences predictable. Without
  // an injected PRNG the roll is seeded per persona and per night, so the same
  // night does not flip between "awake" and "asleep" on every message.
  const nightAwake =
    forcedWake ||
    (asleep &&
      (input.rand ? input.rand() : nightWakeRoll(config, now)) <
        profile.nightWakeChance);
  const lastUser = input.lastUserMsgTs ?? 0;
  const lastHer = input.lastHerReplyTs ?? 0;
  const inActiveDialog =
    (input.recentExchangeCount ?? 0) >= 3 &&
    lastHer > 0 &&
    now - lastHer < ACTIVE_DIALOG_WINDOW_MS &&
    lastUser > 0 &&
    now - lastUser < ACTIVE_DIALOG_USER_WINDOW_MS;

  const base: Omit<PresenceState, 'online' | 'nextCheckSec' | 'hint'> = {
    asleep,
    nightAwake,
    localHour: local.hour,
    pattern: profile.pattern,
    coldActive,
    forcedWake,
  };

  // Branch order is important: conflict first, then sleep, then busy.
  if (coldActive && !forcedWake) {
    const remainingSec = Math.max(60, Math.ceil((coldUntilTs! - now) / 1000));
    const hours = Math.max(1, Math.ceil(remainingSec / 3600));
    return {
      ...base,
      online: false,
      nextCheckSec: remainingSec,
      hint: `Ты в режиме молчания после ссоры (уровень ${input.conflict?.level ?? 1}). Осталось около ${hours} ч игнора. Не отвечай тепло: максимум "."/"и?"/"ну?"/"что", без смайликов и скобок.`,
    };
  }

  if (asleep && !nightAwake) {
    const untilWakeMin = minutesUntil(local.hour, local.minute, profile.sleepTo, 0);
    const jitter = Math.floor(rand() * 1800);
    return {
      ...base,
      online: false,
      nextCheckSec: Math.max(60, untilWakeMin * 60 + jitter),
      hint: `СПИШЬ (сейчас ${String(local.hour).padStart(2, '0')}:00 по твоему времени). Сообщение не прочитано. Даже если откроешь — заспанно, односложно, с опечатками.`,
    };
  }

  if (busySlot && !forcedWake) {
    return computeBusyState(config, busySlot, base, local, inActiveDialog, input, rand);
  }

  if (forcedWake) {
    return {
      ...base,
      online: true,
      nextCheckSec: 0,
      hint: 'ПРИНУДИТЕЛЬНОЕ ПРОБУЖДЕНИЕ: сейчас ты в сети, даже если обычно спишь или занята. Отвечай коротко и немного невнятно, как будто тебя только что разбудили.',
    };
  }

  if (inActiveDialog) {
    return {
      ...base,
      online: true,
      nextCheckSec: 0,
      hint: 'АКТИВНЫЙ ДИАЛОГ: вы только что переписывались. Отвечай быстро и не исчезай внезапно — резкий выход из сети выглядит подозрительно.',
    };
  }

  if (profile.pattern === 'evening-only' && !isEvening(local.hour, profile.sleepFrom)) {
    const waitMin = minutesUntil(local.hour, local.minute, 18, 0);
    return {
      ...base,
      online: false,
      nextCheckSec: Math.max(60, waitMin * 60),
      hint: 'Сейчас ты вне своего обычного вечернего окна: днём почти не заходишь в Telegram. Сообщение увидишь ближе к вечеру.',
    };
  }

  if (profile.pattern === 'phone-attached-night' && !isNightWindow(local.hour)) {
    const waitMin = minutesUntil(local.hour, local.minute, 22, 0);
    return {
      ...base,
      online: false,
      nextCheckSec: Math.max(60, waitMin * 60),
      hint: 'Ты сова: днём телефон почти не в руках, оживаешь к ночи. Сейчас сообщение скорее всего не увидишь.',
    };
  }

  const onlineChance = clamp(
    onlineProbability(profile) *
      (input.hormones?.replyChanceMultiplier ?? 1),
    0,
    1,
  );
  const online = rand() < onlineChance;
  if (online) {
    return {
      ...base,
      online: true,
      nextCheckSec: 0,
      notificationSeen: false,
      hint: 'Ты только что заглянула в Telegram. Можешь ответить спокойно, но не задерживайся: у тебя свои дела.',
    };
  }

  const notificationChance = clamp(
    profile.offlineReplyChance *
      (input.hormones?.replyChanceMultiplier ?? 1),
    0,
    1,
  );
  const notificationSeen = rand() < notificationChance;
  const nextCheckSec = notificationSeen
    ? Math.round(60 + rand() * 240)
    : Math.max(30, Math.round(rand() * profile.checkEveryMin * 60));

  return {
    ...base,
    online: false,
    nextCheckSec,
    notificationSeen,
    hint: notificationSeen
      ? 'Сейчас не в сети, но уведомление увидела. Ответь коротко, как будто посмотрела на бегу, и не втягивайся в долгий диалог.'
      : 'Сейчас не в сети и уведомление не смотрела. Ответ появится, когда заглянешь в телефон.',
  };
}

function computeBusyState(
  config: PersonaConfig,
  match: BusyMatch,
  base: Omit<PresenceState, 'online' | 'nextCheckSec' | 'hint'>,
  local: LocalParts,
  inActiveDialog: boolean,
  input: PresenceInput,
  rand: () => number,
): PresenceState {
  const communication = normalizeCommunicationProfile(config);
  const [rawMin, rawMax] = normalizeCheckRange(match.slot.checkAfterMin);
  const busyMul =
    communication.notifications === 'priority'
      ? 0.45
      : communication.notifications === 'muted'
        ? 1.25
        : 1;
  const dialogMul = inActiveDialog ? 0.35 : 1;
  const minCheck = Math.max(1, Math.round(rawMin * busyMul * dialogMul));
  const maxCheck = Math.max(minCheck, Math.round(rawMax * busyMul * dialogMul));

  const busy: BusyState = {
    label: match.slot.label,
    until: match.until,
    checkAfterMin: minCheck,
  };

  // Boring lesson / commute: the phone is technically unavailable, but she
  // still opens Telegram in short micro-cycles.
  if (maxCheck <= 5) {
    const cycleMin = Math.max(1, Math.round((minCheck + maxCheck) / 2));
    const minuteOfCycle = (local.hour * 60 + local.minute) % cycleMin;
    const onlineMin = clamp(Math.floor(cycleMin / 2), 1, 2);
    const online = minuteOfCycle < onlineMin;
    busy.checkAfterMin = cycleMin;
    const nextCheckSec = online ? 0 : (cycleMin - minuteOfCycle) * 60;
    return {
      ...base,
      online,
      nextCheckSec,
      busy,
      notificationSeen: false,
      hint: `Сейчас занята: ${match.slot.label} до ${match.until}. Телефон под рукой урывками — можешь ответить коротко, но не втягивайся.`,
    };
  }

  const checkAfterMin = minCheck + Math.floor(rand() * (maxCheck - minCheck + 1));
  busy.checkAfterMin = checkAfterMin;
  let nextCheckSec = Math.max(60, (match.remainingMin + checkAfterMin) * 60);
  if (inActiveDialog) {
    const capMin = communication.notifications === 'priority' ? 12 : 20;
    nextCheckSec = Math.min(nextCheckSec, capMin * 60);
  }

  const transition =
    inActiveDialog && checkAfterMin > 5
      ? busyTransitionHint(
          config.stage,
          communication,
          match.remainingMin,
          checkAfterMin,
          input.recentExchangeCount ?? 0,
          rand,
        )
      : null;

  const baseHint = `Сейчас занята: ${match.slot.label} до ${match.until}, телефон убран. Сообщение увидишь примерно через ${checkAfterMin} мин.`;

  return {
    ...base,
    online: false,
    nextCheckSec,
    busy,
    notificationSeen: false,
    hint: transition ? `${baseHint} ${transition}` : baseHint,
  };
}

function normalizeCheckRange(value: [number, number] | undefined): [number, number] {
  const a = Number(value?.[0]);
  const b = Number(value?.[1]);
  const first = Number.isFinite(a) ? Math.max(1, Math.round(a)) : 5;
  const second = Number.isFinite(b) ? Math.max(1, Math.round(b)) : 15;
  return first <= second ? [first, second] : [second, first];
}

const TRANSITION_BASE_CHANCE: Record<Stage, number> = {
  'met-irl-got-tg': 0.05,
  'tg-given-cold': 0.08,
  'tg-given-warming': 0.18,
  convinced: 0.4,
  'first-date-done': 0.55,
  'dating-early': 0.7,
  'dating-stable': 0.8,
  'long-term': 0.75,
  dumped: 0,
};

/**
 * Will she warn him that she is about to disappear into a busy slot? This is a
 * realism detail: close couples usually get "щас пара, освобожусь позже",
 * cold acquaintances just vanish.
 */
export function busyTransitionHint(
  stage: Stage,
  communication: CommunicationProfile,
  remainingMin: number,
  checkAfterMin: number,
  recentExchangeCount: number,
  rand: () => number = Math.random,
): string | null {
  let chance = TRANSITION_BASE_CHANCE[stage] ?? 0.1;
  if (communication.initiative === 'high') chance += 0.15;
  if (communication.initiative === 'low') chance -= 0.15;
  if (communication.notifications === 'priority') chance += 0.1;
  if (communication.notifications === 'muted') chance -= 0.1;
  if (communication.lifeSharing === 'high') chance += 0.05;

  if (remainingMin <= 10) chance -= 0.2;
  else if (remainingMin <= 20) chance -= 0.05;
  else if (remainingMin >= 90) chance += 0.15;
  else if (remainingMin >= 45) chance += 0.08;

  if (checkAfterMin >= 30) chance += 0.15;
  else if (checkAfterMin >= 15) chance += 0.05;
  else if (checkAfterMin <= 8) chance -= 0.1;

  if (recentExchangeCount >= 6) chance += 0.1;
  else if (recentExchangeCount >= 4) chance += 0.05;

  chance = clamp(chance, 0, 1);
  if (rand() >= chance) return null;

  const isCold = communication.initiative === 'low' && communication.messageStyle === 'one-liners';
  const isClose = ['dating-early', 'dating-stable', 'long-term'].includes(stage);
  const isWarm =
    communication.initiative === 'high' || communication.lifeSharing === 'high';
  const when =
    remainingMin > 45 ? 'через пару часов' : remainingMin > 30 ? 'часа через полтора' : 'скоро';

  if (isCold) {
    return 'Можешь коротко предупредить, что занята: одно-два слова ("ушла", "потом", "занята"), без объяснений.';
  }
  if (isClose && isWarm) {
    return `Можешь по-тёплому предупредить, что освободишься ${when}, и что ответишь позже. Одно короткое сообщение, без драмы.`;
  }
  if (isClose) {
    return `Можешь нейтрально сказать, что занята и освободишься ${when}. Коротко, без смайликов.`;
  }
  return `Можешь обмолвиться, что сейчас занята и освободишься ${when}, но не обязательно.`;
}

const PATTERN_RU: Record<PresencePattern, string> = {
  'phone-attached': 'телефон почти всегда в руке',
  'burst-checker': 'заходит каждые 15–30 минут на пару минут',
  'rare-checker': 'проверяет телефон раз в час-два',
  'evening-only': 'активна в основном вечером',
  'phone-attached-night': 'сова: оживает ближе к ночи',
};

export function describePresencePattern(pattern: PresencePattern): string {
  return PATTERN_RU[pattern] ?? PATTERN_RU['burst-checker'];
}

export const PRESENCE_PATTERNS = PATTERN_ORDER;
