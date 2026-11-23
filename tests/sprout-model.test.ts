/**
 * Sprout growth model — lib/sprout/model.ts (plan section 2a)
 *
 * Run with: npx tsx --test tests/sprout-model.test.ts
 * No test framework, same reasoning as tests/recurrence.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ENDLESS_GAP,
  EMPTY_COUNTS,
  ERA_NAMES,
  LEVELS,
  artFor,
  blossomsFor,
  displayLevel,
  eraFor,
  eraName,
  eraStartLevel,
  eraUnlocked,
  friendLevelFrom,
  growthIn,
  istDay,
  levelFor,
  levelInfo,
  levelName,
  pointsFrom,
  resolveMood,
  QUIET_MOODS,
  stageFor,
  streakInfo,
  thresholdFor,
  toNextLevel,
  toNextStage,
  wiltFor,
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
    [61, 8], [62, 9], [84, 9], [85, 10], [107, 10], [108, 11], [130, 11], [131, 12],
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
  // past the base table the art stays a fully blossoming tree (the eras add cosmetics instead)
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
    else assert.equal(g, 0, `reset at ${p}`);
    prev = g;
    prevLevel = l;
  }
  assert.equal(growthIn(0), 0);
  assert.equal(growthIn(1), 1 / 3);
  assert.equal(growthIn(84), 1 - 1 / 23);
  // no top level: growth restarts at 85 and keeps cycling, never pinned at 1
  assert.equal(growthIn(85), 0);
  assert.equal(growthIn(107), 22 / 23);
  assert.equal(growthIn(108), 0);
  assert.ok(growthIn(1000) < 1);
});

test('toNextLevel', () => {
  assert.deepEqual(toNextLevel(0), { nextLevel: 2, nextName: 'Sprout', remaining: 3, fraction: 0 });
  const t = toNextLevel(8)!;
  assert.equal(t.nextLevel, 4);
  assert.equal(t.nextName, 'Shoot');
  assert.equal(t.remaining, 2);
  assert.equal(t.fraction, 0.5);
  assert.equal(toNextLevel(84)!.remaining, 1);
  // never null: levels are endless
  assert.deepEqual(toNextLevel(85), { nextLevel: 11, nextName: levelName(11), remaining: 23, fraction: 0 });
  assert.equal(toNextLevel(900).remaining > 0, true);
});

test('displayLevel never regresses', () => {
  assert.equal(displayLevel(3, 5), 5);
  assert.equal(displayLevel(5, 3), 5);
  assert.equal(displayLevel(4, 4), 4);
  assert.equal(displayLevel(2, null), 2);
  assert.equal(displayLevel(2, undefined), 2);
  assert.equal(displayLevel(1, 10), 10);
  assert.equal(displayLevel(99, null), 99);
  assert.equal(displayLevel(1, 40), 40);
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

test('proud only when explicitly no open balances', () => {
  assert.equal(resolveMood({ ...base, hasOpenBalances: false }), 'proud');
  assert.equal(resolveMood({ ...base, hasOpenBalances: true }), 'idle');
  assert.equal(resolveMood({ ...base, hasOpenBalances: undefined }), 'idle');
});

// ---- streak & quiet days (23 Nov: inactivity-driven mood) ----

/** A counts object with one expense on each given IST day. */
const active = (...days: string[]): SproutCounts =>
  counts({ expensesByDay: Object.fromEntries(days.map((d) => [d, 1])) });
const dayAt = (d: string, hhmm = '12:00') => new Date(`${d}T${hhmm}:00+05:30`);
const NOW = dayAt('2026-11-23'); // noon IST on the 23rd

test('streakInfo: brand-new user is neutral (no activity at all)', () => {
  assert.deepEqual(streakInfo(EMPTY_COUNTS, NOW), { streakDays: 0, daysQuiet: 0 });
  assert.deepEqual(streakInfo(null, NOW), { streakDays: 0, daysQuiet: 0 });
  assert.deepEqual(streakInfo(undefined, NOW), { streakDays: 0, daysQuiet: 0 });
  assert.equal(resolveMood({ ...base, daysQuiet: streakInfo(EMPTY_COUNTS, NOW).daysQuiet }), 'idle');
});

test('streakInfo: consecutive days ending today or yesterday', () => {
  assert.deepEqual(streakInfo(active('2026-11-23'), NOW), { streakDays: 1, daysQuiet: 0 });
  assert.deepEqual(streakInfo(active('2026-11-21', '2026-11-22', '2026-11-23'), NOW), { streakDays: 3, daysQuiet: 0 });
  // yesterday is the last active day: streak still alive, daysQuiet 1
  assert.deepEqual(streakInfo(active('2026-11-21', '2026-11-22'), NOW), { streakDays: 2, daysQuiet: 1 });
});

