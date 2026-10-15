import { supabase } from './supabase';
import { newTransactionId } from './idempotency';
import {
  ReminderRecurrence,
  nextOccurrence,
  advanceUntilFuture,
  occurrencesAhead,
} from './recurrence';

/**
 * Data access for personal reminders — see
 * supabase/migrations/0049_personal_reminders.sql for the table this wraps,
 * and lib/reminderScheduler.ts for the layer that turns these rows into OS
 * notifications. Nothing outside this module talks to personal_reminders
 * directly.
 *
 * This table is the source of truth; the device schedule is derived from it
 * and re-derived on every launch. The recurrence arithmetic itself lives in
 * lib/recurrence.ts and is re-exported below — the date a row will hold and
 * the date the OS is told to fire on must come from ONE function, or the list
 * screen will disagree with the notification.
 */

export type ReminderStatus = 'active' | 'paused' | 'done' | 'archived';

export interface PersonalReminder {
  id: string;
  userId: string;
  title: string;
  amount: number | null;
  currency: string;
  category: string | null;
  notes: string | null;
  recurrence: ReminderRecurrence;
  nextDueAt: string;
  lastCompletedAt: string | null;
  completedCount: number;
  dueTimeZone: string;
  status: ReminderStatus;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  user_id: string;
  title: string;
  amount: number | null;
  currency: string;
  category: string | null;
  notes: string | null;
  recurrence: ReminderRecurrence;
  next_due_at: string;
  last_completed_at: string | null;
  completed_count: number;
  due_time_zone: string;
  status: ReminderStatus;
  created_at: string;
  updated_at: string;
}

function fromRow(row: Row): PersonalReminder {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    amount: row.amount !== null ? Number(row.amount) : null,
    currency: row.currency,
    category: row.category,
    notes: row.notes,
    recurrence: row.recurrence,
    nextDueAt: row.next_due_at,
    lastCompletedAt: row.last_completed_at,
    completedCount: row.completed_count,
    dueTimeZone: row.due_time_zone,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Recurrence — re-exported from lib/recurrence.ts
// ---------------------------------------------------------------------------
// The arithmetic lives there, with no imports, so it can be tested without a
// database or a device (tests/recurrence.test.ts). Re-exported here so callers
// have one module to import from.

export { nextOccurrence, advanceUntilFuture, occurrencesAhead };
export type { ReminderRecurrence };

/** The device's IANA zone, recorded on new reminders so "9am local" stays
 *  implementable later. Falls back to the DB default if unavailable. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Reminders for the signed-in user, soonest first. Excludes archived rows
 * unless asked. Callers wrap this in withOfflineFallback themselves — the
 * wrapper returns { data, cachedAt } and cachedAt is what OfflineBanner
 * needs, so it belongs at the screen, matching app/finance/index.tsx.
 */
export async function listPersonalReminders(
  opts?: { includeArchived?: boolean },
): Promise<PersonalReminder[]> {
  let query = supabase
    .from('personal_reminders')
    .select('*')
    .order('next_due_at', { ascending: true });

  if (!opts?.includeArchived) query = query.neq('status', 'archived');

  const { data, error } = await query;
  if (error) throw error;
  return (data as Row[]).map(fromRow);
}

export async function getPersonalReminder(id: string): Promise<PersonalReminder | null> {
  const { data, error } = await supabase
    .from('personal_reminders')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data ? fromRow(data as Row) : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SaveReminderInput {
  id: string;
  title: string;
  amount?: number | null;
  category?: string | null;
  notes?: string | null;
  recurrence: ReminderRecurrence;
  /** ISO instant. */
  nextDueAt: string;
  currency?: string;
  dueTimeZone?: string;
  status?: ReminderStatus;
}

/** Upsert on a client-minted id (see lib/idempotency.ts) — a retry
 *  overwrites, never duplicates. */
export async function savePersonalReminder(
  input: SaveReminderInput,
): Promise<PersonalReminder> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');

  const { data, error } = await supabase
    .from('personal_reminders')
    .upsert({
      id: input.id,
      user_id: user.id,
      title: input.title.trim(),
      amount: input.amount ?? null,
      currency: input.currency ?? 'INR',
      category: input.category ?? null,
      notes: input.notes ?? null,
      recurrence: input.recurrence,
      next_due_at: input.nextDueAt,
      due_time_zone: input.dueTimeZone ?? deviceTimeZone(),
      status: input.status ?? 'active',
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) throw error;
  return fromRow(data as Row);
}

/**
 * Marks one occurrence done and returns the row as it now stands, so the
 * caller can re-schedule AND read amount/category for the expense pre-fill
 * without a second fetch.
 *
 * A one-off retires (status 'done'). A repeating reminder rolls forward and
 * stays active — 0049's personal_reminders_recurring_never_done CHECK
 * refuses the other outcome at the database, so a bug here fails loudly
 * instead of silently retiring someone's rent reminder.
 */
export async function completePersonalReminder(
  id: string,
): Promise<PersonalReminder | null> {
  const current = await getPersonalReminder(id);
  if (!current) return null;

  const now = new Date();
  const due = new Date(current.nextDueAt);
  const next = advanceUntilFuture(due, current.recurrence, now, due.getDate());

  const { data, error } = await supabase
    .from('personal_reminders')
    .update({
      last_completed_at: now.toISOString(),
      completed_count: current.completedCount + 1,
      next_due_at: next ? next.toISOString() : current.nextDueAt,
      status: next ? 'active' : 'done',
      updated_at: now.toISOString(),
    })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return fromRow(data as Row);
}

/** Push a reminder out without consuming an occurrence. */
export async function snoozePersonalReminder(
  id: string,
  until: Date,
): Promise<PersonalReminder | null> {
  const { data, error } = await supabase
    .from('personal_reminders')
    .update({ next_due_at: until.toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) throw error;
  return data ? fromRow(data as Row) : null;
}

export async function setReminderStatus(
  id: string,
  status: ReminderStatus,
): Promise<void> {
  const { error } = await supabase
    .from('personal_reminders')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) throw error;
}

/** A real delete, unlike personal transactions — a reminder carries no
 *  image, no money and no counterparty, so there is no audit trail to keep
 *  (0049's personal_reminders_delete policy exists for exactly this). */
export async function deletePersonalReminder(id: string): Promise<void> {
  const { error } = await supabase.from('personal_reminders').delete().eq('id', id);
  if (error) throw error;
}

export { newTransactionId };
