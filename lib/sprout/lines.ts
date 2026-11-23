/**
 * Sprout speech-bubble lines. PURE: no React / Supabase imports, so it can be
 * unit-tested with `npx tsx --test tests/sprout-lines.test.ts`.
 *
 * Guardrails (enforced by tests/sprout-lines.test.ts):
 *  - warm and short; when Sprout is quiet-mood (droopy / sad / grumpy, from
 *    days without logging only, 23 Nov owner decision) it only nudges gently
 *    toward logging, never guilt-trips;
 *  - never mentions money, amounts, debts or who owes whom (any mood);
 *  - the only digits ever produced are "N to go", "+N growth", "N days in a row".
 * Nothing here reads balances, so money cannot influence what Sprout says.
 */
import { LEVELS, MAX_LEVEL, istDay, type SproutCounts } from './model';

export type LineEvent =
  | 'open'
  | 'tap'
  | 'gain'
  | 'levelUp'
  | 'expenseLogged'
  | 'settled'
  | 'friendAdded'
  | 'scan'
  | 'revived';

/** Quiet moods that get their own line tier (inactivity only; see model.ts). */
export type QuietTier = 'droopy' | 'sad' | 'grumpy';

/** Counts only (never amounts) of what the user did today. */
export interface TodayCounts {
  expenses: number;
  settlements: number;
  scans: number;
  friends: number;
}

export const EMPTY_TODAY: TodayCounts = { expenses: 0, settlements: 0, scans: 0, friends: 0 };

export interface LineInput {
  /** 1..10 */
  level: number;
  /** Progress to the next level; null at the top. */
  toNext: { remaining: number; nextName: string } | null;
  todayCounts?: TodayCounts;
  /** Local hour 0..23. */
  hour: number;
  event?: LineEvent;
  /** Taps so far in this visit; rotates the line. */
  tapCount?: number;
  /** Points gained in the last growth moment. */
  lastGain?: number;
  /** Current quiet mood, if any: 'tap' and 'open' use that mood's tier. */
  quiet?: QuietTier | null;
}

/** Today's counts (never amounts) from the cached per-day counts. Pure. */
export function todayCountsFrom(counts: SproutCounts | null | undefined, now: Date): TodayCounts {
  if (!counts) return EMPTY_TODAY;
  const day = istDay(now);
  const n = (m: Record<string, number> | undefined) => {
    const v = m?.[day];
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  };
  return {
    expenses: n(counts.expensesByDay),
    settlements: n(counts.settlementsByDay),
    scans: n(counts.scansByDay),
    friends: n(counts.friendsByDay),
  };
}

const clampLevel = (l: number) => {
  const n = Math.floor(Number(l));
  return Number.isFinite(n) ? Math.min(MAX_LEVEL, Math.max(1, n)) : 1;
};

const pick = (pool: readonly string[], n: number): string => {
  const i = Number.isFinite(n) ? Math.abs(Math.floor(n)) % pool.length : 0;
  return pool[i];
};

const nameOf = (level: number) => LEVELS[clampLevel(level) - 1].name;

function dayPart(hour: number): 'morning' | 'afternoon' | 'evening' | 'night' {
  const h = Number.isFinite(hour) ? ((Math.floor(hour) % 24) + 24) % 24 : 12;
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 17) return 'afternoon';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}

const GREETING: Record<ReturnType<typeof dayPart>, string[]> = {
  morning: ['Good morning! Ready to grow?', 'Morning! I stretched my leaves for you.'],
  afternoon: ['Good afternoon! Nice to see you.', 'Hello! The sun is lovely today.'],
  evening: ['Good evening! Glad you stopped by.', 'Evening! I saved you a spot in the shade.'],
  night: ['Hello, night owl! A quiet visit is nice too.', 'Hi! I am cosy and happy you are here.'],
};

const TAP_GENERIC = [
  'Hehe, that tickles!',
  'Hi there!',
  'Growing slowly, happily.',
  'Every little bit counts.',
  'I like it here with you.',
  'Wheee!',
  'Leafy hugs!',
  'You are doing great.',
];

const LEVEL_TAP: Record<number, string[]> = {
  1: ['I am just a seed. Big things ahead!', 'Cosy in the soil, dreaming of leaves.'],
  2: ['First leaves are out!', 'Look, I have a face now!'],
  3: ['Seedling life is fun.', 'My leaves are getting bigger.'],
  4: ['Reaching up, little by little.', 'I can feel the sunlight.'],
  5: ['A proper sapling now!', 'Standing tall in my pot.'],
  6: ['Young tree, strong roots.', 'My branches are filling out.'],
  7: ['A real tree now!', 'Birds could nest here soon.'],
  8: ['Look, blossoms are coming!', 'I am blooming, thanks to you.'],
  9: ['Grand and leafy, and still growing.', 'So many blossoms today.'],
  10: [
    'Ancient and still blossoming.',
    'I keep growing a little, always.',
    'Rooted deep, leaves swaying.',
    'Still here, still happy.',
  ],
};

const EVENT_POOL: Record<Exclude<LineEvent, 'open' | 'tap' | 'gain' | 'levelUp' | 'revived'>, string[]> = {
  expenseLogged: ['Logged! That helps me grow.', 'Nice and tidy. Thank you!'],
  settled: ['A fresh start with a friend. Lovely!', 'Squared up. I feel light as a leaf.'],
  friendAdded: ['A new friend! Welcome to the garden.', 'The more, the merrier.'],
  scan: ['Reading receipts is thirsty work. Good one!', 'Scanned and sorted.'],
};