test('streakInfo: one grace day does not break the streak, two missed days do', () => {
  // 20, 21, (22 missed), 23 -> grace day, 3 active days
  assert.deepEqual(streakInfo(active('2026-11-20', '2026-11-21', '2026-11-23'), NOW), { streakDays: 3, daysQuiet: 0 });
  // yesterday and today both missed: last active is 2 days ago -> broken
  assert.deepEqual(streakInfo(active('2026-11-20', '2026-11-21'), NOW), { streakDays: 0, daysQuiet: 2 });
  // two missed days in a row inside the chain: 18, 19, (20, 21 missed), 22, 23
  assert.deepEqual(streakInfo(active('2026-11-18', '2026-11-19', '2026-11-22', '2026-11-23'), NOW), {
    streakDays: 2,
    daysQuiet: 0,
  });
  // a grace day may repeat in the chain: 17, 19, 21, 23
  assert.equal(streakInfo(active('2026-11-17', '2026-11-19', '2026-11-21', '2026-11-23'), NOW).streakDays, 4);
  // grace day between yesterday and the day before, today not logged yet: 20, (21 missed), 22
  assert.deepEqual(streakInfo(active('2026-11-20', '2026-11-22'), NOW), { streakDays: 2, daysQuiet: 1 });
});

test('streakInfo: counts any of the four per-day maps, ignores zero / junk / future keys', () => {
  const c = counts({
    expensesByDay: { '2026-11-23': 0, 'bad-key': 5 },
    settlementsByDay: { '2026-11-22': 1 },
    scansByDay: { '2026-11-21': 2 },
    friendsByDay: { '2026-12-31': 9 },
  });
  assert.deepEqual(streakInfo(c, NOW), { streakDays: 2, daysQuiet: 1 });
});

test('streakInfo: IST midnight boundary', () => {
  const c = active('2026-11-22');
  // 23:59 IST on the 22nd (18:29 UTC): active today
  assert.deepEqual(streakInfo(c, new Date('2026-11-22T18:29:00Z')), { streakDays: 1, daysQuiet: 0 });
  // 00:01 IST on the 23rd (18:31 UTC): a new IST day, one quiet day
  assert.deepEqual(streakInfo(c, new Date('2026-11-22T18:31:00Z')), { streakDays: 1, daysQuiet: 1 });
});

test('quiet ladder: 0,1 -> idle, 2 -> droopy, 3-4 -> sad, 5+ -> grumpy', () => {
  const m = (daysQuiet: number) => resolveMood({ ...base, daysQuiet });
  assert.equal(m(0), 'idle');
  assert.equal(m(1), 'idle');
  assert.equal(m(2), 'droopy');
  assert.equal(m(3), 'sad');
  assert.equal(m(4), 'sad');
  assert.equal(m(5), 'grumpy');
  assert.equal(m(40), 'grumpy');
  // and end to end from the counts
  const mood = (last: string) => resolveMood({ ...base, daysQuiet: streakInfo(active(last), NOW).daysQuiet });
  assert.equal(mood('2026-11-22'), 'idle');
  assert.equal(mood('2026-11-21'), 'droopy');
  assert.equal(mood('2026-11-20'), 'sad');
  assert.equal(mood('2026-11-19'), 'sad');
  assert.equal(mood('2026-11-18'), 'grumpy');
});

test('revive: a logged action ends a quiet spell (one-shot, then back to idle)', () => {
  const quiet = streakInfo(active('2026-11-17'), NOW);
  assert.equal(quiet.daysQuiet, 6);
  assert.equal(resolveMood({ ...base, daysQuiet: quiet.daysQuiet }), 'grumpy');
  // action logged today: justRevived fires once, daysQuiet is now 0
  const after = streakInfo(active('2026-11-17', '2026-11-23'), NOW);
  assert.equal(after.daysQuiet, 0);
  assert.equal(resolveMood({ ...base, daysQuiet: after.daysQuiet, justRevived: true }), 'revived');
  assert.equal(resolveMood({ ...base, daysQuiet: after.daysQuiet, justRevived: false }), 'idle');
});

