import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, Modal, StyleSheet, Animated } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useGlobalBalances } from '../../context/GlobalBalancesContext';
import { dispatchPushNotification } from '../../lib/pushDispatcher';
import { fetchBalanceMap, statusFor } from '../../lib/balances';

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
}

interface FriendData {
  name: string;
  email: string;
  avatarUrl?: string;
  initials?: string;
  balance: number;
  status: 'owed' | 'owes' | 'settled';
  transactions: Transaction[];
}


const ONE_DAY = 24 * 60 * 60 * 1000;


type TimelineFilter = '30days' | '6months' | '1year' | 'all';

export default function FriendDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { id, friendName, friendEmail } = useLocalSearchParams<{ id: string; friendName?: string; friendEmail?: string }>();
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

  // Collaborative Permission Sheets
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [isActionSheetOpen, setIsActionSheetOpen] = useState(false);
  const [isRequestPopupOpen, setIsRequestPopupOpen] = useState(false);

  // Load real transactions from Supabase
  useFocusEffect(
    React.useCallback(() => {
      async function fetchLiveTransactions() {
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) {
          setLoadState('error');
          setLoadError('You appear to be signed out. Sign in again to see this balance.');
          return;
        }

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
            transaction_splits (user_id, share_amount)
          `)
          // No .or() on transaction_splits here. Filtering an embedded table
          // inside a top-level .or() only works in PostgREST when the embed is
          // an inner join; without that it can fail outright, and a failed
          // fetch used to surface as "All settled up". It is also redundant:
          // RLS (transactions_select, migrations/0002) already restricts rows
          // to ones the caller paid for, is a member of, or has a split in,
          // and the code below re-filters to this specific friend anyway.
          .is('group_id', null);

        if (error) {
          console.error('Error fetching live transactions:', error.message);
          setLoadState('error');
          setLoadError(error.message);
          return;
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
            let shareAmt = 0;
            const mySplit = splits.find((s: any) => s.user_id === userId);
            if (isPayerMe) {
              const myShare = mySplit ? Number(mySplit.share_amount) : 0;
              shareAmt = Number(t.amount) - myShare;
            } else {
              shareAmt = mySplit ? -Number(mySplit.share_amount) : 0;
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
              status: t.status || 'active'
            };
          });

          // The balance comes from the ledger, not from summing the rows
          // above. Those two used to be computed separately and drifted
          // apart, which is how this screen could show a figure that Home
          // and Settle Up disagreed with. The transaction list below is
          // still built locally — it is a history view, not the balance.
          const balanceMap = await fetchBalanceMap(userId);
          const totalBalance = balanceMap[finalFriendId] || 0;

          setFriendsData(prev => {
            const baseFriend = prev[friendId] || { name: friendName || 'Unknown', email: '' };
            return {
              ...prev,
              [friendId]: {
                ...baseFriend,
                transactions: [...formatted],
                balance: Math.abs(totalBalance),
                status: totalBalance > 0 ? 'owed' : totalBalance < 0 ? 'owes' : 'settled'
              }
            };
          });
          setLoadState('ready');
          setLoadError(null);
        }
      } catch (err: any) {
        console.error('Error loading dynamic transactions:', err);
        setLoadState('error');
        setLoadError(err?.message || 'Could not load this balance.');
      }
    }

    fetchLiveTransactions();
  }, [friendId, friendName]));

  // Toast animations
  const [toastMessage, setToastMessage] = useState('');
  const [showToast, setShowToast] = useState(false);
  const toastOpacity = React.useRef(new Animated.Value(0)).current;

  // Resolve current active friend data
  let friend = friendsData[friendId];
  if (!friend) {
    const name = friendName || (id ? id.charAt(0).toUpperCase() + id.slice(1) : 'New Friend');
    const email = friendEmail || `${friendId}@example.com`;
    const initials = name.split(' ').map(n => n.charAt(0)).join('').toUpperCase().slice(0, 2);
    friend = {
      name,
      email,
      balance: 0,
      status: 'settled',
      transactions: [],
      initials
    };
  }

  // Display Toast helper
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
    router.push({
      pathname: '/expense/amount',
      params: {
        friendId: friendId,
        friendName: friend.name
      }
    });
  };

  const handleSettleUp = () => {
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
    router.push({
      pathname: '/settle-up',
      params: {
        friendId: friendId,
        friendName: friend.name,
        balance: Math.abs(friend.balance).toFixed(2),
        status: friend.status
      }
    });
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
  const handleDeleteTx = async () => {
    setIsActionSheetOpen(false);
    if (!selectedTx) return;

    if (selectedTx.addedBy === 'You') {
      try {
        // Void transaction instead of hard delete
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        const currentUserId = authData?.user?.id;
        await supabase.from('transactions').update({ status: 'voided' }).eq('id', selectedTx.id);

        // Phase 2C: recalculate 1-on-1 settlements from scratch. The delete and
        // the rebuild now happen inside one Postgres transaction.
        if (currentUserId) {
          try {
            const { recalculatePairSettlements } = await import('../../lib/recalculateSettlements');
            await recalculatePairSettlements(friendId as string);
            await refreshBalances();
          } catch (debtErr) {
            console.warn('Post-void debt recalculation error (non-critical):', debtErr);
          }
        }

        // Direct action permitted: mark item as voided
        const updatedTxs = friend.transactions.map(t =>
          t.id === selectedTx.id ? { ...t, status: 'voided' } : t
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
        if (selectedTx.paidByUserId) {
          const counterpartyId = selectedTx.paidByUserId === currentUserId ? friendId : selectedTx.paidByUserId;
          dispatchPushNotification(
            [counterpartyId],
            'Expense Deleted',
            `${authData?.user?.user_metadata?.full_name || 'Someone'} deleted the expense: ${selectedTx.description}.`
          );
        }
      } catch (err) {
        console.error('Error voiding transaction:', err);
        triggerToast('Failed to void transaction.');
      }
    } else {
      // Intercept with Collaborative Permission Modal
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
        <View className="flex-row items-center space-x-4">
          <TouchableOpacity 
            onPress={() => router.back()}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
          >
            <MaterialIcons name="arrow-back" size={24} color="#004c22" />
          </TouchableOpacity>
          <Text className="font-headline-md font-bold text-primary text-xl">ZenSplit</Text>
        </View>
        <View className="w-10 h-10 rounded-full border border-outline-variant bg-surface-container items-center justify-center overflow-hidden">
          {friend.avatarUrl ? (
            <Image source={{ uri: friend.avatarUrl }} className="w-full h-full" />
          ) : (
            <Text className="text-primary font-bold text-sm">{friend.initials}</Text>
          )}
        </View>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 120 }}>
        <View className="px-5 pt-8 max-w-xl mx-auto w-full flex-col items-center">
          
          {/* Friend Profile Header */}
          <View className="items-center mb-6 w-full">
            <View className="w-20 h-20 rounded-full border-2 border-white shadow-sm mb-4 bg-secondary-container items-center justify-center overflow-hidden">
              {friend.avatarUrl ? (
                <Image source={{ uri: friend.avatarUrl }} className="w-full h-full" />
              ) : (
                <Text className="text-primary font-bold text-2xl">{friend.initials}</Text>
              )}
            </View>
            <Text className="text-2xl font-bold text-on-surface mb-1">{friend.name}</Text>
            <Text className="text-sm text-on-surface-variant mb-4">{friend.email}</Text>

            {/* Net Balance Status Badge */}
            {friend.status === 'owed' && (
              <View className="flex-col items-center">
                <View className="flex-row items-center space-x-2 bg-[#DCFCE7] px-4 py-1.5 rounded-full mb-2">
                  <View className="w-2 h-2 rounded-full bg-primary" />
                  <Text className="text-primary font-semibold text-xs uppercase tracking-wider">You are owed</Text>
                </View>
                <Text className="text-4xl font-bold text-primary">+₹{friend.balance.toFixed(2)}</Text>
              </View>
            )}

            {friend.status === 'owes' && (
              <View className="flex-col items-center">
                <View className="flex-row items-center space-x-2 bg-error-container px-4 py-1.5 rounded-full mb-2">
                  <View className="w-2 h-2 rounded-full bg-error" />
                  <Text className="text-error font-semibold text-xs uppercase tracking-wider">You owe</Text>
                </View>
                <Text className="text-4xl font-bold text-error">-₹{Math.abs(friend.balance).toFixed(2)}</Text>
              </View>
            )}

            {friend.status === 'settled' && (
              <View className="flex-col items-center">
                <View className="flex-row items-center space-x-2 bg-surface-container-highest px-4 py-1.5 rounded-full mb-2">
                  <View className="w-2 h-2 rounded-full bg-outline" />
                  <Text className="text-on-surface-variant font-semibold text-xs uppercase tracking-wider">Settled up</Text>
                </View>
                <Text className="text-4xl font-bold text-outline">Settled</Text>
              </View>
            )}
          </View>

          {/* Action Buttons */}
          <View className="flex-row gap-3 w-full mb-8">
            <TouchableOpacity 
              onPress={handleAddExpense}
              className="flex-1 bg-primary py-3.5 rounded-2xl items-center shadow-md shadow-primary/20 active:scale-95 duration-100"
            >
              <Text className="text-white font-semibold text-base">Add Expense</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              onPress={handleSettleUp}
              className="flex-1 py-3.5 rounded-2xl items-center border active:scale-95 duration-100"
              style={{
                backgroundColor: 'rgba(255, 255, 255, 0.72)',
                borderColor: 'rgba(255, 255, 255, 0.35)',
              }}
            >
              <Text className="text-primary font-semibold text-base">Settle Up</Text>
            </TouchableOpacity>
          </View>

          <View className="w-full h-px bg-outline-variant/30 mb-6" />

          {/* Transaction History Section Header with Filter Pill */}
          <View className="w-full">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="font-headline-md text-lg font-semibold text-on-surface">Transaction History</Text>
              
              {/* Timeline Filter Trigger Badge */}
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
            
            {/* Stateful Transaction Card Feeds */}
            <View className="space-y-4">
              {filteredTxs.length === 0 ? (
                <View className="py-12 items-center justify-center bg-white/40 border border-dashed border-outline-variant/60 rounded-3xl">
                  <MaterialIcons name="event-busy" size={32} color="#707a6f" className="mb-2" />
                  <Text className="text-on-surface-variant font-medium text-sm">No transactions in selected timeline</Text>
                </View>
              ) : (
                filteredTxs.map((tx) => {
                  const isPositive = tx.share > 0;
                  const isVoided = tx.status === 'voided' || tx.status === 'rejected' || tx.status === 'disputed';
                  
                  return (
                    <View
                      key={tx.id}
                      className={`p-4 rounded-2xl flex-col ${isVoided ? 'opacity-50' : ''}`}
                      style={{
                        backgroundColor: 'rgba(255, 255, 255, 0.72)',
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
                      <TouchableOpacity 
                        onPress={() => !isVoided && handleTxPress(tx)}
                        activeOpacity={0.8}
                        className="flex-row items-center justify-between"
                      >
                        <View className="flex-row items-center space-x-4 flex-1">
                          <View className={`w-12 h-12 bg-surface rounded-full items-center justify-center overflow-hidden ${isVoided ? 'bg-outline-variant/30' : ''}`}>
                            <MaterialIcons 
                              name={tx.icon as any} 
                              size={24} 
                              color={isVoided ? "#9ca3af" : (isPositive ? "#004c22" : "#707a6f")} 
                            />
                          </View>
                           <View className="flex-1 mr-2" style={{ marginLeft: 8 }}>
                             <Text className={`font-semibold text-base ${isVoided ? 'text-outline line-through' : 'text-on-surface'}`} numberOfLines={1}>
                               {tx.description}
                             </Text>
                             <Text className="text-xs text-on-surface-variant mt-0.5" numberOfLines={1}>
                               {tx.paidBy} paid ₹{tx.totalAmount.toFixed(2)} • {tx.time}
                               {tx.status === 'settled' && ' • '}
                               {tx.status === 'settled' && (
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
                          <Text className={`font-headline-md font-bold text-base ${isVoided ? 'text-outline' : (isPositive ? 'text-primary' : 'text-error')}`}>
                            {isPositive ? '+' : '-'}₹{Math.abs(tx.share).toFixed(2)}
                          </Text>
                        </View>
                      </TouchableOpacity>
                    </View>
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
        <TouchableOpacity 
          className="flex-1 bg-black/40 justify-end"
          activeOpacity={1}
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
                <Text className="font-headline text-lg font-bold text-on-surface">{selectedTx.description}</Text>
                <Text className="text-sm text-on-surface-variant mt-1">
                  Added by {selectedTx.addedBy === 'You' ? 'You' : selectedTx.addedBy}
                </Text>
              </View>
            )}

            <View className="space-y-4">
              {selectedTx && Math.abs(selectedTx.share) > 0 && selectedTx.status !== 'settled' && (
                <TouchableOpacity
                  onPress={() => {
                    setIsActionSheetOpen(false);
                    router.push({
                      pathname: '/settle-up',
                      params: {
                        friendId: friendId,
                        friendName: friend.name,
                        balance: Math.abs(selectedTx.share).toFixed(2),
                        status: selectedTx.share > 0 ? 'owed' : 'owes',
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
