/**
 * Sprout speech lines — lib/sprout/lines.ts
 *
 * Run with: npx tsx --test tests/sprout-lines.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allPossibleLines, pickLine, todayCountsFrom, EMPTY_TODAY } from '../lib/sprout/lines';
import { EMPTY_COUNTS, istDay } from '../lib/sprout/model';

const BANNED_WORDS = [
  // 23 Nov: sad / miss / lonely / streak are no longer banned (quiet moods exist); money words still are.
  'owe', 'owed', 'owes', 'owing', 'debt', 'debts',
  'forgot', 'forget', 'alone', 'behind', 'lazy', 'lost', 'lose', 'late',
  'rupee', 'rupees', 'rs', 'inr', 'dollar', 'dollars', 'money', 'cash', 'paid', 'pay', 'price',
];

test('every possible line is free of banned words and amounts', () => {
  const lines = allPossibleLines();
  assert.ok(lines.length > 40, 'sweep should find a healthy pool of lines');
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const w of BANNED_WORDS) {
      assert.equal(new RegExp(`\\b${w}\\b`).test(lower), false, `"${line}" contains banned word "${w}"`);
    }
    assert.equal(/[₹$€£]/.test(line), false, `"${line}" has a currency symbol`);
    // Digits are only ever "N to go", "+N growth" or "N days in a row".
    const stripped = line
      .replace(/\d+ to go/g, '')
      .replace(/\+\d+ growth/g, '')
      .replace(/\d+ days in a row/g, '');
    assert.equal(/\d/.test(stripped), false, `"${line}" has a digit outside the allowed forms`);
  }
});

test('lines are short', () => {
  for (const line of allPossibleLines()) {
    assert.ok(line.length <= 60, `too long (${line.length}): ${line}`);
    assert.ok(line.trim().length > 0);
  }
});

test('gain event states the growth, never an amount of money', () => {
  const l = pickLine({ level: 3, toNext: null, hour: 10, event: 'gain', lastGain: 2 });
  assert.match(l, /\+2 growth/);
});

test('level 10 and every level past it still have a next level to name', () => {
  for (const level of [10, 11, 25, 60]) {
    for (let tapCount = 0; tapCount < 30; tapCount++) {
      const l = pickLine({ level, toNext: { remaining: 9, nextName: 'Songbird tree' }, hour: 14, event: 'tap', tapCount });
      assert.ok(l.length > 0);
      assert.equal(/fully grown|all the way up/i.test(l), false, l);
    }
  }
});

test('era unlock lines name the era and are digit-free', () => {
  for (const level of [11, 16, 21, 26, 31, 36, 41]) {
    const lines = new Set<string>();
    for (let tapCount = 0; tapCount < 6; tapCount++) {
      lines.add(pickLine({ level, toNext: null, hour: 9, event: 'eraUp', tapCount }));
    }
    assert.ok([...lines].some((x) => /era begins/.test(x)), `level ${level}`);
    for (const x of lines) assert.equal(/\d/.test(x), false, x);
  }
});

test('tap lines rotate and are deterministic', () => {
  const a = pickLine({ level: 4, toNext: { remaining: 3, nextName: 'Sapling' }, hour: 9, event: 'tap', tapCount: 0 });
  const a2 = pickLine({ level: 4, toNext: { remaining: 3, nextName: 'Sapling' }, hour: 9, event: 'tap', tapCount: 0 });
  assert.equal(a, a2);
  const seen = new Set<string>();
  for (let i = 0; i < 12; i++) {
    seen.add(pickLine({ level: 4, toNext: { remaining: 3, nextName: 'Sapling' }, hour: 9, event: 'tap', tapCount: i }));
  }
  assert.ok(seen.size >= 6, 'rotation should vary');
});

test('garbage input still returns a safe line', () => {
  const l = pickLine({ level: NaN, toNext: null, hour: NaN, event: 'tap', tapCount: NaN as number });
  assert.ok(l.length > 0);
});

test('todayCountsFrom returns counts only for today', () => {
  const now = new Date(Date.UTC(2026, 0, 5, 12, 0, 0));
  const d = istDay(now);
  const t = todayCountsFrom(
    { ...EMPTY_COUNTS, expensesByDay: { [d]: 4, '2020-01-01': 9 }, scansByDay: { [d]: 1 } },
    now,
  );
  assert.deepEqual(t, { expenses: 4, settlements: 0, scans: 1, friends: 0 });
  assert.deepEqual(todayCountsFrom(null, now), EMPTY_TODAY);
});

test('every quiet mood has its own gentle tier, free of money talk', () => {
  for (const quiet of ['droopy', 'sad', 'grumpy'] as const) {
    const seen = new Set<string>();
    for (let tapCount = 0; tapCount < 12; tapCount++) {
      const l = pickLine({ level: 4, toNext: { remaining: 3, nextName: 'Sapling' }, hour: 9, event: 'tap', tapCount, quiet });
      seen.add(l);
      assert.match(l.toLowerCase(), /log/, `"${l}" should nudge toward logging`);
    }
    assert.ok(seen.size >= 3, `${quiet} tier should rotate`);
    const open = pickLine({ level: 4, toNext: null, hour: 9, event: 'open', quiet });
    assert.ok(open.length > 0);
  }
  assert.match(pickLine({ level: 1, toNext: null, hour: 9, event: 'tap', quiet: 'grumpy', tapCount: 0 }), /Hmph/);
});

test('revived line is warm, and a quiet tier never leaks into other events', () => {
  const r = pickLine({ level: 3, toNext: null, hour: 9, event: 'revived' });
  assert.match(r, /perked|fresh|lifting/);
  const g = pickLine({ level: 3, toNext: null, hour: 9, event: 'gain', lastGain: 2, quiet: 'sad' });
  assert.match(g, /\+2 growth/);
});

test('allPossibleLines includes the new quiet and revive lines', () => {
  const all = allPossibleLines();
  assert.ok(all.includes('Hmph... log something?'));
  assert.ok(all.includes('Ahh, that perked me right up!'));
  assert.ok(all.includes('I am a bit droopy. A quick log perks me up.'));
});
