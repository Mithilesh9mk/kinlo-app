import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TextInput, FlatList } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { getRelatedUsers } from '../../lib/friendFetcher';
import { fetchBalances } from '../../lib/balances';
import { getContactsSyncEnabled, findKinloContactMatches, ContactMatch } from '../../lib/contactsSync';
import { useToast } from '../../components/Toast';
import AddFriendModal from '../../components/AddFriendModal';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { Avatar } from '../../components/Avatar';
import { SkeletonListRow } from '../../components/Skeleton';

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
  // Without this, "no friends yet" showed during the first load and after a
  // failed fetch — both states where we don't actually know the answer.
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const { showToast } = useToast();
  const [contactMatches, setContactMatches] = useState<ContactMatch[]>([]);
  const [addingMatchId, setAddingMatchId] = useState<string | null>(null);

  // Only runs the actual contact scan if the user opted in via the
  // onboarding "Sync contacts" step or the Profile toggle — this screen
  // never requests the permission itself. Best-effort: a failed lookup just
  // means no suggestions show, not an error the user needs to see.
  const loadContactMatches = useCallback(async () => {
    try {
      const enabled = await getContactsSyncEnabled();
      if (!enabled) { setContactMatches([]); return; }
      const matches = await findKinloContactMatches();
      setContactMatches(matches);
    } catch (e) {
      console.warn('Contact match lookup failed:', e);
      setContactMatches([]);
    }
  }, []);

  const addMatchAsFriend = async (match: ContactMatch) => {
    setAddingMatchId(match.id);
    try {
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) {
        showToast('Please sign in again to add friends');
        return;
      }

      const { error } = await supabase
        .from('friendships')
        .insert({ user_id: authData.user.id, friend_id: match.id });

      if (error) {
        // Raw Postgres text isn't for the user, but silence isn't either:
        // the spinner stopping with the card still sitting there reads as
        // the app ignoring the tap.
        console.warn('Failed to add contact match as friend:', error.message);
        showToast(`Could not add ${match.contactName} — try again`);
        return;
      }

      setContactMatches((prev) => prev.filter((m) => m.id !== match.id));
      showToast(`${match.contactName} added`);
      fetchFriends();
    } catch (e) {
      console.warn('Failed to add contact match as friend:', e);
      showToast('Could not add that friend — try again');
    } finally {
      setAddingMatchId(null);
    }
  };

  const dismissMatch = (id: string) => {
    setContactMatches((prev) => prev.filter((m) => m.id !== id));
  };

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
      setLoadState('ready');
    } catch (e) {
      console.error('Failed to fetch friends:', e);
      // Don't clear friendsList: a failed refresh keeps the last good list
      // on screen (with a banner) instead of claiming there are no friends.
      setLoadState('error');
    }
  }, []);

  const retryFetch = () => {
    // Only go back to the skeleton when there is nothing to show; otherwise
    // the existing list stays put while the banner's retry runs.
    if (friendsList.length === 0) setLoadState('loading');
    fetchFriends();
  };

  useFocusEffect(
    useCallback(() => {
      fetchFriends();
      loadContactMatches();
    }, [fetchFriends, loadContactMatches])
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
        <AnimatedPressable onPress={() => router.back()} className="w-10 h-10 rounded-full items-center justify-center bg-surface-container active:scale-95">
          <MaterialIcons name="arrow-back" size={24} color="#404940" />
        </AnimatedPressable>
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
            <AnimatedPressable onPress={() => setSearchQuery('')}>
              <MaterialIcons name="close" size={20} color="#707a6f" />
            </AnimatedPressable>
          )}
        </View>
      </View>

      {/* From Contacts — only shown if the user opted in via onboarding/Profile
          and we found at least one match this visit */}
      {contactMatches.length > 0 && (
        <View className="pb-3 bg-surface z-10">
          <Text className="px-6 mb-2 text-xs font-semibold text-on-surface-variant uppercase tracking-wide">
            From your contacts
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20 }}>
            {contactMatches.map((match) => (
              <View
                key={match.id}
                className="items-center mr-3 bg-surface-container-low rounded-2xl px-4 py-3"
                style={{ width: 112 }}
              >
                <AnimatedPressable onPress={() => dismissMatch(match.id)} className="absolute top-1.5 right-1.5 z-10">
                  <MaterialIcons name="close" size={14} color="#707a6f" />
                </AnimatedPressable>
                {/* size is required here: without it Avatar falls back to
                    height:'100%', which has no fixed parent height to resolve
                    against inside this card and collapses the layout. */}
                <Avatar
                  size={44}
                  uri={match.avatarUrl || undefined}
                  initials={match.contactName.slice(0, 2).toUpperCase()}
                  textClassName="text-primary font-bold"
                />
                <Text numberOfLines={1} className="text-xs font-semibold text-on-surface mt-2 text-center">
                  {match.contactName}
                </Text>
                <AnimatedPressable
                  onPress={() => addMatchAsFriend(match)}
                  disabled={addingMatchId === match.id}
                  className="mt-2 bg-primary rounded-lg px-3 py-1.5"
                >
                  <Text className="text-white text-xs font-semibold">
                    {addingMatchId === match.id ? '...' : 'Add'}
                  </Text>
                </AnimatedPressable>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {/* Refresh failed but we still have a list: keep it, flag it as possibly stale */}
      {loadState === 'error' && friendsList.length > 0 && (
        <View className="mx-6 mb-2 px-4 py-2.5 rounded-xl bg-surface-container flex-row items-center">
          <MaterialIcons name="error-outline" size={18} color="#b91c1c" />
          <Text className="flex-1 ml-2 text-xs text-on-surface-variant">
            Couldn't refresh — balances may be out of date.
          </Text>
          <AnimatedPressable onPress={retryFetch}>
            <Text className="text-xs font-bold text-primary">Retry</Text>
          </AnimatedPressable>
        </View>
      )}

      {/* Friends List */}
      <FlatList
        data={filteredFriends}
        keyExtractor={item => item.id}
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 120, paddingTop: 8 }}
        showsVerticalScrollIndicator={false}
        ListEmptyComponent={() => loadState === 'loading' ? (
          <View>
            {[0, 1, 2, 3, 4].map(i => <SkeletonListRow key={i} avatarSize={56} />)}
          </View>
        ) : loadState === 'error' && friendsList.length === 0 ? (
          // Never fall through to "no friends yet" on a failed load — we don't know.
          <View className="items-center justify-center mt-20 px-8">
            <MaterialIcons name="error-outline" size={40} color="#b91c1c" />
            <Text className="text-on-surface font-bold text-lg mb-1 mt-3">Couldn't load your friends</Text>
            <Text className="text-on-surface-variant text-center max-w-xs text-sm">
              Check your connection and try again.
            </Text>
            <AnimatedPressable onPress={retryFetch} className="mt-5 bg-primary px-6 py-3 rounded-xl">
              <Text className="text-white font-bold">Retry</Text>
            </AnimatedPressable>
          </View>
        ) : (
          <View className="items-center justify-center mt-20 px-8">
            <MaterialIcons name="people-outline" size={64} color="#bfc9bd" />
            <Text className="text-lg font-semibold text-on-surface-variant mt-4 text-center">
              {searchQuery ? "No friends found matching your search." : "You haven't added any friends yet."}
            </Text>
          </View>
        )}
        renderItem={({ item, index }) => (
          <AnimatedListItem index={index}>
            <AnimatedPressable
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
                <Avatar uri={item.image} initials={item.initials} textClassName="text-primary font-bold text-lg" />
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
            </AnimatedPressable>
          </AnimatedListItem>
        )}
      />

      {/* Floating Action Button for Adding Friends */}
      <AnimatedPressable 
        onPress={() => setIsAddModalOpen(true)}
        className="absolute bottom-[40px] right-6 h-16 px-6 rounded-2xl bg-primary flex-row items-center justify-center shadow-lg z-30"
      >
        <MaterialIcons name="person-add" size={24} color="white" />
        <Text className="text-white font-bold text-base ml-2">Add Friend</Text>
      </AnimatedPressable>

      <AddFriendModal 
        isOpen={isAddModalOpen} 
        onClose={() => setIsAddModalOpen(false)} 
        onSuccess={fetchFriends} 
      />
    </View>
  );
}
