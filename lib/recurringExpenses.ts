// Repeating expenses (rent, Wi-Fi, subscriptions).
//
// A rule (table recurring_expenses, migration 0066) is a template. The expense
// itself is created HERE, on the owner's device, through the same record_expense()
// RPC a hand-entered expense uses — so a repeated expense is an ordinary one
// (same validation, same ledger rebuild, same notifications). There is no
// server-side scheduler by design (project decision: no pg_cron), so an
// expense appears the next time the owner opens Kinlo on/after its due date.
//
// Every function degrades instead of throwing: a missing migration, a dropped
// connection or a bad row must never break the screen that calls it.
import { supabase } from './supabase';
import { recordExpense } from './recalculateSettlements';
import { dispatchPushNotification } from './pushDispatcher';
import { nextOccurrence, type ReminderRecurrence } from './recurrence';

export type RepeatFrequency = 'weekly' | 'monthly' | 'yearly';

export const REPEAT_LABELS: Record<RepeatFrequency, string> = {
  weekly: 'Every week',
  monthly: 'Every month',
  yearly: 'Every year',
};

export const REPEAT_SHORT: Record<RepeatFrequency, string> = {
  weekly: 'Weekly',
  monthly: 'Monthly',
  yearly: 'Yearly',
};

export type RecurringRule = {
  id: string;
  description: string;
  amount: number;
  category: string | null;
  splitType: string;
  paidBy: string;
  splits: { user_id: string; share_amount: number }[];
  groupId: string | null;
  frequency: RepeatFrequency;
  anchorDay: number;
  nextDue: string; // YYYY-MM-DD
  active: boolean;
  failCount: number;
};

/** After this many consecutive failed attempts a rule pauses instead of retrying forever. */
const MAX_FAILS = 5;
/** Missed occurrences created per rule per run (an app unopened for months catches up over several runs). */
const MAX_CATCH_UP = 6;

const pad = (n: number) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function toDateStr(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD → local Date at noon (noon keeps it clear of any midnight/DST edge). */
export function fromDateStr(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0, 0);
}

export function nextDueAfter(from: Date, frequency: RepeatFrequency, anchorDay: number): string {
  const next = nextOccurrence(from, frequency as ReminderRecurrence, anchorDay);
  return toDateStr(next ?? from);
}

/**
 * Same (rule, due date) → same transaction id, on every device and every retry.
 * Replaces the last UUID group with the due date, so it is still a valid UUID
 * and never equals the rule's own id.
 */
export function occurrenceTransactionId(ruleId: string, dueDate: string): string {
  return `${ruleId.slice(0, 24)}${dueDate.replace(/-/g, '')}0000`;
}

function fromRow(r: any): RecurringRule {
  return {
    id: r.id,
    description: r.description,
    amount: Number(r.amount),
    category: r.category ?? null,
    splitType: r.split_type,
    paidBy: r.paid_by,
    splits: Array.isArray(r.splits) ? r.splits : [],
    groupId: r.group_id ?? null,
    frequency: r.frequency,
    anchorDay: r.anchor_day,
    nextDue: r.next_due,
    active: !!r.active,
    failCount: r.fail_count ?? 0,
  };
}

export type CreateRuleInput = {
  description: string;
  amount: number;
  category: string | null;
  splitType: string;
  paidBy: string;
  splits: { user_id: string; share_amount: number }[];
  groupId: string | null;
  frequency: RepeatFrequency;
};

/**
 * Save a rule whose first expense was JUST posted, so the first repeat is one
 * period from today. Returns an error message, or null on success.
 */
