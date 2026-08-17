import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, Modal, Animated, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useGlobalBalances } from '../../context/GlobalBalancesContext';
import { dispatchPushNotification } from '../../lib/pushDispatcher';
// The ledger is computed in Postgres now (recalculate_group_settlements); this
// screen only renders what the database stores.
export interface SimplifiedTransfer {
  fromId: string;
  fromName: string;
  fromAvatarUrl?: string;
  toId: string;
  toName: string;
  toAvatarUrl?: string;
  amount: number;
}

interface Transaction {
  id: string;
  description: string;
  totalAmount: number;
  share: number; // Positive = You are owed, Negative = You owe
  paidBy: string;
  paidByUserId: string; // Actual UUID of the payer
  addedBy: string; // 'You' or other names
  time: string;
  icon: string;
  timestamp: number; // Unix Epoch timestamp (ms)
  status?: string;
  /** 'expense' or 'settlement' — settlements are payments, not new charges. */
  type?: string;
}

interface GroupData {
  title: string;
  categoryLabel: string;
  memberCount: number;
  totalSpend: number;
  userBalance: number; // Positive = Owed, Negative = Owe, 0 = Settled
  spentByYou: number;
  yourShare: number;
  transactions: Transaction[];
}


const ONE_DAY = 24 * 60 * 60 * 1000;


type TimelineFilter = '30days' | '6months' | '1year' | 'all';

