import { supabase } from './supabase';
import { categoryMeta } from './categories';

/**
 * Real spending analytics, derived from the transaction ledger AND
 * personal_transactions (see supabase/migrations/0036_personal_transactions.sql).
 * This stays the single place spend numbers are computed — the same
 * single-source-of-truth convention lib/balances.ts already established for
 * balances/debts. A second parallel calculator for personal spend would be
 * exactly the failure mode that convention exists to prevent.
 *
 * "Your spending" on the split side is the sum of YOUR OWN share of each
 * expense (transaction_splits.share_amount where user_id = you) — not what
 * you paid out. Those differ whenever someone fronts a bill: paying ₹1000
 * for a table of four is ₹250 of spending, not ₹1000. Using amounts paid
 * would overstate the spending of whoever happens to hold the card.
 *
 * Settlements are excluded (type = 'settlement'). Paying a friend back moves
 * money without consuming anything; counting it would double-count the
 * original expense. Voided rows are excluded on both sides; 'settled' split
 * rows are kept, since settling an expense does not un-spend it (migrations/0006).
 * Personal rows are only counted when status = 'confirmed' — a
 * 'needs_review' row (reserved for a future ingestion path, unused by
 * anything that writes today) is an unreviewed model guess, not a real
 * number, and must never move anyone's spend total.
 *
 * THREE SCOPES, ONE FETCH
 *
 * `overall` is built by summing the `split` and `personal` per-month and
 * per-category entries, never computed independently — additivity
 * (personal + split = overall) holds by construction, not by coincidence.
 * The one place this does NOT extend to: each scope's category
 * `percentage` is that category's share of ITS OWN scope's spend, so
 * overall's percentages do not equal split% + personal%. Amounts add;
 * percentages don't. This is intentional, not a bug to reconcile.
 *
 * Split spend buckets by transactions.created_at; personal spend buckets by
 * personal_transactions.occurred_at. Deliberate asymmetry: a screenshot of
 * last week's coffee is last week's spending, not today's, and transactions
 * has no occurred-at equivalent to bucket by instead.
 *
 * Personal rows are summed regardless of currency — this app is
 * single-currency today (users.base_currency is hardcoded 'INR' at
 * signup; transactions has no currency column at all), so this is a known
 * v1 limitation, not silently hidden behind a currency filter that would
 * make foreign-currency rows vanish.
 *
 * WINDOWED, ONE GRAIN PER PRESET
 *
 * Everything — headline spend, comparison %, category breakdown, expense
 * count, and the trend chart — is scoped to a caller-chosen trailing window
 * (`WindowPreset`), all reading the same period. 6m/12m stay whole calendar
 * months, as before (this screen went through two wrong shapes before
 * landing here: a rolling N-day window that didn't read as "months" at all,
 * then a chart with daily bars under a monthly label — mismatched grain).
 * 1w/1m are a deliberate second grain on top of that: 7 trailing days and 4
 * trailing 7-day blocks respectively (not the current calendar month split
 * into its actual, variable 4-5 weeks — a fixed 4 bars is simpler and is
 * what "1 month" was asked for as). Both grains share one result shape
 * (`ScopeBreakdown`) and one drill-down mechanism (`SeriesPoint.monthKey` /
 * `monthlyDetail`, generalized from "the tapped bar's month" to "the tapped
 * bar's bucket," whatever grain it is) — buildBucketBreakdown() below is
 * what buildWindowBreakdown() delegates to for 1w/1m.
 *
 * "Previous period" for the comparison % is the equal-length span
 * immediately before the window, at whatever grain the window itself uses.
 * This is a separate concept from `myMonthlyAverage` / `groupMonthlyAverage`
 * below, which stay a long-run average over all fetched history regardless
 * of the selected window — "your average month" isn't a question the window
 * selector should be able to change the answer to.
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
  /** Bucket key — "YYYY-MM" for a month bar (6m/12m), a day or week key for
   *  1w/1m. Lets the screen look up this bar in `monthlyDetail` when tapped,
   *  regardless of what grain it actually represents. */
  monthKey: string;
}

