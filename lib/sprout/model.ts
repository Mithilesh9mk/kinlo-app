/**
 * Sprout growth model — pure logic, no React Native / Supabase imports so it
 * can be unit-tested with `npx tsx --test tests/sprout-model.test.ts`.
 * See docs/CHARACTER_PLAN.md sections 2 and 3.
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

export interface SproutCounts {
  expenses: number;
  settlements: number;
  friends: number;
  circles: number;
  scans: number;
  circlesSquared: number;
}

export const EMPTY_COUNTS: SproutCounts = {
  expenses: 0,
  settlements: 0,
  friends: 0,
  circles: 0,
  scans: 0,
  circlesSquared: 0,
};

export const POINT_WEIGHTS: Record<keyof SproutCounts, number> = {
  expenses: 1,
  settlements: 2,
  friends: 2,
  circles: 2,
  scans: 1,
  circlesSquared: 3,
};

/** Minimum points to be in each stage. */
export const STAGE_THRESHOLDS: Record<SproutStage, number> = {
  seed: 0,
  sprout: 5,
  sapling: 25,
  tree: 80,
};

export const STAGE_ORDER: SproutStage[] = ['seed', 'sprout', 'sapling', 'tree'];

export const BLOSSOM_EVERY = 40;
export const BLOSSOM_MAX = 5;

export const WELCOME_BACK_MS = 7 * 24 * 60 * 60 * 1000;

function safeCount(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function pointsFrom(counts: SproutCounts): number {
  let total = 0;
  for (const key of Object.keys(POINT_WEIGHTS) as (keyof SproutCounts)[]) {
    total += safeCount(counts[key]) * POINT_WEIGHTS[key];
  }
  return total;
}

export function stageFor(points: number): SproutStage {
  const p = safeCount(points);
  let stage: SproutStage = 'seed';
  for (const s of STAGE_ORDER) {
    if (p >= STAGE_THRESHOLDS[s]) stage = s;
  }
  return stage;
}

/** One terracotta blossom per BLOSSOM_EVERY points past Tree, capped. */
export function blossomsFor(points: number): number {
  const over = safeCount(points) - STAGE_THRESHOLDS.tree;
  if (over < 0) return 0;
  return Math.min(BLOSSOM_MAX, Math.floor(over / BLOSSOM_EVERY));
}

/** Next stage and points remaining; null once at Tree. */
export function toNextStage(
  points: number,
): { next: SproutStage; remaining: number } | null {
  const p = safeCount(points);
  const idx = STAGE_ORDER.indexOf(stageFor(p));
  if (idx >= STAGE_ORDER.length - 1) return null;
  const next = STAGE_ORDER[idx + 1];
  return { next, remaining: STAGE_THRESHOLDS[next] - p };
}

export function stageRank(stage: SproutStage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** The shown stage never regresses: the higher of derived and cached. */
export function displayStage(
  derived: SproutStage,
  cached: SproutStage | null | undefined,
): SproutStage {
  if (!cached || stageRank(cached) < 0) return derived;
  return stageRank(cached) > stageRank(derived) ? cached : derived;
}

export interface MoodInput {
  /** The stage being shown (already no-regress adjusted). */
  stage: SproutStage;
  /** Stage last celebrated; null = never recorded (no growing fires). */
  lastSeenStage: SproutStage | null;
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
  const { stage, lastSeenStage, event, scanning, lastOpenAt, hasOpenBalances, now } = input;

  if (lastSeenStage && stageRank(stage) > stageRank(lastSeenStage)) return 'growing';

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
