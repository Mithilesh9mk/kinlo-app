/**
 * Sprout count queries. Head-only exact counts, run in parallel; each one
 * fails soft to the cached value. RLS limits every table to rows the user can
 * see, and each filter below narrows to rows that are theirs.
 *
 * Schema evidence (supabase/migrations):
 *  - transactions.type IN ('expense','settlement') ........ 0001
 *  - transactions.status IN ('active','voided',...) ....... 0001 / 0015 (void)
 *  - transactions.paid_by: the payer. There is NO creator column on
 *    transactions (created_by lives on users/groups only), so "expense logged
 *    by me" is approximated as paid_by = me.
 *  - settlement rows: paid_by = payer, ONE transaction_splits row for the
 *    debtor (0005 / 0048 record_settlement). A settlement involves me if I am
 *    paid_by or the split's user_id; the two cases are disjoint.
 *  - friendships(user_id, friend_id): directional, NO status column, every row
 *    is treated as mutual (0001, 0002). Count rows where I am either side.
 *  - group_members(group_id, user_id) ..................... lib/friendFetcher.ts
 *  - simplified_settlements(group_id, debtor_id, creditor_id, amount>0) . 0001
 *  - personal_transactions(user_id, source IN ('manual','screenshot'),
 *    status IN ('needs_review','confirmed','voided')) ..... 0036
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';
import { EMPTY_COUNTS, type SproutCounts } from './model';

const cacheKey = (userId: string) => `@kinlo/sprout/counts/${userId}`;

export async function getCachedCounts(userId: string): Promise<SproutCounts> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(userId));
    if (!raw) return { ...EMPTY_COUNTS };
    const parsed = JSON.parse(raw) as Partial<SproutCounts>;
    const out = { ...EMPTY_COUNTS };
    for (const key of Object.keys(out) as (keyof SproutCounts)[]) {
      const v = parsed[key];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) out[key] = v;
    }
    return out;
  } catch {
    return { ...EMPTY_COUNTS };
  }
}

async function saveCounts(userId: string, counts: SproutCounts): Promise<void> {
  try {
    await AsyncStorage.setItem(cacheKey(userId), JSON.stringify(counts));
  } catch {
    /* ignore */
  }
}

/** Runs one count query; returns `fallback` on any error. */
async function count(
  run: () => PromiseLike<{ count: number | null; error: unknown }>,
  fallback: number,
): Promise<number> {
  try {
    const { count: c, error } = await run();
    if (error || typeof c !== 'number') return fallback;
    return c;
  } catch {
    return fallback;
  }
}

/**
 * circlesSquared: circles the user is a member of that (a) have at least one
 * non-voided expense and (b) have NO simplified_settlements row where the user
 * is debtor or creditor, i.e. the user's balance there is zero (the ledger is
 * authoritative, see lib/balances.ts).
 *
 * Limits: no row records WHEN a circle hit zero, so this is a snapshot. A new
 * expense can un-square a circle and the count can drop (the displayed stage
 * never regresses, see displayStage). A circle where the user was never
 * involved in any expense also counts as squared. Capped at 1000 rows per
 * query. Any query error returns the cached value.
 */
async function countCirclesSquared(userId: string, fallback: number): Promise<number> {
  try {
    const { data: mine, error: e1 } = await supabase
      .from('group_members')
      .select('group_id')
      .eq('user_id', userId);
    if (e1 || !mine) return fallback;
    const groupIds = Array.from(new Set(mine.map((r: { group_id: string }) => r.group_id)));
    if (groupIds.length === 0) return 0;

    const [expRes, openRes] = await Promise.all([
      supabase
        .from('transactions')
        .select('group_id')
        .in('group_id', groupIds)
        .eq('type', 'expense')
        .neq('status', 'voided')
        .limit(1000),
      supabase
        .from('simplified_settlements')
        .select('group_id')
        .in('group_id', groupIds)
        .or(`debtor_id.eq.${userId},creditor_id.eq.${userId}`)
        .limit(1000),
    ]);
    if (expRes.error || openRes.error || !expRes.data || !openRes.data) return fallback;

    const withExpense = new Set(expRes.data.map((r: { group_id: string }) => r.group_id));
    const open = new Set(openRes.data.map((r: { group_id: string }) => r.group_id));
    let n = 0;
    withExpense.forEach((g) => {
      if (!open.has(g)) n += 1;
    });
    return n;
  } catch {
    return fallback;
  }
}

/**
 * Friendships are directional rows and lib/friendFetcher.ts unions both
 * directions, so one friend can appear as (me, them) AND (them, me). Count
 * distinct counterparties, not rows, so a mutual pair is not worth double.
 */
async function countDistinctFriends(userId: string, fallback: number): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('friendships')
      .select('user_id, friend_id')
      .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
      .limit(1000);
    if (error || !data) return fallback;
    const others = new Set<string>();
    for (const r of data as { user_id: string; friend_id: string }[]) {
      const other = r.user_id === userId ? r.friend_id : r.user_id;
      if (other && other !== userId) others.add(other);
    }
    return others.size;
  } catch {
    return fallback;
  }
}

export async function fetchSproutCounts(userId: string): Promise<SproutCounts> {
  const cached = await getCachedCounts(userId);
  const head = { count: 'exact' as const, head: true };

  const [expenses, settledAsPayer, settledAsDebtor, friends, circles, scans] =
    await Promise.all([
      count(
        () =>
          supabase
            .from('transactions')
            .select('*', head)
            .eq('type', 'expense')
            .neq('status', 'voided')
            .eq('paid_by', userId),
        cached.expenses,
      ),
      count(
        () =>
          supabase
            .from('transactions')
            .select('*', head)
            .eq('type', 'settlement')
            .neq('status', 'voided')
            .eq('paid_by', userId),
        -1,
      ),
      count(
        () =>
          supabase
            .from('transaction_splits')
            .select('transaction_id, transactions!inner(type,status)', head)
            .eq('user_id', userId)
            .eq('transactions.type', 'settlement')
            .neq('transactions.status', 'voided'),
        -1,
      ),
      countDistinctFriends(userId, cached.friends),
      count(
        () => supabase.from('group_members').select('*', head).eq('user_id', userId),
        cached.circles,
      ),
      count(
        () =>
          supabase
            .from('personal_transactions')
            .select('*', head)
            .eq('user_id', userId)
            .eq('source', 'screenshot')
            .neq('status', 'voided'),
        cached.scans,
      ),
    ]);

  const circlesSquared = await countCirclesSquared(userId, cached.circlesSquared);

  // Settlements need both halves; if either failed, keep the cached total.
  const settlements =
    settledAsPayer < 0 || settledAsDebtor < 0
      ? cached.settlements
      : settledAsPayer + settledAsDebtor;

  const counts: SproutCounts = {
    expenses,
    settlements,
    friends,
    circles,
    scans,
    circlesSquared,
  };
  await saveCounts(userId, counts);
  return counts;
}
