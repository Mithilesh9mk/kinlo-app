/**
 * Reminder recurrence arithmetic — lib/recurrence.ts
 *
 * Run with:
 *
 *   npx tsx --test tests/recurrence.test.ts
 *
 * No test framework installed, deliberately — same reasoning as
 * tests/split-calculator.test.ts: this project's runtime version uses the
 * `fingerprint` policy, so a devDependency can change the fingerprint and
 * orphan the installed APK from over-the-air updates.
 *
 * SCOPE
 *
 * The pure layer only. What these cover is the part that has real edge cases
 * and no other safety net: a monthly reminder due on the 31st, a leap year, a
 * December rollover, and advancing a reminder that was marked done late. The
 * database side (0049's CHECK constraints) and the OS scheduling side
 * (lib/reminderScheduler.ts, which needs a device) are verified separately.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  daysInMonth,
  nextOccurrence,
  advanceUntilFuture,
  occurrencesAhead,
} from '../lib/recurrence';

/** Local-time date, so these read the way a user would state them. */
const at = (y: number, m: number, d: number, hh = 9, mm = 0) =>
  new Date(y, m - 1, d, hh, mm, 0, 0);

const iso = (d: Date | null) =>
  d === null ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

// ---------------------------------------------------------------------------
// daysInMonth
// ---------------------------------------------------------------------------

test('daysInMonth handles leap and non-leap February', () => {
  assert.equal(daysInMonth(2026, 1), 28); // Feb 2026
  assert.equal(daysInMonth(2028, 1), 29); // Feb 2028, leap
  assert.equal(daysInMonth(2026, 0), 31); // Jan
  assert.equal(daysInMonth(2026, 3), 30); // Apr
});

// ---------------------------------------------------------------------------
// nextOccurrence — the simple cadences
// ---------------------------------------------------------------------------

test('once has no next occurrence', () => {
  assert.equal(nextOccurrence(at(2026, 9, 5), 'once'), null);
});

test('daily steps one day, keeping the time of day', () => {
  assert.equal(iso(nextOccurrence(at(2026, 9, 5, 21, 30), 'daily')), '2026-09-06 21:30');
});

test('daily crosses a month boundary', () => {
  assert.equal(iso(nextOccurrence(at(2026, 9, 30), 'daily')), '2026-10-01 09:00');
});

test('weekly steps seven days', () => {
  assert.equal(iso(nextOccurrence(at(2026, 9, 28), 'weekly')), '2026-10-05 09:00');
});

// ---------------------------------------------------------------------------
// nextOccurrence — monthly, where the bugs live
// ---------------------------------------------------------------------------

test('monthly steps one month for an ordinary day', () => {
  assert.equal(iso(nextOccurrence(at(2026, 9, 5), 'monthly')), '2026-10-05 09:00');
});

test('monthly on the 31st CLAMPS into a 30-day month, never overflows', () => {
  // The bug this exists to prevent: setMonth(m+1) on 31 Oct gives 1 Dec.
  assert.equal(iso(nextOccurrence(at(2026, 10, 31), 'monthly')), '2026-11-30 09:00');
});

test('monthly on the 31st clamps into February', () => {
  assert.equal(iso(nextOccurrence(at(2026, 1, 31), 'monthly')), '2026-02-28 09:00');
});

test('monthly on the 31st clamps into a leap February', () => {
  assert.equal(iso(nextOccurrence(at(2028, 1, 31), 'monthly')), '2028-02-29 09:00');
});

test('monthly RETURNS to the anchor day after a clamp, rather than drifting', () => {
  // 31 Jan -> 28 Feb. Stepping again from 28 Feb without the anchor would
  // give 28 Mar and stay on the 28th forever. With the anchor it goes back
  // to the 31st.
  const feb = nextOccurrence(at(2026, 1, 31), 'monthly')!;
  assert.equal(iso(feb), '2026-02-28 09:00');
  assert.equal(iso(nextOccurrence(feb, 'monthly', 31)), '2026-03-31 09:00');
});

