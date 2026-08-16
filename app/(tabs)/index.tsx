import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Image, TouchableOpacity, TextInput, FlatList, ActivityIndicator, Alert } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Contacts from 'expo-contacts/legacy';
import { useGlobalBalances } from '../../context/GlobalBalancesContext';
import { supabase } from '../../lib/supabase';
import { getRelatedUsers } from '../../lib/friendFetcher';
import AddFriendModal from '../../components/AddFriendModal';

interface Friend {
  id: string;
  name: string;
  fullName: string;
  phoneNumber: string;
  balance: number;
  status: 'owed' | 'owes' | 'settled';
  image?: string;
  initials?: string;
}

interface RecentActivity {
  id: string;
  description: string;
  amount: number;
  category: string;
  paidByName: string;
  isOwed: boolean;
  displayAmount: number;
  date: string;
  counterpartyId?: string;
  groupId?: string;
  groupName?: string;
  friendName?: string;
  locationLabel?: string;
  status?: string;
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { totalBalance } = useGlobalBalances();

  const [userAvatar, setUserAvatar] = useState('https://lh3.googleusercontent.com/aida-public/AB6AXuDEP19bOMfvzau5jsJe8y0nOXgzOPs4n9padqgNcno1mc61wqugcfWuCuK98uHbLmrjmlS56rUvVTVwjejrgVPnuXdMAIh5le7SPf7N0edXNl2o8pksG9Xl3zKLyocsN7f6zfDG4BJy9LFuXTFmITKQTSQqtCoxofKC268TYCxDGtU81MKxuK2It0qZSWvpaxLIHiLFCAMfmvGn1u2hWciUkg_0S33thA9CT49sMrHYP_Ye6gmRgION6h2ULBHdpCjGZf3clBBC0Lk');

  useEffect(() => {
    async function loadUserAvatar() {
      try {
        const storedAv = await AsyncStorage.getItem('onboarding_avatar');
        if (storedAv) {
          setUserAvatar(storedAv);
        }
      } catch (e) {
        console.error('Failed to load home avatar:', e);
      }
    }
    loadUserAvatar();
  }, []);

  const [friendsList, setFriendsList] = useState<Friend[]>([]);
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [monthlySpend, setMonthlySpend] = useState(0);

  // Fetch friends from DB — runs every time screen comes into focus
  const fetchFriends = useCallback(async () => {
    try {
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;
      if (!userId) return;

      // Get related users only (potential friends)
      const allUsers = await getRelatedUsers(userId, 'id, full_name, avatar_url, phone_number');

      const { data: settlements } = await supabase
        .from('simplified_settlements')
        .select('debtor_id, creditor_id, amount')
        .is('group_id', null)
        .or(`debtor_id.eq.${userId},creditor_id.eq.${userId}`);

      const friendBalances: Record<string, number> = {};
      if (settlements) {
        for (const s of settlements) {
          const isDebtorMe = s.debtor_id === userId;
          const friendId = isDebtorMe ? s.creditor_id : s.debtor_id;
          const amount = Number(s.amount) || 0;
          if (isDebtorMe) {
            friendBalances[friendId] = (friendBalances[friendId] || 0) - amount;
          } else {
            friendBalances[friendId] = (friendBalances[friendId] || 0) + amount;
          }
        }
      }

      // Build friends list from all known users + balance data
      const friends: Friend[] = (allUsers || []).map((p) => {
        const balance = friendBalances[p.id] || 0;
        const name = p.full_name || 'Unknown';
        const shortName = name.split(' ')[0];
        const initials = name.split(' ').map((n: string) => n.charAt(0)).join('').toUpperCase().slice(0, 2);
        return {
          id: p.id,
          name: shortName,
          fullName: name,
          phoneNumber: p.phone_number || '',
          balance: Math.abs(balance),
          status: balance > 0 ? 'owed' as const : balance < 0 ? 'owes' as const : 'settled' as const,
          image: p.avatar_url || undefined,
          initials,
        };
      });

      setFriendsList(friends);
    } catch (e) {
      console.error('Failed to fetch friends:', e);
    }
  }, []);

  // Re-fetch friends every time the home screen is focused
  useFocusEffect(
    useCallback(() => {
      fetchFriends();
    }, [fetchFriends])
  );

