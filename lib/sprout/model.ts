/**
 * Sprout growth model — pure logic, no React Native / Supabase imports so it
 * can be unit-tested with `npx tsx --test tests/sprout-model.test.ts`.
 * See docs/CHARACTER_PLAN.md sections 2 and 2a (2a is the live curve).
 */

export type SproutStage = 'seed' | 'sprout' | 'sapling' | 'tree';

/**
 * Deliberately NO negative mood (sad, worried, lonely...). Owing money,
 * overspending or inactivity must never map to a mood, and this union is the
 * guarantee: resolveMood can only return a member of it, so it is impossible
 * for any input to produce a negative one. Do not add one.
 */
export type SproutMood =
  | 'idle'
  | 'celebrate'
  | 'curious'
  | 'proud'
  | 'welcomeBack'
  | 'sleepy'
  | 'growing';

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

export const MAX_LEVEL = LEVELS.length;

export const STAGE_ORDER: SproutStage[] = ['seed', 'sprout', 'sapling', 'tree'];

export const WELCOME_BACK_MS = 7 * 24 * 60 * 60 * 1000;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** YYYY-MM-DD of an instant in Asia/Kolkata (fixed UTC+5:30, no DST). Pure. */
export function istDay(date: Date): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
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

/** Level 1..10 for a point total. */
export function levelFor(points: number): number {
  const p = safeCount(points);
  let level = 1;
  for (const l of LEVELS) {
    if (p >= l.threshold) level = l.level;
  }
  return level;
}

function clampLevel(level: number): number {
  const n = Math.floor(Number(level));
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_LEVEL, Math.max(1, n));
}

export function levelName(level: number): string {
  return LEVELS[clampLevel(level) - 1].name;
}

/** Art stage and blossoms for a level. */
export function artFor(level: number): { stage: SproutStage; blossoms: number } {
  const l = LEVELS[clampLevel(level) - 1];
  return { stage: l.stage, blossoms: l.blossoms };
}

/** 0..1 progress through the current level; 1 at the top level. */
export function growthIn(points: number): number {
  const p = safeCount(points);
  const level = levelFor(p);
  if (level >= MAX_LEVEL) return 1;
  const lo = LEVELS[level - 1].threshold;
  const hi = LEVELS[level].threshold;
  return Math.min(1, Math.max(0, (p - lo) / (hi - lo)));
}

export interface ToNextLevel {
  nextLevel: number;
  nextName: string;
  remaining: number;
  fraction: number;
}

/** Progress toward the next level; null at the top. */
export function toNextLevel(points: number): ToNextLevel | null {
  const p = safeCount(points);
  const level = levelFor(p);
  if (level >= MAX_LEVEL) return null;
  const next = LEVELS[level];
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
  /** Epoch ms of the previous app open; null = unknown / first run. */
  lastOpenAt: number | null;
  /** true = the user has open balances, false = none (all settled), undefined = unknown. 'proud' only when false. */
  hasOpenBalances?: boolean;
  now: Date;
}

/** Local time 22:00 inclusive to 06:00 exclusive. */
export function isSleepyHour(now: Date): boolean {
  const h = now.getHours();
  return h >= 22 || h < 6;
}

export function resolveMood(input: MoodInput): SproutMood {
  const { level, lastSeenLevel, event, scanning, lastOpenAt, hasOpenBalances, now } = input;

  if (lastSeenLevel != null && level > lastSeenLevel) return 'growing';

  if (event === 'settled' || event === 'circleSquared' || event === 'expenseLogged') {
    return 'celebrate';
  }

  if (scanning || event === 'scanStarted') return 'curious';

  if (lastOpenAt != null && now.getTime() - lastOpenAt > WELCOME_BACK_MS) {
    return 'welcomeBack';
  }

  if (hasOpenBalances === false) return 'proud';

  if (isSleepyHour(now)) return 'sleepy';

  return 'idle';
}