test('monthly rolls December into the next January', () => {
  assert.equal(iso(nextOccurrence(at(2026, 12, 15), 'monthly')), '2027-01-15 09:00');
});

// ---------------------------------------------------------------------------
// nextOccurrence — yearly
// ---------------------------------------------------------------------------

test('yearly steps one year', () => {
  assert.equal(iso(nextOccurrence(at(2026, 3, 15), 'yearly')), '2027-03-15 09:00');
});

test('yearly on 29 Feb clamps to 28 Feb in a non-leap year', () => {
  assert.equal(iso(nextOccurrence(at(2028, 2, 29), 'yearly')), '2029-02-28 09:00');
});

// ---------------------------------------------------------------------------
// advanceUntilFuture — completing a reminder
// ---------------------------------------------------------------------------

test('marking done LATE advances from the due date, not from today', () => {
  // Rent due the 5th, marked done on the 7th. Next month must be the 5th.
  const due = at(2026, 9, 5);
  const markedDoneOn = at(2026, 9, 7);
  assert.equal(iso(advanceUntilFuture(due, 'monthly', markedDoneOn)), '2026-10-05 09:00');
});

test('a reminder two months overdue rolls forward past today, not to today', () => {
  const due = at(2026, 7, 5);
  const now = at(2026, 9, 20);
  assert.equal(iso(advanceUntilFuture(due, 'monthly', now)), '2026-10-05 09:00');
});

test('advancing a one-off yields null', () => {
  assert.equal(advanceUntilFuture(at(2026, 9, 5), 'once', at(2026, 9, 7)), null);
});

test('advancing always steps at least once, even from a future date', () => {
  // The caller only asks after an occurrence has been consumed.
  const due = at(2026, 12, 5);
  const now = at(2026, 9, 1);
  assert.equal(iso(advanceUntilFuture(due, 'monthly', now)), '2027-01-05 09:00');
});

test('a daily reminder abandoned for a year still terminates', () => {
  const due = at(2026, 1, 1);
  const now = at(2026, 12, 20);
  const next = advanceUntilFuture(due, 'daily', now);
  assert.ok(next !== null);
  assert.ok(next!.getTime() > now.getTime(), 'must land in the future');
});

// ---------------------------------------------------------------------------
// occurrencesAhead — what the OS scheduler is handed
// ---------------------------------------------------------------------------

test('a future one-off yields exactly one occurrence', () => {
  const out = occurrencesAhead(at(2026, 9, 20), 'once', 4, at(2026, 9, 1));
  assert.equal(out.length, 1);
  assert.equal(iso(out[0]), '2026-09-20 09:00');
});

test('a PAST one-off yields nothing to schedule', () => {
  // It stays overdue on the list screen instead; there is no occurrence left.
  const out = occurrencesAhead(at(2026, 8, 20), 'once', 4, at(2026, 9, 1));
  assert.equal(out.length, 0);
});

test('a monthly reminder yields the requested horizon, all in the future', () => {
  const now = at(2026, 9, 10);
  const out = occurrencesAhead(at(2026, 9, 5), 'monthly', 4, now);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map(iso), [
    '2026-10-05 09:00',
    '2026-11-05 09:00',
    '2026-12-05 09:00',
    '2027-01-05 09:00',
  ]);
  for (const d of out) assert.ok(d.getTime() > now.getTime());
});

test('a monthly reminder on the 31st schedules clamped dates across the horizon', () => {
  const out = occurrencesAhead(at(2026, 12, 31), 'monthly', 4, at(2026, 12, 1));
  assert.deepEqual(out.map(iso), [
    '2026-12-31 09:00',
    '2027-01-31 09:00',
    '2027-02-28 09:00', // clamped
    '2027-03-31 09:00', // back to the anchor
  ]);
});

test('an unparseable due date yields nothing rather than throwing', () => {
  assert.deepEqual(occurrencesAhead('not-a-date', 'monthly', 4), []);
});
