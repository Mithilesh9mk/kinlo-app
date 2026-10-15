import { supabase } from './supabase';

/**
 * Reading the activity log.
 *
 * activity_events records what happened — who did it, to what, and what
 * changed — rather than what is currently true. Home's Recent Activity is a
 * different thing and stays as it is: it shows your money position on each
 * recent expense, which is what that screen is for. This is the history.
 *
 * One module owns the query and the wording, for the same reason
 * lib/balances.ts owns the ledger read: two screens describing the same event
 * differently is how a log stops being trusted.
 *
 * See supabase/migrations/0032_activity_events.sql.
 */

export type ActivityEventType =
  | 'expense_created'
  | 'expense_edited'
  | 'expense_voided'
  | 'settlement_recorded'
  | 'settlement_voided'
  | 'member_added'
  | 'member_removed'
  | 'group_simplification_changed';

export interface ActivityEvent {
  id: string;
  actorId: string;
  actorName: string;
  /** 'You' when the actor is the signed-in user, else their first name. */
  actorLabel: string;
  eventType: ActivityEventType;
  transactionId: string | null;
  groupId: string | null;
  groupName: string | null;
  subjectId: string | null;
  subjectName: string | null;
  payload: Record<string, any>;
  createdAt: string;
}

interface RawRow {
  id: string;
  actor_id: string;
  event_type: ActivityEventType;
  transaction_id: string | null;
  group_id: string | null;
  subject_id: string | null;
  payload: Record<string, any> | null;
  created_at: string;
}

const firstName = (full: string) => (full || 'Someone').split(' ')[0];

/**
 * The most recent events visible to this user.
 *
 * Visibility is enforced by RLS — activity_events_select only returns events
 * about transactions you are party to, groups you belong to, or things you did
 * yourself. Nothing is filtered here, because a client-side filter over a
 * server-side truth is the pattern that produced most of this app's bugs.
 */
