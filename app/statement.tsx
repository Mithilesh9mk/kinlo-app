import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { supabase } from '../lib/supabase';
import { fetchBalances } from '../lib/balances';
import { useGlobalBalances } from '../context/GlobalBalancesContext';
import { Skeleton, SkeletonListRow } from '../components/Skeleton';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { AnimatedListItem } from '../components/AnimatedListItem';
import { listPersonalTransactions } from '../lib/personalTransactions';
import { readCache, writeCache, isLikelyNetworkError } from '../lib/offlineCache';
import { OfflineBanner } from '../components/OfflineBanner';
import { formatINR, tabularNums } from '../lib/format';

// 'Personal' and 'Split' partition the feed by which ledger a row came from;
// 'You Paid' / 'You Owe' partition it by debt direction. Those two ideas are
// independent, and debt direction is meaningless for a personal expense (you
// paid yourself — nobody owes anybody), so personal rows are excluded from
// the latter two rather than being forced into one of them.
type FilterType = 'All' | 'Personal' | 'Split' | 'You Paid' | 'You Owe';

const STATEMENT_CACHE_KEY = 'statement.transactions';

/**
 * JSON.stringify turns `date: Date` into a plain ISO string, and JSON.parse
 * (inside readCache) does not revive it back — a cached row's `date` field
 * would silently become a string at runtime while TypeScript still thinks
 * it's a Date. Nothing downstream currently calls .getTime() on a
 * cache-restored row, but re-hydrating on the way out keeps the interface's
 * own contract true rather than relying on that staying accidentally safe.
 */
function reviveStatementCacheDates(rows: StatementTx[]): StatementTx[] {
  return rows.map((t) => ({ ...t, date: new Date(t.date) }));
}

interface StatementTx {
  id: string;
  description: string;
  groupOrFriendName: string;
  category: string;
  totalAmount: number;
  userShare: number;
  isPayer: boolean;
  date: Date;
  dateString: string;
  status?: string;
  paidByUserId: string;
  type?: string;
  /** Which ledger this row came from. Personal rows never touch balances. */
  entryType: 'personal' | 'split';
}