export interface MonthDetail {
  spend: number;
  count: number;
  categories: CategorySpend[];
  /** "August 2026" — full label for the drill-down header, distinct from the bar's 3-letter label. */
  fullLabel: string;
}

export type SpendScope = 'overall' | 'split' | 'personal';

/** Window shown/summed on the Insights tab: trailing 7 days, trailing 4
 *  weeks, or trailing whole calendar months (6 or 12). */
export type WindowPreset = '1w' | '1m' | '6m' | '12m';
export const WINDOW_MONTHS: Record<'6m' | '12m', number> = { '6m': 6, '12m': 12 };
const MAX_WINDOW_MONTHS = Math.max(...Object.values(WINDOW_MONTHS));

export interface ScopeBreakdown {
  /** Spend across the selected trailing window (6 or 12 calendar months, including the current one). */
  windowSpend: number;
  /** Spend in the equal-length block of months immediately before the window. */
  previousWindowSpend: number;
  /** Percent change vs the previous period. null when there is no prior-period spend to compare. */
  changePercent: number | null;
  /** Category breakdown for the selected window. */
  categories: CategorySpend[];
  /** One point per calendar month in the window, oldest first. */
  series: SeriesPoint[];
  /** Same months as `series`, keyed by "YYYY-MM", for drilling into a single tapped bar. */
  monthlyDetail: Record<string, MonthDetail>;
  /** Average monthly spend across months that actually have data, in this scope — independent of the selected window. */
  myMonthlyAverage: number | null;
  topCategory: CategorySpend | null;
  /** Number of expenses in this scope within the selected window. */
  windowExpenseCount: number;
  /** False when this scope has no activity at all in the fetched history — render an empty state, not zeros. */
  hasAnyData: boolean;
}

export interface AnalyticsData {
  overall: ScopeBreakdown;
  split: ScopeBreakdown;
  personal: ScopeBreakdown;
  /** Average monthly spend of others you share groups with. A split-side-only concept — comparing personal spend to a group average is meaningless. null if you share no groups. */
  groupMonthlyAverage: number | null;
  /** False when there is no activity in any scope — render the top-level empty state. */
  hasAnyData: boolean;
}

interface Entry {
  date: Date;
  amount: number;
  category: string;
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function emptyBreakdown(): ScopeBreakdown {
  return {
    windowSpend: 0,
    previousWindowSpend: 0,
    changePercent: null,
    categories: [],
    series: [],
    monthlyDetail: {},
    myMonthlyAverage: null,
    topCategory: null,
    windowExpenseCount: 0,
    hasAnyData: false,
  };
}

interface WindowMonth {
  key: string;
  label: string;
  fullLabel: string;
}

/** The trailing `monthsBack` calendar months up to `now`, oldest first. Shared by the series and the
 *  per-month drill-down below so both agree on exactly which months are "in the window". */
function windowMonths(now: Date, monthsBack: number): WindowMonth[] {
  const months: WindowMonth[] = [];
  for (let back = monthsBack - 1; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    months.push({
      key: monthKey(d),
      label: MONTH_LABELS[d.getMonth()],
      fullLabel: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    });
  }
  return months;
}

/** One point per calendar month across the given months, oldest first. */
function buildMonthlySeries(entries: Entry[], months: WindowMonth[]): SeriesPoint[] {
  const byMonth: Record<string, number> = {};
  for (const e of entries) {
    byMonth[monthKey(e.date)] = (byMonth[monthKey(e.date)] || 0) + e.amount;
  }
  return months.map((m) => ({ label: m.label, value: byMonth[m.key] || 0, monthKey: m.key }));
}

/** Per-month spend, count and category breakdown — what a tapped bar drills into. */
function buildMonthlyDetail(entries: Entry[], months: WindowMonth[]): Record<string, MonthDetail> {
  const byMonthCategory: Record<string, Record<string, number>> = {};
  const byMonthCount: Record<string, number> = {};
  for (const e of entries) {
    const key = monthKey(e.date);
    if (!byMonthCategory[key]) byMonthCategory[key] = {};
    byMonthCategory[key][e.category] = (byMonthCategory[key][e.category] || 0) + e.amount;
    byMonthCount[key] = (byMonthCount[key] || 0) + 1;
  }

  const detail: Record<string, MonthDetail> = {};
  for (const m of months) {
    const byCategory = byMonthCategory[m.key] || {};
    const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
    const categories: CategorySpend[] = Object.entries(byCategory)
      .map(([id, amount]) => {
        const meta = categoryMeta(id);
        return {
          id,
          name: meta.name,
          icon: meta.icon,
          amount,
          percentage: total > 0 ? Math.round((amount / total) * 100) : 0,
        };
      })
      .sort((a, b) => b.amount - a.amount);

    detail[m.key] = { spend: total, count: byMonthCount[m.key] || 0, categories, fullLabel: m.fullLabel };
  }
  return detail;
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface Bucket {
  key: string;
  label: string;
  fullLabel: string;
  start: Date;
  /** Exclusive. */
  end: Date;
}

/** Trailing `daysBack` calendar days ending today (inclusive), oldest first. Used by the 1-week preset. */
function dayBuckets(today: Date, daysBack: number): Bucket[] {
  const buckets: Bucket[] = [];
  for (let back = daysBack - 1; back >= 0; back--) {
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
    buckets.push({
      key: `day_${start.toISOString().slice(0, 10)}`,
      label: DAY_LABELS[start.getDay()],
      fullLabel: start.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'short' }),
      start,
      end,
    });
  }
  return buckets;
}

