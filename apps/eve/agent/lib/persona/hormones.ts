/**
 * Deterministic menstrual-cycle / hormone model.
 *
 * The mechanic is deliberately seed-based: the same persona, age, date and
 * stress load always produce the same phase and the same behavior multipliers.
 * There is no `Math.random` and no timezone-dependent clock here, so unit tests
 * can pin a date and compare exact values.
 *
 * The output is an effect layer: `behavior.ts` multiplies ignore/reply chances
 * and delays by it, `presence.ts` nudges the online/notification rolls. The
 * biological numbers are coarse 0..1 indexes, not plasma levels.
 */

import { clamp, mod } from './time';
import type { CyclePhase, HormoneState } from './types';

export const CYCLE_MIN_LENGTH = 26;
export const CYCLE_MAX_LENGTH = 32;
export const CYCLE_BASELINE_LENGTH = 28;
/** Maximum cycle delay caused by maximum stress, in days. */
export const MAX_STRESS_DELAY_DAYS = 3;

const MS_PER_DAY = 86_400_000;
const PRNG_MOD = 233_280;

/**
 * Small integer PRNG, deterministic across engines (unlike `Math.sin`, whose
 * last bits may differ between platforms).
 */
function seededUnit(seed: number, salt: number): number {
  const s = mod(Math.trunc(seed), PRNG_MOD);
  const n = mod(Math.trunc(salt), PRNG_MOD);
  return mod(s * 9_301 + n * 49_297 + 1_013_904_223, PRNG_MOD) / PRNG_MOD;
}

/** Personal cycle length from the seed; always inside 26..32. */
export function cycleLengthFor(seed: number, age: number): number {
  const span = CYCLE_MAX_LENGTH - CYCLE_MIN_LENGTH + 1;
  const base =
    CYCLE_MIN_LENGTH + Math.floor(seededUnit(seed, 7) * span);
  // Teen cycles are a little more irregular, but stay inside the same band.
  if (age > 0 && age <= 19) {
    const jitter = seededUnit(seed, 17) < 0.5 ? -1 : 1;
    return clamp(base + jitter, CYCLE_MIN_LENGTH, CYCLE_MAX_LENGTH);
  }
  return clamp(base, CYCLE_MIN_LENGTH, CYCLE_MAX_LENGTH);
}

/** Normalized stress input, tolerant to garbage from the wire. */
export function normalizeStressLoad(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return clamp(n, 0, 1);
}

/** Whole days the cycle is delayed by stress, 0..3. */
export function stressDelayDaysFor(stressLoad: unknown): number {
  return Math.round(normalizeStressLoad(stressLoad) * MAX_STRESS_DELAY_DAYS);
}

/**
 * Single stress formula shared by the behavior tick and the prompt block.
 *
 * The reference computes `annoyance*0.4 + cringe*0.3 + conflict*0.3`; keeping
 * one function means the phase in the prompt cannot disagree with the phase
 * the decision was made from.
 */
export function stressLoadOf(
  score: { annoyance?: unknown; cringe?: unknown } | null | undefined,
  conflictLevel?: unknown,
): number {
  const annoyance = Number(score?.annoyance ?? 0);
  const cringe = Number(score?.cringe ?? 0);
  const level = Number(conflictLevel ?? 0);
  const value =
    (Number.isFinite(annoyance) ? Math.max(0, annoyance) / 100 : 0) * 0.4 +
    (Number.isFinite(cringe) ? Math.max(0, cringe) / 100 : 0) * 0.3 +
    (Number.isFinite(level) ? Math.max(0, level) / 4 : 0) * 0.3;
  return normalizeStressLoad(value);
}

/**
 * Phase boundaries relative to a personal cycle length. The luteal phase is
 * assumed stable at ~14 days, so ovulation sits at `length - 14`, exactly like
 * the reference model.
 *
 * For a 28-day cycle: 1-4 menstrual, 5-13 follicular, 14-15 ovulation,
 * 16-22 luteal, 23-28 PMS.
 */
export function phaseForCycleDay(
  cycleDay: number,
  cycleLength: number,
): CyclePhase {
  const len =
    Number.isFinite(cycleLength) && cycleLength >= 5
      ? Math.round(cycleLength)
      : CYCLE_BASELINE_LENGTH;
  const day = mod(Math.round(cycleDay) - 1, len) + 1;
  const ovulationDay = Math.max(6, len - 14);

  if (day <= 4) return 'menstrual';
  if (day <= ovulationDay - 1) return 'follicular';
  if (day <= ovulationDay + 1) return 'ovulation';
  if (day <= ovulationDay + 8) return 'luteal';
  return 'pms';
}

/** Whole UTC days since the epoch; stable regardless of the local clock. */
function epochDay(now: Date): number {
  const ms = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(ms)) return 0;
  return Math.floor(ms / MS_PER_DAY);
}

