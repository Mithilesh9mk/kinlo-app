/**
 * Sprout growth model — lib/sprout/model.ts (plan section 2a)
 *
 * Run with: npx tsx --test tests/sprout-model.test.ts
 * No test framework, same reasoning as tests/recurrence.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_COUNTS,
  LEVELS,
  WELCOME_BACK_MS,
  artFor,
  blossomsFor,
  displayLevel,
  growthIn,
  istDay,
  levelFor,
  levelName,
  pointsFrom,
  resolveMood,
  stageFor,
  toNextLevel,
  toNextStage,
  type MoodInput,
  type SproutCounts,
  type SproutMood,
} from '../lib/sprout/model';

const NOON = new Date(2026, 10, 23, 12, 0, 0);
const at = (h: number, m = 0) => new Date(2026, 10, 23, h, m, 0);
const base: MoodInput = {
  level: 5,
  lastSeenLevel: 5,
  lastOpenAt: NOON.getTime() - 1000,
  now: NOON,
};

const counts = (o: Partial<SproutCounts>): SproutCounts => ({ ...EMPTY_COUNTS, ...o });
const D = '2026-11-23';

// ---- points & caps ----

test('pointsFrom weights (one of each, spread over days)', () => {
  assert.equal(pointsFrom(EMPTY_COUNTS), 0);
  assert.equal(
    pointsFrom({
      expensesByDay: { a: 1 },
      settlementsByDay: { a: 1 },
      scansByDay: { a: 1 },
      friendsByDay: { a: 1 },
      circles: 1,
      circlesSquared: 1,
    }),
    1 + 2 + 1 + 2 + 2 + 3,
  );
});

test('expenses: 5 points per day, 6th gives 0, new day counts again', () => {
  assert.equal(pointsFrom(counts({ expensesByDay: { [D]: 5 } })), 5);
  assert.equal(pointsFrom(counts({ expensesByDay: { [D]: 6 } })), 5);
  assert.equal(pointsFrom(counts({ expensesByDay: { [D]: 50 } })), 5);
  assert.equal(pointsFrom(counts({ expensesByDay: { [D]: 6, '2026-11-24': 2 } })), 7);
});

test('settlements: 6 points per day (3 settlements)', () => {
  assert.equal(pointsFrom(counts({ settlementsByDay: { [D]: 3 } })), 6);
  assert.equal(pointsFrom(counts({ settlementsByDay: { [D]: 4 } })), 6);
  assert.equal(pointsFrom(counts({ settlementsByDay: { [D]: 2 } })), 4);
});

test('scans: 3 points per day', () => {
  assert.equal(pointsFrom(counts({ scansByDay: { [D]: 3 } })), 3);
  assert.equal(pointsFrom(counts({ scansByDay: { [D]: 9 } })), 3);
});

test('friends: 6 points per day (3 friends)', () => {
  assert.equal(pointsFrom(counts({ friendsByDay: { [D]: 3 } })), 6);
  assert.equal(pointsFrom(counts({ friendsByDay: { [D]: 10 } })), 6);
});

test('circles lifetime cap: 5 counted at 2 points', () => {
  assert.equal(pointsFrom(counts({ circles: 5 })), 10);
  assert.equal(pointsFrom(counts({ circles: 9 })), 10);
});

test('circles squared lifetime cap: 5 counted at 3 points', () => {
  assert.equal(pointsFrom(counts({ circlesSquared: 5 })), 15);
  assert.equal(pointsFrom(counts({ circlesSquared: 20 })), 15);
});

test('a one-day maximum (circles and squared aside) is 20 points', () => {
  const day = counts({
    expensesByDay: { [D]: 99 },
    settlementsByDay: { [D]: 99 },
    scansByDay: { [D]: 99 },
    friendsByDay: { [D]: 99 },
  });
  assert.equal(pointsFrom(day), 20);
  assert.equal(levelFor(20), 5);
});

test('garbage input never yields negative or NaN points', () => {
  const bad = counts({
    expensesByDay: { a: -3, b: Number.NaN, c: Infinity },
    circles: -1,
    circlesSquared: Number.NaN,
  });
  assert.equal(pointsFrom(bad), 0);
});

// ---- levels ----

test('LEVELS table matches plan 2a', () => {
  assert.deepEqual(
    LEVELS.map((l) => [l.threshold, l.name, l.stage, l.blossoms]),
    [
      [0, 'Seed', 'seed', 0],
      [3, 'Sprout', 'sprout', 0],
      [6, 'Seedling', 'sprout', 0],
      [10, 'Shoot', 'sapling', 0],
      [15, 'Sapling', 'sapling', 0],
      [22, 'Young tree', 'sapling', 0],
      [32, 'Tree', 'tree', 0],
      [45, 'Blooming tree', 'tree', 2],
      [62, 'Grand tree', 'tree', 4],
      [85, 'Ancient tree', 'tree', 5],
    ],
  );
});

test('level boundaries at every threshold', () => {
  const cases: [number, number][] = [
    [0, 1], [2, 1], [3, 2], [5, 2], [6, 3], [9, 3], [10, 4], [14, 4],
    [15, 5], [21, 5], [22, 6], [31, 6], [32, 7], [44, 7], [45, 8],
    [61, 8], [62, 9], [84, 9], [85, 10], [500, 10],
  ];
  for (const [p, l] of cases) assert.equal(levelFor(p), l, `${p} points`);
});

test('pacing targets (worst case all 1-point actions)', () => {
  assert.ok(levelFor(3) >= 2, 'level 2 within 3 actions');
  assert.ok(levelFor(8) >= 3, 'level 3 within 8 actions');
  assert.ok(levelFor(15) >= 4, 'level 4 within 15 actions');
  // actual pacing is tighter: 3 / 6 / 10
  assert.equal(levelFor(2), 1);
  assert.equal(levelFor(3), 2);
  assert.equal(levelFor(6), 3);
  assert.equal(levelFor(10), 4);
});

test('levelName and artFor', () => {
  assert.equal(levelName(1), 'Seed');
  assert.equal(levelName(10), 'Ancient tree');
  assert.deepEqual(artFor(1), { stage: 'seed', blossoms: 0 });
  assert.deepEqual(artFor(3), { stage: 'sprout', blossoms: 0 });
  assert.deepEqual(artFor(6), { stage: 'sapling', blossoms: 0 });
  assert.deepEqual(artFor(7), { stage: 'tree', blossoms: 0 });
  assert.deepEqual(artFor(8), { stage: 'tree', blossoms: 2 });
  assert.deepEqual(artFor(10), { stage: 'tree', blossoms: 5 });
  // out-of-range clamps rather than throwing
  assert.deepEqual(artFor(99), artFor(10));
  assert.deepEqual(artFor(-4), artFor(1));
});

test('growthIn is 0..1, monotonic within a level, resets at each level', () => {
  let prev = -1;
  let prevLevel = 1;
  for (let p = 0; p <= 120; p++) {
    const g = growthIn(p);
    const l = levelFor(p);
    assert.ok(g >= 0 && g <= 1, `${p}: ${g}`);
    if (l === prevLevel) assert.ok(g >= prev, `monotonic at ${p}`);
    else if (l < 10) assert.equal(g, 0, `reset at ${p}`);
    prev = g;
    prevLevel = l;
  }
  assert.equal(growthIn(0), 0);
  assert.equal(growthIn(1), 1 / 3);
  assert.equal(growthIn(84), 1 - 1 / 23);
  assert.equal(growthIn(85), 1);
  assert.equal(growthIn(1000), 1);
});

test('toNextLevel', () => {
  assert.deepEqual(toNextLevel(0), { nextLevel: 2, nextName: 'Sprout', remaining: 3, fraction: 0 });
  const t = toNextLevel(8)!;
  assert.equal(t.nextLevel, 4);
  assert.equal(t.nextName, 'Shoot');
  assert.equal(t.remaining, 2);
  assert.equal(t.fraction, 0.5);
  assert.equal(toNextLevel(84)!.remaining, 1);
  assert.equal(toNextLevel(85), null);
  assert.equal(toNextLevel(900), null);
});

test('displayLevel never regresses', () => {
  assert.equal(displayLevel(3, 5), 5);
  assert.equal(displayLevel(5, 3), 5);
  assert.equal(displayLevel(4, 4), 4);
  assert.equal(displayLevel(2, null), 2);
  assert.equal(displayLevel(2, undefined), 2);
  assert.equal(displayLevel(1, 10), 10);
  assert.equal(displayLevel(99, null), 10);
});

test('stage and blossom wrappers follow the level logic', () => {
  assert.equal(stageFor(0), 'seed');
  assert.equal(stageFor(3), 'sprout');
  assert.equal(stageFor(9), 'sprout');
  assert.equal(stageFor(10), 'sapling');
  assert.equal(stageFor(31), 'sapling');
  assert.equal(stageFor(32), 'tree');
  assert.equal(blossomsFor(44), 0);
  assert.equal(blossomsFor(45), 2);
  assert.equal(blossomsFor(62), 4);
  assert.equal(blossomsFor(85), 5);
  assert.deepEqual(toNextStage(0), { next: 'sprout', remaining: 3 });
  assert.deepEqual(toNextStage(6), { next: 'sapling', remaining: 4 });
  assert.deepEqual(toNextStage(22), { next: 'tree', remaining: 10 });
  assert.equal(toNextStage(32), null);
});

// ---- istDay ----

test('istDay boundary is 18:30 UTC', () => {
  assert.equal(istDay(new Date('2026-11-22T18:29:59Z')), '2026-11-22');
  assert.equal(istDay(new Date('2026-11-22T18:30:00Z')), '2026-11-23');
  assert.equal(istDay(new Date('2026-12-31T18:30:00Z')), '2027-01-01');
  assert.equal(istDay(new Date('2026-11-23T00:00:00Z')), '2026-11-23');
});

// ---- mood ----

test('growing fires when level rose past the last celebrated one', () => {
  assert.equal(resolveMood({ ...base, level: 6, lastSeenLevel: 5 }), 'growing');
});

test('growing does not fire for first run (lastSeenLevel null) or same level', () => {
  assert.notEqual(resolveMood({ ...base, level: 6, lastSeenLevel: null }), 'growing');
  assert.notEqual(resolveMood({ ...base, level: 5, lastSeenLevel: 5 }), 'growing');
});

test('mood priority: growing > celebrate > curious > welcomeBack > proud > sleepy', () => {
  const stale = NOON.getTime() - WELCOME_BACK_MS - 1;
  const full: MoodInput = {
    level: 6,
    lastSeenLevel: 5,
    event: 'settled',
    scanning: true,
    lastOpenAt: stale,
    hasOpenBalances: false,
    now: at(23),
  };
  assert.equal(resolveMood(full), 'growing');
  assert.equal(resolveMood({ ...full, level: 5 }), 'celebrate');
  assert.equal(resolveMood({ ...full, level: 5, event: null }), 'curious');
  assert.equal(resolveMood({ ...full, level: 5, event: null, scanning: false }), 'welcomeBack');
  assert.equal(
    resolveMood({ ...full, level: 5, event: null, scanning: false, lastOpenAt: NOON.getTime() }),
    'proud',
  );
  assert.equal(
    resolveMood({
      ...full, level: 5, event: null, scanning: false, lastOpenAt: at(22).getTime(), hasOpenBalances: true,
    }),
    'sleepy',
  );
});

test('celebrate events and scanStarted', () => {
  for (const event of ['settled', 'circleSquared', 'expenseLogged'] as const) {
    assert.equal(resolveMood({ ...base, event }), 'celebrate');
  }
  assert.equal(resolveMood({ ...base, event: 'scanStarted' }), 'curious');
  assert.equal(resolveMood({ ...base, scanning: true }), 'curious');
});

test('sleepy 22:00 to 06:00 only, idle otherwise', () => {
  assert.equal(resolveMood({ ...base, now: at(21, 59) }), 'idle');
  assert.equal(resolveMood({ ...base, now: at(22) }), 'sleepy');
  assert.equal(resolveMood({ ...base, now: at(5, 59) }), 'sleepy');
  assert.equal(resolveMood({ ...base, now: at(6) }), 'idle');
});

test('welcomeBack after more than 7 days away, not at exactly 7', () => {
  assert.equal(resolveMood({ ...base, lastOpenAt: NOON.getTime() - WELCOME_BACK_MS }), 'idle');
  assert.equal(
    resolveMood({ ...base, lastOpenAt: NOON.getTime() - WELCOME_BACK_MS - 1 }),
    'welcomeBack',
  );
  assert.equal(resolveMood({ ...base, lastOpenAt: null }), 'idle');
});

test('proud only when explicitly no open balances', () => {
  assert.equal(resolveMood({ ...base, hasOpenBalances: false }), 'proud');
  assert.equal(resolveMood({ ...base, hasOpenBalances: true }), 'idle');
  assert.equal(resolveMood({ ...base, hasOpenBalances: undefined }), 'idle');
});

test('never a negative mood for any input combination', () => {
  const allowed: SproutMood[] = [
    'idle', 'celebrate', 'curious', 'proud', 'welcomeBack', 'sleepy', 'growing',
  ];
  const events = [null, 'settled', 'circleSquared', 'expenseLogged', 'friendAdded', 'circleJoined', 'scanStarted', 'scanFinished', 'appOpened'] as const;
  for (const level of [1, 5, 10])
    for (const lastSeenLevel of [null, 1, 10])
      for (const event of events)
        for (const scanning of [true, false])
          for (const hasOpenBalances of [true, false, undefined])
            for (const lastOpenAt of [null, 0, NOON.getTime()])
              for (const h of [3, 12, 23]) {
                const m = resolveMood({
                  level, lastSeenLevel, event, scanning, hasOpenBalances, lastOpenAt, now: at(h),
                });
                assert.ok(allowed.includes(m), m);
              }
});
