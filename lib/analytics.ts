import { supabase } from './supabase';

/**
 * Real spending analytics, derived from the transaction ledger.
 *
 * "Your spending" is the sum of YOUR OWN share of each expense
 * (transaction_splits.share_amount where user_id = you) — not what you paid
 * out. Those differ whenever someone fronts a bill: paying ₹1000 for a table
 * of four is ₹250 of spending, not ₹1000. Using amounts paid would overstate
 * the spending of whoever happens to hold the card.
 *
 * Settlements are excluded (type = 'settlement'). Paying a friend back moves
 * money without consuming anything; counting it would double-count the
 * original expense. Voided rows are excluded; 'settled' rows are kept, since
 * settling an expense does not un-spend it (see migrations/0006).
 */

export interface CategorySpend {
  id: string;
  name: string;
  amount: number;
  percentage: number;
  icon: string;
}

export interface SeriesPoint {
  label: string;
  value: number;
}

export interface AnalyticsData {
  monthlySpend: number;
  previousMonthSpend: number;
  /** Percent change vs last month. null when there is no prior month to compare. */
  changePercent: number | null;
  categories: CategorySpend[];
  /** Cumulative spend across the current month, for the trend chart. */
  series: SeriesPoint[];
  /** Your average monthly spend across months that actually have data. */
  myMonthlyAverage: number | null;
  /** Average monthly spend of others you share groups with. null if you share none. */
  groupMonthlyAverage: number | null;
  /** False when the user has no expenses at all — render an empty state, not zeros. */
  hasAnyData: boolean;
  topCategory: CategorySpend | null;
  /** Number of expenses you were part of this month. */
  monthExpenseCount: number;
}

const CATEGORY_META: Record<string, { name: string; icon: string }> = {
  food: { name: 'Food & Dining', icon: 'restaurant' },
  travel: { name: 'Travel & Transport', icon: 'flight' },
  home: { name: 'Home', icon: 'home' },
  utilities: { name: 'Rent & Utilities', icon: 'bolt' },
  other: { name: 'Miscellaneous', icon: 'category' },
};

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export async function fetchAnalytics(): Promise<AnalyticsData> {
  const empty: AnalyticsData = {
    monthlySpend: 0,
    previousMonthSpend: 0,
    changePercent: null,
    categories: [],
    series: [],
    myMonthlyAverage: null,
    groupMonthlyAverage: null,
    hasAnyData: false,
    topCategory: null,
    monthExpenseCount: 0,
  };

  const { data: authData } = await supabase.auth.getUser();
  const userId = authData?.user?.id;
  if (!userId) return empty;

  // Six months back, so month-over-month and the average have history to work
  // with. RLS already limits this to transactions the user is party to.
  const since = new Date();
  since.setMonth(since.getMonth() - 5);
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const { data: txs, error } = await supabase
    .from('transactions')
    .select('id, category, created_at, status, type, group_id, transaction_splits (user_id, share_amount)')
    .gte('created_at', since.toISOString());

  if (error) throw new Error(error.message);
  if (!txs || txs.length === 0) return empty;

  const isCounted = (t: any) =>
    t.type !== 'settlement' && t.status !== 'voided';

  // ---- my spend, by month and by category -------------------------------
  const byMonth: Record<string, number> = {};
  const byCategory: Record<string, number> = {};
  const now = new Date();
  const thisMonth = monthKey(now);
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = monthKey(prev);

  let monthExpenseCount = 0;

  for (const t of txs) {
    if (!isCounted(t)) continue;
    const splits = (t as any).transaction_splits || [];
    const mine = splits.find((s: any) => s.user_id === userId);
    if (!mine) continue;

    const share = Number(mine.share_amount) || 0;
    if (share <= 0) continue;

    const created = new Date(t.created_at);
    const key = monthKey(created);
    byMonth[key] = (byMonth[key] || 0) + share;

    if (key === thisMonth) {
      byCategory[t.category || 'other'] = (byCategory[t.category || 'other'] || 0) + share;
      monthExpenseCount += 1;
    }
  }

  const monthlySpend = byMonth[thisMonth] || 0;
  const previousMonthSpend = byMonth[prevMonth] || 0;

  const changePercent =
    previousMonthSpend > 0
      ? ((monthlySpend - previousMonthSpend) / previousMonthSpend) * 100
      : null;

  // ---- categories --------------------------------------------------------
  const categoryTotal = Object.values(byCategory).reduce((a, b) => a + b, 0);
  const categories: CategorySpend[] = Object.entries(byCategory)
    .map(([id, amount]) => ({
      id,
      name: CATEGORY_META[id]?.name || id,
      icon: CATEGORY_META[id]?.icon || 'category',
      amount,
      percentage: categoryTotal > 0 ? Math.round((amount / categoryTotal) * 100) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  // ---- last 6 months, oldest first ---------------------------------------
  const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const series: SeriesPoint[] = [];
  for (let back = 5; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    series.push({
      label: MONTH_LABELS[d.getMonth()],
      value: byMonth[monthKey(d)] || 0,
    });
  }

  // ---- my average across months that have activity -----------------------
  const activeMonths = Object.values(byMonth).filter(v => v > 0);
  const myMonthlyAverage =
    activeMonths.length > 0
      ? activeMonths.reduce((a, b) => a + b, 0) / activeMonths.length
      : null;

  // ---- group comparison --------------------------------------------------
  // Everyone else's share on group expenses the user can see. RLS scopes this
  // to groups the user belongs to, so it is genuinely "people I split with".
  const othersByMonthUser: Record<string, number> = {};
  for (const t of txs) {
    if (!isCounted(t)) continue;
    if (!t.group_id) continue;
    const splits = (t as any).transaction_splits || [];
    const created = new Date(t.created_at);
    const key = monthKey(created);
    for (const s of splits) {
      if (s.user_id === userId) continue;
      const share = Number(s.share_amount) || 0;
      if (share <= 0) continue;
      othersByMonthUser[`${key}|${s.user_id}`] =
        (othersByMonthUser[`${key}|${s.user_id}`] || 0) + share;
    }
  }
  const otherValues = Object.values(othersByMonthUser);
  const groupMonthlyAverage =
    otherValues.length > 0
      ? otherValues.reduce((a, b) => a + b, 0) / otherValues.length
      : null;

  const hasAnyData = Object.keys(byMonth).length > 0;

  return {
    monthlySpend,
    previousMonthSpend,
    changePercent,
    categories,
    series,
    myMonthlyAverage,
    groupMonthlyAverage,
    hasAnyData,
    topCategory: categories[0] || null,
    monthExpenseCount,
  };
}
