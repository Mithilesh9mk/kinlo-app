/**
 * Recurrence arithmetic for personal reminders — pure, no I/O, no imports.
 *
 * Split out of lib/reminders.ts (which imports the Supabase client, and so
 * cannot be loaded outside the app) for the same reason lib/splitCalculator.ts
 * is separate from the modules that write transactions: this is the part with
 * real edge cases, and it has to be testable without a database or a device.
 * See tests/recurrence.test.ts.
 *
 * ONE implementation, two consumers. lib/reminders.ts uses it to compute the
 * `next_due_at` a row will hold; lib/reminderScheduler.ts uses it to compute
 * the dates the OS is told to fire on. If those ever came from two functions,
 * the list screen and the notification would drift apart — the same failure
 * mode lib/balances.ts's header documents for balances.
 */

export type ReminderRecurrence = 'once' | 'daily' | 'weekly' | 'monthly' | 'yearly';

/** Days in a given month. `month` is 0-indexed, matching Date. */
export function daysInMonth(year: number, month: number): number {
  return new Date(year, month + 1, 0).getDate();
}

/**
 * The next occurrence strictly after `from`, or null for a one-off.
 *
 * Month and year steps CLAMP rather than overflow: a reminder due the 31st
 * lands on the 28th/29th in February, not the 2nd/3rd of March, which is what
 * a naive `setMonth(m + 1)` silently does.
 *
 * `anchorDay` is what stops the clamp becoming permanent. Without it, a rent
 * reminder on the 31st clamps to 28 Feb and then every later step is computed
 * from 28, so it spends the rest of its life on the 28th. Passing the original
 * day-of-month means it returns to the 31st in March.
 */
export function nextOccurrence(
  from: Date,
  recurrence: ReminderRecurrence,
  anchorDay?: number,
): Date | null {
  if (recurrence === 'once') return null;

  if (recurrence === 'daily') {
    const d = new Date(from.getTime());
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (recurrence === 'weekly') {
    const d = new Date(from.getTime());
    d.setDate(d.getDate() + 7);
    return d;
  }

  const day = anchorDay ?? from.getDate();
  const rawMonth = recurrence === 'yearly' ? from.getMonth() : from.getMonth() + 1;
  const rawYear = recurrence === 'yearly' ? from.getFullYear() + 1 : from.getFullYear();

  // Normalise a December rollover before clamping the day.
  const y = rawYear + Math.floor(rawMonth / 12);
  const m = ((rawMonth % 12) + 12) % 12;

  return new Date(
    y,
    m,
    Math.min(day, daysInMonth(y, m)),
    from.getHours(),
    from.getMinutes(),
    from.getSeconds(),
    0,
  );
}

/**
 * `nextOccurrence` applied until the result is in the future.
 *
 * Advancement starts from the reminder's own due date, never from now(): a
 * monthly rent reminder due the 5th and marked done on the 7th advances to the
 * 5th of next month, not the 7th. Two months late rolls forward twice.
 *
 * The step count is bounded. A daily reminder abandoned for a year needs ~365
 * steps; 400 covers it, and a corrupt row cannot spin forever on the UI thread.
 */
export function advanceUntilFuture(
  from: Date,
  recurrence: ReminderRecurrence,
  now: Date = new Date(),
  anchorDay?: number,
): Date | null {
  if (recurrence === 'once') return null;

  const anchor = anchorDay ?? from.getDate();
  let next = nextOccurrence(from, recurrence, anchor);

  let guard = 0;
  while (next && next.getTime() <= now.getTime() && guard < 400) {
    next = nextOccurrence(next, recurrence, anchor);
    guard += 1;
  }
  return next;
}

/**
 * The next `count` occurrences at or after `now`, for the OS scheduler.
 *
 * A one-off already in the past yields nothing — there is no occurrence left
 * to schedule, and the list screen shows it as overdue instead.
 */
export function occurrencesAhead(
  nextDueAt: string | Date,
  recurrence: ReminderRecurrence,
  count: number,
  now: Date = new Date(),
): Date[] {
  const out: Date[] = [];
  const due = typeof nextDueAt === 'string' ? new Date(nextDueAt) : nextDueAt;
  if (Number.isNaN(due.getTime())) return out;

  const anchor = due.getDate();

  let cursor: Date | null = due;
  if (cursor.getTime() <= now.getTime()) {
    cursor = recurrence === 'once' ? null : advanceUntilFuture(due, recurrence, now, anchor);
  }

  while (cursor && out.length < count) {
    out.push(cursor);
    cursor = nextOccurrence(cursor, recurrence, anchor);
  }
  return out;
}
