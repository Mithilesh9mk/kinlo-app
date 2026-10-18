import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, Modal } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { Skeleton, SkeletonListRow } from '../../components/Skeleton';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { SwipeableRow } from '../../components/SwipeableRow';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useGlobalBalances } from '../../context/GlobalBalancesContext';
import { useToast } from '../../components/Toast';
import { dispatchPushNotification } from '../../lib/pushDispatcher';
import { fetchBalanceMap, fetchBalanceRows, balanceMapForScope, statusFor } from '../../lib/balances';
import { readCache, writeCache, isLikelyNetworkError } from '../../lib/offlineCache';
import { OfflineBanner } from '../../components/OfflineBanner';
import { sendDebtNudge, describeNudgeResult } from '../../lib/debtNudges';

// Transaction with exact Date tags for mindful timeline filtering
interface Transaction {
  id: string;
  description: string;
  totalAmount: number;
  share: number;
  paidBy: string;
  paidByUserId: string; // Actual UUID of the payer
  addedBy: string; // 'You' or friend's name
  time: string;
  icon: string;
  timestamp: number; // Unix Epoch timestamp (ms)
  status?: string;
  /** 'expense' or 'settlement' — settlements are payments, not new charges. */
  type?: string;
  /** null = a direct 1-on-1 expense; otherwise the group this was created in. */
  group_id?: string | null;
  groupName?: string | null;
}

interface FriendData {
  name: string;
  phone: string;
  avatarUrl?: string;
  initials?: string;
  balance: number;
  status: 'owed' | 'owes' | 'settled';
  transactions: Transaction[];
  /** null/undefined = live. An ISO timestamp = this is a cached fallback. */
  cachedAt?: string | null;
}


const ONE_DAY = 24 * 60 * 60 * 1000;


type TimelineFilter = '30days' | '6months' | '1year' | 'all';

