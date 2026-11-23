/**
 * Sprout count queries. The growth model caps points per Asia/Kolkata day, so
 * head-only counts are not enough (they cannot group by day): each type fetches
 * its `created_at` rows (newest first, at most ROW_LIMIT) and buckets them with
 * istDay(). Queries run in parallel and each one fails soft to the cached value
 * for that type. RLS limits every table to rows the user can see, and each
 * filter below narrows to rows that are theirs.
 *
 * Mirrors refresh_my_sprout() in supabase/migrations/0074_sprout_stats.sql:
 * same filters, same day (created_at in Asia/Kolkata), same linked-friends and
 * >= 2-member rules. The caps themselves live in model.ts (client) and in the
 * RPC (server); this file only supplies the per-day counts.
 *
 * Schema evidence (supabase/migrations):
 *  - transactions.type IN ('expense','settlement') ........ 0001
 *  - transactions.status IN ('active','voided',...) ....... 0001 / 0015 (void)
 *  - transactions.created_at: used by lib/analytics.ts to bucket split spend
 *    (select ... created_at ... from transactions), so the column exists.
 *  - transactions.paid_by: the payer. There is NO creator column on
 *    transactions (created_by lives on users/groups only), so "expense logged
 *    by me" is approximated as paid_by = me.
 *  - settlement rows: paid_by = payer, ONE transaction_splits row for the
 *    debtor (0005 / 0048 record_settlement). A settlement involves me if I am
 *    paid_by or the split's user_id; the two cases are disjoint. Both are
 *    dated by transactions.created_at.
 *  - friendships(user_id, friend_id, created_at): directional, NO status
 *    column, every row is treated as mutual (0001, 0002).
 *  - users.is_placeholder BOOLEAN NOT NULL DEFAULT FALSE ... 0001
 *  - group_members(group_id, user_id) ..................... lib/friendFetcher.ts
 *    (no timestamp, hence the lifetime caps for circles in the model)
 *  - simplified_settlements(group_id, debtor_id, creditor_id, amount>0) . 0001
 *  - personal_transactions(user_id, source IN ('manual','screenshot'),
 *    status IN ('needs_review','confirmed','voided'), created_at) ... 0036
 *    (created_at, not occurred_at: backdating a screenshot must not dodge the cap)
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';
import { istDay, type DayCounts, type SproutCounts } from './model';

/** Newest rows read per type. A heavier history only lowers the local number
 * (the server value never lowers, and the display never regresses). */
const ROW_LIMIT = 1000;
const MEMBER_ROW_LIMIT = 5000;
const IN_CHUNK = 100;

// v2: per-day shape. The old (v1) key held lifetime totals and is ignored.
const cacheKey = (userId: string) => `@kinlo/sprout/counts/v2/${userId}`;

function emptyCounts(): SproutCounts {
  return {
    expensesByDay: {},
    settlementsByDay: {},
    scansByDay: {},
    friendsByDay: {},
    circles: 0,
    circlesSquared: 0,
  };
}

function cleanDays(v: unknown): DayCounts | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: DayCounts = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
  }
  return out;
}

export async function getCachedCounts(userId: string): Promise<SproutCounts> {
  try {
    const raw = await AsyncStorage.getItem(cacheKey(userId));
    if (!raw) return emptyCounts();
    const parsed = JSON.parse(raw) as Partial<Record<keyof SproutCounts, unknown>>;
    const expensesByDay = cleanDays(parsed.expensesByDay);
    const settlementsByDay = cleanDays(parsed.settlementsByDay);
    const scansByDay = cleanDays(parsed.scansByDay);
    const friendsByDay = cleanDays(parsed.friendsByDay);
    const circles = parsed.circles;
    const circlesSquared = parsed.circlesSquared;
    // Old-shape or damaged cache: ignore it entirely.
    if (
      !expensesByDay ||
      !settlementsByDay ||
      !scansByDay ||
      !friendsByDay ||
      typeof circles !== 'number' ||
      typeof circlesSquared !== 'number' ||
      !Number.isFinite(circles) ||
      !Number.isFinite(circlesSquared)
    ) {
      return emptyCounts();
    }
    return {
      expensesByDay,
      settlementsByDay,
      scansByDay,
      friendsByDay,
      circles: Math.max(0, Math.floor(circles)),
      circlesSquared: Math.max(0, Math.floor(circlesSquared)),
    };
  } catch {
    return emptyCounts();
  }
}

