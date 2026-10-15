import { supabase } from './supabase';
import { getRelatedUsers } from './friendFetcher';
import { withOfflineFallback } from './offlineCache';

/**
 * THE single source of truth for "who owes whom".
 *
 * This module exists because the same balance used to be computed five
 * separate times — Home's total, Home's friend rows, the Friends list, the
 * friend detail screen, and the settle-up picker each ran their own query
 * with their own filters. They disagreed, which is why Home could show a
 * balance while Settle Up reported nothing to settle: the two screens were
 * not reading the same thing.
 *
 * Every balance shown anywhere in the app must come from here. If a screen
 * needs a number this module does not expose, add it here rather than
 * querying the ledger directly.
 *
 * SIGN CONVENTION (used everywhere):
 *   balance > 0  -> they owe you       -> status 'owed'
 *   balance < 0  -> you owe them       -> status 'owes'
 *   balance == 0 -> settled
 *
 * The ledger (`simplified_settlements`) is authoritative. It is rebuilt
 * atomically server-side by recalculate_group_settlements /
 * recalculate_pair_settlements (migrations 0003/0006) whenever a transaction
 * changes, so screens should read it rather than recompute from raw
 * transactions — recomputing locally is what let the friend detail screen
 * drift out of step with everything else.
 */

export type BalanceStatus = 'owed' | 'owes' | 'settled';

export interface FriendBalance {
  id: string;
  name: string;
  fullName: string;
  phoneNumber: string;
  avatarUrl?: string;
  initials: string;
  /** Signed. Positive means they owe you. */
  balance: number;
  status: BalanceStatus;
}

export interface BalanceSnapshot {
  /** Signed net across every relationship. Positive means you are owed overall. */
  totalBalance: number;
  /** Everyone you have any relationship with, including settled (balance 0). */
  friends: FriendBalance[];
  /** Only those with a non-trivial outstanding balance — what Settle Up should offer. */
  outstanding: FriendBalance[];
  /** null when this snapshot is live; an ISO timestamp when it's a cached fallback. */
  cachedAt?: string | null;
}

export function statusFor(balance: number): BalanceStatus {
  if (balance > 0.005) return 'owed';
  if (balance < -0.005) return 'owes';
  return 'settled';
}

function initialsFor(name: string) {
  return (
    name
      .split(' ')
      .filter(Boolean)
      .map(n => n.charAt(0))
      .join('')
      .toUpperCase()
      .slice(0, 2) || 'U'
  );
}

/**
 * Signed balance per counterparty, keyed by user id.
 *
 * Includes group ledger rows as well as 1-on-1 ones. Screens used to differ
 * on this — some passed `.is('group_id', null)` and some did not — so a debt
 * inside a group appeared on one screen and vanished on another.
 */
async function fetchBalanceMapLive(userId: string): Promise<Record<string, number>> {
  const { data: settlements, error } = await supabase
    .from('simplified_settlements')
    .select('debtor_id, creditor_id, amount')
    .or(`debtor_id.eq.${userId},creditor_id.eq.${userId}`);

  if (error) throw new Error(error.message);

  const map: Record<string, number> = {};
  for (const s of settlements ?? []) {
    const amount = Number(s.amount) || 0;
    if (s.creditor_id === userId) {
      // They owe me.
      map[s.debtor_id] = (map[s.debtor_id] || 0) + amount;
    } else if (s.debtor_id === userId) {
      // I owe them.
      map[s.creditor_id] = (map[s.creditor_id] || 0) - amount;
    }
  }
  return map;
}

/**
 * Falls back to the last cached map on a network error so a friend's
 * balance doesn't go blank offline. Every caller gets this transparently.
 */
export async function fetchBalanceMap(userId: string): Promise<Record<string, number>> {
  const { data } = await withOfflineFallback(
    `balanceMap.${userId}`,
    () => fetchBalanceMapLive(userId),
  );
  return data;
}

/** One row of the materialised ledger, as stored. */
export interface LedgerRow {
  /** null for a 1-on-1 debt; a group id for a debt inside that group. */
  group_id: string | null;
  debtor_id: string;
  creditor_id: string;
  amount: number;
}

/**
 * The raw ledger rows involving this user, un-aggregated.
 *
 * fetchBalanceMap collapses every scope into one number per counterparty, which
 * is right for Home, Friends and Settle Up — they show the overall relationship.
 * It is wrong for anything reasoning about a single expense, because a group
 * debt and a 1-on-1 debt with the same person are separate obligations that
 * must not offset each other.
 *
 * Fetching the rows and scoping them locally keeps this to one round trip even
 * when the caller does not yet know which scope it needs.
 */
async function fetchBalanceRowsLive(userId: string): Promise<LedgerRow[]> {
  const { data, error } = await supabase
    .from('simplified_settlements')
    .select('group_id, debtor_id, creditor_id, amount')
    .or(`debtor_id.eq.${userId},creditor_id.eq.${userId}`);

  if (error) throw new Error(error.message);

  return (data ?? []).map(r => ({
    group_id: (r as any).group_id ?? null,
    debtor_id: (r as any).debtor_id,
    creditor_id: (r as any).creditor_id,
    amount: Number((r as any).amount) || 0,
  }));
}