export default function GroupDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams();
  const { refreshBalances } = useGlobalBalances();
  const { id } = params; // e.g. 'euro-trip-24'

  const groupId = id as string;

  // Group Details with dynamic updates
  const [groupsData, setGroupsData] = useState<Record<string, GroupData>>({});
  const [timeline, setTimeline] = useState<TimelineFilter>('1year');
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  const [settlements, setSettlements] = useState<SimplifiedTransfer[]>([]);
  const [isSettleSheetOpen, setIsSettleSheetOpen] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  // Collaborative Permission state machines
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [isActionSheetOpen, setIsActionSheetOpen] = useState(false);
  const [isRequestPopupOpen, setIsRequestPopupOpen] = useState(false);

  // Load real transactions and simplified settlements from Supabase for this group
  // Uses useFocusEffect so data refreshes when navigating back from settle-up
  useFocusEffect(
    useCallback(() => {
      async function fetchLiveGroupData() {
        try {
          const { supabase } = await import('../../lib/supabase');
          const { data: authData } = await supabase.auth.getUser();
          const currentUserId = authData?.user?.id;
          if (!currentUserId) return;
          setUserId(currentUserId);

          // Query transactions for this specific group
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
              transaction_splits (user_id, share_amount)
            `)
            .eq('group_id', groupId);

          if (error) {
            console.error('Error fetching live group transactions:', error.message);
          }

          if (txs) {
            // Collect all payer user IDs so we can resolve names
            const payerIds = new Set<string>();
            for (const t of txs) {
              if (t.paid_by !== currentUserId) payerIds.add(t.paid_by);
            }

            // Fetch payer names in one batch
            let payerNames: Record<string, string> = {};
            if (payerIds.size > 0) {
              const { data: payerProfiles } = await supabase
                .from('users')
                .select('id, full_name')
                .in('id', [...payerIds]);
              if (payerProfiles) {
                for (const p of payerProfiles) {
                  payerNames[p.id] = p.full_name || 'Friend';
                }
              }
            }

            // Format transactions to fit UI structure
            const formatted: Transaction[] = txs.map(t => {
              const isPayerMe = t.paid_by === currentUserId;
              const splits = t.transaction_splits || [];
              
              // Share calculation
              let shareAmt = 0;
              const mySplit = splits.find((s: any) => s.user_id === currentUserId);
              const myShareAmount = mySplit ? Number(mySplit.share_amount) : 0;
              
              if (isPayerMe) {
                const othersSplits = splits.filter((s: any) => s.user_id !== currentUserId);
                shareAmt = othersSplits.reduce((sum: number, s: any) => sum + Number(s.share_amount), 0);
              } else {
                shareAmt = -myShareAmount;
              }

              const categoryIcons: Record<string, string> = {
                'food': 'restaurant',
                'travel': 'flight',
                'home': 'home',
                'other': 'receipt-long'
              };
              const isSettlement = (t as any).type === 'settlement';
              const payerDisplayName = isPayerMe ? 'You' : (payerNames[t.paid_by] || 'Friend');

              return {
                id: t.id,
                description: t.description,
                totalAmount: Number(t.amount),
                share: shareAmt,
                paidBy: payerDisplayName,
                paidByUserId: t.paid_by,
                addedBy: payerDisplayName,
                time: new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                icon: isSettlement ? 'payments' : (categoryIcons[t.category] || 'receipt-long'),
                timestamp: new Date(t.created_at).getTime(),
                status: t.status,
                type: (t as any).type || 'expense'
              };
            });

            // Update state
            setGroupsData(prev => {
              const baseGroup = prev[groupId] || group;
              
              // Calculate total spend and user balance based on live transactions
              let totalGroupSpend = 0, spentByYou = 0, yourShareSum = 0;
              // Newest first — same omission as the friend screen had.
              const allTxs = [...formatted].sort((a, b) => b.timestamp - a.timestamp);
              
              allTxs.forEach(t => {
                totalGroupSpend += t.totalAmount;
                if (t.paidBy === 'You') spentByYou += t.totalAmount;
                yourShareSum += t.share;
              });

              return {
                ...prev,
                [groupId]: {
                  ...baseGroup,
                  transactions: allTxs,
                  totalSpend: totalGroupSpend,
                  userBalance: yourShareSum,
                  spentByYou: spentByYou,
                  yourShare: Math.abs(yourShareSum)
                }
              };
            });
          }

          // Calculate net balances dynamically
          const netBalancesMap: Record<string, number> = {};
          if (txs) {
            for (const tx of txs) {
              const payer = tx.paid_by;
              netBalancesMap[payer] = (netBalancesMap[payer] || 0) + Number(tx.amount);
              for (const split of tx.transaction_splits || []) {
                netBalancesMap[split.user_id] = (netBalancesMap[split.user_id] || 0) - Number(split.share_amount);
              }
            }

            // Also collect user IDs to get names for the simplified settlements
            const userIds = new Set<string>(Object.keys(netBalancesMap));
            let names: Record<string, string> = {};
            if (userIds.size > 0) {
              const { data: usersData } = await supabase
                .from('users')
                .select('id, full_name, avatar_url')
                .in('id', [...userIds]);
              if (usersData) {
                for (const u of usersData) {
                  names[u.id] = u.full_name || 'Friend';
                }
              }
            }

            // Read the settlements the database actually stores, rather than
            // recomputing them here with a second (float-based) algorithm. The
            // ledger is written atomically by recalculate_group_settlements();
            // recomputing locally is what let the screen and the database show
            // different numbers for the same group.
            const { data: ledger, error: ledgerError } = await supabase
              .from('simplified_settlements')
              .select('debtor_id, creditor_id, amount')
              .eq('group_id', groupId);

            if (ledgerError) throw ledgerError;

            // Names for anyone in the ledger but not in the balance map
            const ledgerIds = new Set<string>();
            for (const row of ledger ?? []) {
              ledgerIds.add(row.debtor_id);
              ledgerIds.add(row.creditor_id);
            }
            const missingIds = [...ledgerIds].filter(uid => !(uid in names));
            if (missingIds.length > 0) {
              const { data: extraUsers } = await supabase
                .from('users')
                .select('id, full_name')
                .in('id', missingIds);
              for (const u of extraUsers ?? []) {
                names[u.id] = u.full_name || 'Friend';
              }
            }

            const nameFor = (uid: string) =>
              uid === currentUserId ? 'You' : (names[uid] || 'Friend');

            const dynamicSettlements: SimplifiedTransfer[] = (ledger ?? []).map(row => ({
              fromId: row.debtor_id,
              fromName: nameFor(row.debtor_id),
              toId: row.creditor_id,
              toName: nameFor(row.creditor_id),
              amount: Number(row.amount) || 0,
            }));

            setSettlements(dynamicSettlements);
          }

        } catch (err) {
          console.error('Error loading dynamic group data:', err);
        }
      }

      fetchLiveGroupData();
    }, [groupId])
  );

  // Custom visual toast banners
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const toastOpacity = React.useRef(new Animated.Value(0)).current;

  // Resolve active group details
  let group = groupsData[groupId];
  if (!group) {
    const title = (params.title as string) || (id ? (id as string).split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : 'New Circle');
    const categoryLabel = (params.categoryLabel as string) || 'Other';
    const memberCount = parseInt(params.memberCount as string || '4');
    group = {
      title,
      categoryLabel,
      memberCount,
      totalSpend: 0,
      userBalance: 0,
      spentByYou: 0,
      yourShare: 0,
      transactions: []
    };
  }

  // Toast launcher
  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setShowToast(true);
    Animated.sequence([
      Animated.timing(toastOpacity, { toValue: 1, duration: 250, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(toastOpacity, { toValue: 0, duration: 250, useNativeDriver: true }),
    ]).start(() => setShowToast(false));
  };

  const handleAddExpense = () => {
    // Navigate to expense amount setting pass selected group info
    router.push({
      pathname: '/expense/amount',
      params: {
        groupId: groupId,
        groupName: group.title
      }
    });
  };

  // Stateful timeline calculations
  const getFilteredTransactions = () => {
    const NOW = Date.now();
    const limit = {
      '30days': 30 * ONE_DAY,
      '6months': 180 * ONE_DAY,
      '1year': 365 * ONE_DAY,
      'all': Infinity
    }[timeline];

    return group.transactions.filter(t => {
      const elapsed = NOW - t.timestamp;
      return elapsed <= limit;
    });
  };

  const handleTxPress = (tx: Transaction) => {
    setSelectedTx(tx);
    setIsActionSheetOpen(true);
  };

  const handleDeleteTx = async () => {
    setIsActionSheetOpen(false);
    if (!selectedTx) return;

    try {
      const { supabase } = await import('../../lib/supabase');
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;

      // Real auth check - creator path vs non-creator path
      // Note: Because we use mocked transactions, we fall back to 'You' check if userId isn't available
      const isCreator = userId ? userId === selectedTx.paidByUserId : selectedTx.addedBy === 'You';

      if (isCreator) {
        // Creator Path
        if (userId) {
          const { error } = await supabase.from('transactions').update({ status: 'voided' }).eq('id', selectedTx.id);
          if (error) {
            console.error('Void transaction error:', error.message);
          } else {
            // Recalculate simplified_settlements for this group (atomic RPC)
            try {
              const { recalculateGroupSettlements } = await import('../../lib/recalculateSettlements');
              await recalculateGroupSettlements(groupId);
              // Refresh global balances
              await refreshBalances();
            } catch (calcErr) {
              console.error('Failed to recalculate group debts:', calcErr);
            }
          }
        }

        // Local state UI update
        const updatedTxs = group.transactions.map(t => 
          t.id === selectedTx.id ? { ...t, status: 'voided' } : t
        );
        let totalGroupSpend = 0, spentByYou = 0, yourShareSum = 0;

        updatedTxs.forEach(t => {
          if (t.status !== 'voided') {
            totalGroupSpend += t.totalAmount;
            if (t.paidBy === 'You') spentByYou += t.totalAmount;
            const shareAmt = t.totalAmount / group.memberCount;
            if (t.paidBy === 'You') yourShareSum += (t.totalAmount - shareAmt);
            else yourShareSum -= shareAmt;
          }
        });

        setGroupsData(prev => ({
          ...prev,
          [groupId]: {
            ...group,
            transactions: updatedTxs,
            totalSpend: totalGroupSpend,
            userBalance: yourShareSum,
            spentByYou: spentByYou,
            yourShare: Math.abs(yourShareSum)
          }
        }));

        triggerToast('Expense voided successfully!');

        // Trigger P-6: Send Notification to group members about deletion
        const { data: members } = await supabase.from('group_members').select('user_id').eq('group_id', groupId);
        const memberIds = (members || []).map(m => m.user_id).filter(id => id !== userId);
        
        if (memberIds.length > 0) {
          dispatchPushNotification(
            memberIds,
            'Expense Deleted',
            `${authData?.user?.user_metadata?.full_name || 'Someone'} deleted the expense: ${selectedTx.description}.`
          );
        }

      } else {
        // Non-Creator Path (Intercept)
        setIsRequestPopupOpen(true);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSendRequest = async () => {
    setIsRequestPopupOpen(false);
    triggerToast(`Request sent to ${selectedTx?.addedBy}!`);

    // Trigger P-6: Notify Creator
    try {
      if (selectedTx?.paidByUserId) {
        dispatchPushNotification(
          [selectedTx.paidByUserId],
          'Deletion Request 🗑️',
          `Someone requested to delete: ${selectedTx.description}. Tap to approve.`,
          { action: 'approve_delete' }
        );
      }
    } catch (e) {
      console.log('Error pushing to creator', e);
    }
  };

  const filteredTxs = getFilteredTransactions();

  return (
    <View className="flex-1 bg-background">
      {/* Top App Bar */}
      <View 
        className="px-5 pb-4 flex-row justify-between items-center z-50 border-b border-white/35 shadow-sm"
        style={{ 
          paddingTop: Math.max(insets.top, 24),
          backgroundColor: 'rgba(252, 249, 244, 0.72)' 
        }}
      >
        <View className="flex-row items-center space-x-4">
          <TouchableOpacity 
            onPress={() => router.back()}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
          >
            <MaterialIcons name="arrow-back" size={24} color="#004c22" />
          </TouchableOpacity>
          <Text className="font-headline-md font-bold text-primary text-xl">ZenSplit</Text>
        </View>
        <View className="flex-row items-center space-x-4">
          <Text className="hidden md:flex font-label-md text-on-surface-variant">{group.title}</Text>
          <Image 
            source={{ uri: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCP2lYulIDN3HKMzay5TmoxHl0D3_v_hFndrolveJtS5szl6Wb3TnSzc2NHAEYbAejSvqSr0CvawXdAs74w9zR-i8XejLSe5FMH42OaPqRZZhwohxeFdTQG_ntGzGHMmTA4HD1GtQqCPrSLf27KtcVlz12XCMrqBlQpQxvMH7T9xlN0KodrIkNsb8rUg-FnLNsH7Ho3Mu-FVCiPNzsAaC6uAGqFnDBWumxRu3MByst2WQH6sDmlbynwe6QX-wQwWKkYKoYLZaWDOcw' }} 
            className="w-10 h-10 rounded-full border border-outline-variant bg-surface-container"
          />
        </View>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 120 }}>
        <View className="px-5 pt-8 max-w-7xl mx-auto w-full">
          
          {/* Header Section */}
          <View className="mb-8 flex-col md:flex-row md:items-end justify-between">
            <View>
              <View className="flex-row items-center space-x-2 mb-2">
                <View className="bg-secondary-container px-3 py-1 rounded-full">
                  <Text className="text-on-secondary-container font-label-sm text-xs">{group.categoryLabel}</Text>
                </View>
                <Text className="text-on-surface-variant font-label-sm text-xs opacity-60">• {group.memberCount} Members</Text>
              </View>
              <Text className="font-headline-lg-mobile text-3xl text-on-background mb-1 font-bold">{group.title}</Text>
              <Text className="font-body-md text-on-surface-variant">
                Total Group Spend: ₹{group.totalSpend.toFixed(2)}
              </Text>
            </View>
            <TouchableOpacity 
              onPress={handleAddExpense}
              className="hidden md:flex flex-row items-center bg-primary px-6 py-3 rounded-2xl space-x-2 mt-4 md:mt-0"
            >
              <MaterialIcons name="add" size={20} color="white" />
              <Text className="text-white font-label-md font-semibold text-base">Add Expense</Text>
            </TouchableOpacity>
          </View>

          {/* Balance Card - Liquid Glass */}
          <View 
            className="p-8 rounded-3xl mb-8 overflow-hidden"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.72)',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.35)',
              shadowColor: '#1c1917',
              shadowOffset: { width: 0, height: 8 },
              shadowOpacity: 0.06,
              shadowRadius: 32,
              elevation: 2,
            }}
          >
            <View className="absolute -top-24 -right-24 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />
            <View className="flex-col md:flex-row justify-between md:items-center space-y-6 md:space-y-0 z-10">
              <View className="items-center md:items-start">
                <Text className="font-label-md text-sm text-on-surface-variant uppercase tracking-wider mb-2">Your Balance</Text>
                <Text className={`font-display-lg text-5xl font-bold mb-4 ${
                  group.userBalance > 0 ? 'text-primary' : group.userBalance < 0 ? 'text-error' : 'text-on-surface-variant'
                }`}>
                  {group.userBalance > 0 ? `+₹${group.userBalance.toFixed(2)}` : group.userBalance < 0 ? `-₹${Math.abs(group.userBalance).toFixed(2)}` : 'Settled'}
                </Text>
                <View className="flex-row items-center space-x-2">
                  <View className={`flex-row items-center space-x-2 px-4 py-2 rounded-xl ${
                    group.userBalance > 0 ? 'bg-[#DCFCE7]' : group.userBalance < 0 ? 'bg-error-container' : 'bg-surface-container-high'
                  }`}>
                    <MaterialIcons 
                      name={group.userBalance > 0 ? "check-circle" : group.userBalance < 0 ? "info" : "account-balance"} 
                      size={18} 
                      color={group.userBalance > 0 ? "#004c22" : group.userBalance < 0 ? "#ba1a1a" : "#707a6f"} 
                    />
                    <Text className={`font-label-md font-semibold text-sm ${
                      group.userBalance > 0 ? 'text-primary' : group.userBalance < 0 ? 'text-error' : 'text-on-surface-variant'
                    }`}>
                      {group.userBalance > 0 ? 'You are owed' : group.userBalance < 0 ? 'You owe' : 'Group settled'}
                    </Text>
                  </View>
                  
                  {group.userBalance !== 0 && (
                    <TouchableOpacity 
                      onPress={() => setIsSettleSheetOpen(true)}
                      className="bg-primary px-4 py-2 rounded-xl active:scale-95 duration-100 flex-row items-center space-x-1"
                      style={{ marginLeft: 12 }}
                    >
                      <MaterialIcons name="payments" size={16} color="white" />
                      <Text className="text-white font-semibold text-sm">Settle Up</Text>
                    </TouchableOpacity>
                  )}
                </View>
              </View>

              <View className="flex-row space-x-4">
                <View className="bg-surface/50 p-4 rounded-2xl border border-white/40 flex-1 md:flex-none">
                  <Text className="font-label-sm text-xs text-on-surface-variant mb-1">Spent by you</Text>
                  <Text className="font-headline-md text-xl font-bold text-on-background">
                    ₹{group.spentByYou.toFixed(2)}
                  </Text>
                </View>
                <View className="bg-surface/50 p-4 rounded-2xl border border-white/40 flex-1 md:flex-none">
                  <Text className="font-label-sm text-xs text-on-surface-variant mb-1">Your share</Text>
                  <Text className="font-headline-md text-xl font-bold text-on-background">
                    ₹{group.yourShare.toFixed(2)}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {/* Transactions List */}
          <View>
            <View className="flex-row justify-between items-center mb-6">
              <Text className="font-headline-md text-2xl font-semibold">Recent Transactions</Text>
              
              {/* Timeline filter trigger badge dropdown */}
              <TouchableOpacity 
                onPress={() => setIsFilterSheetOpen(true)}
                className="flex-row items-center space-x-1 bg-surface-container-high px-3 py-1.5 rounded-full border border-outline-variant/30 active:scale-95"
              >
                <MaterialIcons name="calendar-today" size={12} color="#004c22" />
                <Text className="text-primary text-[10px] font-bold uppercase tracking-wider pl-1">
                  {timeline === '30days' ? '30 Days' : timeline === '6months' ? '6 Months' : timeline === '1year' ? '1 Year' : 'All Time'}
                </Text>
                <MaterialIcons name="keyboard-arrow-down" size={14} color="#004c22" />
              </TouchableOpacity>
            </View>

            {filteredTxs.length === 0 ? (
              // Empty State for newly created groups
              <View className="p-8 items-center bg-white/40 border border-dashed border-outline-variant/60 rounded-3xl">
                <View className="w-12 h-12 rounded-full bg-secondary-container items-center justify-center mb-3">
                  <MaterialIcons name="receipt-long" size={24} color="#004c22" />
                </View>
                <Text className="font-semibold text-on-surface text-base mb-1">No expenses yet</Text>
                <Text className="text-sm text-on-surface-variant/80 text-center max-w-[240px]">
                  Tap the + button to add your first shared expense to this circle.
                </Text>
              </View>
            ) : (
              <View className="space-y-4">
                {filteredTxs.map((tx) => {
                  const isVoided = tx.status === 'voided';
                  const isSettlementRow = tx.type === 'settlement';
                  // A settlement is money changing hands, not a new charge.
                  // Describing it as "you are owed" / "you owe" made settling
                  // look like it had created another debt.
                  const shareText = isVoided
                    ? 'Voided'
                    : isSettlementRow
                      ? 'Settled up'
                      : (tx.share > 0 ? `You are owed ₹${tx.share.toFixed(2)}` : tx.share < 0 ? `You owe ₹${Math.abs(tx.share).toFixed(2)}` : 'Settled');
                  const isYouPaid = tx.paidBy === 'You';
                  
                  return (
                    <TouchableOpacity 
                      key={tx.id}
                      onPress={() => !isVoided && handleTxPress(tx)}
                      activeOpacity={0.8}
                      className={`p-5 rounded-2xl flex-row items-center justify-between ${isVoided ? 'opacity-50' : ''}`}
                      style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.72)',
                        borderWidth: 1,
                        borderColor: 'rgba(255, 255, 255, 0.35)',
                        shadowColor: '#1c1917',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.04,
                        shadowRadius: 8,
                        elevation: 1,
                        marginBottom: 16
                      }}
                    >
                      <View className="flex-row items-center space-x-4 flex-1">
                        <View className={`w-12 h-12 bg-surface-container rounded-xl items-center justify-center ${isVoided ? 'bg-outline-variant/30' : ''}`}>
                          <MaterialIcons name={tx.icon as any} size={24} color={isVoided ? "#9ca3af" : "#004c22"} />
                        </View>
                        <View className="flex-1 mr-2" style={{ marginLeft: 8 }}>
                          <Text className={`font-body-md font-semibold text-base ${isVoided ? 'text-outline line-through' : 'text-on-background'}`} numberOfLines={1}>
                            {isSettlementRow
                              ? (isYouPaid ? 'You made a payment' : `${tx.paidBy.split(' ')[0]} made a payment`)
                              : tx.description}
                          </Text>
                          <Text className="font-label-sm text-xs text-on-surface-variant mt-1" numberOfLines={1}>
                            {isSettlementRow ? `Payment • ${tx.time}` : `${tx.time} • Paid by ${tx.paidBy}`}
                            {!isSettlementRow && tx.status === 'settled' && ' • '}
                            {!isSettlementRow && tx.status === 'settled' && (
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
                        <Text className={`font-body-md font-bold text-base ${isVoided ? 'text-outline' : 'text-on-background'}`}>₹{tx.totalAmount.toFixed(2)}</Text>
                        <Text className={`font-label-sm text-xs mt-1 font-semibold ${
                          isVoided ? 'text-outline' : (isSettlementRow ? 'text-primary' : tx.share > 0 ? 'text-primary' : tx.share < 0 ? 'text-error' : 'text-on-surface-variant')
                        }`}>
                          {shareText}
                        </Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
          </View>

        </View>
      </ScrollView>

      {/* Floating Action Button (Mobile) */}
      <TouchableOpacity 
        onPress={handleAddExpense}
        className="md:hidden absolute bottom-6 right-6 w-16 h-16 rounded-full bg-primary items-center justify-center shadow-lg z-30 active:scale-95 duration-100"
      >
        <MaterialIcons name="add" size={32} color="white" />
      </TouchableOpacity>

      {/* 1. Timeline Filter Sheet Bottom Modal */}
      <Modal
        visible={isFilterSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsFilterSheetOpen(false)}
      >
        <TouchableOpacity 
          className="flex-1 bg-black/40 justify-end"
          activeOpacity={1}
          onPress={() => setIsFilterSheetOpen(false)}
        >
          <View 
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
          >
            {/* Top drag indicator */}
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />

            <Text className="font-headline text-lg font-bold text-on-surface mb-2">Timeline Filter</Text>
            <Text className="text-sm text-on-surface-variant mb-6">Select a period to filter circle transactions</Text>

            <View className="space-y-3">
              {([
                { key: '30days', label: 'Past 30 Days' },
                { key: '6months', label: 'Past 6 Months' },
                { key: '1year', label: 'Past 1 Year (Default)' },
                { key: 'all', label: 'All Time' }
              ] as const).map((opt) => {
                const isActive = timeline === opt.key;
                return (
                  <TouchableOpacity
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
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 2. Collaborative Actions Sheet (Edit / Delete) */}
      <Modal
        visible={isActionSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsActionSheetOpen(false)}
      >
        <TouchableOpacity 
          className="flex-1 bg-black/40 justify-end"
          activeOpacity={1}
          onPress={() => setIsActionSheetOpen(false)}
        >
          <View 
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
          >
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />

            {selectedTx && (
              <View className="mb-6 items-center">
                <Text className="font-headline text-lg font-bold text-on-surface text-center px-4">{selectedTx.description}</Text>
                <Text className="text-sm text-on-surface-variant mt-1">
                  Added by {selectedTx.addedBy === 'You' ? 'You' : selectedTx.addedBy}
                </Text>
              </View>
            )}

            <View className="space-y-4">
              {/* Every participant and their share, with a settle action each.
                  In a group where you paid, the old flow could not name a
                  single counterparty and just showed a toast pointing
                  elsewhere; this replaces that dead end. */}
              {selectedTx && (
                <TouchableOpacity
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
                </TouchableOpacity>
              )}

              {selectedTx && Math.abs(selectedTx.share) > 0 && selectedTx.status !== 'settled' && (
                <TouchableOpacity
                  onPress={() => {
                    setIsActionSheetOpen(false);
                    // Determine who the counterparty is for settlement
                    // If share > 0, someone owes you → you are owed → the payer (friend) should settle with you
                    // If share < 0, you owe someone → the payer paid and you need to pay them back
                    const isYouOwed = selectedTx.share > 0;
                    
                    // The counterparty is always the other person in this transaction
                    // paidByUserId is a UUID (never 'You')
                    let targetFriendId = '';
                    let targetFriendName = '';
                    
                    if (isYouOwed) {
                      // You paid this expense, others owe you. We need to find who owes.
                      // For group settlements, just use the paidByUserId if it's not us
                      // Since you paid, we can't settle with ourselves — show a message
                      if (selectedTx.paidByUserId === userId) {
                        // You paid and are owed — we can't auto-determine single counterparty in groups
                        triggerToast("Use the 'Settle Up' button in the balance card to see who owes you.");
                        return;
                      } else {
                        targetFriendId = selectedTx.paidByUserId;
                        targetFriendName = selectedTx.paidBy;
                      }
                    } else {
                      // You owe someone (the payer)
                      targetFriendId = selectedTx.paidByUserId;
                      targetFriendName = selectedTx.paidBy;
                    }

                    if (targetFriendId && targetFriendId !== userId) {
                      router.push({
                        pathname: '/settle-up',
                        params: {
                          friendId: targetFriendId,
                          friendName: targetFriendName,
                          balance: Math.abs(selectedTx.share).toFixed(2),
                          status: isYouOwed ? 'owed' : 'owes',
                          groupId: groupId,
                          groupName: group.title,
                          transactionId: selectedTx.id,
                          transactionDescription: selectedTx.description
                        }
                      });
                    } else {
                      triggerToast("Use the 'Settle Up' button in the balance card to see who owes you.");
                    }
                  }}
                  className="w-full h-14 bg-primary rounded-2xl flex-row items-center px-4"
                  style={{ marginBottom: 10 }}
                >
                  <MaterialIcons name="check-circle" size={22} color="white" />
                  <Text className="text-white font-semibold text-base pl-3" style={{ marginLeft: 8 }}>
                    Settle this Expense (₹{Math.abs(selectedTx.share).toFixed(2)})
                  </Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
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
              </TouchableOpacity>

              <TouchableOpacity
                onPress={handleDeleteTx}
                className="w-full h-14 bg-[#FEE2E2] rounded-2xl flex-row items-center px-4"
              >
                <MaterialIcons name="delete" size={22} color="#DC2626" />
                <Text className="text-error font-semibold text-base pl-3" style={{ marginLeft: 8 }}>
                  Delete Transaction
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Group Settle Up Bottom Sheet Modal */}
      <Modal
        visible={isSettleSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsSettleSheetOpen(false)}
      >
        <TouchableOpacity 
          className="flex-1 bg-black/40 justify-end"
          activeOpacity={1}
          onPress={() => setIsSettleSheetOpen(false)}
        >
          <View 
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
          >
            {/* Top drag indicator */}
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />

            <Text className="font-headline text-lg font-bold text-on-surface mb-2">Group Settlements</Text>
            <Text className="text-sm text-on-surface-variant mb-6">Select a settlement to record payment</Text>

            <ScrollView className="max-h-[300px]" contentContainerStyle={{ paddingBottom: 24 }}>
              {settlements.length === 0 ? (
                <Text className="text-on-surface-variant text-center py-6">No pending settlements found in this group.</Text>
              ) : (
                settlements.map((s, index) => {
                  const isYouPaying = s.fromName === 'You';
                  
                  return (
                    <TouchableOpacity
                      key={`settle-${index}`}
                      onPress={() => {
                        setIsSettleSheetOpen(false);
                        router.push({
                          pathname: '/settle-up',
                          params: {
                            friendId: isYouPaying ? s.toId : s.fromId,
                            friendName: isYouPaying ? s.toName : s.fromName,
                            balance: s.amount.toFixed(2),
                            status: isYouPaying ? 'owes' : 'owed',
                            groupId: groupId,
                            groupName: group.title
                          }
                        });
                      }}
                      className="p-4 rounded-2xl flex-row justify-between items-center bg-white border border-outline-variant/20 mb-3"
                      style={{
                        shadowColor: '#1c1917',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.04,
                        shadowRadius: 8,
                        elevation: 1,
                      }}
                    >
                      <View className="flex-row items-center space-x-3">
                        <MaterialIcons 
                          name={isYouPaying ? "arrow-upward" : "arrow-downward"} 
                          size={20} 
                          color={isYouPaying ? "#ba1a1a" : "#004c22"} 
                        />
                        <View style={{ marginLeft: 8 }}>
                          <Text className="font-semibold text-on-surface text-base">
                            {isYouPaying ? `Pay ${s.toName}` : `${s.fromName} pays You`}
                          </Text>
                          <Text className="text-xs text-on-surface-variant">
                            {isYouPaying ? 'Record your payment' : 'Record payment received'}
                          </Text>
                        </View>
                      </View>
                      <Text className={`font-bold text-lg ${isYouPaying ? 'text-error' : 'text-primary'}`}>
                        ₹{s.amount.toFixed(2)}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              )}
            </ScrollView>
          </View>
        </TouchableOpacity>
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
              Only <Text className="font-bold">{selectedTx?.addedBy}</Text> can modify this expense directly since they recorded it. Would you like to send a deletion request to {selectedTx?.addedBy.split(' ')[0]}?
            </Text>

            <View className="flex-row gap-3">
              <TouchableOpacity 
                onPress={() => setIsRequestPopupOpen(false)}
                className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center active:scale-95 bg-white/40"
              >
                <Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={handleSendRequest}
                className="flex-1 h-12 bg-primary rounded-xl items-center justify-center active:scale-95 shadow-sm"
              >
                <Text className="text-white font-semibold text-sm">Send Request</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Bottom Floating Toast Banner */}
      {showToast && (
        <Animated.View 
          style={[
            styles.toastContainer,
            { opacity: toastOpacity }
          ]}
          className="absolute bottom-10 left-6 right-6 bg-[#1C1C19] py-3.5 px-5 rounded-2xl flex-row items-center justify-between shadow-lg z-50"
        >
          <Text className="text-white font-medium text-sm flex-1">{toastMessage}</Text>
          <MaterialIcons name="info" size={18} color="#8bd79b" />
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  toastContainer: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 12,
  }
});