async function saveCounts(userId: string, counts: SproutCounts): Promise<void> {
  try {
    await AsyncStorage.setItem(cacheKey(userId), JSON.stringify(counts));
  } catch {
    /* ignore */
  }
}

function bump(days: DayCounts, createdAt: unknown): void {
  if (typeof createdAt !== 'string') return;
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return;
  const key = istDay(d);
  days[key] = (days[key] ?? 0) + 1;
}

/** Runs a row query; null on any error (the caller keeps its cached value). */
async function rows<T>(
  run: () => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[] | null> {
  try {
    const { data, error } = await run();
    if (error || !Array.isArray(data)) return null;
    return data as T[];
  } catch {
    return null;
  }
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type CreatedAtRow = { created_at: string };

/** transactions of one type paid by me, bucketed by created_at day. */
async function paidByMeDays(
  userId: string,
  type: 'expense' | 'settlement',
): Promise<DayCounts | null> {
  const data = await rows<CreatedAtRow>(() =>
    supabase
      .from('transactions')
      .select('created_at')
      .eq('type', type)
      .neq('status', 'voided')
      .eq('paid_by', userId)
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT),
  );
  if (!data) return null;
  const days: DayCounts = {};
  for (const r of data) bump(days, r.created_at);
  return days;
}

/**
 * Settlements where I am the debtor (my transaction_splits row on a settlement
 * transaction), dated by the settlement's transactions.created_at. The embed
 * is to-one, so PostgREST returns an object (tolerate an array too). No server
 * ordering is requested for the embedded column; the row cap is the only limit.
 */
async function debtorSettlementDays(userId: string): Promise<DayCounts | null> {
  type Row = { transactions: CreatedAtRow | CreatedAtRow[] | null };
  const data = await rows<Row>(() =>
    supabase
      .from('transaction_splits')
      .select('transactions!inner(created_at, type, status)')
      .eq('user_id', userId)
      .eq('transactions.type', 'settlement')
      .neq('transactions.status', 'voided')
      .limit(ROW_LIMIT),
  );
  if (!data) return null;
  const days: DayCounts = {};
  for (const r of data) {
    const t = Array.isArray(r.transactions) ? r.transactions[0] : r.transactions;
    if (t) bump(days, t.created_at);
  }
  return days;
}

async function scanDays(userId: string): Promise<DayCounts | null> {
  const data = await rows<CreatedAtRow>(() =>
    supabase
      .from('personal_transactions')
      .select('created_at')
      .eq('user_id', userId)
      .eq('source', 'screenshot')
      .neq('status', 'voided')
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT),
  );
  if (!data) return null;
  const days: DayCounts = {};
  for (const r of data) bump(days, r.created_at);
  return days;
}

/**
 * Friends by day. Friendships are directional rows and lib/friendFetcher.ts
 * unions both directions, so one friend can appear as (me, them) AND
 * (them, me): count DISTINCT counterparties, on the day of their EARLIEST
 * friendship row. Placeholders (unlinked contacts) are dropped by checking
 * users.is_placeholder; a counterparty whose users row cannot be read is not
 * counted (only ids confirmed is_placeholder = false count).
 */
async function friendDays(userId: string): Promise<DayCounts | null> {
  type Row = { user_id: string; friend_id: string; created_at: string };
  const data = await rows<Row>(() =>
    supabase
      .from('friendships')
      .select('user_id, friend_id, created_at')
      .or(`user_id.eq.${userId},friend_id.eq.${userId}`)
      .order('created_at', { ascending: false })
      .limit(ROW_LIMIT),
  );
  if (!data) return null;

  const earliest = new Map<string, number>();
  for (const r of data) {
    const other = r.user_id === userId ? r.friend_id : r.user_id;
    if (!other || other === userId) continue;
    const t = new Date(r.created_at).getTime();
    if (Number.isNaN(t)) continue;
    const prev = earliest.get(other);
    if (prev === undefined || t < prev) earliest.set(other, t);
  }
  if (earliest.size === 0) return {};

  const linked = new Set<string>();
  for (const ids of chunks(Array.from(earliest.keys()), IN_CHUNK)) {
    const users = await rows<{ id: string; is_placeholder: boolean | null }>(() =>
      supabase.from('users').select('id, is_placeholder').in('id', ids),
    );
    if (!users) return null;
    for (const u of users) if (u.is_placeholder === false) linked.add(u.id);
  }

  const days: DayCounts = {};
  earliest.forEach((t, id) => {
    if (linked.has(id)) bump(days, new Date(t).toISOString());
  });
  return days;
}