export default function FriendDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id, friendName, friendPhone } = useLocalSearchParams<{ id: string; friendName?: string; friendPhone?: string }>();
  const { refreshBalances } = useGlobalBalances();

  const friendId = id as string;

  // Track friends dynamic transaction history states locally
  const [friendsData, setFriendsData] = useState<Record<string, FriendData>>({});

  // Whether this friend's transactions have actually come back from the
  // server yet. Without this the screen cannot tell "balance is genuinely
  // zero" from "the fetch failed or hasn't finished", and the fallback
  // friend object below (balance: 0, status: 'settled') makes the second
  // case look exactly like the first — which is how Settle Up came to say
  // "All settled up!" for a friend the user actually owes money to.
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<TimelineFilter>('1year');
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  // The signed-in user's id, needed outside the fetch closure below to
  // compute a per-scope (direct vs. each shared group) balance breakdown
  // when Settle Up is pressed.
  const [myUserId, setMyUserId] = useState<string | null>(null);

  // Settle Up must target one scope at a time — group debt and direct debt
  // are independently reconciled ledgers that the settlement RPC will not
  // net together. When a friend has more than one non-zero scope, this
  // sheet lets the user pick which one to settle.
  interface SettleScope {
    groupId: string | null;
    label: string;
    balance: number;
  }
  const [settleScopes, setSettleScopes] = useState<SettleScope[]>([]);
  const [isSettleScopeSheetOpen, setIsSettleScopeSheetOpen] = useState(false);

  // Collaborative Permission Sheets
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [isActionSheetOpen, setIsActionSheetOpen] = useState(false);
  const [isRequestPopupOpen, setIsRequestPopupOpen] = useState(false);

  const [nudgeSending, setNudgeSending] = useState(false);

  // Load real transactions from Supabase
  useFocusEffect(
    React.useCallback(() => {
      async function fetchLiveTransactions() {
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) {
          throw new Error('You appear to be signed out. Sign in again to see this balance.');
        }
        setMyUserId(userId);

        const finalFriendId = friendId;

        // Query transactions from Supabase
        const { data: txs, error } = await supabase
          .from('transactions')
          .select(`
            id,
            amount,
            description,
            category,
            paid_by,
            created_at,
            status,
            type,
            group_id,
            transaction_splits (user_id, share_amount)
          `);
          // No .or() on transaction_splits here. Filtering an embedded table
          // inside a top-level .or() only works in PostgREST when the embed is
          // an inner join; without that it can fail outright, and a failed
          // fetch used to surface as "All settled up". It is also redundant:
          // RLS (transactions_select, migrations/0002) already restricts rows
          // to ones the caller paid for, is a member of, or has a split in,
          // and the code below re-filters to this specific friend anyway.
          //
          // No .is('group_id', null) here anymore either — that used to
          // exclude every group-originated expense between this pair, even
          // when both people are participants in the same group expense.
          // That's why a group expense could be invisible on this screen
          // while still showing up in the combined balance below.

        if (error) {
          throw new Error(error.message);
        }

        if (txs) {
          // Filter 1-on-1 transactions between me and this friend
          const matched = txs.filter(t => {
            const isPayerMe = t.paid_by === userId;
            const isPayerFriend = t.paid_by === finalFriendId;
            const splits = t.transaction_splits || [];
            
            // Check if both users are involved somehow
            const involvesMe = isPayerMe || splits.some((s: any) => s.user_id === userId);
            const involvesFriend = isPayerFriend || splits.some((s: any) => s.user_id === finalFriendId);

            return involvesMe && involvesFriend;
          });

          // Resolve group titles for any group-originated rows so they can
          // be labeled below, mirroring the groupMap pattern in statement.tsx.
          const groupIds = Array.from(
            new Set(matched.map(t => (t as any).group_id).filter(Boolean) as string[])
          );
          const groupTitleMap: Record<string, string> = {};
          if (groupIds.length > 0) {
            const { data: groups } = await supabase
              .from('groups')
              .select('id, title')
              .in('id', groupIds);
            if (groups) {
              for (const g of groups) groupTitleMap[g.id] = g.title || 'Circle';
            }
          }

          // Format transactions to fit UI structure
          const formatted: Transaction[] = matched.map(t => {
            const isPayerMe = t.paid_by === userId;
            const splits = t.transaction_splits || [];
            
            // Share calculation: Use total amount minus my share if I paid to bypass RLS hiding friend's split.
            //
            // Settlements need no special case. A settlement is just a
            // transaction whose payer is whoever handed over the money, and
            // "paid_by = X, split.user_id = Y" already means "Y owes X" —
            // the same encoding as any expense, so the branch below gets the
            // sign right for both.
            //
            // This used to infer direction from `description.includes('with
            // You.')` instead, because settle-up.tsx wrote every settlement
            // with paid_by = the caller regardless of who actually paid. That
            // string check quietly corrected the display while the stored row
            // stayed wrong, which is why the balances looked fine and the
            // ledger did not. 0005 fixes the write; keeping the compensation
            // on top of it would flip the sign back. See
            // migrations/0005_record_settlement.sql.
            // Scoped to THIS pair only.
            //
            // The old version used `t.amount - myShare` when I paid, which is
            // what *everyone* owes me — on a three-person expense that
            // included a third party's share. So this screen showed an
            // inflated figure, and settling from here tried to settle the
            // whole expense rather than just what this friend owes.
            //
            // Only the two of us matter here:
            //   I paid      -> this friend owes me their own share
            //   they paid   -> I owe them my own share
            //   someone else paid -> no debt between us from this expense
            const mySplit = splits.find((s: any) => s.user_id === userId);
            const friendSplit = splits.find((s: any) => s.user_id === finalFriendId);

            let shareAmt = 0;
            if (isPayerMe) {
              shareAmt = friendSplit ? Number(friendSplit.share_amount) : 0;
            } else if (t.paid_by === finalFriendId) {
              shareAmt = mySplit ? -Number(mySplit.share_amount) : 0;
            } else {
              shareAmt = 0;
            }

            const categoryIcons: Record<string, string> = {
              'food': 'restaurant',
              'travel': 'flight',
              'home': 'home',
              'other': 'receipt-long'
            };
            const hasSettlementIcon = (t as any).type === 'settlement';

            return {
              id: t.id,
              description: t.description,
              totalAmount: Number(t.amount),
              share: shareAmt,
              paidBy: isPayerMe ? 'You' : (friendName || 'Friend'),
              paidByUserId: t.paid_by,
              addedBy: isPayerMe ? 'You' : (friendName || 'Friend'),
              time: new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
              icon: hasSettlementIcon ? 'payments' : (categoryIcons[t.category] || 'receipt-long'),
              timestamp: new Date(t.created_at).getTime(),
              status: t.status || 'active',
              type: (t as any).type || 'expense',
              group_id: (t as any).group_id ?? null,
              groupName: (t as any).group_id ? (groupTitleMap[(t as any).group_id] || 'Group') : null,
            };
          });

          // The balance comes from the ledger, not from summing the rows
          // above. Those two used to be computed separately and drifted
          // apart, which is how this screen could show a figure that Home
          // and Settle Up disagreed with. The transaction list below is
          // still built locally — it is a history view, not the balance.
          const balanceMap = await fetchBalanceMap(userId);
          const totalBalance = balanceMap[finalFriendId] || 0;

          const cacheKey = `friendDetail.${friendId}`;
          let nextFriend: FriendData | null = null;
          setFriendsData(prev => {
            const baseFriend = prev[friendId] || { name: friendName || 'Unknown', phone: friendPhone || '' };
            nextFriend = {
              ...baseFriend,
              // Newest first. Nothing sorted these before, so rows arrived in
              // whatever order Postgres returned and a just-added expense
              // could appear part-way down the list.
              transactions: [...formatted].sort((a, b) => b.timestamp - a.timestamp),
              balance: Math.abs(totalBalance),
              status: totalBalance > 0 ? 'owed' : totalBalance < 0 ? 'owes' : 'settled',
              cachedAt: null,
            };
            return { ...prev, [friendId]: nextFriend };
          });
          if (nextFriend) await writeCache(cacheKey, nextFriend);
          setLoadState('ready');
          setLoadError(null);
        }
      } catch (err: any) {
        console.error('Error loading dynamic transactions:', err);
        const cached = isLikelyNetworkError(err)
          ? await readCache<FriendData>(`friendDetail.${friendId}`)
          : null;
        if (cached) {
          setFriendsData(prev => ({
            ...prev,
            [friendId]: { ...cached.data, cachedAt: cached.cachedAt },
          }));
          setLoadState('ready');
          setLoadError(null);
        } else {
          setLoadState('error');
          setLoadError(err?.message || 'Could not load this balance.');
        }
      }
    }

    fetchLiveTransactions();
  }, [friendId, friendName]));

  const { showToast: triggerToast } = useToast();

  // Resolve current active friend data
  let friend = friendsData[friendId];
  if (!friend) {
    // No UUID-derived guess here — a wrong-looking name is worse than none.
    // The header renders a skeleton instead of this until loadState settles.
    const name = friendName || '';
    const phone = friendPhone || '';
    const initials = name ? name.split(' ').map(n => n.charAt(0)).join('').toUpperCase().slice(0, 2) : '';
    friend = {
      name,
      phone,
      balance: 0,
      status: 'settled',
      transactions: [],
      initials
    };
  }

  const handleAddExpense = () => {
    router.push({
      pathname: '/expense/amount',
      params: {
        friendId: friendId,
        friendName: friend.name
      }
    });
  };

  const navigateToSettleUp = (scope: { groupId: string | null; label: string; balance: number }) => {
    setIsSettleScopeSheetOpen(false);
    router.push({
      pathname: '/settle-up',
      params: {
        friendId: friendId,
        friendName: friend.name,
        balance: Math.abs(scope.balance).toFixed(2),
        status: scope.balance > 0 ? 'owed' : 'owes',
        groupId: scope.groupId || undefined,
        groupName: scope.groupId ? scope.label : undefined,
      }
    });
  };

  const handleSettleUp = async () => {
    // Never report "settled" on the strength of data we don't have. The
    // fallback friend object is balance: 0 / status: 'settled', so without
    // these two guards an unfinished or failed load is reported to the user
    // as a zero balance — telling someone they owe nothing when they do.
    if (loadState === 'loading') {
      triggerToast('Still loading this balance — try again in a moment.');
      return;
    }
    if (loadState === 'error') {
      triggerToast(loadError ? `Could not load balance: ${loadError}` : 'Could not load this balance. Pull to refresh and try again.');
      return;
    }

    if (friend.status === 'settled' || friend.balance <= 0.01) {
      triggerToast('All settled up! No outstanding balance.');
      return;
    }

    if (!myUserId) {
      triggerToast('Still loading — try again in a moment.');
      return;
    }

    // The balance shown above sums every scope together (direct + each
    // shared group), but the settlement RPC only ever settles one scope per
    // call — group debt and direct debt are independently reconciled
    // ledgers that are never netted against each other. Settling straight
    // off the combined total (as this used to do) tried to clear a scope
    // that was often still zero, which the DB correctly rejected as
    // "already square" even though the friend genuinely owed money in a
    // different scope.
    try {
      const rows = await fetchBalanceRows(myUserId);

      const scopes: { groupId: string | null; label: string; balance: number }[] = [];

      const directBal = balanceMapForScope(rows, myUserId, null)[friendId] || 0;
      if (Math.abs(directBal) > 0.005) {
        scopes.push({ groupId: null, label: 'Direct', balance: directBal });
      }

      const groupIds = Array.from(
        new Set(rows.filter(r => r.group_id).map(r => r.group_id as string))
      );
      const groupBalances = groupIds
        .map(gid => ({ gid, bal: balanceMapForScope(rows, myUserId, gid)[friendId] || 0 }))
        .filter(g => Math.abs(g.bal) > 0.005);

      if (groupBalances.length > 0) {
        const { supabase } = await import('../../lib/supabase');
        const { data: groups } = await supabase
          .from('groups')
          .select('id, title')
          .in('id', groupBalances.map(g => g.gid));
        const groupTitleMap: Record<string, string> = {};
        if (groups) for (const g of groups) groupTitleMap[g.id] = g.title || 'Circle';
        for (const g of groupBalances) {
          scopes.push({ groupId: g.gid, label: groupTitleMap[g.gid] || 'Circle', balance: g.bal });
        }
      }

      if (scopes.length === 0) {
        // The combined total said non-zero, but every individual scope
        // rounds to zero (a rounding edge case) — treat as settled rather
        // than showing an empty chooser.
        triggerToast('All settled up! No outstanding balance.');
        return;
      }

      if (scopes.length === 1) {
        navigateToSettleUp(scopes[0]);
        return;
      }

      setSettleScopes(scopes);
      setIsSettleScopeSheetOpen(true);
    } catch (err) {
      console.error('Could not compute settle-up scopes:', err);
      triggerToast('Could not check this balance. Please try again.');
    }
  };

  // Core Functionality Audit's payment-reminder gap (P1 #5) / engagement
  // audit feature A. send_debt_nudge() (0052) already proves the debt and
  // enforces the per-pair cooldown; this just calls it and surfaces the
  // result. Gated on friend.status === 'owed' in the JSX below, but the RPC
  // re-derives the debt itself from simplified_settlements — the same
  // source lib/balances.ts reads — so a stale client-side status can never
  // send a reminder for a debt that no longer exists.
  const handleSendReminder = async () => {
    if (nudgeSending || !friendId) return;
    setNudgeSending(true);
    try {
      const { supabase } = await import('../../lib/supabase');
      const { data: authData } = await supabase.auth.getUser();
      const senderName = authData?.user?.user_metadata?.full_name || 'Someone';

      const result = await sendDebtNudge(friendId, senderName);
      triggerToast(describeNudgeResult(result, friend.name || 'this friend'));
    } catch (err: any) {
      console.error('Could not send reminder:', err);
      triggerToast('Could not send a reminder right now.');
    } finally {
      setNudgeSending(false);
    }
  };

  // Timeline Filtering math
  const getFilteredTransactions = () => {
    const NOW = Date.now();
    const limit = {
      '30days': 30 * ONE_DAY,
      '6months': 180 * ONE_DAY,
      '1year': 365 * ONE_DAY,
      'all': Infinity
    }[timeline];

    return friend.transactions.filter(t => {
      const elapsed = NOW - t.timestamp;
      return elapsed <= limit;
    });
  };

  const handleTxPress = (tx: Transaction) => {
    setSelectedTx(tx);
    setIsActionSheetOpen(true);
  };

  // Perform Delete / Request permission
  const handleDeleteTx = async (txOverride?: Transaction) => {
    const tx = txOverride ?? selectedTx;
    setIsActionSheetOpen(false);
    if (!tx) return;

    if (tx.addedBy === 'You') {
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        const currentUserId = authData?.user?.id;

        // One call: the status change and the rebuild of every affected pair
        // happen in a single database transaction.
        //
        // This used to be an update() followed by a separate
        // recalculatePairSettlements(friendId), with the rebuild in a catch
        // that logged "non-critical" and fell through to a success toast. Two
        // things were wrong with that. A failure between the two left the
        // expense voided and the ledger stale, permanently and silently. And
        // the scope came from this screen rather than from the expense: on a
        // three-person expense the third party kept their share of something
        // that no longer counted. See migrations/0015_void_transaction.sql.
        const { voidTransaction } = await import('../../lib/recalculateSettlements');
        const voidError = await voidTransaction(tx.id);

        if (voidError) {
          console.error('Void failed:', voidError.message);
          triggerToast('Could not void this transaction. Please try again.');
          return;
        }

        await refreshBalances();

        // Direct action permitted: mark item as voided
        const updatedTxs = friend.transactions.map(t =>
          t.id === tx.id ? { ...t, status: 'voided' } : t
        );

        // Re-read the balance from the ledger the RPC above just rebuilt,
        // rather than re-summing the rows locally. Summing here is what let
        // this screen drift away from Home and Settle Up in the first place.
        let newBalance = friend.balance;
        try {
          const balanceMap = await fetchBalanceMap(currentUserId as string);
          newBalance = balanceMap[friendId as string] || 0;
        } catch (balErr) {
          console.warn('Could not re-read balance after void:', balErr);
        }

        setFriendsData(prev => ({
          ...prev,
          [friendId]: {
            ...friend,
            transactions: updatedTxs,
            balance: Math.abs(newBalance),
            status: statusFor(newBalance)
          }
        }));

        triggerToast('Transaction voided successfully!');
        
        // P-6: Notify friend about deleted expense
        if (tx.paidByUserId) {
          const counterpartyId = tx.paidByUserId === currentUserId ? friendId : tx.paidByUserId;
          dispatchPushNotification(
            [counterpartyId],
            'Expense Deleted',
            `${authData?.user?.user_metadata?.full_name || 'Someone'} deleted the expense: ${tx.description}.`
          );
        }
      } catch (err) {
        console.error('Error voiding transaction:', err);
        triggerToast('Failed to void transaction.');
      }
    } else {
      // Intercept with Collaborative Permission Modal. If this was triggered
      // from a swipe (tx passed explicitly, not via the tap-driven Actions
      // Sheet), selectedTx won't be populated yet — the request popup and
      // handleSendRequest below both read it for display/notification.
      if (tx !== selectedTx) setSelectedTx(tx);
      setIsRequestPopupOpen(true);
    }
  };


  const handleSendRequest = () => {
    setIsRequestPopupOpen(false);
    triggerToast(`Request sent to ${friend.name}!`);
    
    // P-6: Notify Creator
    if (selectedTx?.paidByUserId) {
      dispatchPushNotification(
        [selectedTx.paidByUserId],
        'Deletion Request 🗑️',
        `Someone requested to delete: ${selectedTx.description}. Tap to approve.`,
        { action: 'approve_delete' }
      );
    }
  };

  const filteredTxs = getFilteredTransactions();

  return (
    <View className="flex-1 bg-background">
      {/* Top App Bar */}
      <View 
        className="px-5 pb-4 flex-row justify-between items-center z-50 border-b border-outline-variant/35 shadow-sm"
        style={{ 
          paddingTop: Math.max(insets.top, 24),
          backgroundColor: 'rgba(252, 249, 244, 0.72)' 
        }}
      >
        <View className="flex-row items-center gap-4">
          <AnimatedPressable 
            onPress={() => router.back()}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
          >
            <MaterialIcons name="arrow-back" size={24} color="#004c22" />
          </AnimatedPressable>
          <Text className="font-headline-md font-bold text-primary text-xl">Kinlo</Text>
        </View>
        <View className="w-10 h-10 rounded-full border border-outline-variant bg-surface-container items-center justify-center overflow-hidden">
          <Avatar
            uri={friend.avatarUrl}
            initials={friend.initials}
            textClassName="text-primary font-bold text-sm"
          />
        </View>
      </View>

      <OfflineBanner cachedAt={friend.cachedAt} />

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 120 }}>
        <View className="px-5 pt-8 max-w-xl mx-auto w-full flex-col items-center">
          
          {/* Friend Profile Header */}
          <View className="items-center mb-6 w-full">
            <View className="w-20 h-20 rounded-full border-2 border-white shadow-sm mb-4 bg-secondary-container items-center justify-center overflow-hidden">
              <Avatar
                uri={friend.avatarUrl}
                initials={friend.initials}
                textClassName="text-primary font-bold text-2xl"
              />
            </View>
            {friend.name
              ? <Text className="text-2xl font-bold text-on-surface mb-1">{friend.name}</Text>
              : <Skeleton width={140} height={22} radius={6} style={{ marginBottom: 4 }} />}
            {friend.phone ? (
              <Text className="text-sm text-on-surface-variant mb-4">{friend.phone}</Text>
            ) : (
              <View className="mb-4" />
            )}

            {/* Net Balance Status Badge */}
            {friend.status === 'owed' && (
              <View className="flex-col items-center">
                <View className="flex-row items-center gap-2 bg-[#DCFCE7] px-4 py-1.5 rounded-full mb-2">
                  <View className="w-2 h-2 rounded-full bg-primary" />
                  <Text className="text-primary font-semibold text-xs uppercase tracking-wider">You are owed</Text>
                </View>
                <Text className="text-4xl font-bold text-primary">+₹{friend.balance.toFixed(2)}</Text>
                <AnimatedPressable
                  onPress={handleSendReminder}
                  disabled={nudgeSending}
                  className="flex-row items-center gap-1.5 mt-3 px-4 py-2 rounded-full bg-primary-container active:scale-95 duration-100"
                >
                  <MaterialIcons name="notifications-none" size={16} color="white" />
                  <Text className="text-white font-semibold text-xs">
                    {nudgeSending ? 'Sending…' : 'Send Reminder'}
                  </Text>
                </AnimatedPressable>
              </View>
            )}

            {friend.status === 'owes' && (
              <View className="flex-col items-center">
                <View className="flex-row items-center gap-2 bg-error-container px-4 py-1.5 rounded-full mb-2">
                  <View className="w-2 h-2 rounded-full bg-error" />
                  <Text className="text-error font-semibold text-xs uppercase tracking-wider">You owe</Text>
                </View>
                <Text className="text-4xl font-bold text-error">-₹{Math.abs(friend.balance).toFixed(2)}</Text>
              </View>
            )}

            {friend.status === 'settled' && (
              <View className="flex-col items-center">
                <View className="flex-row items-center gap-2 bg-surface-container-highest px-4 py-1.5 rounded-full mb-2">
                  <View className="w-2 h-2 rounded-full bg-outline" />
                  <Text className="text-on-surface-variant font-semibold text-xs uppercase tracking-wider">Settled up</Text>
                </View>
                <Text className="text-4xl font-bold text-outline">Settled</Text>
              </View>
            )}
          </View>

          {/* Action Buttons */}
          <View className="flex-row gap-3 w-full mb-8">
            <AnimatedPressable 
              onPress={handleAddExpense}
              className="flex-1 bg-primary py-3.5 rounded-2xl items-center shadow-md shadow-primary/20 active:scale-95 duration-100"
            >
              <Text className="text-white font-semibold text-base">Add Expense</Text>
            </AnimatedPressable>
            <AnimatedPressable 
              onPress={handleSettleUp}
              className="flex-1 py-3.5 rounded-2xl items-center border active:scale-95 duration-100"
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.72)',
                borderColor: 'rgba(255, 255, 255, 0.35)',
              }}
            >
              <Text className="text-primary font-semibold text-base">Settle Up</Text>
            </AnimatedPressable>
          </View>

          <View className="w-full h-px bg-outline-variant/30 mb-6" />

          {/* Transaction History Section Header with Filter Pill */}
          <View className="w-full">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="font-headline-md text-lg font-semibold text-on-surface">Transaction History</Text>
              
              {/* Timeline Filter Trigger Badge */}
              <AnimatedPressable 
                onPress={() => setIsFilterSheetOpen(true)}
                className="flex-row items-center gap-1 bg-surface-container-high px-3 py-1.5 rounded-full border border-outline-variant/30 active:scale-95"
              >
                <MaterialIcons name="calendar-today" size={12} color="#004c22" />
                <Text className="text-primary text-[10px] font-bold uppercase tracking-wider pl-1">
                  {timeline === '30days' ? '30 Days' : timeline === '6months' ? '6 Months' : timeline === '1year' ? '1 Year' : 'All Time'}
                </Text>
                <MaterialIcons name="keyboard-arrow-down" size={14} color="#004c22" />
              </AnimatedPressable>
            </View>
            
            {/* Stateful Transaction Card Feeds */}
            <View className="gap-4">
              {loadState === 'loading' ? (
                // Distinct from the empty state below on purpose. "No
                // transactions" and "not loaded yet" mean opposite things, and
                // this screen already guards against conflating them elsewhere.
                [0, 1, 2, 3].map(i => (
                  <View
                    key={`skeleton-${i}`}
                    className="p-4 rounded-2xl"
                    style={{
                      backgroundColor: 'rgba(255,255,255,0.72)',
                      borderWidth: 1,
                      borderColor: 'rgba(0,0,0,0.05)',
                      marginBottom: 12,
                    }}
                  >
                    <SkeletonListRow avatarSize={44} />
                  </View>
                ))
              ) : filteredTxs.length === 0 ? (
                <View className="py-12 items-center justify-center bg-white/40 border border-dashed border-outline-variant/60 rounded-3xl">
                  <MaterialIcons name="event-busy" size={32} color="#707a6f" className="mb-2" />
                  <Text className="text-on-surface-variant font-medium text-sm">No transactions in selected timeline</Text>
                </View>
              ) : (
                filteredTxs.map((tx, txIndex) => {
                  const isPositive = tx.share > 0;
                  const isVoided = tx.status === 'voided' || tx.status === 'rejected' || tx.status === 'disputed';
                  const isSettlement = tx.type === 'settlement';

                  return (
                    <AnimatedListItem index={txIndex} key={tx.id}>
                    <View
                      className={`p-4 rounded-2xl flex-col ${isVoided ? 'opacity-50' : ''}`}
                      style={{
                        // Opaque, not translucent — a semi-transparent
                        // background paired with Android's `elevation` is a
                        // known rendering bug there. Same color, precomputed
                        // opaque over this app's #fcf9f4 page background.
                        backgroundColor: '#fefdfc',
                        borderWidth: 1,
                        borderColor: 'rgba(255, 255, 255, 0.35)',
                        shadowColor: '#1c1917',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.04,
                        shadowRadius: 8,
                        elevation: 1,
                        marginBottom: 12
                      }}
                    >
                      <SwipeableRow
                        onDelete={() => handleDeleteTx(tx)}
                        disabled={isVoided}
                        confirmTitle="Void this expense?"
                        // Same dual-outcome caveat as the group screen: a
                        // non-creator's delete sends a request rather than
                        // voting anything, so the copy must hold for both.
                        confirmMessage="If you added this, it will be voided and your balance updated. If your friend did, they'll be asked to approve."
                        confirmLabel="Continue"
                      >
                      <AnimatedPressable
                        onPress={() => !isVoided && handleTxPress(tx)}
                        className="flex-row items-center justify-between"
                      >
                        <View className="flex-row items-center gap-4 flex-1">
                          <View className={`w-12 h-12 bg-surface rounded-full items-center justify-center overflow-hidden ${isVoided ? 'bg-outline-variant/30' : ''}`}>
                            <MaterialIcons 
                              name={tx.icon as any} 
                              size={24} 
                              color={isVoided ? "#9ca3af" : (isPositive ? "#004c22" : "#707a6f")} 
                            />
                          </View>
                           <View className="flex-1 mr-2">
                             <Text className={`font-semibold text-base ${isVoided ? 'text-outline line-through' : 'text-on-surface'}`} numberOfLines={1}>
                               {isSettlement
                                 ? (tx.paidBy === 'You' ? `You paid ${friend.name.split(' ')[0]}` : `${tx.paidBy.split(' ')[0]} paid you`)
                                 : tx.description}
                             </Text>
                             <Text className="text-xs text-on-surface-variant mt-0.5" numberOfLines={1}>
                               {isSettlement
                                 ? `Payment · ${tx.time}`
                                 : `${tx.paidBy} paid ₹${tx.totalAmount.toFixed(2)} • ${tx.time}${tx.groupName ? ' • ' + tx.groupName : ''}`}
                               {!isSettlement && tx.status === 'settled' && ' • '}
                               {!isSettlement && tx.status === 'settled' && (
                                 <Text className="text-primary font-bold">Settled</Text>
                               )}
                               {isVoided && ' • '}
                               {isVoided && (
                                 <Text className="text-error font-bold tracking-tight">Voided by {tx.addedBy}</Text>
                               )}
                             </Text>
                           </View>
                        </View>
                        <View className="items-end justify-center">
                          {/* A settlement is money changing hands, not a new
                              charge. Showing it with the same +/- owe colouring
                              as an expense made settling look like it had added
                              another debt. */}
                          {isSettlement ? (
                            <View className="items-end">
                              <Text className="font-headline-md font-bold text-base" style={{ color: isVoided ? '#9ca3af' : '#4d5a51' }}>
                                ₹{Math.abs(tx.share).toFixed(2)}
                              </Text>
                              <View
                                className="flex-row items-center px-2 py-0.5 rounded-full mt-1"
                                style={{ backgroundColor: '#caead6' }}
                              >
                                <MaterialIcons name="check" size={11} color="#004c22" />
                                <Text className="text-[10px] font-bold text-primary" style={{ marginLeft: 3 }}>SETTLED</Text>
                              </View>
                            </View>
                          ) : (
                            <Text className={`font-headline-md font-bold text-base ${isVoided ? 'text-outline' : (isPositive ? 'text-primary' : 'text-error')}`}>
                              {isPositive ? '+' : '-'}₹{Math.abs(tx.share).toFixed(2)}
                            </Text>
                          )}
                        </View>
                      </AnimatedPressable>
                      </SwipeableRow>
                    </View>
                    </AnimatedListItem>
                  );
                })
              )}
            </View>
          </View>

        </View>
      </ScrollView>

      {/* 1. Timeline Filter Sheet Bottom Modal */}
      <Modal
        visible={isFilterSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsFilterSheetOpen(false)}
      >
        <AnimatedPressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setIsFilterSheetOpen(false)}
        >
          <View 
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
          >
            {/* Top drag pill indicator */}
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />

            <Text className="font-headline text-lg font-bold text-on-surface mb-2">Timeline Filter</Text>
            <Text className="text-sm text-on-surface-variant mb-6">Select a period to display transaction histories</Text>

            <View className="gap-3">
              {([
                { key: '30days', label: 'Past 30 Days' },
                { key: '6months', label: 'Past 6 Months' },
                { key: '1year', label: 'Past 1 Year (Default)' },
                { key: 'all', label: 'All Time' }
              ] as const).map((opt) => {
                const isActive = timeline === opt.key;
                return (
                  <AnimatedPressable
                    key={opt.key}
                    onPress={() => {
                      setTimeline(opt.key);
                      setIsFilterSheetOpen(false);
                    }}
                    className="p-4 rounded-2xl flex-row justify-between items-center"
                    style={{
                      backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255,255,255,0.6)',
                      borderWidth: 1,
                      borderColor: isActive ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                      marginBottom: 10
                    }}
                  >
                    <Text className={`font-semibold text-base ${isActive ? 'text-primary' : 'text-on-surface'}`}>
                      {opt.label}
                    </Text>
                    {isActive && <MaterialIcons name="check-circle" size={20} color="#004c22" />}
                  </AnimatedPressable>
                );
              })}
            </View>
          </View>
        </AnimatedPressable>
      </Modal>

      {/* 2. Collaborative Actions Sheet (Edit / Delete) */}
      <Modal
        visible={isActionSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsActionSheetOpen(false)}
      >
        <AnimatedPressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setIsActionSheetOpen(false)}
        >
          <View 
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
          >
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />

            {selectedTx && (
              <View className="mb-6 items-center">
                <Text className="font-headline text-lg font-bold text-on-surface">{selectedTx.description}</Text>
                <Text className="text-sm text-on-surface-variant mt-1">
                  Added by {selectedTx.addedBy === 'You' ? 'You' : selectedTx.addedBy}
                </Text>
              </View>
            )}

            <View className="gap-4">
              {selectedTx && (
                <AnimatedPressable
                  onPress={() => {
                    setIsActionSheetOpen(false);
                    router.push({ pathname: `/transaction/${selectedTx.id}` });
                  }}
                  className="w-full h-14 rounded-2xl flex-row items-center px-4"
                  style={{ backgroundColor: 'rgba(0,0,0,0.05)', marginBottom: 10 }}
                >
                  <MaterialIcons name="receipt-long" size={22} color="#004c22" />
                  <Text className="text-primary font-semibold text-base" style={{ marginLeft: 10 }}>
                    View full expense
                  </Text>
                </AnimatedPressable>
              )}

              {selectedTx && Math.abs(selectedTx.share) > 0 && selectedTx.status !== 'settled' && (
                <AnimatedPressable
                  onPress={() => {
                    setIsActionSheetOpen(false);
                    router.push({
                      pathname: '/settle-up',
                      params: {
                        friendId: friendId,
                        friendName: friend.name,
                        balance: Math.abs(selectedTx.share).toFixed(2),
                        status: selectedTx.share > 0 ? 'owed' : 'owes',
                        groupId: selectedTx.group_id || undefined,
                        groupName: selectedTx.groupName || undefined,
                        transactionId: selectedTx.id,
                        transactionDescription: selectedTx.description
                      }
                    });
                  }}
                  className="w-full h-14 bg-primary rounded-2xl flex-row items-center px-4"
                  style={{ marginBottom: 10 }}
                >
                  <MaterialIcons name="check-circle" size={22} color="white" />
                  <Text className="text-white font-semibold text-base pl-3" style={{ marginLeft: 8 }}>
                    Settle this Expense (₹{Math.abs(selectedTx.share).toFixed(2)})
                  </Text>
                </AnimatedPressable>
              )}

              <AnimatedPressable
                onPress={() => {
                  setIsActionSheetOpen(false);
                  if (selectedTx) {
                    router.push({
                      pathname: '/expense/amount',
                      params: { editTxId: selectedTx.id }
                    });
                  }
                }}
                className="w-full h-14 bg-white/70 border border-outline-variant/30 rounded-2xl flex-row items-center px-4"
                style={{ marginBottom: 10 }}
              >
                <MaterialIcons name="edit" size={22} color="#004c22" />
                <Text className="text-on-surface font-semibold text-base pl-3" style={{ marginLeft: 8 }}>
                  Edit Expense
                </Text>
              </AnimatedPressable>

              <AnimatedPressable
                onPress={() => handleDeleteTx()}
                className="w-full h-14 bg-[#FEE2E2] rounded-2xl flex-row items-center px-4"
              >
                <MaterialIcons name="delete" size={22} color="#DC2626" />
                <Text className="text-error font-semibold text-base pl-3" style={{ marginLeft: 8 }}>
                  Delete Transaction
                </Text>
              </AnimatedPressable>
            </View>
          </View>
        </AnimatedPressable>
      </Modal>

      {/* 3. Intercept Collaborative Permissions (Edit/Delete Request Popup) */}
      <Modal
        visible={isRequestPopupOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsRequestPopupOpen(false)}
      >
        <View className="flex-1 bg-black/40 justify-center items-center px-6">
          <View 
            className="w-full max-w-sm rounded-3xl p-6"
            style={{
              backgroundColor: '#fcf9f4',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.4)',
              elevation: 4
            }}
          >
            <View className="w-12 h-12 bg-error-container/40 rounded-full items-center justify-center self-center mb-4">
              <MaterialIcons name="lock-outline" size={24} color="#BA1A1A" />
            </View>

            <Text className="font-headline text-lg font-bold text-on-surface text-center mb-2">Request Permission?</Text>
            <Text className="text-sm text-on-surface-variant text-center leading-relaxed mb-6">
              Only <Text className="font-bold">{friend.name}</Text> can modify this expense directly since they recorded it. Would you like to send a request to {friend.name.split(' ')[0]}?
            </Text>

            <View className="flex-row gap-3">
              <AnimatedPressable 
                onPress={() => setIsRequestPopupOpen(false)}
                className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center active:scale-95 bg-white/40"
              >
                <Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text>
              </AnimatedPressable>
              <AnimatedPressable 
                onPress={handleSendRequest}
                className="flex-1 h-12 bg-primary rounded-xl items-center justify-center active:scale-95 shadow-sm"
              >
                <Text className="text-white font-semibold text-sm">Send Request</Text>
              </AnimatedPressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* 4. Settle Scope Chooser — shown only when this friend's balance spans
             more than one scope (direct + one or more shared groups). Each
             scope is an independently reconciled ledger and the settle-up
             RPC will not net them together, so the user picks one. */}
      <Modal
        visible={isSettleScopeSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsSettleScopeSheetOpen(false)}
      >
        <AnimatedPressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setIsSettleScopeSheetOpen(false)}
        >
          <View
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
          >
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />
            <Text className="font-headline text-lg font-bold text-on-surface mb-2">Settle which balance?</Text>
            <Text className="text-sm text-on-surface-variant mb-6">
              You and {friend.name.split(' ')[0]} have separate balances in different places — pick one to settle.
            </Text>

            <View className="gap-3">
              {settleScopes.map((scope) => {
                const owed = scope.balance > 0;
                return (
                  <AnimatedPressable
                    key={scope.groupId ?? 'direct'}
                    onPress={() => navigateToSettleUp(scope)}
                    className="p-4 rounded-2xl flex-row justify-between items-center"
                    style={{
                      backgroundColor: 'rgba(255,255,255,0.6)',
                      borderWidth: 1,
                      borderColor: 'rgba(255, 255, 255, 0.35)',
                      marginBottom: 10,
                    }}
                  >
                    <View>
                      <Text className="font-semibold text-base text-on-surface">{scope.label}</Text>
                      <Text className="text-xs text-on-surface-variant mt-0.5">{owed ? 'You are owed' : 'You owe'}</Text>
                    </View>
                    <Text className={`font-headline-md font-bold text-base ${owed ? 'text-primary' : 'text-error'}`}>
                      {owed ? '+' : '-'}₹{Math.abs(scope.balance).toFixed(2)}
                    </Text>
                  </AnimatedPressable>
                );
              })}
            </View>
          </View>
        </AnimatedPressable>
      </Modal>
    </View>
  );
}