export default function StatementScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  
  const [transactions, setTransactions] = useState<StatementTx[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed fetch used to render as "No transactions", which is
  // indistinguishable from genuinely having none.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterType>('All');
  // null = not known yet (loading) or failed. 0 is a real answer ("settled"),
  // so it must not double as the placeholder — that showed ₹0.00 while
  // loading, and after a failed fetch.
  const [runningNetBalance, setRunningNetBalance] = useState<number | null>(null);
  // Separate from loadError: a failed balance call says nothing about whether
  // the transaction list loaded, so it must not replace an already-loaded list.
  const [balanceError, setBalanceError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserName, setCurrentUserName] = useState<string>('A friend');

  const { refreshBalances } = useGlobalBalances();

  const fetchStatement = useCallback(async () => {
    try {
      setLoading(true);
      // getSession() reads locally (no network) so a degraded connection
      // can't be mistaken for "signed out" and silently return empty — see
      // the same fix in lib/balances.ts for why that's worse than an error.
      const { data: sessionData } = await supabase.auth.getSession();

      if (!sessionData?.session?.user) {
        setLoading(false);
        return;
      }

      const userId = sessionData.session.user.id;
      setCurrentUserId(userId);

      // Fetch transactions WITHOUT problematic joins
      const { data: txs, error } = await supabase
        .from('transactions')
        .select(`
          id,
          amount,
          description,
          category,
          created_at,
          paid_by,
          group_id,
          status,
          type,
          transaction_splits ( user_id, share_amount )
        `)
        // No .or() on transaction_splits. Filtering an embedded table inside a
        // top-level .or() only works in PostgREST when the embed is an inner
        // join; otherwise it can fail and the screen renders as "no
        // transactions". It is redundant anyway — RLS (transactions_select,
        // migrations/0002) already limits rows to ones the caller paid for, is
        // a group member of, or has a split in, and the code below filters to
        // this user regardless.
        .order('created_at', { ascending: false });

      if (error || !txs) {
        console.error("Statement fetch error:", error);
        const cached = isLikelyNetworkError(error)
          ? await readCache<StatementTx[]>(STATEMENT_CACHE_KEY)
          : null;
        if (cached) {
          setTransactions(reviveStatementCacheDates(cached.data));
          setCachedAt(cached.cachedAt);
          setLoadError(null);
        } else {
          setLoadError(error?.message || 'Could not load your statement.');
        }
        // Independent of whether the transaction list came from cache —
        // fetchBalances() has its own offline fallback, so still worth trying.
        try {
          const { totalBalance } = await fetchBalances();
          setRunningNetBalance(totalBalance);
          setBalanceError(false);
        } catch (balErr) {
          console.warn('Could not load net balance for statement:', balErr);
          setRunningNetBalance(null);
          setBalanceError(true);
        }
        setLoading(false);
        return;
      }

      // Filter to transactions involving this user
      const involvedTxs = txs.filter(t => {
        const isPayer = t.paid_by === userId;
        const splits = t.transaction_splits || [];
        const hasMySplit = splits.some((s: any) => s.user_id === userId);
        return isPayer || hasMySplit;
      });

      // Collect all user IDs and group IDs for name lookups
      const allUserIds = new Set<string>();
      const allGroupIds = new Set<string>();
      for (const t of involvedTxs) {
        allUserIds.add(t.paid_by);
        const splits = t.transaction_splits || [];
        for (const s of splits) {
          allUserIds.add((s as any).user_id);
        }
        if (t.group_id) allGroupIds.add(t.group_id);
      }

      // Fetch user names
      const nameMap: Record<string, string> = {};
      if (allUserIds.size > 0) {
        const { data: profiles } = await supabase
          .from('users')
          .select('id, full_name')
          .in('id', [...allUserIds]);
        if (profiles) {
          for (const p of profiles) nameMap[p.id] = p.full_name || 'Unknown';
        }
      }

      // Fetch group names
      const groupMap: Record<string, string> = {};
      if (allGroupIds.size > 0) {
        const { data: groups } = await supabase
          .from('groups')
          .select('id, title')
          .in('id', [...allGroupIds]);
        if (groups) {
          for (const g of groups) groupMap[g.id] = g.title || 'Circle';
        }
      }

      const userName = nameMap[userId] || sessionData.session.user.user_metadata?.full_name || 'A friend';
      setCurrentUserName(userName);

      const processedTxs: StatementTx[] = [];

      for (const t of involvedTxs) {
        const isPayer = t.paid_by === userId;
        const splits = t.transaction_splits || [];
        const mySplit = splits.find((s: any) => s.user_id === userId);
        
        let userShare = 0;
        if (isPayer) {
          const othersSplits = splits.filter((s: any) => s.user_id !== userId);
          userShare = othersSplits.reduce((sum: number, s: any) => sum + Number(s.share_amount), 0);
        } else {
          userShare = mySplit ? -Number(mySplit.share_amount) : 0;
        }
        
        if (userShare === 0 && !isPayer) continue;

        // Get a friendly name for the counterparty
        let groupOrFriendName = '';
        if (t.group_id && groupMap[t.group_id]) {
          groupOrFriendName = groupMap[t.group_id];
        } else if (isPayer) {
          // Show the friend names from splits
          const otherIds = splits.filter((s: any) => s.user_id !== userId).map((s: any) => s.user_id);
          const names = otherIds.map(id => nameMap[id] || 'Friend');
          groupOrFriendName = names.length > 0 ? names.join(', ') : 'Self';
        } else {
          groupOrFriendName = nameMap[t.paid_by] || 'Someone';
        }

        const date = new Date(t.created_at);
        const dateString = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

        processedTxs.push({
          id: t.id,
          description: t.description,
          groupOrFriendName,
          category: t.category,
          totalAmount: Number(t.amount),
          userShare,
          isPayer,
          date,
          dateString,
          status: ((t as any).status || 'active'),
          paidByUserId: t.paid_by,
          type: t.type || 'expense',
          entryType: 'split',
        });
      }

      // Personal expenses live in their own table and are invisible to the
      // split ledger by design (see migration 0036). They are merged in here
      // for display only — the net balance below still comes from
      // lib/balances.ts and is unaffected by anything in this block.
      //
      // A failure here must not blank the whole statement, so it degrades to
      // "split rows only" rather than propagating.
      let personalTxs: StatementTx[] = [];
      try {
        const personal = await listPersonalTransactions();
        personalTxs = personal
          .filter((p) => p.status === 'confirmed')
          .map((p) => {
            const date = new Date(p.occurredAt);
            return {
              id: p.id,
              description: p.merchant || p.description || 'Personal expense',
              groupOrFriendName: 'Personal',
              category: p.category || 'other',
              totalAmount: p.amount,
              // Negative: a personal expense is money out, always. It is not a
              // debt, so this figure never reaches a balance — it only drives
              // this row's own colour and sign.
              userShare: -p.amount,
              isPayer: true,
              date,
              dateString: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
              status: 'active',
              paidByUserId: userId,
              type: 'expense',
              entryType: 'personal' as const,
            };
          });
      } catch (personalErr) {
        console.warn('Could not load personal transactions for statement:', personalErr);
      }

      const merged = [...processedTxs, ...personalTxs].sort(
        (a, b) => b.date.getTime() - a.date.getTime()
      );

      setTransactions(merged);
      setCachedAt(null);
      setLoadError(null);
      await writeCache(STATEMENT_CACHE_KEY, merged);

      // The headline figure comes from the shared balance engine, not from
      // re-summing the rows above.
      //
      // This screen used to accumulate `userShare` across every transaction it
      // had fetched — and the query has no status filter, so voided expenses
      // were counted too. That is why Statement could report "You owe ₹1,226"
      // while Home, Profile and Friends all showed settled: they read
      // simplified_settlements, which excludes voided rows, and this did not.
      //
      // It was also blind to transaction_payers, so any multi-payer expense
      // would have been attributed wrongly on top of that.
      //
      // Exactly the defect C1 fixed on the group screen. lib/balances.ts is the
      // single source for a balance; the per-row figures below are a different
      // thing — one transaction's own effect — and stay as they are.
      try {
        const { totalBalance } = await fetchBalances();
        setRunningNetBalance(totalBalance);
        setBalanceError(false);
      } catch (balErr) {
        console.warn('Could not load net balance for statement:', balErr);
        // Not setLoadError: the list above loaded fine and stays on screen.
        setRunningNetBalance(null);
        setBalanceError(true);
      }
    } catch (err: any) {
      console.error("Statement error:", err);
      const cached = isLikelyNetworkError(err)
        ? await readCache<StatementTx[]>(STATEMENT_CACHE_KEY)
        : null;
      if (cached) {
        setTransactions(reviveStatementCacheDates(cached.data));
        setCachedAt(cached.cachedAt);
        setLoadError(null);
      } else {
        setLoadError(err?.message || 'Could not load your statement.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchStatement();
    }, [fetchStatement])
  );

  // The approve / reject / confirm / dispute handlers that stood here are gone.
  //
  // None of them was ever called — there was no button, no menu item, no code
  // path reaching any of the four. They were the remains of an approval flow
  // that was abandoned, and record_expense() has always written status='active'
  // directly, so no transaction could ever arrive in a state needing approval.
  //
  // They were not merely inert. handleReject wrote status='rejected', which is
  // not among the values transactions_status_check permits, so it would have
  // failed outright. handleApprove called recalculatePairSettlements without
  // checking group_id, so on a group expense it would have rebuilt a 1-on-1
  // ledger and left the group's untouched. Dead code that is also wrong is
  // worse than dead code, because the next person to wire it up inherits both.
  //
  // Migration 0026 removes the columns and statuses that backed this.

  const getFilteredTransactions = () => {
    if (filter === 'Personal') {
      return transactions.filter(t => t.entryType === 'personal');
    }
    if (filter === 'Split') {
      return transactions.filter(t => t.entryType === 'split');
    }
    // Both of these describe who owes whom, which only split rows can answer
    // — a personal expense creates no debt in either direction.
    if (filter === 'You Paid') {
      return transactions.filter(t => t.entryType === 'split' && t.userShare > 0);
    }
    if (filter === 'You Owe') {
      return transactions.filter(t => t.entryType === 'split' && t.userShare < 0);
    }
    return transactions;
  };

  const filtered = getFilteredTransactions();

  const netKnown = runningNetBalance !== null;
  const net = runningNetBalance ?? 0;

  const onRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchStatement();
    } finally {
      setRefreshing(false);
    }
  };

  const getCategoryIcon = (category: string) => {
    const map: Record<string, any> = {
      food: 'restaurant',
      travel: 'flight',
      home: 'home',
      utilities: 'bolt',
      other: 'receipt-long'
    };
    return map[category] || 'receipt-long';
  };

  return (
    <View className="flex-1 bg-background">
      {/* Top App Bar */}
      <View 
        className="px-5 pb-4 flex-row items-center z-50 border-b border-white/35 shadow-sm"
        style={{ 
          paddingTop: Math.max(insets.top, 24),
          backgroundColor: 'rgba(252, 249, 244, 0.72)' 
        }}
      >
        <AnimatedPressable 
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="arrow-back" size={24} color="#1c1c19" />
        </AnimatedPressable>
        <Text className="font-headline-md font-bold text-primary text-xl ml-2 flex-1">Statement</Text>
      </View>

      <OfflineBanner cachedAt={cachedAt} />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Net Balance Header */}
        <View className="items-center justify-center pt-8 pb-6 px-6">
          <Text className="font-label-md text-sm text-on-surface-variant uppercase tracking-wider mb-2">Net Balance</Text>
          {!netKnown && loading ? (
            // Same height as the figure (text-5xl), so nothing shifts on load.
            <View style={{ height: 48, justifyContent: 'center' }}>
              <Skeleton width={160} height={32} />
            </View>
          ) : !netKnown ? (
            // Unknown, not zero: "₹0.00" would claim the user is settled.
            <Text className="font-display-lg text-5xl font-bold text-on-surface-variant">—</Text>
          ) : (
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.6}
              style={tabularNums}
              className={`font-display-lg text-5xl font-bold ${
              net > 0 ? 'text-primary' : net < 0 ? 'text-error' : 'text-on-surface'
            }`}>
              {formatINR(net, { signed: true })}
            </Text>
          )}
          {netKnown && net !== 0 && (
            <View className={`mt-3 px-4 py-1.5 rounded-full ${net > 0 ? 'bg-[#DCFCE7]' : 'bg-error-container'}`}>
              <Text className={`font-label-md font-semibold text-sm ${net > 0 ? 'text-primary' : 'text-error'}`}>
                {net > 0 ? 'You are owed' : 'You owe'}
              </Text>
            </View>
          )}
        </View>

        {/* Slim note for a failed balance call only — the list below is
            unaffected. Hidden when the list error card (with its own Retry)
            is already showing, so there are never two Retry buttons. */}
        {balanceError && !loading && !loadError && (
          <View className="mx-5 mb-4 px-4 py-3 rounded-xl bg-error-container flex-row items-center">
            <MaterialIcons name="error-outline" size={18} color="#b91c1c" />
            <Text className="text-sm text-on-surface flex-1 ml-2">Could not load your net balance.</Text>
            <AnimatedPressable onPress={fetchStatement} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} className="px-3 py-1.5">
              <Text className="text-primary font-semibold text-sm">Retry</Text>
            </AnimatedPressable>
          </View>
        )}

        {/* Filter Tabs — horizontally scrollable rather than five equal
            flex-1 columns. At five options, equal columns squeeze "You Paid"
            and "You Owe" until they wrap or clip on narrower phones; natural
            widths in a scroller stay legible however many filters exist. */}
        <View className="mb-6">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: 20, gap: 8 }}
          >
            {(['All', 'Personal', 'Split', 'You Paid', 'You Owe'] as FilterType[]).map((tab, index) => (
              <AnimatedListItem key={tab} index={index}>
                <AnimatedPressable
                  onPress={() => setFilter(tab)}
                  className={`px-4 py-2.5 rounded-xl items-center justify-center ${filter === tab ? 'bg-white shadow-sm border border-outline-variant/20' : 'bg-surface-container-high'}`}
                >
                  <Text className={`font-label-md font-semibold text-sm ${filter === tab ? 'text-primary' : 'text-on-surface-variant'}`}>
                    {tab}
                  </Text>
                </AnimatedPressable>
              </AnimatedListItem>
            ))}
          </ScrollView>
        </View>

        {/* Transactions List */}
        <View className="px-5">
          <Text className="font-headline text-lg font-bold text-on-surface mb-4">Transaction History</Text>
          
          {loading ? (
            <View className="py-2">
              {[0, 1, 2, 3, 4].map(i => (
                <View
                  key={i}
                  className="p-4 rounded-2xl mb-3"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.72)',
                    borderWidth: 1,
                    borderColor: 'rgba(0,0,0,0.05)',
                  }}
                >
                  <SkeletonListRow avatarSize={48} />
                </View>
              ))}
            </View>
          ) : loadError ? (
            <View className="p-8 items-center bg-white/40 border border-dashed border-outline-variant/60 rounded-3xl mt-4">
              <View className="w-12 h-12 rounded-full bg-error-container items-center justify-center mb-3">
                <MaterialIcons name="error-outline" size={24} color="#b91c1c" />
              </View>
              <Text className="font-semibold text-on-surface text-base mb-1">Could not load transactions</Text>
              <Text className="text-sm text-on-surface-variant/80 text-center">{loadError}</Text>
              <AnimatedPressable onPress={fetchStatement} className="mt-5 bg-primary px-6 py-3 rounded-xl">
                <Text className="text-white font-semibold">Try Again</Text>
              </AnimatedPressable>
            </View>
          ) : filtered.length === 0 ? (
            <View className="p-8 items-center bg-white/40 border border-dashed border-outline-variant/60 rounded-3xl mt-4">
              <View className="w-12 h-12 rounded-full bg-secondary-container items-center justify-center mb-3">
                <MaterialIcons name="receipt-long" size={24} color="#004c22" />
              </View>
              <Text className="font-semibold text-on-surface text-base mb-1">No transactions</Text>
              <Text className="text-sm text-on-surface-variant/80 text-center">
                Nothing matches this filter yet.
              </Text>
            </View>
          ) : (
            <View>
              {filtered.map((tx, index) => (
                <AnimatedListItem key={tx.id} index={index}>
                <View
                  className="p-5 rounded-2xl flex-col"
                  style={{
                    // Opaque colors, not the rgba(...) they replace: a
                    // translucent background paired with Android's
                    // `elevation` is a known rendering bug there — elevation's
                    // shadow/outline math assumes an opaque background, and a
                    // transparent one leaves a mismatched rectangle behind
                    // the real rounded card. These are the same colors,
                    // precomputed opaque over this app's #fcf9f4 page
                    // background.
                    backgroundColor: (tx.status === 'rejected' || tx.status === 'disputed')
                        ? '#fdeeeb'
                        : '#fefdfc',
                    borderWidth: 1,
                    borderColor: 'rgba(255, 255, 255, 0.35)',
                    shadowColor: '#1c1917',
                    shadowOffset: { width: 0, height: 2 },
                    shadowOpacity: 0.04,
                    shadowRadius: 8,
                    elevation: 1,
                    marginBottom: 12,
                    opacity: (tx.status === 'rejected' || tx.status === 'disputed' || tx.status === 'voided') ? 0.6 : 1
                  }}
                >
                  <View className="flex-row items-center justify-between">
                    <View className="flex-row items-center gap-4 flex-1">
                      {/* Personal rows deliberately avoid the red "you owe"
                          treatment — that colour means debt, and a personal
                          expense is not one. Amber matches how Personal
                          Spending is identified elsewhere in the app. */}
                      <View
                        className="w-12 h-12 rounded-xl items-center justify-center"
                        style={{
                          backgroundColor: tx.entryType === 'personal'
                            ? 'rgba(217,119,6,0.14)'
                            : tx.userShare > 0 ? '#DCFCE7' : 'rgba(255,218,214,0.5)',
                        }}
                      >
                        <MaterialIcons
                          name={getCategoryIcon(tx.category)}
                          size={24}
                          color={tx.entryType === 'personal' ? '#d97706' : tx.userShare > 0 ? '#004c22' : '#ba1a1a'}
                        />
                      </View>
                      <View className="flex-1 mr-2">
                        <Text className="font-body-md font-semibold text-on-background text-base" numberOfLines={1}>{tx.description}</Text>
                        <View className="flex-row items-center gap-1.5 mt-1">
                          <View
                            className="px-1.5 py-0.5 rounded"
                            style={{ backgroundColor: tx.entryType === 'personal' ? 'rgba(217,119,6,0.14)' : '#DCFCE7' }}
                          >
                            <Text
                              className="font-bold"
                              style={{ fontSize: 9, color: tx.entryType === 'personal' ? '#d97706' : '#004c22' }}
                            >
                              {tx.entryType === 'personal' ? 'PERSONAL' : 'SPLIT'}
                            </Text>
                          </View>
                          <Text className="font-label-sm text-xs text-on-surface-variant flex-1" numberOfLines={1}>
                            {tx.dateString}
                            {tx.entryType === 'split' ? ` • ${tx.groupOrFriendName}` : ''}
                          </Text>
                        </View>
                      </View>
                    </View>
                    <View className="items-end justify-center">
                      {/* Green/red here encode "owed to you" / "you owe".
                          Personal spending is neither, so it renders neutral
                          rather than borrowing the debt palette. */}
                      <Text
                        className="font-body-md font-bold text-base"
                        style={[tabularNums, {
                          color: tx.entryType === 'personal'
                            ? '#1c1c19'
                            : tx.userShare > 0 ? '#004c22' : '#ba1a1a',
                        }]}
                      >
                        {tx.entryType === 'personal' ? '' : tx.userShare > 0 ? '+' : '-'}{formatINR(Math.abs(tx.userShare))}
                      </Text>
                      {/* For a personal row the total and the user's share are
                          the same number — printing it twice reads as a bug. */}
                      {tx.entryType === 'split' && (
                        <Text style={tabularNums} className="font-label-sm text-[10px] text-on-surface-variant mt-1">
                          Total: {formatINR(tx.totalAmount)}
                        </Text>
                      )}
                    </View>
                  </View>
                  {/* Status Badge & Actions */}
                  {tx.status && tx.status !== 'active' && tx.status !== 'settled' && (
                    <View className="mt-2 pt-2 border-t border-outline-variant/20 flex-row items-center justify-between">
                      <View className={`px-3 py-1 rounded-full ${
                        tx.status === 'rejected' ? 'bg-[#FEE2E2]' 
                        : tx.status === 'disputed' ? 'bg-[#FEE2E2]' 
                        : 'bg-surface-container'
                      }`}>
                        <Text className={`text-xs font-semibold ${
                          tx.status === 'rejected' || tx.status === 'disputed' ? 'text-error' 
                          : 'text-on-surface-variant'
                        }`}>
                          {tx.status === 'rejected' ? '❌ Rejected' 
                          : tx.status === 'disputed' ? '⚠️ Disputed' 
                          : tx.status === 'voided' ? '🚫 Voided' 
                          : tx.status}
                        </Text>
                      </View>
                    </View>
                  )}
                </View>
                </AnimatedListItem>
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