const AFFECTION_BASE: Record<CyclePhase, number> = {
  menstrual: 0.35,
  follicular: 0.65,
  ovulation: 0.85,
  luteal: 0.5,
  pms: 0.32,
};

const IRRITABILITY_BASE: Record<CyclePhase, number> = {
  menstrual: 0.5,
  follicular: 0.15,
  ovulation: 0.08,
  luteal: 0.25,
  pms: 0.6,
};

const LIBIDO_BASE: Record<CyclePhase, number> = {
  menstrual: 0.15,
  follicular: 0.55,
  ovulation: 0.9,
  luteal: 0.35,
  pms: 0.25,
};

const ENERGY_BASE: Record<CyclePhase, number> = {
  menstrual: -0.25,
  follicular: 0.15,
  ovulation: 0.25,
  luteal: 0,
  pms: -0.25,
};

/**
 * Compute the cycle snapshot.
 *
 * @param seed stable persona seed (`presenceSeed(name, age)` works fine).
 * @param age persona age, only used to make teen cycles slightly irregular.
 * @param now any date inside the simulated day.
 * @param stressLoad 0..1 from relationship annoyance / cringe / conflict.
 */
export function computeHormones(
  seed: number,
  age: number,
  now: Date,
  stressLoad = 0,
): HormoneState {
  const stress = normalizeStressLoad(stressLoad);
  const cycleLength = cycleLengthFor(seed, age);
  const startOffset = Math.floor(seededUnit(seed, 3) * cycleLength);
  const stressDelayDays = stressDelayDaysFor(stress);
  const day =
    mod(epochDay(now) + startOffset - stressDelayDays, cycleLength) + 1;
  const phase = phaseForCycleDay(day, cycleLength);

  // Stress shifts the cycle (delay) and directly raises irritability, exactly
  // like the reference model.
  const affection = clamp(
    AFFECTION_BASE[phase] - stress * 0.15,
    0,
    1,
  );
  const irritability = clamp(
    IRRITABILITY_BASE[phase] + stress * 0.25,
    0,
    1,
  );
  const libido = clamp(LIBIDO_BASE[phase] - stress * 0.2, 0, 1);
  const energy = clamp(ENERGY_BASE[phase] - stress * 0.2, -1, 1);

  const replyChanceMultiplier = clamp(
    (0.7 + affection * 0.8) * (1 - irritability * 0.4) * (1 - stress * 0.15),
    0.3,
    1.6,
  );
  const ignoreChanceMultiplier = clamp(
    0.35 + irritability * 1.6,
    0.4,
    2.2,
  );
  const delayMultiplier = clamp(0.65 + irritability * 1.2, 0.6, 2);
  const bubbleMultiplier = clamp(
    0.8 + affection * 0.5 - irritability * 0.5,
    0.5,
    1.35,
  );

  return {
    cycleDay: day,
    cycleLength,
    phase,
    stressLoad: stress,
    stressDelayDays,
    affection,
    irritability,
    libido,
    energy,
    replyChanceMultiplier,
    ignoreChanceMultiplier,
    delayMultiplier,
    bubbleMultiplier,
    flirt: phase === 'ovulation' || phase === 'follicular',
    shortReplies: phase === 'menstrual' || phase === 'pms',
  };
}

const PHASE_RU: Record<CyclePhase, string> = {
  menstrual: 'менструальная',
  follicular: 'фолликулярная',
  ovulation: 'овуляция',
  luteal: 'лютеиновая',
  pms: 'ПМС',
};

const PHASE_TONE: Record<CyclePhase, string> = {
  menstrual:
    'самочувствие так себе: отвечаешь короче и неохотнее, терпения мало, хочется полежать.',
  follicular:
    'энергии больше, настроение ровное и тёплое, отвечаешь охотнее и с интересом.',
  ovulation:
    'пик тепла и игривости: флиртуешь смелее, отвечаешь быстрее и охотнее обычного.',
  luteal:
    'спокойный ровный фон, но постепенно копится усталость; тон чуть сдержаннее.',
  pms:
    'раздражительность выше: отвечаешь короче и суше, можешь проигнорировать или задержать ответ.',
};

/**
 * Compact Russian block for the dynamic system prompt. It describes only what
 * changes in tone; the numbers and the mechanic itself must not leak.
 */
export function hormonesPromptFragment(state: HormoneState): string {
  const lines = [
    '# Гормоны',
    `фаза цикла: ${PHASE_RU[state.phase]} (день ${state.cycleDay}/${state.cycleLength}). ${PHASE_TONE[state.phase]}`,
  ];
  if (state.stressLoad >= 0.5) {
    lines.push(
      'фон: накопилось напряжение после ваших последних стычек — терпения меньше обычного.',
    );
  }
  lines.push(
    'об этом не говори прямо на ранних стадиях: не упоминай цикл, фазы и гормоны; на близких стадиях можешь мягко сослаться на самочувствие.',
  );
  return lines.join('\n');
}
