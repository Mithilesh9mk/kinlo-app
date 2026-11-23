/**
 * Sprout growth model — pure logic, no React Native / Supabase imports so it
 * can be unit-tested with `npx tsx --test tests/sprout-model.test.ts`.
 * See docs/CHARACTER_PLAN.md sections 2 and 2a (2a is the live curve).
 */

export type SproutStage = 'seed' | 'sprout' | 'sapling' | 'tree';

/**
 * Moods. Negative moods (droopy, sad, grumpy) exist since the owner decision
 * of 23 Nov, under ONE rule: they come ONLY from inactivity, i.e. whole IST
 * days without a logged action (`daysQuiet`, see streakInfo). They must NEVER
 * be derived from money, balances, `hasOpenBalances`, amounts or who owes whom.
 * They are mood and wilting only: level, points, the progress bar, server data
 * (sprout_stats) and what friends see never drop. A new user with no activity
 * at all has daysQuiet 0 and is never sad. A logged action ends a quiet spell
 * ('revived' one-shot). 'welcomeBack' is kept in the union so older callers
 * compile, but resolveMood no longer returns it (quiet time is measured from
 * the last logged action, not from app open).
 */
export type SproutMood =
  | 'idle'
  | 'celebrate'
  | 'curious'
  | 'proud'
  | 'welcomeBack'
  | 'sleepy'
  | 'growing'
  | 'droopy'
  | 'sad'
  | 'grumpy'
  | 'revived';

/** Moods that come from inactivity only. */
export const QUIET_MOODS: readonly SproutMood[] = ['droopy', 'sad', 'grumpy'];

export type SproutEvent =
  | 'expenseLogged'
  | 'settled'
  | 'circleSquared'
  | 'friendAdded'
  | 'circleJoined'
  | 'scanStarted'
  | 'scanFinished'
  | 'appOpened';

/** Per-day counts keyed by YYYY-MM-DD in Asia/Kolkata (see istDay). */
export type DayCounts = Record<string, number>;

export interface SproutCounts {
  expensesByDay: DayCounts;
  settlementsByDay: DayCounts;
  scansByDay: DayCounts;
  /** Distinct non-placeholder friends, by friendship created_at day. */
  friendsByDay: DayCounts;
  /** Circles with >= 2 members, before the lifetime cap. */
  circles: number;
  /** Squared circles, before the lifetime cap. */
  circlesSquared: number;
}

export const EMPTY_COUNTS: SproutCounts = {
  expensesByDay: {},
  settlementsByDay: {},
  scansByDay: {},
  friendsByDay: {},
  circles: 0,
  circlesSquared: 0,
};

export const POINT_WEIGHTS = {
  expense: 1,
  settlement: 2,
  friend: 2,
  circle: 2,
  scan: 1,
  squared: 3,
} as const;

/** Max points per type per IST day. */
export const DAILY_CAPS = {
  expense: 5,
  settlement: 6,
  scan: 3,
  friend: 6,
} as const;

/** Max counted circles / squared circles over a lifetime. */
export const LIFETIME_CAPS = { circles: 5, squared: 5 } as const;

export interface SproutLevel {
  level: number;
  name: string;
  /** Points needed to reach this level. */
  threshold: number;
  stage: SproutStage;
  blossoms: number;
}

export const LEVELS: readonly SproutLevel[] = [
  { level: 1, name: 'Seed', threshold: 0, stage: 'seed', blossoms: 0 },
  { level: 2, name: 'Sprout', threshold: 3, stage: 'sprout', blossoms: 0 },
  { level: 3, name: 'Seedling', threshold: 6, stage: 'sprout', blossoms: 0 },
  { level: 4, name: 'Shoot', threshold: 10, stage: 'sapling', blossoms: 0 },
  { level: 5, name: 'Sapling', threshold: 15, stage: 'sapling', blossoms: 0 },
  { level: 6, name: 'Young tree', threshold: 22, stage: 'sapling', blossoms: 0 },
  { level: 7, name: 'Tree', threshold: 32, stage: 'tree', blossoms: 0 },
  { level: 8, name: 'Blooming tree', threshold: 45, stage: 'tree', blossoms: 2 },
  { level: 9, name: 'Grand tree', threshold: 62, stage: 'tree', blossoms: 4 },
  { level: 10, name: 'Ancient tree', threshold: 85, stage: 'tree', blossoms: 5 },
];

/** Levels in the hand-written base table. Levels past this come from a formula (see thresholdFor). */
export const BASE_LEVELS = LEVELS.length;

