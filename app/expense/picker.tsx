import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useExpense, Participant } from '../../context/ExpenseContext';
import { getRelatedUsers } from '../../lib/friendFetcher';

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
        const users = await getRelatedUsers(myId, 'id, full_name, avatar_url');

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
        const { data: myGroups } = await supabase
          .from('group_members')
          .select('group_id, groups(*)')
          .eq('user_id', myId);

        if (myGroups) {
          // Fetch actual member count for each group using RPC
          const groupsFormatted = [];
          for (const mg of myGroups) {
            const grp = mg.groups;
            const g = Array.isArray(grp) ? grp[0] : grp;
            if (!g?.id) continue;

            const { data: memberData } = await supabase
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
              title: g.title || 'Group',
              icon: g.category === 'trip' ? 'flight' : (g.category === 'home' ? 'home' : 'group'),
              memberCount: groupMembers.length,
              members: groupMembers
            });
          }
          setGroupsList(groupsFormatted);
        }
      } catch (err: any) {
        console.error(err);
        // Surface it. An empty friend list is indistinguishable from a failed
        // one, and the failed case used to look like "you have no friends".
        setLoadError(err?.message || 'Could not load your friends and groups.');
      } finally {
        setLoading(false);
      }
    }
    loadData();

    // Load user avatar from AsyncStorage
    AsyncStorage.getItem('onboarding_avatar').then(av => {
      if (av) setUserAvatar(av);
    });
  }, []);

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

  const isConfirmDisabled = selectedFriends.length === 0 && !selectedGroup;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top']}>
      {/* Header dragging bar decoration */}
      <View className="w-full pt-3 pb-1 flex items-center">
        <View className="w-10 h-1.5 rounded-full bg-outline-variant/60" />
      </View>

      {/* Title & Close */}
      <View className="flex-row items-center justify-between px-5 py-3">
        <Text className="font-headline text-2xl font-bold text-on-surface">Split with</Text>
        <TouchableOpacity 
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="close" size={24} color="#1c1c19" />
        </TouchableOpacity>
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
            placeholder="Search friends or groups..."
            placeholderTextColor="rgba(64, 73, 64, 0.5)"
            className="w-full bg-surface-container-lowest border border-outline-variant/30 rounded-2xl py-3.5 pl-12 pr-4 font-body text-base shadow-sm focus:border-primary"
          />
        </View>
      </View>

      {/* Tabs */}
      <View className="px-5 mb-4">
        <View className="flex-row p-1 bg-surface-container rounded-xl">
          <TouchableOpacity 
            onPress={() => setActiveTab('friends')}
            className={`flex-1 py-2.5 rounded-lg items-center ${activeTab === 'friends' ? 'bg-white shadow-sm' : ''}`}
          >
            <Text className={`font-semibold text-sm ${activeTab === 'friends' ? 'text-primary' : 'text-on-surface-variant'}`}>
              Friends
            </Text>
          </TouchableOpacity>
          <TouchableOpacity 
            onPress={() => setActiveTab('groups')}
            className={`flex-1 py-2.5 rounded-lg items-center ${activeTab === 'groups' ? 'bg-white shadow-sm' : ''}`}
          >
            <Text className={`font-semibold text-sm ${activeTab === 'groups' ? 'text-primary' : 'text-on-surface-variant'}`}>
              Groups
            </Text>
          </TouchableOpacity>
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
            {selectedFriends.map(friend => (
              <View 
                key={friend.id}
                className="flex-row items-center bg-secondary-container px-3 py-1.5 rounded-full"
              >
                <Text className="text-primary font-semibold text-xs mr-1">{friend.name.split(' ')[0]}</Text>
                <TouchableOpacity onPress={() => handleRemoveFriendChip(friend.id)}>
                  <MaterialIcons name="close" size={14} color="#004c22" />
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        </View>
      )}

      {selectedGroup && (
        <View className="px-5 mb-3">
          <View className="flex-row items-center bg-primary self-start px-4 py-1.5 rounded-full">
            <Text className="text-white font-semibold text-xs mr-2">{selectedGroup.title}</Text>
            <TouchableOpacity onPress={() => setSelectedGroup(null)}>
              <MaterialIcons name="close" size={14} color="white" />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Scrollable list content */}
      <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 120 }}>
        {activeTab === 'friends' ? (
          <View className="space-y-6">
            {/* Frequently split section */}
            <View>
              <Text className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3">
                Frequently Split With
              </Text>
              <View className="gap-2">
                {filteredFriends.slice(0, 2).map(friend => {
                  const isChecked = selectedFriends.some(f => f.id === friend.id);
                  return (
                    <TouchableOpacity
                      key={`freq-${friend.id}`}
                      onPress={() => handleToggleFriend(friend)}
                      className="p-3 rounded-2xl flex-row items-center justify-between"
                      style={{
                        backgroundColor: isChecked ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                        borderWidth: 1,
                        borderColor: isChecked ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                      }}
                    >
                      <View className="flex-row items-center space-x-3">
                        {friend.image ? (
                          <Image source={{ uri: friend.image }} className="w-10 h-10 rounded-full" />
                        ) : (
                          <View className="w-10 h-10 rounded-full bg-secondary-container items-center justify-center">
                            <Text className="text-primary font-bold text-sm">{friend.initials}</Text>
                          </View>
                        )}
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
                    </TouchableOpacity>
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
                {filteredFriends.slice(2).map(friend => {
                  const isChecked = selectedFriends.some(f => f.id === friend.id);
                  return (
                    <TouchableOpacity
                      key={`all-${friend.id}`}
                      onPress={() => handleToggleFriend(friend)}
                      className="p-3 rounded-2xl flex-row items-center justify-between"
                      style={{
                        backgroundColor: isChecked ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.72)',
                        borderWidth: 1,
                        borderColor: isChecked ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                      }}
                    >
                      <View className="flex-row items-center space-x-3">
                        {friend.image ? (
                          <Image source={{ uri: friend.image }} className="w-10 h-10 rounded-full" />
                        ) : (
                          <View className="w-10 h-10 rounded-full bg-secondary-container items-center justify-center">
                            <Text className="text-primary font-bold text-sm">{friend.initials}</Text>
                          </View>
                        )}
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
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          </View>
        ) : (
          // Groups list content
          <View className="gap-3 pt-2">
            {filteredGroups.map(group => {
              const isChecked = selectedGroup?.id === group.id;
              return (
                <TouchableOpacity
                  key={group.id}
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
                </TouchableOpacity>
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
        <TouchableOpacity
          disabled={isConfirmDisabled}
          onPress={handleConfirm}
          activeOpacity={0.85}
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
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