export async function createRecurringRule(input: CreateRuleInput): Promise<string | null> {
  try {
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth?.user?.id;
    if (!uid) return 'Not signed in';
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const { error } = await supabase.from('recurring_expenses').insert({
      owner_id: uid,
      description: input.description.trim().slice(0, 100),
      amount: input.amount,
      category: input.category,
      split_type: input.splitType,
      paid_by: input.paidBy,
      splits: input.splits,
      group_id: input.groupId,
      frequency: input.frequency,
      anchor_day: today.getDate(),
      next_due: nextDueAfter(today, input.frequency, today.getDate()),
    });
    return error ? error.message : null;
  } catch (e: any) {
    return e?.message ?? 'Could not save the repeat';
  }
}

export async function fetchMyRules(): Promise<RecurringRule[] | null> {
  try {
    const { data, error } = await supabase
      .from('recurring_expenses')
      .select('*')
      .order('next_due', { ascending: true });
    if (error || !data) return null;
    return data.map(fromRow);
  } catch {
    return null;
  }
}

export async function setRuleActive(id: string, active: boolean): Promise<boolean> {
  try {
    const patch: Record<string, unknown> = { active, updated_at: new Date().toISOString() };
    if (active) patch.fail_count = 0;
    const { error } = await supabase.from('recurring_expenses').update(patch).eq('id', id);
    return !error;
  } catch {
    return false;
  }
}

export async function deleteRule(id: string): Promise<boolean> {
  try {
    const { error } = await supabase.from('recurring_expenses').delete().eq('id', id);
    return !error;
  } catch {
    return false;
  }
}

let running = false;

/**
 * Create every expense that has come due. Safe to call often and from several
 * places: one run at a time, ids are deterministic, and an occurrence whose
 * transaction already exists (even if since edited or voided) is skipped and
 * the rule simply moves on. Returns how many expenses it created.
 */
export async function runDueRecurring(): Promise<number> {
  if (running) return 0;
  running = true;
  let created = 0;
  try {
    const { data: auth } = await supabase.auth.getUser();
    const me = auth?.user;
    if (!me) return 0;

    const todayStr = toDateStr(new Date());
    const { data, error } = await supabase
      .from('recurring_expenses')
      .select('*')
      .eq('active', true)
      .lte('next_due', todayStr)
      .order('next_due', { ascending: true })
      .limit(20);
    if (error || !data) return 0;

    for (const row of data) {
      const rule = fromRow(row);
      let due = rule.nextDue;
      let steps = 0;

      while (due <= todayStr && steps < MAX_CATCH_UP) {
        steps += 1;
        const txId = occurrenceTransactionId(rule.id, due);

        const { data: existing } = await supabase
          .from('transactions')
          .select('id')
          .eq('id', txId)
          .maybeSingle();

        if (!existing) {
          const err = await recordExpense({
            transactionId: txId,
            amount: rule.amount,
            description: rule.description,
            category: rule.category ?? 'other',
            paidBy: rule.paidBy,
            splitType: rule.splitType,
            splits: rule.splits,
            groupId: rule.groupId,
          });
          if (err) {
            const fails = rule.failCount + 1;
            await supabase
              .from('recurring_expenses')
              .update({
                fail_count: fails,
                active: fails < MAX_FAILS,
                updated_at: new Date().toISOString(),
              })
              .eq('id', rule.id);
            break;
          }
          created += 1;
          const others = rule.splits.map(s => s.user_id).filter(id => id !== me.id);
          if (others.length > 0) {
            dispatchPushNotification(
              others,
              'Repeating expense added 🔁',
              `${(me.user_metadata as any)?.full_name || 'Someone'} added "${rule.description}" for ₹${rule.amount.toFixed(2)}.`,
            );
          }
        }

        due = nextDueAfter(fromDateStr(due), rule.frequency, rule.anchorDay);
        const { error: advErr } = await supabase
          .from('recurring_expenses')
          .update({
            next_due: due,
            last_generated_on: todayStr,
            fail_count: 0,
            updated_at: new Date().toISOString(),
          })
          .eq('id', rule.id);
        if (advErr) break;
      }
    }
  } catch (e) {
    console.warn('runDueRecurring failed:', e);
  } finally {
    running = false;
  }
  return created;
}