/**
 * ENDLESS LEVELS (23 Nov owner decision): Sprout never stops growing.
 * Past the base table every level costs the same ENDLESS_GAP points, which
 * equals the last base gap (62 to 85 is 23), so the pace never gets slower
 * than the end of the table: threshold(n) = 85 + 23 * (n - 10) for n >= 10.
 * Daily caps are unchanged (anti-farming); "endless" means no ceiling over
 * time. The server still caps sprout_stats.level at 10 by design; friends'
 * devices derive the same level from the points they can read
 * (see friendLevelFrom).
 */
export const ENDLESS_GAP = 23;

/** Every ERA_SPAN levels past the base table starts a named era (era 1 = level 11). */
export const ERA_SPAN = 5;
/** First level of era 1 (the first level past the base table). */
export const FIRST_ERA_LEVEL = BASE_LEVELS + 1;

/** Era names, then they cycle with a Roman numeral suffix (no digits in names). */
export const ERA_NAMES = ['Fruiting', 'Songbird', 'Lantern', 'Starlight', 'Golden'] as const;
/** One small cosmetic per era name (drawn in SproutFigure, tree stage only). */
export const ERA_UNLOCKS = [
  'Ripe fruit on the branches',
  'A little songbird',
  'A glowing lantern',
  'Tiny twinkling stars',
  'Golden leaves',
] as const;
const LEVEL_RANKS = ['tree', 'canopy', 'grove', 'elder', 'legend'] as const;

function roman(n: number): string {
  let v = ((Math.max(1, Math.floor(n)) - 1) % 3999) + 1;
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let out = '';
  for (const [n1, sym] of table) {
    while (v >= n1) {
      out += sym;
      v -= n1;
    }
  }
  return out;
}

function clampLevel(level: number): number {
  const n = Math.floor(Number(level));
  if (!Number.isFinite(n)) return 1;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, n));
}

/** Era number of a level: 0 for the base table, then 1, 2, ... every ERA_SPAN levels. */
export function eraFor(level: number): number {
  const n = clampLevel(level);
  return n < FIRST_ERA_LEVEL ? 0 : Math.floor((n - FIRST_ERA_LEVEL) / ERA_SPAN) + 1;
}

/** First level of era e (e >= 1). */
export function eraStartLevel(era: number): number {
  const e = Math.max(1, Math.floor(Number(era)) || 1);
  return FIRST_ERA_LEVEL + (e - 1) * ERA_SPAN;
}

/** Index 0..4 into ERA_NAMES / ERA_UNLOCKS / figure cosmetics for an era >= 1. */
export function eraSlot(era: number): number {
  return (Math.max(1, Math.floor(Number(era)) || 1) - 1) % ERA_NAMES.length;
}

/** Era name without the word "era", e.g. "Fruiting", "Fruiting II". null for era 0. No digits. */
export function eraName(era: number): string | null {
  const e = Math.floor(Number(era));
  if (!Number.isFinite(e) || e < 1) return null;
  const round = Math.floor((e - 1) / ERA_NAMES.length);
  return ERA_NAMES[eraSlot(e)] + (round > 0 ? ` ${roman(round + 1)}` : '');
}

/** What an era unlocks (its cosmetic), plain words. null for era 0. */
export function eraUnlock(era: number): string | null {
  const e = Math.floor(Number(era));
  if (!Number.isFinite(e) || e < 1) return null;
  return ERA_UNLOCKS[eraSlot(e)];
}

/** True when `level` is in a later era than the last celebrated level (an era unlock moment). */
export function eraUnlocked(level: number, lastSeenLevel: number | null | undefined): boolean {
  if (lastSeenLevel == null || !Number.isFinite(lastSeenLevel)) return false;
  return eraFor(level) > eraFor(lastSeenLevel);
}

export interface LevelInfo extends SproutLevel {
  /** 0 for levels 1..10, then 1, 2, ... */
  era: number;
  eraName: string | null;
}

/** Points needed to reach level n, for ANY n >= 1. O(1). Strictly increasing. */
export function thresholdFor(level: number): number {
  const n = clampLevel(level);
  if (n <= BASE_LEVELS) return LEVELS[n - 1].threshold;
  return LEVELS[BASE_LEVELS - 1].threshold + ENDLESS_GAP * (n - BASE_LEVELS);
}

/** Name, threshold, art stage, blossoms and era for ANY level >= 1. Deterministic, no digits in names. */
export function levelInfo(level: number): LevelInfo {
  const n = clampLevel(level);
  if (n <= BASE_LEVELS) return { ...LEVELS[n - 1], era: 0, eraName: null };
  const era = eraFor(n);
  const pos = (n - FIRST_ERA_LEVEL) % ERA_SPAN;
  const round = Math.floor((era - 1) / ERA_NAMES.length);
  const name = `${ERA_NAMES[eraSlot(era)]} ${LEVEL_RANKS[pos]}${round > 0 ? ` ${roman(round + 1)}` : ''}`;
  return { level: n, name, threshold: thresholdFor(n), stage: 'tree', blossoms: 5, era, eraName: eraName(era) };
}