  // Re-fetch recent activity every time home screen is focused
  // Phase 1B fix: Use two targeted queries instead of global fetch + JS filter
  const fetchRecentActivity = useCallback(async () => {
    try {
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;
      if (!userId) return;

      // Query 1: Transactions where I am the payer
      const { data: paidByMe, error: err1 } = await supabase
        .from('transactions')
        .select(`
          id, amount, description, category, paid_by, group_id, created_at, status, type,
          transaction_splits (user_id, share_amount)
        `)
        .eq('paid_by', userId)
        .order('created_at', { ascending: false })
        .limit(20);

      // Query 2: Transactions where I have a split (someone else paid)
      const { data: splitWithMe, error: err2 } = await supabase
        .from('transactions')
        .select(`
          id, amount, description, category, paid_by, group_id, created_at, status, type,
          transaction_splits!inner (user_id, share_amount)
        `)
        .eq('transaction_splits.user_id', userId)
        .neq('paid_by', userId)
        .order('created_at', { ascending: false })
        .limit(20);

      if ((err1 && err2) || (!paidByMe && !splitWithMe)) return;

      // Merge and deduplicate by transaction ID
      const txMap = new Map<string, any>();
      for (const tx of (paidByMe || [])) {
        txMap.set(tx.id, tx);
      }
      for (const tx of (splitWithMe || [])) {
        if (!txMap.has(tx.id)) {
          txMap.set(tx.id, tx);
        }
      }

      // Sort by created_at descending, take first 20
      const involving = [...txMap.values()]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 20);

      // Collect ALL user IDs and group IDs we need names for
      const allUserIds = new Set<string>();
      const groupIds = new Set<string>();
      for (const tx of involving) {
        allUserIds.add(tx.paid_by);
        if (tx.group_id) {
          groupIds.add(tx.group_id);
        }
        const splits = tx.transaction_splits || [];
        for (const s of splits) {
          allUserIds.add((s as any).user_id);
        }
      }

      // Fetch user profiles
      const { data: userProfiles } = await supabase
        .from('users')
        .select('id, full_name')
        .in('id', [...allUserIds]);

      const nameMap: Record<string, string> = {};
      if (userProfiles) {
        for (const p of userProfiles) {
          nameMap[p.id] = p.full_name || 'Unknown';
        }
      }

      // Fetch group titles
      const groupMap: Record<string, string> = {};
      if (groupIds.size > 0) {
        const { data: groupsData } = await supabase
          .from('groups')
          .select('id, title')
          .in('id', [...groupIds]);
        if (groupsData) {
          for (const g of groupsData) {
            groupMap[g.id] = g.title;
          }
        }
      }

      const recent: RecentActivity[] = involving.slice(0, 10).map((tx) => {
        const isPayerMe = tx.paid_by === userId;
        const splits = tx.transaction_splits || [];
        let displayAmount = 0;
        let isOwed = false;
        let counterpartyId = '';
        let friendName = '';
        let locationLabel = '';
        const groupId = tx.group_id || undefined;
        const groupName = groupId ? (groupMap[groupId] || 'Group') : undefined;

        // If I paid, others owe me (Total - My Share)
        if (isPayerMe) {
          const mySplit = splits.find((s: any) => s.user_id === userId);
          const myShare = mySplit ? Number(mySplit.share_amount) : 0;
          displayAmount = Number(tx.amount) - myShare;
          isOwed = true;
          
          // Try to guess the counterparty if possible, otherwise leave it to the UI
          const otherShares = splits.filter((s: any) => s.user_id !== userId);
          if (otherShares.length > 0) {
            counterpartyId = (otherShares[0] as any).user_id;
            friendName = nameMap[counterpartyId] || 'Friend';
          }
        } else {
          // If friend paid, I owe them my share
          const mySplit = splits.find((s: any) => s.user_id === userId);
          displayAmount = mySplit ? Number(mySplit.share_amount) : 0;
          isOwed = false;
          counterpartyId = tx.paid_by;
          friendName = nameMap[tx.paid_by] || 'Friend';
        }

        if (groupId && groupName) {
          locationLabel = `in ${groupName}`;
        } else if (friendName) {
          locationLabel = `with ${friendName}`;
        }

        return {
          id: tx.id,
          description: tx.description,
          amount: Number(tx.amount),
          category: tx.category || 'other',
          paidByName: isPayerMe ? 'You' : (nameMap[tx.paid_by] || 'Someone'),
          isOwed,
          displayAmount,
          date: new Date(tx.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          counterpartyId: counterpartyId || undefined,
          groupId,
          groupName,
          friendName,
          locationLabel,
          status: tx.status || 'active'
        };
      });

      setRecentActivity(recent);
    } catch (e) {
      console.error('Failed to fetch recent activity:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchRecentActivity();
    }, [fetchRecentActivity])
  );

  useEffect(() => {
    async function fetchMonthlySpend() {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;

        const now = new Date();
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

        const { data: txs, error } = await supabase
          .from('transactions')
          .select(`
            id,
            amount,
            paid_by,
            transaction_splits (user_id, share_amount)
          `)
          .or('paid_by.eq.' + userId + ',transaction_splits.user_id.eq.' + userId)
          .neq('type', 'settlement')
          .gte('created_at', startOfMonth);

        if (error || !txs) return;

        let total = 0;
        for (const tx of txs) {
          const splits = tx.transaction_splits || [];
          if (tx.paid_by === userId) {
            const mySplit = splits.find((s: any) => s.user_id === userId);
            total += mySplit ? Number(mySplit.share_amount) : Number(tx.amount);
          } else {
            const mySplit = splits.find((s: any) => s.user_id === userId);
            if (mySplit) {
              total += Number(mySplit.share_amount);
            }
          }
        }

        setMonthlySpend(total);
      } catch (e) {
        console.error('Failed to fetch monthly spend:', e);
      }
    }
    fetchMonthlySpend();
  }, []);
  // Modal Input State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  const getBorderColor = (friend: Friend) => {
    if (friend.status === 'owed') return 'border-[#1f6c3a]';
    if (friend.status === 'owes') return 'border-[#ba1a1a]';
    return 'border-[#bfc9bd]';
  };

  const getBalanceTextColor = (friend: Friend) => {
    if (friend.status === 'owed') return 'text-primary';
    if (friend.status === 'owes') return 'text-error';
    return 'text-outline-variant';
  };

  const getBalanceLabel = (friend: Friend) => {
    if (friend.status === 'owed') return `+₹${friend.balance.toFixed(0)}`;
    if (friend.status === 'owes') return `-₹${friend.balance.toFixed(0)}`;
    return 'Settled';
  };

  const categoryIcons: Record<string, string> = {
    food: 'restaurant',
    travel: 'flight',
    home: 'home',
    entertainment: 'movie',
    shopping: 'shopping-bag',
    other: 'receipt-long',
  };

  const getBalanceCardLabel = () => {
    if (totalBalance > 0) return "You're owed";
    if (totalBalance < 0) return 'You owe';
    return 'All settled';
  };

  const getBalanceCardAmount = () => {
    if (totalBalance > 0) return `₹${totalBalance.toFixed(2)}`;
    if (totalBalance < 0) return `-₹${Math.abs(totalBalance).toFixed(2)}`;
    return '₹0.00';
  };

  const getBalanceCardColor = () => {
    if (totalBalance > 0) return 'text-primary';
    if (totalBalance < 0) return 'text-error';
    return 'text-on-surface-variant';
  };

  return (
    <View className="flex-1 bg-surface">
      {/* Header */}
      <View 
        className="px-6 pb-4 flex-row justify-between items-center bg-surface/90 z-20"
        style={{ paddingTop: Math.max(insets.top, 24) }}
      >
        <TouchableOpacity 
          onPress={() => router.push('/profile')}
          className="w-10 h-10 rounded-full overflow-hidden border-2 border-white shadow-sm"
        >
          <Image 
            source={{ uri: userAvatar }} 
            className="w-full h-full"
          />
        </TouchableOpacity>
        <Text className="font-bold text-2xl text-primary tracking-tight">Kinlo</Text>
        <TouchableOpacity 
          onPress={() => router.push('/profile')}
          className="w-10 h-10 rounded-full items-center justify-center bg-surface-container active:scale-95"
        >
          <MaterialIcons name="settings" size={22} color="#404940" />
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 120 }}>
        
        {/* Friends Horizontal Strip */}
        <ScrollView 
          horizontal 
          showsHorizontalScrollIndicator={false}
          className="pl-6 py-2 mb-4"
          contentContainerStyle={{ gap: 16, paddingRight: 24 }}
        >
          {/* Add Friend Button */}
          <TouchableOpacity 
            onPress={() => setIsAddModalOpen(true)}
            className="items-center gap-1.5"
          >
            <View className="w-16 h-16 rounded-full border-[2.5px] border-dashed border-primary bg-surface items-center justify-center">
              <MaterialIcons name="person-add" size={28} color="#004c22" />
            </View>
            <Text className="text-xs font-semibold text-primary">Add</Text>
          </TouchableOpacity>

          {/* Dynamic Friends List */}
          {friendsList.slice(0, 10).map(friend => (
            <TouchableOpacity 
              key={friend.id}
              onPress={() => router.push({
                pathname: `/friend/${friend.id}`,
                params: {
                  friendName: friend.fullName,
                  friendPhone: friend.phoneNumber
                }
              })} 
              className="items-center gap-1.5"
            >
              <View 
                className={`w-16 h-16 rounded-full border-[3px] p-[2px] bg-surface ${getBorderColor(friend)}`}
              >
                {friend.image ? (
                  <Image 
                    source={{ uri: friend.image }} 
                    className="w-full h-full rounded-full"
                  />
                ) : (
                  <View className="w-full h-full rounded-full bg-secondary-container items-center justify-center">
                    <Text className="text-primary font-bold">{friend.initials}</Text>
                  </View>
                )}
              </View>
              <View className="items-center">
                <Text className="text-xs font-semibold text-on-surface">{friend.name}</Text>
                <Text className={`text-[10px] font-bold mt-0.5 ${getBalanceTextColor(friend)}`}>
                  {getBalanceLabel(friend)}
                </Text>
              </View>
            </TouchableOpacity>
          ))}

          {friendsList.length > 10 && (
            <TouchableOpacity 
              onPress={() => router.push('/friends')}
              className="items-center gap-1.5"
            >
              <View className="w-16 h-16 rounded-full border-[2.5px] border-outline-variant/50 bg-surface-container items-center justify-center active:scale-95">
                <MaterialIcons name="arrow-forward" size={26} color="#404940" />
              </View>
              <Text className="text-xs font-semibold text-on-surface-variant">View All</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {/* Balance Card */}
        <View className="px-6 mb-6">
          <View className="liquid-glass rounded-3xl p-6 items-center">
            <Text className="text-sm font-medium text-on-surface-variant uppercase tracking-wider mb-2">{getBalanceCardLabel()}</Text>
            <Text className={`text-5xl font-bold mb-6 ${getBalanceCardColor()}`}>{getBalanceCardAmount()}</Text>
            <View className="flex-row gap-3 w-full">
              <TouchableOpacity 
                onPress={() => router.push('/settle-up')}
                className="flex-1 bg-primary py-3.5 rounded-2xl items-center shadow-sm"
              >
                <Text className="text-white font-semibold text-base">Settle Up</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                onPress={() => router.push('/statement')}
                className="flex-1 liquid-glass py-3.5 rounded-2xl items-center"
              >
                <Text className="text-primary font-semibold text-base">Statement</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* Insights Grid */}
        <View className="px-6 flex-row gap-4 mb-8">
          <TouchableOpacity className="flex-1 liquid-glass rounded-3xl p-5">
            <View className="w-10 h-10 rounded-full bg-surface mb-3 items-center justify-center">
              <MaterialIcons name="trending-up" size={20} color="#004c22" />
            </View>
            <Text className="text-xs font-medium text-on-surface-variant uppercase tracking-wider mb-1">Monthly Spend</Text>
            <Text className="text-xl font-bold text-on-surface">₹{monthlySpend.toFixed(0)}</Text>
          </TouchableOpacity>
          <TouchableOpacity className="flex-1 liquid-glass rounded-3xl p-5">
            <View className="w-10 h-10 rounded-full bg-secondary-container mb-3 items-center justify-center">
              <MaterialIcons name="eco" size={20} color="#004c22" />
            </View>
            <Text className="text-xs font-medium text-on-surface-variant uppercase tracking-wider mb-1">Eco Impact</Text>
            <Text className="text-xl font-bold text-primary">Coming Soon</Text>
          </TouchableOpacity>
        </View>

        {/* Smart Suggestion */}
        <View className="px-6 mb-8">
          <TouchableOpacity className="bg-[#8bd79b]/20 border border-[#004c22]/20 rounded-2xl p-4 flex-row gap-4 items-center">
            <View className="w-12 h-12 rounded-full bg-white items-center justify-center shadow-sm">
              <MaterialIcons name="auto-awesome" size={24} color="#004c22" />
            </View>
            <View className="flex-1">
              <Text className="text-xs font-bold text-primary uppercase tracking-wider mb-0.5">Smart Split</Text>
              <Text className="font-semibold text-on-surface" numberOfLines={1}>{recentActivity.length > 0 ? 'Review your recent splits and settle up!' : 'Start splitting expenses with friends!'}</Text>
            </View>
            <MaterialIcons name="chevron-right" size={24} color="#004c22" />
          </TouchableOpacity>
        </View>

        {/* Recent Activity */}
        <View className="px-6 mb-4">
          <View className="flex-row justify-between items-center mb-4">
            <Text className="font-semibold text-xl text-on-surface">Recent Activity</Text>
            <TouchableOpacity onPress={() => router.push('/statement')}>
              <Text className="text-primary font-semibold text-sm">See all</Text>
            </TouchableOpacity>
          </View>

          <View className="gap-3">
            {recentActivity.length === 0 ? (
              <View className="liquid-glass rounded-2xl p-6 items-center justify-center">
                <Text className="font-semibold text-on-surface-variant">No recent activity</Text>
              </View>
            ) : (
              recentActivity.map((item) => {
                const isVoided = item.status === 'voided';

                return (
                  <TouchableOpacity 
                    key={item.id}
                    onPress={() => {
                      if (isVoided) return;
                      if (item.groupId) {
                        router.push({
                          pathname: `/group/${item.groupId}`
                        });
                      } else if (item.counterpartyId) {
                        router.push({
                          pathname: `/friend/${item.counterpartyId}`,
                          params: { friendName: item.friendName || 'Friend' }
                        });
                      } else {
                        Alert.alert("Incomplete Transaction", "This transaction is missing the friend's data in the database. It was likely created before the recent bug fixes. Please delete it and create a new one.");
                      }
                    }}
                    className={`rounded-2xl p-4 flex-row items-center gap-3 ${isVoided ? 'opacity-50' : ''}`}
                    style={{
                      backgroundColor: 'rgba(255, 255, 255, 0.72)', // liquid-glass for active
                      borderColor: 'rgba(255, 255, 255, 0.4)',
                    }}
                  >
                    <View className={`w-10 h-10 rounded-full items-center justify-center ${isVoided ? 'bg-outline-variant/30' : 'bg-surface-container'}`}>
                      <MaterialIcons 
                        name={((item as any).type === 'settlement'
                          ? 'payments' 
                          : (categoryIcons[item.category] || 'receipt-long')) as any} 
                        size={20} 
                        color={isVoided ? "#9ca3af" : "#004c22"} 
                      />
                    </View>
                    <View className="flex-1">
                      <Text className={`font-semibold text-sm ${isVoided ? 'text-outline line-through' : 'text-on-surface'}`} numberOfLines={1}>{item.description}</Text>
                      <Text className="text-xs text-on-surface-variant mt-0.5">
                        {item.paidByName} paid ₹{item.amount.toFixed(0)}
                        {item.locationLabel ? ` • ${item.locationLabel}` : ''}
                        {` • ${item.date}`}
                      </Text>
                      <Text className={`text-xs font-semibold mt-0.5 ${isVoided ? 'text-outline' : (item.status === 'settled' || item.displayAmount <= 0 ? 'text-[#1f6c3a]' : (item.isOwed ? 'text-[#1f6c3a]' : 'text-[#ba1a1a]'))}`}>
                        {isVoided ? 'Voided' : (item.status === 'settled' || item.displayAmount <= 0
                          ? 'Settled'
                          : (item.isOwed ? `You get back ₹${item.displayAmount.toFixed(2)}` : `You owe ₹${item.displayAmount.toFixed(2)}`))}
                      </Text>
                    </View>
                    <Text className={`font-bold text-base ${isVoided ? 'text-outline' : (item.displayAmount === 0 ? 'text-[#404940]' : (item.isOwed ? 'text-[#1f6c3a]' : 'text-[#ba1a1a]'))}`}>
                      {item.displayAmount > 0 ? (item.isOwed ? '+' : '-') : ''}₹{item.displayAmount.toFixed(2)}
                    </Text>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        </View>
      </ScrollView>

      {/* Floating Action Button */}
      <TouchableOpacity 
        onPress={() => router.push('/expense/amount')}
        className="absolute bottom-[100px] right-6 w-16 h-16 rounded-2xl bg-primary items-center justify-center shadow-lg z-30"
      >
        <MaterialIcons name="add" size={32} color="white" />
      </TouchableOpacity>

      {/* Add Friend Full Modal */}
      <AddFriendModal 
        isOpen={isAddModalOpen} 
        onClose={() => setIsAddModalOpen(false)} 
        onSuccess={fetchFriends} 
      />
    </View>
  );
}
