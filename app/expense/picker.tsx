import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useExpense, Participant } from '../../context/ExpenseContext';
import { getRelatedUsers } from '../../lib/friendFetcher';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { Skeleton, SkeletonListRow } from '../../components/Skeleton';
import AddFriendModal from '../../components/AddFriendModal';

interface Friend {
  id: string;
  name: string;
  email: string;
  image?: string;
  initials?: string;
}

interface Group {
  id: string;
  title: string;
  icon: string;
  memberCount: number;
  members: any[];
  // True when this circle's member query failed. Without it a failed query
  // looked like an empty circle and could be confirmed as just "You".
  membersError?: boolean;
}

// Removed static mock data

export default function FriendGroupPickerScreen() {
  const router = useRouter();
  const { participants, setParticipants, groupId, setGroupId, payer } = useExpense();

  const [searchQuery, setSearchQuery] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'friends' | 'groups'>('friends');
  const [selectedFriends, setSelectedFriends] = useState<Friend[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);

  const [friendsList, setFriendsList] = useState<Friend[]>([]);
  const [groupsList, setGroupsList] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [userAvatar, setUserAvatar] = useState<string | undefined>(undefined);
  const [myId, setMyId] = useState<string>('');
  // Bumping this re-runs the load effect (Retry button).
  const [reloadKey, setReloadKey] = useState(0);
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [retryingMembers, setRetryingMembers] = useState(false);
  // Circles failing to load must not block picking friends, so this is kept
  // apart from loadError (which replaces the whole list).
  const [groupsLoadFailed, setGroupsLoadFailed] = useState(false);

  useEffect(() => {
    async function loadData() {
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        if (!authData?.user) {
          setLoadError('You appear to be signed out.');
          return;
        }
        const myId = authData.user.id;
        setMyId(myId);

        // Everyone you are connected to: friends you added, people you share a
        // group with, and anyone you have split an expense with. This came back
        // empty for a while because it reads transactions, which the RLS
        // recursion bug was breaking — an empty list looked identical to
        // having no friends.
        const users = await getRelatedUsers(myId, 'id, full_name, avatar_url', true);

        if (users) {
          setFriendsList(users.map((u: any) => ({
            id: u.id,
            name: u.full_name || 'Friend',
            email: u.email || '',
            image: u.avatar_url,
            initials: u.full_name ? u.full_name.charAt(0) : '?'
          })));
        }

        // Fetch groups
        const { data: myGroups, error: groupsErr } = await supabase
          .from('group_members')
          .select('group_id, groups(*)')
          .eq('user_id', myId);
        // A failed query must not read as "no circles" — but it also must not
        // take the friends list down with it, so it only flags the Circles tab.
        if (groupsErr) console.warn('Could not load circles:', groupsErr);
        setGroupsLoadFailed(!!groupsErr);

        if (myGroups) {
          // Fetch actual member count for each group using RPC
          const groupsFormatted = [];
          for (const mg of myGroups) {
            const grp = mg.groups;
            const g = Array.isArray(grp) ? grp[0] : grp;
            if (!g?.id) continue;

            const { data: memberData, error: memberErr } = await supabase
              .from('group_members')
              .select('user_id, users(full_name, avatar_url)')
              .eq('group_id', g.id);

            const groupMembers = memberData?.map((m: any) => ({
               id: m.user_id,
               name: m.users?.full_name?.split(' ')[0] || 'Unknown',
               image: m.users?.avatar_url,
               initials: m.users?.full_name ? m.users.full_name.charAt(0) : '?'
            })) || [];

            groupsFormatted.push({
              id: g.id,
              title: g.title || 'Circle',
              icon: g.category === 'trip' ? 'flight' : (g.category === 'home' ? 'home' : 'group'),
              memberCount: groupMembers.length,
              members: groupMembers,
              membersError: !!memberErr,
            });
          }
          setGroupsList(groupsFormatted);
        }
      } catch (err: any) {
        console.error(err);
        // Surface it. An empty friend list is indistinguishable from a failed
        // one, and the failed case used to look like "you have no friends".
        setLoadError(err?.message || 'Could not load your friends and circles.');
      } finally {
        setLoading(false);
      }
    }
    loadData();

    // Load user avatar from AsyncStorage
    AsyncStorage.getItem('onboarding_avatar').then(av => {
      if (av) setUserAvatar(av);
    });
  }, [reloadKey]);

  const handleRetryLoad = () => {
    setLoadError(null);
    setLoading(true);
    setReloadKey(k => k + 1);
  };

  // Re-fetch one circle's members after a failed load, so it can be confirmed.
  const handleRetryMembers = async (group: Group) => {
    setRetryingMembers(true);
    try {
      const { supabase } = await import('../../lib/supabase');
      const { data: memberData, error: memberErr } = await supabase
        .from('group_members')
        .select('user_id, users(full_name, avatar_url)')
        .eq('group_id', group.id);
      if (memberErr || !memberData) return; // stays flagged; user can retry again
      const members = memberData.map((m: any) => ({
        id: m.user_id,
        name: m.users?.full_name?.split(' ')[0] || 'Unknown',
        image: m.users?.avatar_url,
        initials: m.users?.full_name ? m.users.full_name.charAt(0) : '?'
      }));
      const fixed: Group = { ...group, members, memberCount: members.length, membersError: false };
      setGroupsList(prev => prev.map(g => (g.id === group.id ? fixed : g)));
      setSelectedGroup(prev => (prev?.id === group.id ? fixed : prev));
    } catch (err) {
      console.error(err);
    } finally {
      setRetryingMembers(false);
    }
  };

  // Initialize selections from context
  useEffect(() => {
    if (groupId && groupsList.length > 0) {
      const match = groupsList.find(g => g.id === groupId);
      if (match) setSelectedGroup(match);
      setActiveTab('groups');
    } else if (participants.length > 0) {
      const friendsInParticipants = participants
        .filter(p => !p.isYou)
        .map(p => ({
          id: p.id,
          name: p.name,
          email: '', // Mock fallback
          image: p.image,
          initials: p.initials
        }));
      setSelectedFriends(friendsInParticipants);
      setActiveTab('friends');
    }
  }, [groupId, participants, groupsList]);

  const handleToggleFriend = (friend: Friend) => {
    // Clear group selection when selecting friends
    setSelectedGroup(null);

    const exists = selectedFriends.some(f => f.id === friend.id);
    if (exists) {
      setSelectedFriends(prev => prev.filter(f => f.id !== friend.id));
    } else {
      setSelectedFriends(prev => [...prev, friend]);
    }
  };

  const handleSelectGroup = (group: Group) => {
    // Clear friends selection when selecting a group
    setSelectedFriends([]);
    setSelectedGroup(group);
  };

  const handleRemoveFriendChip = (friendId: string) => {
    setSelectedFriends(prev => prev.filter(f => f.id !== friendId));
  };

  const handleConfirm = () => {
    const you: Participant = { id: 'you', name: 'You', isYou: true, included: true, image: userAvatar };

    // Never confirm a circle whose members did not load: it would post the
    // expense with only "You".
    if (selectedGroup?.membersError) return;

    if (selectedGroup) {
      setGroupId(selectedGroup.id);
      
      // Auto-populate group members
      const groupParticipants: Participant[] = [];
      let hasYou = false;

      selectedGroup.members.forEach((m: any) => {
        if (m.id === myId) {
          groupParticipants.push(you);
          hasYou = true;
        } else {
          groupParticipants.push({
            id: m.id,
            name: m.name,
            image: m.image,
            initials: m.initials,
            included: true
          });
        }
      });

      // Just in case the current user is somehow not in the group member list locally
      if (!hasYou) {
        groupParticipants.unshift(you);
      }

      setParticipants(groupParticipants);
    } else {
      setGroupId(undefined);
      const newParticipants = [you, ...selectedFriends.map(f => ({
        id: f.id,
        name: f.name,
        image: f.image,
        initials: f.initials,
        included: true
      }))];
      setParticipants(newParticipants);
    }
    router.back();
  };

  // Filters
  const filteredFriends = friendsList.filter(f => 
    f.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (f.email || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredGroups = groupsList.filter(g =>
    g.title.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const isConfirmDisabled = (selectedFriends.length === 0 && !selectedGroup) || !!selectedGroup?.membersError;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {/* Header dragging bar decoration */}
      <View className="w-full pt-3 pb-1 flex items-center">
        <View className="w-10 h-1.5 rounded-full bg-outline-variant/60" />
      </View>

      {/* Title & Close */}
      <View className="flex-row items-center justify-between px-5 py-3">
        <Text className="font-headline text-2xl font-bold text-on-surface">Split with</Text>
        <AnimatedPressable
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="close" size={24} color="#1c1c19" />
        </AnimatedPressable>
      </View>

      {/* Search Input */}
      <View className="px-5 mb-4">
        <View className="relative w-full">
          <View className="absolute left-4 top-4 z-10">
            <MaterialIcons name="search" size={22} color="#404940" />
          </View>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search friends or circles..."
            placeholderTextColor="rgba(64, 73, 64, 0.5)"
            className="w-full bg-surface-container-lowest border border-outline-variant/30 rounded-2xl py-3.5 pl-12 pr-4 font-body text-base shadow-sm focus:border-primary"
          />
        </View>
      </View>

      {/* Tabs */}
      <View className="px-5 mb-4">
        <View className="flex-row p-1 bg-surface-container rounded-xl">
          <AnimatedPressable
            onPress={() => setActiveTab('friends')}
            className={`flex-1 py-2.5 rounded-lg items-center ${activeTab === 'friends' ? 'bg-white shadow-sm' : ''}`}
          >
            <Text className={`font-semibold text-sm ${activeTab === 'friends' ? 'text-primary' : 'text-on-surface-variant'}`}>
              Friends
            </Text>
          </AnimatedPressable>
          <AnimatedPressable
            onPress={() => setActiveTab('groups')}
            className={`flex-1 py-2.5 rounded-lg items-center ${activeTab === 'groups' ? 'bg-white shadow-sm' : ''}`}
          >
            <Text className={`font-semibold text-sm ${activeTab === 'groups' ? 'text-primary' : 'text-on-surface-variant'}`}>
              Circles
            </Text>
          </AnimatedPressable>
        </View>
      </View>

      {/* Selected Chips */}
      {selectedFriends.length > 0 && (
        <View className="mb-3">
          <ScrollView 
            horizontal 
            showsHorizontalScrollIndicator={false}
            className="pl-5"
            contentContainerStyle={{ gap: 8, paddingRight: 20 }}
          >
            {selectedFriends.map((friend, index) => (
              <AnimatedListItem key={friend.id} index={index}>
                <View
                  className="flex-row items-center bg-secondary-container px-3 py-1.5 rounded-full"
                >
                  <Text className="text-primary font-semibold text-xs mr-1">{friend.name.split(' ')[0]}</Text>
                  <AnimatedPressable onPress={() => handleRemoveFriendChip(friend.id)}>
                    <MaterialIcons name="close" size={14} color="#004c22" />
                  </AnimatedPressable>
                </View>
              </AnimatedListItem>
            ))}
          </ScrollView>
        </View>
      )}

      {selectedGroup && (
        <View className="px-5 mb-3">
          <View className="flex-row items-center bg-primary self-start px-4 py-1.5 rounded-full">
            <Text className="text-white font-semibold text-xs mr-2">{selectedGroup.title}</Text>
            <AnimatedPressable onPress={() => setSelectedGroup(null)}>
              <MaterialIcons name="close" size={14} color="white" />
            </AnimatedPressable>
          </View>
        </View>
      )}

      {selectedGroup?.membersError && (
        // Block confirm until this circle's members load (see isConfirmDisabled).
        <View className="px-5 mb-3">
          <View className="flex-row items-center bg-white border border-outline-variant/20 rounded-2xl p-3">
            <MaterialIcons name="error-outline" size={22} color="#b91c1c" />
            <Text className="flex-1 text-on-surface text-sm font-semibold mx-2">
              Couldn't load this circle's members
            </Text>
            <AnimatedPressable
              disabled={retryingMembers}
              onPress={() => handleRetryMembers(selectedGroup)}
              className="bg-primary px-4 py-2 rounded-xl"
            >
              <Text className="text-white font-semibold text-sm">{retryingMembers ? 'Retrying...' : 'Retry'}</Text>
            </AnimatedPressable>
          </View>
        </View>
      )}

      {/* Scrollable list content */}
      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 120 }}>
        {loading ? (
          // Row-shaped placeholders matching the friend rows below.
          <View className="pt-2">
            <Skeleton width="42%" height={11} style={{ marginBottom: 16 }} />
            {[0, 1, 2, 3].map(i => (
              <View
                key={i}
                className="p-3 rounded-2xl mb-2"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.72)',
                  borderWidth: 1,
                  borderColor: 'rgba(0,0,0,0.05)',
                }}
              >
                <SkeletonListRow avatarSize={40} showAmount={false} />
              </View>
            ))}
          </View>
        ) : loadError ? (
          // A failed load must never look like "you have no friends".
          <View className="items-center justify-center px-6 pt-10">
            <MaterialIcons name="error-outline" size={40} color="#b91c1c" />
            <Text className="text-on-surface font-bold text-lg mb-1 mt-3">Could not load friends and circles</Text>
            <Text className="text-on-surface-variant text-center max-w-xs text-sm">{loadError}</Text>
            <AnimatedPressable onPress={handleRetryLoad} className="mt-5 bg-primary px-6 py-3 rounded-xl">
              <Text className="text-white font-semibold">Retry</Text>
            </AnimatedPressable>
          </View>
        ) : activeTab === 'friends' ? (
          <View className="space-y-6">
            {friendsList.length === 0 && (
              <View className="items-center justify-center px-6 py-8">
                <Text className="text-on-surface font-bold text-lg mb-1">No friends yet</Text>
                <Text className="text-on-surface-variant text-center max-w-xs text-sm">
                  Add a friend to start splitting expenses.
                </Text>
                <AnimatedPressable onPress={() => setIsAddModalOpen(true)} className="mt-5 bg-primary px-6 py-3 rounded-xl">
                  <Text className="text-white font-semibold">Add a friend</Text>
                </AnimatedPressable>
              </View>
            )}
            {/* First two matches (list order, not a usage frequency) */}
            <View>
              <Text className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3">
                Friends
              </Text>
              <View className="gap-2">
                {filteredFriends.slice(0, 2).map((friend, index) => {
                  const isChecked = selectedFriends.some(f => f.id === friend.id);
                  return (
                    <AnimatedListItem key={`freq-${friend.id}`} index={index}>
                      <AnimatedPressable
                        onPress={() => handleToggleFriend(friend)}
                        className="p-3 rounded-2xl flex-row items-center justify-between"
                        style={{
                          backgroundColor: isChecked ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                          borderWidth: 1,
                          borderColor: isChecked ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                        }}
                      >
                        <View className="flex-row items-center space-x-3">
                          <Avatar
                            uri={friend.image}
                            initials={friend.initials}
                            size={40}
                            textClassName="text-primary font-bold text-sm"
                          />
                          <View>
                            <Text className="font-semibold text-on-surface leading-tight">{friend.name}</Text>
                            <Text className="text-xs text-on-surface-variant mt-0.5">{friend.email}</Text>
                          </View>
                        </View>
                        <MaterialIcons
                          name={isChecked ? "check-circle" : "radio-button-unchecked"}
                          size={24}
                          color={isChecked ? "#004c22" : "#bfc9bd"}
                        />
                      </AnimatedPressable>
                    </AnimatedListItem>
                  );
                })}
              </View>
            </View>

            {/* All contacts section */}
            <View>
              <Text className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3">
                All Contacts
              </Text>
              <View className="gap-2">
                {filteredFriends.slice(2).map((friend, index) => {
                  const isChecked = selectedFriends.some(f => f.id === friend.id);
                  return (
                    <AnimatedListItem key={`all-${friend.id}`} index={index}>
                      <AnimatedPressable
                        onPress={() => handleToggleFriend(friend)}
                        className="p-3 rounded-2xl flex-row items-center justify-between"
                        style={{
                          backgroundColor: isChecked ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                          borderWidth: 1,
                          borderColor: isChecked ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                        }}
                      >
                        <View className="flex-row items-center space-x-3">
                          <Avatar
                            uri={friend.image}
                            initials={friend.initials}
                            size={40}
                            textClassName="text-primary font-bold text-sm"
                          />
                          <View>
                            <Text className="font-semibold text-on-surface leading-tight">{friend.name}</Text>
                            <Text className="text-xs text-on-surface-variant mt-0.5">{friend.email}</Text>
                          </View>
                        </View>
                        <MaterialIcons
                          name={isChecked ? "check-circle" : "radio-button-unchecked"}
                          size={24}
                          color={isChecked ? "#004c22" : "#bfc9bd"}
                        />
                      </AnimatedPressable>
                    </AnimatedListItem>
                  );
                })}
              </View>
            </View>
          </View>
        ) : (
          // Groups list content
          <View className="gap-3 pt-2">
            {groupsList.length === 0 && groupsLoadFailed && (
              <View className="items-center justify-center px-6 py-8">
                <Text className="text-on-surface font-bold text-lg mb-1">Couldn't load your circles</Text>
                <AnimatedPressable onPress={handleRetryLoad} className="mt-4 bg-primary px-6 py-3 rounded-xl">
                  <Text className="text-white font-semibold">Retry</Text>
                </AnimatedPressable>
              </View>
            )}
            {groupsList.length === 0 && !groupsLoadFailed && (
              <View className="items-center justify-center px-6 py-8">
                <Text className="text-on-surface font-bold text-lg mb-1">No circles yet</Text>
                <Text className="text-on-surface-variant text-center max-w-xs text-sm">
                  Circles you create or join will show up here.
                </Text>
              </View>
            )}
            {filteredGroups.map((group, index) => {
              const isChecked = selectedGroup?.id === group.id;
              return (
                <AnimatedListItem key={group.id} index={index}>
                  <AnimatedPressable
                    onPress={() => handleSelectGroup(group)}
                    className="p-3 rounded-2xl flex-row items-center justify-between"
                    style={{
                      backgroundColor: isChecked ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                      borderWidth: 1,
                      borderColor: isChecked ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                    }}
                  >
                    <View className="flex-row items-center space-x-4">
                      <View className="w-12 h-12 rounded-full bg-secondary-container items-center justify-center">
                        <MaterialIcons name={group.icon as any} size={24} color="#004c22" />
                      </View>
                      <View>
                        <Text className="font-semibold text-on-surface text-lg leading-tight">{group.title}</Text>
                        <Text className="text-sm text-on-surface-variant mt-0.5">{group.memberCount} members</Text>
                      </View>
                    </View>
                    <MaterialIcons
                      name={isChecked ? "check-circle" : "radio-button-unchecked"}
                      size={24}
                      color={isChecked ? "#004c22" : "#bfc9bd"}
                    />
                  </AnimatedPressable>
                </AnimatedListItem>
              );
            })}
          </View>
        )}
      </ScrollView>

      {/* Sticky Bottom Action Button.
          Colours are inline styles, not conditional utility classes. The
          class-based version kept rendering in its disabled grey even once
          friends were selected — the same class-not-applying problem seen
          with gap and space-x elsewhere in this codebase — so the button
          looked permanently unavailable while actually being tappable. */}
      <View
        className="absolute bottom-0 left-0 w-full px-5 pt-6 pb-6"
        style={{ backgroundColor: 'rgba(252, 249, 244, 0.94)' }}
      >
        <AnimatedPressable
          scaleTo={0.9}
          disabled={isConfirmDisabled}
          onPress={handleConfirm}
          style={{
            width: '100%',
            height: 56,
            borderRadius: 16,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: isConfirmDisabled ? 'rgba(0,0,0,0.12)' : '#004c22',
          }}
        >
          <Text
            style={{
              fontSize: 16,
              fontWeight: '700',
              color: isConfirmDisabled ? 'rgba(64,73,64,0.45)' : '#ffffff',
            }}
          >
            {selectedGroup
              ? `Confirm ${selectedGroup.title}`
              : selectedFriends.length === 0
                ? 'Select who to split with'
                : `Continue with ${selectedFriends.length} ${selectedFriends.length === 1 ? 'person' : 'people'}`
            }
          </Text>
        </AnimatedPressable>
      </View>

      <AddFriendModal
        isOpen={isAddModalOpen}
        onClose={() => setIsAddModalOpen(false)}
        onSuccess={handleRetryLoad}
      />
    </SafeAreaView>
  );
}