test('mood priority: growing > celebrate > revived > curious > grumpy/sad/droopy > proud > sleepy > idle', () => {
  const full: MoodInput = {
    level: 6,
    lastSeenLevel: 5,
    event: 'settled',
    scanning: true,
    justRevived: true,
    daysQuiet: 6,
    hasOpenBalances: false,
    now: at(23),
  };
  const calm = { ...full, level: 5, event: null, justRevived: false, scanning: false };
  assert.equal(resolveMood(full), 'growing');
  assert.equal(resolveMood({ ...full, level: 5 }), 'celebrate');
  assert.equal(resolveMood({ ...full, level: 5, event: null }), 'revived');
  assert.equal(resolveMood({ ...full, level: 5, event: null, justRevived: false }), 'curious');
  assert.equal(resolveMood(calm), 'grumpy');
  assert.equal(resolveMood({ ...calm, daysQuiet: 4 }), 'sad');
  assert.equal(resolveMood({ ...calm, daysQuiet: 2 }), 'droopy');
  assert.equal(resolveMood({ ...calm, daysQuiet: 0 }), 'proud');
  assert.equal(resolveMood({ ...calm, daysQuiet: 0, hasOpenBalances: true }), 'sleepy');
  assert.equal(resolveMood({ ...calm, daysQuiet: 0, hasOpenBalances: true, now: at(12) }), 'idle');
});

test('resolveMood no longer returns welcomeBack (quiet time is from the last log, not app open)', () => {
  assert.equal(resolveMood({ ...base, lastOpenAt: 0 }), 'idle');
});

test('wiltFor: 0 until 2 quiet days, then grows, always within 0..1', () => {
  assert.equal(wiltFor(0), 0);
  assert.equal(wiltFor(1), 0);
  assert.equal(wiltFor(NaN), 0);
  assert.ok(wiltFor(2) > 0 && wiltFor(2) < wiltFor(3) && wiltFor(3) < wiltFor(4) && wiltFor(4) < wiltFor(5));
  assert.ok(wiltFor(999) <= 1);
});

test('money can never move a neutral user to a negative mood', () => {
  const events = [null, 'friendAdded', 'circleJoined', 'scanFinished', 'appOpened'] as const;
  for (const level of [1, 5, 10])
    for (const lastSeenLevel of [null, level])
      for (const event of events)
        for (const hasOpenBalances of [true, false, undefined])
          for (const lastOpenAt of [null, 0, NOON.getTime()])
            for (const daysQuiet of [0, 1, undefined])
              for (const h of [3, 12, 23]) {
                const m = resolveMood({
                  level, lastSeenLevel, event, scanning: false, hasOpenBalances, lastOpenAt, daysQuiet, now: at(h),
                });
                assert.ok(!QUIET_MOODS.includes(m), `${m} from balances alone`);
              }
});

test('negative moods occur only with daysQuiet >= 2, whatever else is set', () => {
  const events = [null, 'settled', 'circleSquared', 'expenseLogged', 'friendAdded', 'scanStarted', 'appOpened'] as const;
  for (const level of [1, 5, 10])
    for (const lastSeenLevel of [null, 1, 10])
      for (const event of events)
        for (const scanning of [true, false])
          for (const justRevived of [true, false])
            for (const hasOpenBalances of [true, false, undefined])
              for (const daysQuiet of [undefined, -3, NaN, 0, 1, 2, 3, 4, 5, 9])
                for (const h of [3, 12, 23]) {
                  const m = resolveMood({
                    level, lastSeenLevel, event, scanning, justRevived, hasOpenBalances, daysQuiet, now: at(h),
                  });
                  if (QUIET_MOODS.includes(m)) {
                    assert.ok(typeof daysQuiet === 'number' && daysQuiet >= 2, `${m} with daysQuiet ${daysQuiet}`);
                  }
                }
});

// ---- endless levels and eras ----

test('85 to 86 and beyond: level 10 holds, then the formula takes over', () => {
  assert.equal(levelFor(85), 10);
  assert.equal(levelFor(86), 10);
  assert.equal(levelFor(107), 10);
  assert.equal(levelFor(108), 11);
  assert.equal(levelFor(127), 11); // the owner's current total
  assert.equal(levelFor(131), 12);
  assert.equal(levelInfo(11).stage, 'tree');
});