export async function fetchActivity(limit = 40): Promise<ActivityEvent[]> {
  const { data: sessionData } = await supabase.auth.getSession();
  const me = sessionData?.session?.user?.id ?? null;

  const { data, error } = await supabase
    .from('activity_events')
    .select('id, actor_id, event_type, transaction_id, group_id, subject_id, payload, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  const rows = (data ?? []) as RawRow[];
  if (rows.length === 0) return [];

  // Resolve names in one round trip each rather than per row.
  const userIds = new Set<string>();
  const groupIds = new Set<string>();
  for (const r of rows) {
    userIds.add(r.actor_id);
    if (r.subject_id) userIds.add(r.subject_id);
    if (r.group_id) groupIds.add(r.group_id);
  }

  const [{ data: users }, { data: groups }] = await Promise.all([
    supabase.from('users').select('id, full_name').in('id', [...userIds]),
    groupIds.size > 0
      ? supabase.from('groups').select('id, title').in('id', [...groupIds])
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const nameOf: Record<string, string> = {};
  for (const u of users ?? []) nameOf[u.id] = u.full_name || 'Unknown';

  const titleOf: Record<string, string> = {};
  for (const g of groups ?? []) titleOf[g.id] = g.title || 'a group';

  return rows.map(r => {
    const actorName = nameOf[r.actor_id] || 'Someone';
    return {
      id: r.id,
      actorId: r.actor_id,
      actorName,
      actorLabel: r.actor_id === me ? 'You' : firstName(actorName),
      eventType: r.event_type,
      transactionId: r.transaction_id,
      groupId: r.group_id,
      groupName: r.group_id ? (titleOf[r.group_id] ?? null) : null,
      subjectId: r.subject_id,
      subjectName: r.subject_id ? (nameOf[r.subject_id] ?? null) : null,
      payload: r.payload ?? {},
      createdAt: r.created_at,
    };
  });
}

/**
 * How many events, by someone other than the caller, have happened since the
 * caller last opened the Activity screen.
 *
 * Your own actions never count — recording your own expense shouldn't leave
 * you a notification about it. activity_events_select (0032) already limits
 * this to events the caller can see; this only adds the "since" and "not me"
 * conditions on top.
 */
export async function fetchUnreadActivityCount(): Promise<number> {
  const { data: sessionData } = await supabase.auth.getSession();
  const me = sessionData?.session?.user?.id ?? null;
  if (!me) return 0;

  const { data: userRow, error: userError } = await supabase
    .from('users')
    .select('activity_last_read_at')
    .eq('id', me)
    .maybeSingle();
  if (userError) throw new Error(userError.message);

  const since = userRow?.activity_last_read_at ?? '1970-01-01T00:00:00Z';

  const { count, error } = await supabase
    .from('activity_events')
    .select('id', { count: 'exact', head: true })
    .gt('created_at', since)
    .neq('actor_id', me);
  if (error) throw new Error(error.message);

  return count ?? 0;
}

/**
 * Marks activity as read as of now. Called when the Activity screen opens —
 * the badge should clear the moment you look, not require reading every row.
 */
export async function markActivityRead(): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const me = sessionData?.session?.user?.id ?? null;
  if (!me) return;

  const { error } = await supabase
    .from('users')
    .update({ activity_last_read_at: new Date().toISOString() })
    .eq('id', me);
  if (error) throw new Error(error.message);
}

/** Events recorded against one expense, oldest first. Its history. */
export async function fetchTransactionHistory(transactionId: string): Promise<ActivityEvent[]> {
  const all = await fetchActivity(200);
  return all
    .filter(e => e.transactionId === transactionId)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

const money = (n: unknown) => `₹${Number(n ?? 0).toFixed(2)}`;

/**
 * How an event reads.
 *
 * Kept beside the data rather than in JSX so the Activity screen and the
 * expense detail line word the same event identically. `detail` is null when
 * there is nothing useful to add — better a short line than a padded one.
 */
export function describeEvent(e: ActivityEvent): {
  title: string;
  detail: string | null;
  icon: string;
  tone: 'neutral' | 'positive' | 'warning';
} {
  const where = e.groupName ? ` in ${e.groupName}` : '';
  const what = e.payload?.description || 'an expense';

  switch (e.eventType) {
    case 'expense_created':
      return {
        title: `${e.actorLabel} added "${what}"${where}`,
        detail: e.payload?.amount != null ? money(e.payload.amount) : null,
        icon: 'receipt-long',
        tone: 'neutral',
      };

    case 'expense_edited': {
      const changes = (e.payload?.changes ?? {}) as Record<string, [any, any]>;
      // Amount is the change people care about most, so it gets said in full.
      // Everything else is named rather than spelled out — "changed the
      // category and who paid" is more readable than four before/after pairs.
      const parts: string[] = [];
      if (changes.amount) {
        parts.push(`${money(changes.amount[0])} → ${money(changes.amount[1])}`);
      }
      const others = Object.keys(changes).filter(k => k !== 'amount');
      const labels: Record<string, string> = {
        description: 'the name',
        category: 'the category',
        paid_by: 'who paid',
        group_id: 'the group',
        split_type: 'how it splits',
      };
      const named = others.map(k => labels[k] ?? k);
      if (named.length === 1) parts.push(`changed ${named[0]}`);
      else if (named.length > 1) {
        parts.push(`changed ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`);
      }

      return {
        title: `${e.actorLabel} edited "${what}"${where}`,
        detail: parts.length > 0 ? parts.join(' · ') : null,
        icon: 'edit',
        tone: 'warning',
      };
    }

    case 'expense_voided':
      return {
        title: `${e.actorLabel} deleted "${what}"${where}`,
        detail: e.payload?.amount != null ? money(e.payload.amount) : null,
        icon: 'delete-outline',
        tone: 'warning',
      };

    case 'settlement_recorded':
      return {
        title: `${e.actorLabel} recorded a payment${where}`,
        detail: e.payload?.amount != null ? money(e.payload.amount) : null,
        icon: 'payments',
        tone: 'positive',
      };

    case 'settlement_voided':
      return {
        title: `${e.actorLabel} deleted a payment${where}`,
        detail: e.payload?.amount != null ? money(e.payload.amount) : null,
        icon: 'money-off',
        tone: 'warning',
      };

    case 'member_added':
      return {
        title: e.subjectId === e.actorId
          ? `${e.actorLabel} joined ${e.groupName ?? 'a group'}`
          : `${e.actorLabel} added ${firstName(e.subjectName ?? '')} to ${e.groupName ?? 'a group'}`,
        detail: null,
        icon: 'person-add',
        tone: 'neutral',
      };

    case 'member_removed':
      return {
        title: e.subjectId === e.actorId
          ? `${e.actorLabel} left ${e.groupName ?? 'a group'}`
          : `${e.actorLabel} removed ${firstName(e.subjectName ?? '')} from ${e.groupName ?? 'a group'}`,
        detail: null,
        icon: 'person-remove',
        tone: 'warning',
      };

    case 'group_simplification_changed': {
      const nowSimplified = e.payload?.simplify_debts?.[1] === true;
      return {
        title: nowSimplified
          ? `${e.actorLabel} turned on debt simplification${where}`
          : `${e.actorLabel} turned off debt simplification${where}`,
        detail: nowSimplified
          ? 'Balances now show the fewest payments needed to settle up'
          : 'Balances now show who paid for what, person to person',
        icon: 'call-split',
        tone: 'warning',
      };
    }

    default:
      return { title: 'Something happened', detail: null, icon: 'history', tone: 'neutral' };
  }
}

/** "just now", "2h ago", "3d ago", then a date. */
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