export const STAGE_ORDER: SproutStage[] = ['seed', 'sprout', 'sapling', 'tree'];

export const WELCOME_BACK_MS = 7 * 24 * 60 * 60 * 1000;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** YYYY-MM-DD of an instant in Asia/Kolkata (fixed UTC+5:30, no DST). Pure. */
export function istDay(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole-day index of a YYYY-MM-DD key; NaN if malformed. */
function dayIndex(key: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return NaN;
  return Math.floor(Date.parse(`${key}T00:00:00Z`) / DAY_MS);
}

/**
 * Streak and quiet time, from the existing per-day counts only (no new data).
 * An active day is an IST day with >= 1 counted action in any of the four
 * per-day maps. LOCAL display only: never stored in sprout_stats.
 *
 * - daysQuiet: whole IST days since the last active day (0 if active today).
 *   No activity at all => 0 (a brand-new user is neutral, never sad).
 * - streakDays: number of active days in the chain ending at the last active
 *   day, provided that day is today or yesterday. A single missed day between
 *   two active days is a grace day and does not break the chain (it is not
 *   counted); two or more missed days in a row break it. If the last active
 *   day is 2+ days ago the streak is 0.
 */
export function streakInfo(
  counts: SproutCounts | null | undefined,
  now: Date,
): { streakDays: number; daysQuiet: number } {
  const none = { streakDays: 0, daysQuiet: 0 };
  if (!counts) return none;
  const today = dayIndex(istDay(now));
  if (!Number.isFinite(today)) return none;
  const active = new Set<number>();
  const maps = [counts.expensesByDay, counts.settlementsByDay, counts.scansByDay, counts.friendsByDay];
  for (const map of maps) {
    if (!map || typeof map !== 'object') continue;
    for (const key of Object.keys(map)) {
      if (safeCount(map[key]) < 1) continue;
      const d = dayIndex(key);
      if (Number.isFinite(d) && d <= today) active.add(d);
    }
  }
  if (active.size === 0) return none;
  let last = -Infinity;
  for (const d of active) if (d > last) last = d;
  const daysQuiet = today - last;
  if (daysQuiet >= 2) return { streakDays: 0, daysQuiet };
  let streakDays = 1;
  let cur = last;
  for (;;) {
    if (active.has(cur - 1)) cur -= 1;
    else if (active.has(cur - 2)) cur -= 2; // one grace day
    else break;
    streakDays += 1;
  }
  return { streakDays, daysQuiet };
}

/** 0..1 how wilted Sprout looks for a quiet spell. Look only; never touches data. */
export function wiltFor(daysQuiet: number): number {
  const d = Math.floor(Number(daysQuiet));
  if (!Number.isFinite(d) || d < 2) return 0;
  if (d === 2) return 0.35;
  if (d === 3) return 0.55;
  if (d === 4) return 0.75;
  return 0.9;
}

function safeCount(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function cappedDaily(days: DayCounts | undefined, weight: number, cap: number): number {
  if (!days || typeof days !== 'object') return 0;
  let total = 0;
  for (const key of Object.keys(days)) {
    total += Math.min(cap, safeCount(days[key]) * weight);
  }
  return total;
}

export function pointsFrom(counts: SproutCounts): number {
  return (
    cappedDaily(counts.expensesByDay, POINT_WEIGHTS.expense, DAILY_CAPS.expense) +
    cappedDaily(counts.settlementsByDay, POINT_WEIGHTS.settlement, DAILY_CAPS.settlement) +
    cappedDaily(counts.scansByDay, POINT_WEIGHTS.scan, DAILY_CAPS.scan) +
    cappedDaily(counts.friendsByDay, POINT_WEIGHTS.friend, DAILY_CAPS.friend) +
    Math.min(LIFETIME_CAPS.circles, safeCount(counts.circles)) * POINT_WEIGHTS.circle +
    Math.min(LIFETIME_CAPS.squared, safeCount(counts.circlesSquared)) * POINT_WEIGHTS.squared
  );
}

/** Level (1 and up, no ceiling) for a point total. O(1) past the base table. */
export function levelFor(points: number): number {
  const p = safeCount(points);
  const top = LEVELS[BASE_LEVELS - 1].threshold;
  if (p >= top) return BASE_LEVELS + Math.floor((p - top) / ENDLESS_GAP);
  let level = 1;
  for (const l of LEVELS) {
    if (p >= l.threshold) level = l.level;
  }
  return level;
}

export function levelName(level: number): string {
  return levelInfo(level).name;
}

/** Art stage and blossoms for a level (tree with 5 blossoms from level 10 on). */
export function artFor(level: number): { stage: SproutStage; blossoms: number } {
  const l = levelInfo(level);
  return { stage: l.stage, blossoms: l.blossoms };
}

/** 0..1 progress through the current level. Never pinned at 1: every level has a next. */
export function growthIn(points: number): number {
  const p = safeCount(points);
  const level = levelFor(p);
  const lo = thresholdFor(level);
  const hi = thresholdFor(level + 1);
  return Math.min(1, Math.max(0, (p - lo) / (hi - lo)));
}

export interface ToNextLevel {
  nextLevel: number;
  nextName: string;
  remaining: number;
  fraction: number;
}

/** Progress toward the next level. Never null: levels are endless. */
export function toNextLevel(points: number): ToNextLevel {
  const p = safeCount(points);
  const level = levelFor(p);
  const next = levelInfo(level + 1);
  return {
    nextLevel: next.level,
    nextName: next.name,
    remaining: next.threshold - p,
    fraction: growthIn(p),
  };
}

/** The shown level never regresses: the higher of derived and cached. */
export function displayLevel(derived: number, cached: number | null | undefined): number {
  const d = clampLevel(derived);
  if (cached == null || !Number.isFinite(cached)) return d;
  return Math.max(d, clampLevel(cached));
}

/**
 * A friend's level as seen on this device. The server stores level capped at
 * 10 (CHECK 1..10) but points unbounded, so every device derives the same
 * endless level from the points it can read: max(stored level, levelFor(points)).
 */
export function friendLevelFrom(rowLevel: unknown, rowPoints: unknown): number {
  const stored =
    typeof rowLevel === 'number' && Number.isFinite(rowLevel) ? clampLevel(rowLevel) : 1;
  const pts = typeof rowPoints === 'number' ? rowPoints : 0;
  return Math.max(stored, levelFor(pts));
}

// ---- stage wrappers kept so existing callers compile ----

export function stageFor(points: number): SproutStage {
  return artFor(levelFor(points)).stage;
}

export function blossomsFor(points: number): number {
  return artFor(levelFor(points)).blossoms;
}

export function stageRank(stage: SproutStage): number {
  return STAGE_ORDER.indexOf(stage);
}

export function displayStage(
  derived: SproutStage,
  cached: SproutStage | null | undefined,
): SproutStage {
  if (!cached || stageRank(cached) < 0) return derived;
  return stageRank(cached) > stageRank(derived) ? cached : derived;
}

/** Next art stage and points to the first level showing it; null at Tree. */
export function toNextStage(
  points: number,
): { next: SproutStage; remaining: number } | null {
  const p = safeCount(points);
  const cur = stageFor(p);
  const target = LEVELS.find((l) => stageRank(l.stage) > stageRank(cur));
  if (!target) return null;
  return { next: target.stage, remaining: target.threshold - p };
}

export interface MoodInput {
  /** The level being shown (already no-regress adjusted). */
  level: number;
  /** Level last celebrated; null = never recorded (no growing fires). */
  lastSeenLevel: number | null;
  event?: SproutEvent | null;
  scanning?: boolean;
  /** Epoch ms of the previous app open. Unused since 23 Nov (quiet time comes from daysQuiet); kept so callers compile. */
  lastOpenAt?: number | null;
  /** true = the user has open balances, false = none (all settled), undefined = unknown. 'proud' only when false. NEVER yields a negative mood. */
  hasOpenBalances?: boolean;
  /** Whole IST days since the last logged action (streakInfo). Missing, 0 or 1 = no quiet mood. */
  daysQuiet?: number;
  /** One-shot: a logged action just ended a quiet spell. */
  justRevived?: boolean;
  now: Date;
}

/** Local time 22:00 inclusive to 06:00 exclusive. */
export function isSleepyHour(now: Date): boolean {
  const h = now.getHours();
  return h >= 22 || h < 6;
}

export function resolveMood(input: MoodInput): SproutMood {
  const { level, lastSeenLevel, event, scanning, hasOpenBalances, justRevived, now } = input;
  const q = Math.floor(Number(input.daysQuiet));
  const daysQuiet = Number.isFinite(q) && q > 0 ? q : 0;

  if (lastSeenLevel != null && level > lastSeenLevel) return 'growing';

  if (event === 'settled' || event === 'circleSquared' || event === 'expenseLogged') {
    return 'celebrate';
  }

  if (justRevived) return 'revived';

  if (scanning || event === 'scanStarted') return 'curious';

  // Inactivity only. hasOpenBalances and amounts are deliberately not read here.
  if (daysQuiet >= 5) return 'grumpy';
  if (daysQuiet >= 3) return 'sad';
  if (daysQuiet === 2) return 'droopy';

  if (hasOpenBalances === false) return 'proud';

  if (isSleepyHour(now)) return 'sleepy';

  return 'idle';
}