const QUIET_LINES: Record<QuietTier, string[]> = {
  droopy: [
    'I am a bit droopy. A quick log perks me up.',
    'My leaves feel floppy. Log something?',
    'A tiny log would cheer me right up.',
  ],
  sad: [
    'Feeling a bit wilted. One little log helps!',
    'It is quiet in here. Log something?',
    'My leaves are drooping. A log would help.',
  ],
  grumpy: [
    'Hmph... log something?',
    'Huff! Even a tiny log would do.',
    'I am a little grumpy. A log fixes it!',
    'Hmph. One log, please?',
  ],
};

const REVIVED_LINES = [
  'Ahh, that perked me right up!',
  'Thank you! I feel fresh again.',
  'My leaves are lifting. Lovely!',
];

const GAIN_FALLBACK = ['A little growth!', 'I grew a bit!'];

function todayLines(t: TodayCounts): string[] {
  const out: string[] = [];
  const total = t.expenses + t.settlements + t.scans + t.friends;
  if (total <= 0) return out;
  if (t.expenses > 0) out.push('You logged something today. Thank you!');
  if (t.settlements > 0) out.push('You squared something up today. Nice!');
  if (t.scans > 0) out.push('Scanning today, so handy!');
  if (t.friends > 0) out.push('A new friend today. I love that.');
  out.push(total >= 3 ? 'What a lovely, busy day!' : 'Today is off to a good start.');
  return out;
}

/** Every candidate for the situation, in a stable order. */
function candidates(input: LineInput): string[] {
  const level = clampLevel(input.level);
  const event = input.event ?? 'tap';
  const part = dayPart(input.hour);
  const today = input.todayCounts ?? EMPTY_TODAY;

  if (event === 'levelUp') {
    const nm = nameOf(level);
    return [`I am a ${nm} now!`, `${nm}! Look at me go!`];
  }
  if (event === 'gain') {
    const g = Math.floor(Number(input.lastGain));
    if (Number.isFinite(g) && g > 0) {
      return [`That's +${g} growth`, `+${g} growth, thank you!`];
    }
    return GAIN_FALLBACK;
  }
  if (event === 'revived') return REVIVED_LINES;
  if ((event === 'open' || event === 'tap') && input.quiet) return QUIET_LINES[input.quiet];
  if (event === 'open') {
    const base = [...GREETING[part]];
    if (input.toNext && input.toNext.remaining > 0 && input.toNext.remaining <= 3) {
      base.push(`Just ${input.toNext.remaining} to go to ${input.toNext.nextName}!`);
    }
    return base;
  }
  if (event !== 'tap') return EVENT_POOL[event];

  const pool = [...TAP_GENERIC, ...(LEVEL_TAP[level] ?? [])];
  pool.push(...todayLines(today));
  if (input.toNext && input.toNext.remaining > 0) {
    pool.push(`${input.toNext.remaining} to go to ${input.toNext.nextName}.`);
    pool.push(`Next up: ${input.toNext.nextName}!`);
  } else if (level >= MAX_LEVEL) {
    pool.push('All the way up, and still blossoming.');
  }
  pool.push(GREETING[part][0]);
  return pool;
}

/**
 * Pick a speech-bubble line. Deterministic: rotation uses `tapCount`
 * (and level/hour for greetings), so tests and the UI never depend on RNG.
 */
export function pickLine(input: LineInput): string {
  const pool = candidates(input);
  const event = input.event ?? 'tap';
  if (event === 'tap') return pick(pool, input.tapCount ?? 0);
  return pick(pool, clampLevel(input.level) + Math.floor(Number(input.hour) || 0) + (input.tapCount ?? 0));
}

/**
 * Every line pickLine can produce, found by sweeping the input space.
 * Used by tests to scan for banned words; never used by the app.
 */
export function allPossibleLines(): string[] {
  const seen = new Set<string>();
  const events: LineEvent[] = ['open', 'tap', 'gain', 'levelUp', 'expenseLogged', 'settled', 'friendAdded', 'scan', 'revived'];
  const quiets: (QuietTier | null)[] = [null, 'droopy', 'sad', 'grumpy'];
  const todays: TodayCounts[] = [
    EMPTY_TODAY,
    { expenses: 1, settlements: 0, scans: 0, friends: 0 },
    { expenses: 0, settlements: 1, scans: 1, friends: 1 },
    { expenses: 3, settlements: 2, scans: 1, friends: 1 },
  ];
  for (let level = 1; level <= MAX_LEVEL; level++) {
    const nexts: LineInput['toNext'][] = [null];
    if (level < MAX_LEVEL) {
      for (const r of [1, 2, 3, 4, 9, 25]) nexts.push({ remaining: r, nextName: nameOf(level + 1) });
    }
    for (const toNext of nexts) {
      for (const event of events) {
        for (const todayCounts of todays) {
          for (let hour = 0; hour < 24; hour += 3) {
            for (const lastGain of [0, 1, 2, 7, 12]) {
              for (const quiet of quiets) {
                const pool = candidates({ level, toNext, todayCounts, hour, event, lastGain, quiet });
                for (const l of pool) seen.add(l);
              }
            }
          }
        }
      }
    }
  }
  return [...seen];
}
