import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useExpense, Participant } from '../../context/ExpenseContext';
import { supabase } from '../../lib/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';

const categories = [
  { id: 'food', icon: 'restaurant', label: 'Food' },
  { id: 'travel', icon: 'flight', label: 'Travel' },
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'utilities', icon: 'bolt', label: 'Utilities' },
  { id: 'other', icon: 'category', label: 'Other' },
];

interface Friend {
  id: string;
  name: string;
  image?: string;
  initials?: string;
}

interface Group {
  id: string;
  title: string;
  icon: string;
  memberCount: number;
}

interface Payer {
  id: string;
  name: string;
  image?: string;
  initials?: string;
}

export default function ExpenseDetailsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams();
  const { 
    amount, 
    description, 
    setDescription, 
    category: activeCategory, 
    setCategory: setActiveCategory, 
    payer: selectedPayer, 
    setPayer,
    participants,
    setParticipants,
    groupId,
    setGroupId,
    editTransactionId
  } = useExpense();

  const [isFocused, setIsFocused] = useState(false);

  // Derive selectedGroup and selectedFriends from participants/groupId
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const selectedFriends = participants; // They are the same now basically, wait no, participants includes the payer. 
  // Wait, I can simplify this by keeping participants in context.

  const friendId = (params.friendId as string) || '';
  const friendName = (params.friendName as string) || '';
  const paramGroupId = (params.groupId as string) || '';
  const paramGroupName = (params.groupName as string) || '';

  useEffect(() => {
    if (groupId) {
      setSelectedGroup({ id: groupId, title: paramGroupName || 'Group', icon: 'group', memberCount: participants.length });
    } else {
      setSelectedGroup(null);
    }
  }, [groupId, participants]);

  // Auto-populate participants when navigating from a group
  useEffect(() => {
    if (!paramGroupId || participants.length > 0) return;

    setGroupId(paramGroupId);

    const loadParticipants = async () => {
      const youParticipant: Participant = {
        id: 'you',
        name: 'You',
        image: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBWpKstfCvKh8Ok0dt4bCcBUCfI0ghEW_ystNj_uD03Ghj09SdII9HhFWjNUtjENIwzhIycaYwNLqUH95kT4cC4V9jkkcwQAhy1DqQDRB_jHs2QJ4E-NEI8TzXj222SRJVbeNi3FDVKcjEAHFFV-m43PaOweoPpsuEfPS1q9rgLoS4pV3JcMeiLAkyS2Y984uAKf8p0o7LldyZgRrjJTFck7Ii38LrOM2gtxd53b4L10_xbXyTmbqO4EtDWDEqXO08HwbWAJBng1Ro',
        included: true,
        isYou: true,
      };

      // Fetch real members from DB
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        const youId = authData?.user?.id;

        const { data, error } = await supabase
          .rpc('get_group_members', { target_group_id: paramGroupId });

        if (error || !data) {
          setParticipants([youParticipant]);
          return;
        }

        const members: Participant[] = data.map((row: any) => {
          const isYou = row.user_id === youId;
          return {
            id: row.user_id,
            name: row.full_name || 'Unknown',
            image: row.avatar_url,
            initials: row.full_name ? row.full_name.charAt(0) : '?',
            included: true,
            isYou: isYou
          };
        });

        // Ensure "You" is always first
        const youIndex = members.findIndex(m => m.isYou);
        if (youIndex > 0) {
          const you = members.splice(youIndex, 1)[0];
          members.unshift(you);
        } else if (youIndex === -1 && youId) {
          // If you are not in the group but you are adding the expense (edge case)
          members.unshift({ ...youParticipant, id: youId });
        }

        setParticipants(members.length > 0 ? members : [youParticipant]);
      } catch (err) {
        setParticipants([youParticipant]);
      }
    };

    loadParticipants();
  }, [paramGroupId]);

  useEffect(() => {
    // Direct navigation from a friend detail screen pre-selects that friend
    if (friendId && participants.length === 0) {
      const name = friendName || 'Friend';
      const initials = name.split(' ').map(n => n.charAt(0)).join('').toUpperCase().slice(0, 2);
      
      // Add BOTH "You" and the friend so the split page shows both shares
      const loadYouAndFriend = async () => {
        let youId = 'you';
        let youAvatar: string | undefined;
        try {
          const { data: authData } = await supabase.auth.getUser();
          if (authData?.user?.id) {
            youId = authData.user.id;
          }
          const storedAvatar = await AsyncStorage.getItem('onboarding_avatar');
          if (storedAvatar) youAvatar = storedAvatar;
        } catch (_) {}
        
        setParticipants([
          { id: youId, name: 'You', isYou: true, included: true, image: youAvatar },
          { id: friendId, name: name, initials: initials, included: true, isYou: false }
        ]);
        
        // Also set payer to "You" by default
        setPayer({ id: youId, name: 'You', isYou: true, image: youAvatar });
      };
      loadYouAndFriend();
    }
  }, [friendId, friendName]);

  const handleOpenPicker = () => {
    router.push('/expense/picker');
  };

  const handleOpenPayer = () => {
    router.push('/expense/payer');
  };

  const handleNextStep = () => {
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      alert('Please enter a valid amount greater than zero.');
      return;
    }
    if (!description.trim()) {
      alert('Please add a description for this expense.');
      return;
    }
    router.push('/expense/split');
  };

  const renderWithAvatar = () => {
    if (selectedGroup) {
      return (
        <View className="w-10 h-10 rounded-full bg-secondary-container items-center justify-center overflow-hidden">
          <MaterialIcons name={selectedGroup.icon as any} size={22} color="#004c22" />
        </View>
      );
    }

    if (selectedFriends.length > 0) {
      if (selectedFriends.length === 1) {
        const friend = selectedFriends[0];
        return (
          <View className="w-10 h-10 rounded-full bg-secondary-container items-center justify-center overflow-hidden">
            {friend.image ? (
              <Image source={{ uri: friend.image }} className="w-full h-full" />
            ) : (
              <Text className="text-primary font-bold text-sm">{friend.initials || '??'}</Text>
            )}
          </View>
        );
      }

      // Overlapping multi-avatar preview
      return (
        <View className="flex-row items-center">
          <View className="w-10 h-10 rounded-full border-2 border-white bg-secondary-fixed items-center justify-center overflow-hidden z-10">
            {selectedFriends[0].image ? (
              <Image source={{ uri: selectedFriends[0].image }} className="w-full h-full" />
            ) : (
              <Text className="text-on-secondary-fixed font-bold text-xs">{selectedFriends[0].initials || '??'}</Text>
            )}
          </View>
          <View className="w-10 h-10 rounded-full border-2 border-white bg-tertiary-fixed items-center justify-center -ml-3 z-0">
            <Text className="text-on-tertiary-fixed font-label-sm text-xs font-bold">
              +{selectedFriends.length - 1}
            </Text>
          </View>
        </View>
      );
    }

    // Default empty state
    return (
      <View className="w-10 h-10 rounded-full bg-surface-variant flex items-center justify-center text-on-surface-variant">
        <MaterialIcons name="group" size={24} color="#707a6f" />
      </View>
    );
  };

  const getWithLabel = () => {
    if (selectedGroup) return selectedGroup.title;
    if (selectedFriends.length > 0) {
      if (selectedFriends.length === 1) return selectedFriends[0].name;
      if (selectedFriends.length === 2) return `${selectedFriends[0].name.split(' ')[0]} & ${selectedFriends[1].name.split(' ')[0]}`;
      return `${selectedFriends[0].name.split(' ')[0]} & ${selectedFriends.length - 1} others`;
    }
    return 'Select friend or group';
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {/* Top Navigation */}
      <View className="flex-row items-center justify-between px-5 h-16 w-full z-50 border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.72)' }}>
        <TouchableOpacity 
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="arrow-back" size={24} color="#1c1c19" />
        </TouchableOpacity>
        <Text className="font-headline-md text-xl text-primary font-semibold">Kinlo</Text>
        <View className="w-10" />
      </View>

      <ScrollView className="flex-1 px-5 pt-8" contentContainerStyle={{ paddingBottom: 120 }}>
        <View className="max-w-xl mx-auto w-full">
          {/* Step Indicator */}
          <View className="flex-row items-center space-x-2 mb-8">
            <View className="h-1.5 w-12 rounded-full bg-primary/20 overflow-hidden">
              <View className="h-full w-full bg-primary rounded-full" />
            </View>
            <View className="h-1.5 w-12 rounded-full bg-outline-variant/30 overflow-hidden">
              <View className="h-full w-2/3 bg-primary rounded-full" />
            </View>
            <View className="h-1.5 w-12 rounded-full bg-outline-variant/30" />
            <View className="flex-1 items-end">
              <Text className="font-label-sm text-xs font-semibold text-on-surface-variant">Step 2 of 3</Text>
            </View>
          </View>

          {/* Description Header */}
          <View className="mb-6 flex-row justify-between items-end">
            <View className="flex-1 mr-4">
              <Text className="font-headline-lg-mobile text-2xl font-semibold text-on-surface mb-2">
                {editTransactionId ? 'Edit Expense Details' : 'Expense details'}
              </Text>
              <Text className="font-body-md text-base text-on-surface-variant">Add a description and pick a category to keep things organized.</Text>
            </View>
            <View className="items-end">
              <Text className="text-xs text-on-surface-variant uppercase tracking-wider font-semibold">Amount</Text>
              <Text className="text-2xl font-bold text-primary">₹{parseFloat(amount).toFixed(2)}</Text>
            </View>
          </View>

          {/* Input Card: Description */}
          <View 
            className="p-6 rounded-xl mb-6"
            style={{
              backgroundColor: 'rgba(255, 255, 255, 0.72)',
              borderWidth: 1,
              borderColor: isFocused ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
              shadowColor: isFocused ? '#004c22' : '#1c1917',
              shadowOffset: { width: 0, height: isFocused ? 0 : 8 },
              shadowOpacity: isFocused ? 0.1 : 0.06,
              shadowRadius: isFocused ? 4 : 32,
              elevation: 2,
            }}
          >
            <Text className="font-label-md text-sm text-on-surface-variant mb-2 font-medium">What was it for?</Text>
            <TextInput
              value={description}
              onChangeText={setDescription}
              onFocus={() => setIsFocused(true)}
              onBlur={() => setIsFocused(false)}
              placeholder="e.g. Italian Dinner at Mario's"
              placeholderTextColor="rgba(64, 73, 64, 0.5)"
              className="bg-surface-container-low border border-outline-variant/50 rounded-xl p-4 font-body-lg text-lg text-on-surface"
            />
          </View>

          {/* Categories Section */}
          <View className="mb-6">
            <View className="flex-row items-center justify-between mb-4">
              <Text className="font-label-md text-sm font-medium text-on-surface-variant">Category</Text>
              <Text className="font-label-sm text-xs font-semibold text-primary">View all</Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} className="-mx-5 px-5">
              <View className="flex-row space-x-3 pb-2 pr-5">
                {categories.map((cat) => {
                  const isActive = activeCategory === cat.id;
                  return (
                    <TouchableOpacity
                      key={cat.id}
                      onPress={() => setActiveCategory(cat.id)}
                      className={`items-center justify-center min-w-[84px] p-4 rounded-xl border ${
                        isActive 
                          ? 'bg-secondary-container/70 border-primary/10' 
                          : 'bg-surface-container-high border-transparent'
                      }`}
                    >
                      <MaterialIcons 
                        name={cat.icon as any} 
                        size={24} 
                        color={isActive ? "#042014" : "#404940"} 
                        className="mb-1"
                      />
                      <Text className={`font-label-sm text-xs font-semibold ${isActive ? 'text-on-secondary-fixed' : 'text-on-surface-variant'}`}>
                        {cat.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </ScrollView>
          </View>

          {/* Payer and Group Selection Rows */}
          <View 
            className="rounded-xl overflow-hidden"
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
            {/* Paid By Row */}
            <TouchableOpacity 
              onPress={handleOpenPayer}
              className="flex-row items-center justify-between p-5 border-b border-outline-variant/20 active:bg-surface-container-lowest"
            >
              <View className="flex-row items-center space-x-4">
                <View className="w-10 h-10 rounded-full bg-primary-fixed items-center justify-center overflow-hidden">
                  {selectedPayer?.image ? (
                    <Image source={{ uri: selectedPayer.image }} className="w-full h-full" />
                  ) : (
                    <View className="w-full h-full bg-secondary-container items-center justify-center">
                      <Text className="text-primary font-bold text-sm">
                        {selectedPayer?.initials || selectedPayer?.name?.charAt(0) || 'Y'}
                      </Text>
                    </View>
                  )}
                </View>
                <View>
                  <Text className="font-label-sm text-[10px] text-on-surface-variant uppercase tracking-wider mb-0.5">Paid by</Text>
                  <Text className="font-body-md font-semibold text-on-surface text-base">
                    {selectedPayer?.name || 'You'}
                  </Text>
                </View>
              </View>
              <MaterialIcons name="chevron-right" size={24} color="#707a6f" />
            </TouchableOpacity>

            {/* With Row */}
            <TouchableOpacity 
              onPress={handleOpenPicker}
              className="flex-row items-center justify-between p-5 active:bg-surface-container-lowest"
            >
              <View className="flex-row items-center space-x-4">
                {renderWithAvatar()}
                <View>
                  <Text className="font-label-sm text-[10px] text-on-surface-variant uppercase tracking-wider mb-0.5">With</Text>
                  <Text className="font-body-md font-semibold text-on-surface text-base">
                    {getWithLabel()}
                  </Text>
                </View>
              </View>
              <MaterialIcons name="chevron-right" size={24} color="#707a6f" />
            </TouchableOpacity>
          </View>
        </View>
      </ScrollView>

      {/* Bottom Action Button */}
      <View className="absolute bottom-0 left-0 w-full px-5 pt-10 pb-5" style={{ backgroundColor: 'rgba(252, 249, 244, 0.9)' }}>
        <TouchableOpacity 
          onPress={handleNextStep}
          disabled={selectedFriends.length === 0 && !selectedGroup}
          className={`w-full max-w-xl mx-auto h-14 rounded-xl flex-row items-center justify-center space-x-2 active:scale-95 transition-all shadow-lg ${
            (selectedFriends.length === 0 && !selectedGroup) ? 'bg-outline-variant/30 opacity-50' : 'bg-primary shadow-primary/20'
          }`}
        >
          <Text className="text-white font-bold text-lg font-body-lg">Next Step</Text>
          <MaterialIcons name="arrow-forward" size={24} color="#ffffff" />
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}
