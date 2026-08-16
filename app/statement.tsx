import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, ActivityIndicator, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { supabase } from '../lib/supabase';
import { useGlobalBalances } from '../context/GlobalBalancesContext';
import { dispatchPushNotification } from '../lib/pushDispatcher';

type FilterType = 'All' | 'You Paid' | 'You Owe';

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
}

export default function StatementScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  
  const [transactions, setTransactions] = useState<StatementTx[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<FilterType>('All');
  const [runningNetBalance, setRunningNetBalance] = useState(0);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [currentUserName, setCurrentUserName] = useState<string>('A friend');

  const { refreshBalances } = useGlobalBalances();

  const fetchStatement = useCallback(async () => {
    try {
      setLoading(true);
      const { data: authData } = await supabase.auth.getUser();
      
      if (!authData?.user) {
        setLoading(false);
        return;
      }
      
      const userId = authData.user.id;
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
        .or('paid_by.eq.' + userId + ',transaction_splits.user_id.eq.' + userId)
        .order('created_at', { ascending: false });

      if (error || !txs) {
        console.error("Statement fetch error:", error);
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
          for (const g of groups) groupMap[g.id] = g.title || 'Group';
        }
      }

      const userName = nameMap[userId] || authData.user.user_metadata?.full_name || 'A friend';
      setCurrentUserName(userName);

      let totalBalance = 0;
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

        totalBalance += userShare;

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
          type: t.type || 'expense'
        });
      }

      setTransactions(processedTxs);
      setRunningNetBalance(totalBalance);
    } catch (err) {
      console.error("Statement error:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchStatement();
    }, [fetchStatement])
  );

  const handleApprove = async (tx: StatementTx) => {
    try {
      setLoading(true);
      await supabase.from('transactions').update({ status: 'active' }).eq('id', tx.id);
      
      const { data: splits } = await supabase.from('transaction_splits').select('*').eq('transaction_id', tx.id);
      if (splits) {
        const payerId = tx.paidByUserId;
        const otherSplit = splits.find(s => s.user_id !== payerId);
        if (otherSplit) {
          // Recompute the pair's net position instead of appending a row —
          // the old insert stacked a new debt on top of any existing one.
          const { data: authData } = await supabase.auth.getUser();
          const me = authData?.user?.id;
          const counterpartyId = me === payerId ? otherSplit.user_id : payerId;

          const { recalculatePairSettlements } = await import('../lib/recalculateSettlements');
          await recalculatePairSettlements(counterpartyId);
          await refreshBalances();
          
          dispatchPushNotification(
            [payerId],
            'Expense Approved ✅',
            `Your expense "${tx.description}" was approved and added to the ledger.`
          );
        }
      }
      
      Alert.alert('Success', 'Expense approved and added to ledger!');
      await fetchStatement();
    } catch (err) {
      console.error(err);
      Alert.alert('Error', 'Failed to approve expense.');
      setLoading(false);
    }
  };

  const handleReject = async (tx: StatementTx) => {
    try {
      setLoading(true);
      await supabase.from('transactions').update({ status: 'rejected' }).eq('id', tx.id);
      
      dispatchPushNotification(
        [tx.paidByUserId],
        'Expense Rejected ❌',
        `${currentUserName} rejected your expense ₹${Math.abs(tx.userShare).toFixed(0)} for "${tx.description}".`
      );

      Alert.alert('Success', 'Expense rejected.');
      await fetchStatement();
    } catch (err) {
      console.error(err);
      Alert.alert('Error', 'Failed to reject expense.');
      setLoading(false);
    }
  };

  const handleConfirmSettlement = async (tx: StatementTx) => {
    try {
      setLoading(true);
      await supabase.from('transactions').update({ status: 'active' }).eq('id', tx.id);
      await refreshBalances();
      
      dispatchPushNotification(
        [tx.paidByUserId],
        'Settlement Confirmed ✅',
        `${currentUserName} confirmed your settlement of ₹${Math.abs(tx.userShare).toFixed(0)}.`
      );

      Alert.alert('Success', 'Settlement confirmed!');
      await fetchStatement();
    } catch (err) {
      console.error(err);
      Alert.alert('Error', 'Failed to confirm settlement.');
      setLoading(false);
    }
  };

  const handleDisputeSettlement = async (tx: StatementTx) => {
    try {
      setLoading(true);
      await supabase.from('transactions').update({ status: 'disputed' }).eq('id', tx.id);
      
      dispatchPushNotification(
        [tx.paidByUserId],
        'Settlement Disputed ⚠️',
        `${currentUserName} disputed your settlement of ₹${Math.abs(tx.userShare).toFixed(0)}. The original balance has been restored.`
      );

      Alert.alert('Success', 'Settlement disputed. Original balance restored.');
      await fetchStatement();
    } catch (err) {
      console.error(err);
      Alert.alert('Error', 'Failed to dispute settlement.');
      setLoading(false);
    }
  };

  const getFilteredTransactions = () => {
    if (filter === 'You Paid') {
      return transactions.filter(t => t.userShare > 0);
    }
    if (filter === 'You Owe') {
      return transactions.filter(t => t.userShare < 0);
    }
    return transactions;
  };

  const filtered = getFilteredTransactions();

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
        <TouchableOpacity 
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="arrow-back" size={24} color="#1c1c19" />
        </TouchableOpacity>
        <Text className="font-headline-md font-bold text-primary text-xl ml-2 flex-1">Statement</Text>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 100 }}>
        {/* Net Balance Header */}
        <View className="items-center justify-center pt-8 pb-6 px-6">
          <Text className="font-label-md text-sm text-on-surface-variant uppercase tracking-wider mb-2">Net Balance</Text>
          <Text className={`font-display-lg text-5xl font-bold ${
            runningNetBalance > 0 ? 'text-primary' : runningNetBalance < 0 ? 'text-error' : 'text-on-surface'
          }`}>
            {runningNetBalance > 0 ? '+' : runningNetBalance < 0 ? '-' : ''}₹{Math.abs(runningNetBalance).toFixed(2)}
          </Text>
          {runningNetBalance !== 0 && (
            <View className={`mt-3 px-4 py-1.5 rounded-full ${runningNetBalance > 0 ? 'bg-[#DCFCE7]' : 'bg-error-container'}`}>
              <Text className={`font-label-md font-semibold text-sm ${runningNetBalance > 0 ? 'text-primary' : 'text-error'}`}>
                {runningNetBalance > 0 ? 'You are owed overall' : 'You owe overall'}
              </Text>
            </View>
          )}
        </View>

        {/* Filter Tabs */}
        <View className="px-5 mb-6">
          <View className="flex-row p-1 bg-surface-container-high rounded-2xl">
            {(['All', 'You Paid', 'You Owe'] as FilterType[]).map((tab) => (
              <TouchableOpacity
                key={tab}
                onPress={() => setFilter(tab)}
                className={`flex-1 py-2.5 rounded-xl items-center justify-center ${filter === tab ? 'bg-white shadow-sm border border-outline-variant/20' : 'bg-transparent'}`}
              >
                <Text className={`font-label-md font-semibold text-sm ${filter === tab ? 'text-primary' : 'text-on-surface-variant'}`}>
                  {tab}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Transactions List */}
        <View className="px-5">
          <Text className="font-headline text-lg font-bold text-on-surface mb-4">Transaction History</Text>
          
          {loading ? (
            <View className="py-10 items-center justify-center">
              <ActivityIndicator size="large" color="#004c22" />
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
            <View className="space-y-4">
              {filtered.map((tx) => (
                <View 
                  key={tx.id}
                  className="p-5 rounded-2xl flex-col"
                  style={{
                    backgroundColor: (tx.status === 'rejected' || tx.status === 'disputed') 
                        ? 'rgba(254, 226, 226, 0.5)' 
                        : 'rgba(255, 255, 255, 0.72)',
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
                    <View className="flex-row items-center space-x-4 flex-1">
                      <View className={`w-12 h-12 rounded-xl items-center justify-center ${tx.userShare > 0 ? 'bg-[#DCFCE7]' : 'bg-error-container/50'}`}>
                        <MaterialIcons name={getCategoryIcon(tx.category)} size={24} color={tx.userShare > 0 ? "#004c22" : "#ba1a1a"} />
                      </View>
                      <View className="flex-1 mr-2" style={{ marginLeft: 12 }}>
                        <Text className="font-body-md font-semibold text-on-background text-base" numberOfLines={1}>{tx.description}</Text>
                        <Text className="font-label-sm text-xs text-on-surface-variant mt-1" numberOfLines={1}>
                          {tx.dateString} • {tx.groupOrFriendName}
                        </Text>
                      </View>
                    </View>
                    <View className="items-end justify-center">
                      <Text className={`font-body-md font-bold text-base ${
                        tx.userShare > 0 ? 'text-primary' : 'text-error'
                      }`}>
                        {tx.userShare > 0 ? '+' : '-'}₹{Math.abs(tx.userShare).toFixed(2)}
                      </Text>
                      <Text className="font-label-sm text-[10px] text-on-surface-variant mt-1">
                        Total: ₹{tx.totalAmount.toFixed(2)}
                      </Text>
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
              ))}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  );
}