/**
 * circles / circlesSquared. group_members has no timestamp, so these are
 * lifetime numbers (the model applies the lifetime cap of 5).
 *  - circles: circles I am in with >= 2 members (the other member rows are
 *    read in chunks, capped at MEMBER_ROW_LIMIT rows per chunk).
 *  - circlesSquared: of those, circles with >= 1 non-voided expense and NO
 *    simplified_settlements row where I am debtor or creditor (my balance there
 *    is zero; the ledger is authoritative, see lib/balances.ts).
 * Limits: no row records WHEN a circle hit zero, so squared is a snapshot; a
 * new expense can un-square a circle and the count can drop (the displayed
 * level never regresses). Row-capped queries; any error returns null so the
 * caller keeps the cached values.
 */
async function circleCounts(
  userId: string,
): Promise<{ circles: number; circlesSquared: number } | null> {
  const mine = await rows<{ group_id: string }>(() =>
    supabase.from('group_members').select('group_id').eq('user_id', userId).limit(ROW_LIMIT),
  );
  if (!mine) return null;
  const groupIds = Array.from(new Set(mine.map((r) => r.group_id)));
  if (groupIds.length === 0) return { circles: 0, circlesSquared: 0 };

  const memberCount = new Map<string, number>();
  for (const ids of chunks(groupIds, IN_CHUNK)) {
    const members = await rows<{ group_id: string }>(() =>
      supabase.from('group_members').select('group_id').in('group_id', ids).limit(MEMBER_ROW_LIMIT),
    );
    if (!members) return null;
    for (const m of members) memberCount.set(m.group_id, (memberCount.get(m.group_id) ?? 0) + 1);
  }
  const eligible = groupIds.filter((g) => (memberCount.get(g) ?? 0) >= 2);
  if (eligible.length === 0) return { circles: 0, circlesSquared: 0 };

  const withExpense = new Set<string>();
  const open = new Set<string>();
  for (const ids of chunks(eligible, IN_CHUNK)) {
    const [exp, bal] = await Promise.all([
      rows<{ group_id: string }>(() =>
        supabase
          .from('transactions')
          .select('group_id')
          .in('group_id', ids)
          .eq('type', 'expense')
          .neq('status', 'voided')
          .limit(ROW_LIMIT),
      ),
      rows<{ group_id: string }>(() =>
        supabase
          .from('simplified_settlements')
          .select('group_id')
          .in('group_id', ids)
          .or(`debtor_id.eq.${userId},creditor_id.eq.${userId}`)
          .limit(ROW_LIMIT),
      ),
    ]);
    if (!exp || !bal) return null;
    for (const r of exp) withExpense.add(r.group_id);
    for (const r of bal) open.add(r.group_id);
  }

  let squared = 0;
  for (const g of eligible) if (withExpense.has(g) && !open.has(g)) squared += 1;
  return { circles: eligible.length, circlesSquared: squared };
}

function mergeDays(a: DayCounts, b: DayCounts): DayCounts {
  const out: DayCounts = { ...a };
  for (const [k, n] of Object.entries(b)) out[k] = (out[k] ?? 0) + n;
  return out;
}

export async function fetchSproutCounts(userId: string): Promise<SproutCounts> {
  const cached = await getCachedCounts(userId);

  const [expenses, paidSettlements, debtorSettlements, scans, friends, circles] =
    await Promise.all([
      paidByMeDays(userId, 'expense'),
      paidByMeDays(userId, 'settlement'),
      debtorSettlementDays(userId),
      scanDays(userId),
      friendDays(userId),
      circleCounts(userId),
    ]);

  // Settlements need both halves; if either failed, keep the cached total.
  const settlementsByDay =
    paidSettlements && debtorSettlements
      ? mergeDays(paidSettlements, debtorSettlements)
      : cached.settlementsByDay;

  const counts: SproutCounts = {
    expensesByDay: expenses ?? cached.expensesByDay,
    settlementsByDay,
    scansByDay: scans ?? cached.scansByDay,
    friendsByDay: friends ?? cached.friendsByDay,
    circles: circles ? circles.circles : cached.circles,
    circlesSquared: circles ? circles.circlesSquared : cached.circlesSquared,
  };
  await saveCounts(userId, counts);
  return counts;
}