/** Trailing `weeksBack` 7-day blocks ending today (inclusive), oldest first. Used by the 1-month preset —
 *  a fixed 4 bars rather than the current calendar month's variable 4-5 week split. */
function weekBuckets(today: Date, weeksBack: number): Bucket[] {
  const buckets: Bucket[] = [];
  for (let back = weeksBack - 1; back >= 0; back--) {
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back * 7);
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 6);
    const endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    buckets.push({
      key: `wk_${start.toISOString().slice(0, 10)}`,
      label: back === 0 ? 'This wk' : `${back}w ago`,
      fullLabel: `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
      start,
      end: endExclusive,
    });
  }
  return buckets;
}

/** Same shape as buildWindowBreakdown below, for an arbitrary list of day/week buckets instead of whole
 *  calendar months. "Previous period" is the equal-length span immediately before the first bucket. */
function buildBucketBreakdown(entries: Entry[], buckets: Bucket[]) {
  const windowStart = buckets[0].start;
  const windowEnd = buckets[buckets.length - 1].end;
  const prevStart = new Date(windowStart.getTime() - (windowEnd.getTime() - windowStart.getTime()));

  let windowSpend = 0;
  let previousWindowSpend = 0;
  let windowExpenseCount = 0;
  const byCategory: Record<string, number> = {};
  const byBucketCategory: Record<string, Record<string, number>> = {};
  const byBucketCount: Record<string, number> = {};

  for (const e of entries) {
    if (e.date >= windowStart && e.date < windowEnd) {
      windowSpend += e.amount;
      windowExpenseCount += 1;
      byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;

      const b = buckets.find((bk) => e.date >= bk.start && e.date < bk.end);
      if (b) {
        if (!byBucketCategory[b.key]) byBucketCategory[b.key] = {};
        byBucketCategory[b.key][e.category] = (byBucketCategory[b.key][e.category] || 0) + e.amount;
        byBucketCount[b.key] = (byBucketCount[b.key] || 0) + 1;
      }
    } else if (e.date >= prevStart && e.date < windowStart) {
      previousWindowSpend += e.amount;
    }
  }

  const changePercent =
    previousWindowSpend > 0 ? ((windowSpend - previousWindowSpend) / previousWindowSpend) * 100 : null;

  const categoryTotal = Object.values(byCategory).reduce((a, b) => a + b, 0);
  const categories: CategorySpend[] = Object.entries(byCategory)
    .map(([id, amount]) => {
      const meta = categoryMeta(id);
      return {
        id,
        name: meta.name,
        icon: meta.icon,
        amount,
        percentage: categoryTotal > 0 ? Math.round((amount / categoryTotal) * 100) : 0,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const series: SeriesPoint[] = buckets.map((b) => {
    const byCat = byBucketCategory[b.key] || {};
    return { label: b.label, value: Object.values(byCat).reduce((a, c) => a + c, 0), monthKey: b.key };
  });

  const monthlyDetail: Record<string, MonthDetail> = {};
  for (const b of buckets) {
    const byCat = byBucketCategory[b.key] || {};
    const total = Object.values(byCat).reduce((a, c) => a + c, 0);
    const cats: CategorySpend[] = Object.entries(byCat)
      .map(([id, amount]) => {
        const meta = categoryMeta(id);
        return { id, name: meta.name, icon: meta.icon, amount, percentage: total > 0 ? Math.round((amount / total) * 100) : 0 };
      })
      .sort((a, b) => b.amount - a.amount);
    monthlyDetail[b.key] = { spend: total, count: byBucketCount[b.key] || 0, categories: cats, fullLabel: b.fullLabel };
  }

  return {
    windowSpend,
    previousWindowSpend,
    changePercent,
    categories,
    series,
    monthlyDetail,
    topCategory: categories[0] || null,
    windowExpenseCount,
  };
}

/** Everything that depends on the selected window: spend, comparison, categories, series, count. */
function buildWindowBreakdown(entries: Entry[], now: Date, preset: WindowPreset) {
  if (preset === '1w' || preset === '1m') {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return buildBucketBreakdown(entries, preset === '1w' ? dayBuckets(today, 7) : weekBuckets(today, 4));
  }

  // preset is narrowed to '6m' | '12m' here — the two early returns above
  // cover '1w'/'1m', so WINDOW_MONTHS[preset] below is exhaustive.
  const windowMonthCount = WINDOW_MONTHS[preset];
  const windowStart = new Date(now.getFullYear(), now.getMonth() - windowMonthCount + 1, 1);
  const prevWindowStart = new Date(windowStart.getFullYear(), windowStart.getMonth() - windowMonthCount, 1);

  let windowSpend = 0;
  let previousWindowSpend = 0;
  let windowExpenseCount = 0;
  const byCategory: Record<string, number> = {};

  for (const e of entries) {
    if (e.date >= windowStart) {
      windowSpend += e.amount;
      windowExpenseCount += 1;
      byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
    } else if (e.date >= prevWindowStart) {
      previousWindowSpend += e.amount;
    }
  }

  const changePercent =
    previousWindowSpend > 0 ? ((windowSpend - previousWindowSpend) / previousWindowSpend) * 100 : null;

  const categoryTotal = Object.values(byCategory).reduce((a, b) => a + b, 0);
  const categories: CategorySpend[] = Object.entries(byCategory)
    .map(([id, amount]) => {
      const meta = categoryMeta(id);
      return {
        id,
        name: meta.name,
        icon: meta.icon,
        amount,
        percentage: categoryTotal > 0 ? Math.round((amount / categoryTotal) * 100) : 0,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  const months = windowMonths(now, windowMonthCount);

  return {
    windowSpend,
    previousWindowSpend,
    changePercent,
    categories,
    series: buildMonthlySeries(entries, months),
    monthlyDetail: buildMonthlyDetail(entries, months),
    topCategory: categories[0] || null,
    windowExpenseCount,
  };
}

/** Combines the windowed figures above with the window-independent monthly average and history flag. */
function buildScope(
  entries: Entry[],
  byMonth: Record<string, number>,
  now: Date,
  preset: WindowPreset,
): ScopeBreakdown {
  const activeMonths = Object.values(byMonth).filter((v) => v > 0);
  const myMonthlyAverage =
    activeMonths.length > 0 ? activeMonths.reduce((a, b) => a + b, 0) / activeMonths.length : null;

  return {
    ...buildWindowBreakdown(entries, now, preset),
    myMonthlyAverage,
    hasAnyData: Object.keys(byMonth).length > 0,
  };
}

export async function fetchAnalytics(preset: WindowPreset): Promise<AnalyticsData> {
  const empty: AnalyticsData = {
    overall: emptyBreakdown(),
    split: emptyBreakdown(),
    personal: emptyBreakdown(),
    groupMonthlyAverage: null,
    hasAnyData: false,
  };

  const { data: authData } = await supabase.auth.getUser();
  const userId = authData?.user?.id;
  if (!userId) return empty;

  // Twice the largest window this file supports (12 → 24 months back), so
  // even the 12-month preset's "previous period" comparison has a full
  // prior 12 months of data behind it. RLS already limits both queries to
  // rows the user is party to / owns.
  const since = new Date();
  since.setMonth(since.getMonth() - (2 * MAX_WINDOW_MONTHS - 1));
  since.setDate(1);
  since.setHours(0, 0, 0, 0);

  const [{ data: txs, error: txError }, { data: personalRows, error: personalError }] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, category, created_at, status, type, group_id, transaction_splits (user_id, share_amount)')
      .gte('created_at', since.toISOString()),
    supabase
      .from('personal_transactions')
      .select('id, amount, category, occurred_at, status')
      .eq('status', 'confirmed')
      .gte('occurred_at', since.toISOString()),
  ]);

  if (txError) throw new Error(txError.message);
  if (personalError) throw new Error(personalError.message);

  const now = new Date();
  const isCounted = (t: any) => t.type !== 'settlement' && t.status !== 'voided';

  // ---- split side: my spend, both as a by-month map (average) and a flat
  // entry list (window figures) --------------------------------------------
  const splitByMonth: Record<string, number> = {};
  const splitEntries: Entry[] = [];

  for (const t of txs ?? []) {
    if (!isCounted(t)) continue;
    const splits = (t as any).transaction_splits || [];
    const mine = splits.find((s: any) => s.user_id === userId);
    if (!mine) continue;

    const share = Number(mine.share_amount) || 0;
    if (share <= 0) continue;

    const date = new Date(t.created_at);
    splitByMonth[monthKey(date)] = (splitByMonth[monthKey(date)] || 0) + share;
    splitEntries.push({ date, amount: share, category: t.category || 'other' });
  }

  // ---- personal side: same shape, bucketed by occurred_at -----------------
  const personalByMonth: Record<string, number> = {};
  const personalEntries: Entry[] = [];

  for (const row of personalRows ?? []) {
    const amount = Number(row.amount) || 0;
    if (amount <= 0) continue;

    const date = new Date(row.occurred_at);
    personalByMonth[monthKey(date)] = (personalByMonth[monthKey(date)] || 0) + amount;
    personalEntries.push({ date, amount, category: row.category || 'other' });
  }

  const split = buildScope(splitEntries, splitByMonth, now, preset);
  const personal = buildScope(personalEntries, personalByMonth, now, preset);

  // ---- overall: split + personal entries/months, summed by construction ---
  const overallByMonth: Record<string, number> = { ...splitByMonth };
  for (const [key, value] of Object.entries(personalByMonth)) {
    overallByMonth[key] = (overallByMonth[key] || 0) + value;
  }
  const overall = buildScope([...splitEntries, ...personalEntries], overallByMonth, now, preset);

  // ---- group comparison — split-side only, monthly, independent of window
  // ---------------------------------------------------------------------
  // Everyone else's share on group expenses the user can see. RLS scopes this
  // to groups the user belongs to, so it is genuinely "people I split with".
  // Comparing personal spend to this average would be meaningless, so it
  // lives at the top level, not per-scope.
  const othersByMonthUser: Record<string, number> = {};
  for (const t of txs ?? []) {
    if (!isCounted(t)) continue;
    if (!t.group_id) continue;
    const splits = (t as any).transaction_splits || [];
    const key = monthKey(new Date(t.created_at));
    for (const s of splits) {
      if (s.user_id === userId) continue;
      const share = Number(s.share_amount) || 0;
      if (share <= 0) continue;
      othersByMonthUser[`${key}|${s.user_id}`] = (othersByMonthUser[`${key}|${s.user_id}`] || 0) + share;
    }
  }
  const otherValues = Object.values(othersByMonthUser);
  const groupMonthlyAverage =
    otherValues.length > 0 ? otherValues.reduce((a, b) => a + b, 0) / otherValues.length : null;

  return {
    overall,
    split,
    personal,
    groupMonthlyAverage,
    hasAnyData: overall.hasAnyData,
  };
}
