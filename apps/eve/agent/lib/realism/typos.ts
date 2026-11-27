/**
 * Keyboard-aware typos for the outgoing text.
 *
 * The model writes clean text; real people do not. Typos are injected at the
 * transport edge so the density is controlled and stays independent of the
 * model, and so they never appear in the session log or the memory pipeline.
 *
 * Only human-plausible mistakes: a neighbouring key, a dropped letter, a
 * doubled letter, two swapped letters. Words shorter than three characters,
 * links and mentions are left alone.
 */

const RU_NEIGHBORS: Record<string, string> = {
  й: 'цфы',
  ц: 'уйфы',
  у: 'кцыв',
  к: 'еува',
  е: 'нкавп',
  н: 'гепр',
  г: 'шнпр',
  ш: 'щгро',
  щ: 'зшол',
  з: 'хщлд',
  х: 'ъздж',
  ъ: 'хжэ',
  ф: 'йцыяч',
  ы: 'йцувфя',
  в: 'уакпс',
  а: 'квперс',
  п: 'анеро',
  р: 'пнгом',
  о: 'ргшл',
  л: 'ошщд',
  д: 'лщзж',
  ж: 'дзхэ',
  э: 'жхъ',
  я: 'фыч',
  ч: 'ыясм',
  с: 'ачмви',
  м: 'всит',
  и: 'пасмть',
  т: 'пирь',
  ь: 'ротл',
  б: 'лоюм',
  ю: 'длбь',
};

const OPS = ['neighbor', 'neighbor', 'drop', 'double', 'swap'] as const;

type Op = (typeof OPS)[number];

function pick<T>(pool: readonly T[], rng: () => number): T {
  return pool[Math.floor(rng() * pool.length)] as T;
}

function neighborOf(char: string): string {
  return RU_NEIGHBORS[char.toLowerCase()] ?? '';
}

function corruptWord(word: string, rng: () => number): string {
  if (word.length < 3) return word;
  const index = Math.floor(rng() * word.length);
  const char = word[index] as string;
  const op: Op = pick(OPS, rng);

  if (op === 'drop') {
    return word.slice(0, index) + word.slice(index + 1);
  }
  if (op === 'double') {
    return word.slice(0, index + 1) + char + word.slice(index + 1);
  }
  if (op === 'swap') {
    if (index >= word.length - 1) return word;
    return (
      word.slice(0, index) +
      (word[index + 1] as string) +
      char +
      word.slice(index + 2)
    );
  }
  const neighbors = neighborOf(char);
  if (!neighbors) return word;
  const replacement = pick([...neighbors], rng);
  return (
    word.slice(0, index) +
    (char === char.toUpperCase()
      ? replacement.toUpperCase()
      : replacement) +
    word.slice(index + 1)
  );
}

const WORD = /([A-Za-zА-Яа-яЁё]+)/g;

export interface TypoOptions {
  /** Per-word probability. 0 disables the pass. */
  intensity?: number;
  rng?: () => number;
}

/**
 * Injects at most a handful of typos into one reply.
 *
 * `intensity` is small on purpose: a typo in every sentence reads like a
 * broken model, not like a person.
 */
export function injectTypos(text: string, options: TypoOptions = {}): string {
  const intensity = options.intensity ?? 0;
  if (intensity <= 0) return text;
  if (/(?:https?:\/\/|www\.|t\.me\/|@\w+)/i.test(text)) return text;
  const rng = options.rng ?? Math.random;
  let budget = 1;
  return text.replace(WORD, (word) => {
    if (budget <= 0) return word;
    if (rng() > intensity) return word;
    const next = corruptWord(word, rng);
    if (next !== word) budget -= 1;
    return next;
  });
}

/**
 * Decides whether this reply gets a typo at all.
 *
 * Roughly half of the replies stay clean; bursts and short, casual styles get
 * a little more, long explanations almost none.
 */
export function pickTypoIntensity(options: {
  messageStyle?: string;
  bubbles?: number;
  rng?: () => number;
} = {}): number {
  const rng = options.rng ?? Math.random;
  let base = 0.05;
  if (options.messageStyle === 'bursty') base = 0.09;
  if (options.messageStyle === 'longform') base = 0.03;
  if ((options.bubbles ?? 1) >= 3) base += 0.02;
  if (rng() < 0.55) return 0;
  return base;
}
