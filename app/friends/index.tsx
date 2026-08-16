import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Image, TouchableOpacity, TextInput, FlatList } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { getRelatedUsers } from '../../lib/friendFetcher';
import { fetchBalances } from '../../lib/balances';
import AddFriendModal from '../../components/AddFriendModal';

interface Friend {
  id: string;
  name: string;
  fullName: string;
  phoneNumber: string;
  balance: number;
  status: 'owed' | 'owes' | 'settled';
  image?: string;
  initials: string;
}

export default function FriendsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [friendsList, setFriendsList] = useState<Friend[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  // Balances come from the shared snapshot (lib/balances.ts), so this list
  // agrees with Home, the settle-up picker and the friend detail screen by
  // construction rather than by four copies of the same query happening to
  // match.
  const fetchFriends = useCallback(async () => {
    try {
      const { friends } = await fetchBalances();

      const mapped: Friend[] = friends.map((f) => ({
        id: f.id,
        name: f.name,
        fullName: f.fullName,
        phoneNumber: f.phoneNumber,
        balance: Math.abs(f.balance),
        status: f.status,
        image: f.avatarUrl,
        initials: f.initials,
      }));

      // Sort alphabetically
      mapped.sort((a, b) => a.fullName.localeCompare(b.fullName));

      setFriendsList(mapped);
    } catch (e) {
      console.error('Failed to fetch friends:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchFriends();
    }, [fetchFriends])
  );

  const filteredFriends = friendsList.filter(f => 
    f.fullName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    f.phoneNumber.includes(searchQuery)
  );

  const getBorderColor = (friend: Friend) => {
    if (friend.status === 'owed') return 'border-[#1f6c3a]';
    if (friend.status === 'owes') return 'border-[#ba1a1a]';
    return 'border-[#bfc9bd]';
  };

  const getBalanceTextColor = (friend: Friend) => {
    if (friend.status === 'owed') return 'text-[#1f6c3a]';
    if (friend.status === 'owes') return 'text-[#ba1a1a]';
    return 'text-[#707a6f]';
  };

  const getBalanceLabel = (friend: Friend) => {
    if (friend.status === 'owed') return `+₹${friend.balance.toFixed(0)}`;
    if (friend.status === 'owes') return `-₹${friend.balance.toFixed(0)}`;
    return 'Settled';
  };

  return (
    <View className="flex-1 bg-surface">
      {/* Header */}
      <View 
        className="px-6 pb-4 flex-row items-center justify-between bg-surface z-20 shadow-sm border-b border-outline-variant/20"
        style={{ paddingTop: Math.max(insets.top, 24) }}
      >
        <TouchableOpacity onPress={() => router.back()} className="w-10 h-10 rounded-full items-center justify-center bg-surface-container active:scale-95">
          <MaterialIcons name="arrow-back" size={24} color="#404940" />
        </TouchableOpacity>
        <Text className="font-bold text-xl text-on-surface">All Friends</Text>
        <View className="w-10 h-10" />
      </View>

      {/* Search Bar */}
      <View className="px-6 py-4 bg-surface z-10">
        <View className="flex-row items-center bg-surface-container-low border border-outline-variant/40 rounded-full px-4 py-2.5">
          <MaterialIcons name="search" size={22} color="#707a6f" />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search friends by name or phone..."
            placeholderTextColor="rgba(64, 73, 64, 0.5)"
            className="flex-1 ml-3 text-base text-on-surface font-body"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <MaterialIcons name="close" size={20} color="#707a6f" />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Friends List */}
      <FlatList
        data={filteredFriends}
        keyExtractor={item => item.id}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 120, paddingTop: 8 }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={() => (
          <View className="items-center justify-center mt-20 px-8">
            <MaterialIcons name="people-outline" size={64} color="#bfc9bd" />
            <Text className="text-lg font-semibold text-on-surface-variant mt-4 text-center">
              {searchQuery ? "No friends found matching your search." : "You haven't added any friends yet."}
            </Text>
          </View>
        )}
        renderItem={({ item }) => (
          <TouchableOpacity 
            onPress={() => router.push({
              pathname: `/friend/${item.id}`,
              params: {
                friendName: item.fullName,
                friendPhone: item.phoneNumber
              }
            })} 
            className="flex-row items-center py-4 border-b border-outline-variant/15"
          >
            <View className={`w-14 h-14 rounded-full border-[3px] p-[2px] bg-surface mr-4 ${getBorderColor(item)}`}>
              {item.image ? (
                <Image 
                  source={{ uri: item.image }} 
                  className="w-full h-full rounded-full"
                />
              ) : (
                <View className="w-full h-full rounded-full bg-secondary-container items-center justify-center">
                  <Text className="text-primary font-bold text-lg">{item.initials}</Text>
                </View>
              )}
            </View>
            <View className="flex-1">
              <Text className="text-base font-semibold text-on-surface">{item.fullName}</Text>
              <Text className="text-xs text-on-surface-variant mt-0.5">{item.phoneNumber || 'No phone added'}</Text>
            </View>
            <View className="items-end">
              <Text className={`text-sm font-bold ${getBalanceTextColor(item)}`}>
                {getBalanceLabel(item)}
              </Text>
            </View>
          </TouchableOpacity>
        )}
      />

      {/* Floating Action Button for Adding Friends */}
      <TouchableOpacity 
        onPress={() => setIsAddModalOpen(true)}
        className="absolute bottom-[40px] right-6 h-16 px-6 rounded-2xl bg-primary flex-row items-center justify-center shadow-lg z-30"
      >
        <MaterialIcons name="person-add" size={24} color="white" />
        <Text className="text-white font-bold text-base ml-2">Add Friend</Text>
      </TouchableOpacity>

      <AddFriendModal 
        isOpen={isAddModalOpen} 
        onClose={() => setIsAddModalOpen(false)} 
        onSuccess={fetchFriends} 
      />
    </View>
  );
}