/** Falls back to the last cached rows on a network error. */
export async function fetchBalanceRows(userId: string): Promise<LedgerRow[]> {
  const { data } = await withOfflineFallback(
    `balanceRows.${userId}`,
    () => fetchBalanceRowsLive(userId),
  );
  return data;
}

/**
 * Signed balance per counterparty within one scope only.
 *
 * `groupId` null means 1-on-1 debts; a group id means debts inside that group.
 * Same sign convention as everywhere else: positive means they owe you.
 */
export function balanceMapForScope(
  rows: LedgerRow[],
  userId: string,
  groupId: string | null,
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of rows) {
    if ((r.group_id ?? null) !== groupId) continue;
    if (r.creditor_id === userId) {
      map[r.debtor_id] = (map[r.debtor_id] || 0) + r.amount;
    } else if (r.debtor_id === userId) {
      map[r.creditor_id] = (map[r.creditor_id] || 0) - r.amount;
    }
  }
  return map;
}

/**
 * Signed net balance per group the user belongs to (1-on-1 rows excluded).
 * Same sign convention as everywhere else: positive means you are owed.
 */
export function groupBalanceMap(rows: LedgerRow[], userId: string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const r of rows) {
    if (!r.group_id) continue;
    if (r.creditor_id === userId) {
      map[r.group_id] = (map[r.group_id] || 0) + r.amount;
    } else if (r.debtor_id === userId) {
      map[r.group_id] = (map[r.group_id] || 0) - r.amount;
    }
  }
  return map;
}

/** "+₹250" / "-₹180" / "Settled" — the compact form used on cards and strips. */
export function formatBalanceLabel(balance: number): string {
  if (balance > 0.005) return `+₹${balance.toFixed(0)}`;
  if (balance < -0.005) return `-₹${Math.abs(balance).toFixed(0)}`;
  return 'Settled';
}

/**
 * Everything the balance-showing screens need, in one call.
 *
 * `totalBalance` is derived from the same map that produces `friends`, so the
 * headline figure and the rows underneath it can never disagree.
 */
async function fetchBalancesLive(): Promise<BalanceSnapshot> {
  // getSession() reads the session from local storage; getUser() makes a
  // network round-trip to revalidate it. Using getUser() here meant a slow
  // or degraded connection (not full offline — no exception, just a failed
  // background call) silently looked identical to "not logged in", which
  // returned an empty snapshot as if it were a genuine successful result.
  // That empty result then got written into the cache via writeCache,
  // overwriting real cached balances/friends with zeros — worse than doing
  // nothing, since it destroyed the exact fallback data this file exists to
  // preserve.
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) {
    return { totalBalance: 0, friends: [], outstanding: [] };
  }

  const [balanceMap, relatedUsers] = await Promise.all([
    fetchBalanceMap(userId),
    getRelatedUsers(userId, 'id, full_name, avatar_url, phone_number'),
  ]);

  const friends: FriendBalance[] = (relatedUsers ?? []).map((u: any) => {
    const fullName = u.full_name || 'Unknown';
    const balance = balanceMap[u.id] || 0;
    return {
      id: u.id,
      name: fullName.split(' ')[0] || fullName,
      fullName,
      phoneNumber: u.phone_number || '',
      avatarUrl: u.avatar_url || undefined,
      initials: initialsFor(fullName),
      balance,
      status: statusFor(balance),
    };
  });

  // A counterparty can carry a balance without appearing in getRelatedUsers
  // (for instance a placeholder friend whose profile row is not visible under
  // the current RLS policy). Dropping them would hide a real debt, so surface
  // them rather than silently omitting the money.
  for (const [otherId, balance] of Object.entries(balanceMap)) {
    if (friends.some(f => f.id === otherId)) continue;
    if (Math.abs(balance) <= 0.005) continue;
    friends.push({
      id: otherId,
      name: 'Unknown',
      fullName: 'Unknown',
      phoneNumber: '',
      initials: 'U',
      balance,
      status: statusFor(balance),
    });
  }

  friends.sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance));

  const totalBalance = Object.values(balanceMap).reduce((sum, v) => sum + v, 0);
  const outstanding = friends.filter(f => Math.abs(f.balance) > 0.005);

  return { totalBalance, friends, outstanding };
}

/**
 * Falls back to the last cached snapshot on a network error, so a cold
 * start with no connection shows the last-known balances instead of ₹0 —
 * the same "don't lie about being settled up" concern this file already
 * cares about, just covering the case where there's nothing in memory yet
 * to fall back to (see GlobalBalancesContext's own in-memory keep-previous
 * behavior, which handles going offline mid-session).
 */
export async function fetchBalances(): Promise<BalanceSnapshot> {
  const { data, cachedAt } = await withOfflineFallback('balances', fetchBalancesLive);
  return { ...data, cachedAt };
}
