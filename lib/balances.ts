import { supabase } from './supabase';
import { getRelatedUsers } from './friendFetcher';

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
export async function fetchBalanceMap(userId: string): Promise<Record<string, number>> {
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
 * Everything the balance-showing screens need, in one call.
 *
 * `totalBalance` is derived from the same map that produces `friends`, so the
 * headline figure and the rows underneath it can never disagree.
 */
export async function fetchBalances(): Promise<BalanceSnapshot> {
  const { data: authData } = await supabase.auth.getUser();
  const userId = authData?.user?.id;
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