test('thresholds strictly increase and no gap past level 10 exceeds the last base gap', () => {
  const baseGaps = LEVELS.slice(1).map((l, i) => l.threshold - LEVELS[i].threshold);
  const lastBaseGap = baseGaps[baseGaps.length - 1];
  assert.equal(lastBaseGap, 23);
  assert.ok(ENDLESS_GAP <= lastBaseGap && ENDLESS_GAP >= 1);
  assert.equal(thresholdFor(10), 85);
  let prev = thresholdFor(1);
  for (let n = 2; n <= 5000; n++) {
    const t = thresholdFor(n);
    assert.ok(t > prev, `strictly increasing at ${n}`);
    if (n > 10) assert.ok(t - prev <= lastBaseGap, `gap at ${n}`);
    prev = t;
  }
  // thresholdFor and levelFor agree on every boundary
  for (let n = 1; n <= 3000; n++) {
    assert.equal(levelFor(thresholdFor(n)), n);
    if (n > 1) assert.equal(levelFor(thresholdFor(n) - 1), n - 1);
  }
});

test('huge point totals are fast and sane (levelFor is O(1))', () => {
  const t0 = Date.now();
  for (let i = 0; i < 100000; i++) levelFor(10_000_000 + i);
  assert.ok(Date.now() - t0 < 500, 'bounded work for large totals');
  const l = levelFor(1e7);
  assert.equal(l, 10 + Math.floor((1e7 - 85) / ENDLESS_GAP));
  assert.ok(thresholdFor(l) <= 1e7 && thresholdFor(l + 1) > 1e7);
  const g = growthIn(1e7);
  assert.ok(g >= 0 && g < 1);
  assert.ok(toNextLevel(1e7).remaining > 0);
  assert.ok(levelName(l).length > 0);
});

test('names are deterministic, unique per level in a long run, and never contain digits', () => {
  const seen = new Set<string>();
  for (let n = 1; n <= 600; n++) {
    const a = levelInfo(n);
    assert.equal(a.name, levelInfo(n).name);
    assert.equal(/\d/.test(a.name), false, `digit in "${a.name}"`);
    assert.equal(a.eraName == null || !/\d/.test(a.eraName), true);
    assert.ok(a.blossoms <= 5);
    assert.ok(!seen.has(a.name), `duplicate name "${a.name}" at ${n}`);
    seen.add(a.name);
  }
  assert.equal(levelName(11), 'Fruiting tree');
  assert.equal(levelName(36), 'Fruiting tree II');
  assert.equal(levelName(1e9).length > 0, true);
});

test('eras: every five levels past ten, five names, then the set cycles with a numeral', () => {
  assert.equal(eraFor(10), 0);
  assert.equal(eraFor(11), 1);
  assert.equal(eraFor(15), 1);
  assert.equal(eraFor(16), 2);
  assert.equal(eraStartLevel(1), 11);
  assert.equal(eraStartLevel(2), 16);
  assert.deepEqual([1, 2, 3, 4, 5].map((e) => eraName(e)), [...ERA_NAMES]);
  assert.equal(eraName(6), 'Fruiting II');
  assert.equal(eraName(11), 'Fruiting III');
  assert.equal(eraName(0), null);
  assert.equal(levelInfo(10).era, 0);
  assert.equal(levelInfo(11).eraName, 'Fruiting');
  assert.equal(eraUnlocked(11, 10), true);
  assert.equal(eraUnlocked(12, 11), false);
  assert.equal(eraUnlocked(16, 12), true);
  assert.equal(eraUnlocked(11, null), false);
});

test('friend-derived level equals the local derived level for the same points', () => {
  for (const p of [0, 3, 84, 85, 107, 108, 127, 500, 12345, 1e7]) {
    // the server stores level capped at 10 and points unbounded
    const serverLevel = Math.min(10, levelFor(p));
    assert.equal(friendLevelFrom(serverLevel, p), displayLevel(levelFor(p), null), `${p} points`);
  }
  assert.equal(friendLevelFrom(undefined, 200), levelFor(200));
  assert.equal(friendLevelFrom(10, undefined), 10);
  assert.equal(friendLevelFrom('x', 'y'), 1);
});

test('displayLevel never decreases as points or the cache grow', () => {
  let prev = 0;
  for (let p = 0; p <= 5000; p += 7) {
    const d = displayLevel(levelFor(p), null);
    assert.ok(d >= prev, `at ${p}`);
    prev = d;
  }
  assert.equal(displayLevel(levelFor(100), 25), 25);
});

test('growing mood fires on any level rise past ten, not only up to ten', () => {
  assert.equal(resolveMood({ ...base, level: 11, lastSeenLevel: 10 }), 'growing');
  assert.equal(resolveMood({ ...base, level: 40, lastSeenLevel: 39 }), 'growing');
  assert.notEqual(resolveMood({ ...base, level: 40, lastSeenLevel: 40 }), 'growing');
});
