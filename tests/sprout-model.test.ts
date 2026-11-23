/**
 * Sprout growth model — lib/sprout/model.ts
 *
 * Run with: npx tsx --test tests/sprout-model.test.ts
 * No test framework, same reasoning as tests/recurrence.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_COUNTS,
  WELCOME_BACK_MS,
  blossomsFor,
  displayStage,
  pointsFrom,
  resolveMood,
  stageFor,
  toNextStage,
  type MoodInput,
  type SproutMood,
} from '../lib/sprout/model';

const NOON = new Date(2026, 10, 23, 12, 0, 0);
const at = (h: number, m = 0) => new Date(2026, 10, 23, h, m, 0);
const base: MoodInput = {
  stage: 'sapling',
  lastSeenStage: 'sapling',
  lastOpenAt: NOON.getTime() - 1000,
  now: NOON,
};

test('pointsFrom weights', () => {
  assert.equal(pointsFrom(EMPTY_COUNTS), 0);
  assert.equal(
    pointsFrom({ expenses: 3, settlements: 2, friends: 1, circles: 1, scans: 2, circlesSquared: 1 }),
    3 + 4 + 2 + 2 + 2 + 3,
  );
});

test('stage boundaries', () => {
  assert.equal(stageFor(0), 'seed');
  assert.equal(stageFor(4), 'seed');
  assert.equal(stageFor(5), 'sprout');
  assert.equal(stageFor(24), 'sprout');
  assert.equal(stageFor(25), 'sapling');
  assert.equal(stageFor(79), 'sapling');
  assert.equal(stageFor(80), 'tree');
  assert.equal(stageFor(5000), 'tree');
});

test('blossoms start after tree and cap at 5', () => {
  assert.equal(blossomsFor(79), 0);
  assert.equal(blossomsFor(80), 0);
  assert.equal(blossomsFor(119), 0);
  assert.equal(blossomsFor(120), 1);
  assert.equal(blossomsFor(280), 5);
  assert.equal(blossomsFor(100000), 5);
});

test('toNextStage', () => {
  assert.deepEqual(toNextStage(0), { next: 'sprout', remaining: 5 });
  assert.deepEqual(toNextStage(24), { next: 'sapling', remaining: 1 });
  assert.deepEqual(toNextStage(70), { next: 'tree', remaining: 10 });
  assert.equal(toNextStage(80), null);
});

test('displayStage never regresses', () => {
  assert.equal(displayStage('sprout', 'sapling'), 'sapling');
  assert.equal(displayStage('tree', 'sapling'), 'tree');
  assert.equal(displayStage('seed', null), 'seed');
  assert.equal(displayStage('sapling', 'sapling'), 'sapling');
});

test('mood: idle by default', () => {
  assert.equal(resolveMood(base), 'idle');
});

test('mood priority order', () => {
  const all: MoodInput = {
    ...base,
    stage: 'tree',
    lastSeenStage: 'sapling',
    event: 'settled',
    scanning: true,
    lastOpenAt: NOON.getTime() - WELCOME_BACK_MS - 1,
    hasOpenBalances: false,
    now: at(23),
  };
  assert.equal(resolveMood(all), 'growing');
  const noGrow: MoodInput = { ...all, lastSeenStage: 'tree' };
  assert.equal(resolveMood(noGrow), 'celebrate');
  const noEvent: MoodInput = { ...noGrow, event: null };
  assert.equal(resolveMood(noEvent), 'curious');
  const noScan: MoodInput = { ...noEvent, scanning: false };
  assert.equal(resolveMood(noScan), 'welcomeBack');
  const recent: MoodInput = { ...noScan, lastOpenAt: at(22).getTime() };
  assert.equal(resolveMood(recent), 'proud');
  assert.equal(resolveMood({ ...recent, hasOpenBalances: true }), 'sleepy');
  assert.equal(resolveMood({ ...recent, hasOpenBalances: true, now: NOON }), 'idle');
});

test('unknown balances never give proud; unknown lastSeen never gives growing', () => {
  assert.equal(resolveMood({ ...base, hasOpenBalances: undefined }), 'idle');
  assert.equal(resolveMood({ ...base, stage: 'tree', lastSeenStage: null }), 'idle');
});

test('sleepy window across midnight, 22:00 inclusive, 06:00 exclusive', () => {
  const m = (d: Date) => resolveMood({ ...base, lastOpenAt: d.getTime(), now: d });
  assert.equal(m(at(21, 59)), 'idle');
  assert.equal(m(at(22, 0)), 'sleepy');
  assert.equal(m(at(23, 59)), 'sleepy');
  assert.equal(m(at(0, 0)), 'sleepy');
  assert.equal(m(at(5, 59)), 'sleepy');
  assert.equal(m(at(6, 0)), 'idle');
});

test('welcomeBack only when strictly older than 7 days', () => {
  const exactly7 = { ...base, lastOpenAt: NOON.getTime() - WELCOME_BACK_MS };
  assert.equal(resolveMood(exactly7), 'idle');
  const over = { ...base, lastOpenAt: NOON.getTime() - WELCOME_BACK_MS - 1 };
  assert.equal(resolveMood(over), 'welcomeBack');
  assert.equal(resolveMood({ ...base, lastOpenAt: null }), 'idle');
});

test('no negative mood for any input combination', () => {
  const allowed: SproutMood[] = [
    'idle', 'celebrate', 'curious', 'proud', 'welcomeBack', 'sleepy', 'growing',
  ];
  for (const hasOpenBalances of [true, false, undefined])
    for (const scanning of [true, false])
      for (const event of [null, 'settled', 'friendAdded', 'appOpened'] as const)
        for (const h of [0, 7, 12, 22])
          for (const lastOpenAt of [null, 0, NOON.getTime()]) {
            const mood = resolveMood({ ...base, hasOpenBalances, scanning, event, lastOpenAt, now: at(h) });
            assert.ok(allowed.includes(mood));
          }
});
