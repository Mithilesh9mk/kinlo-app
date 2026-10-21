import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, ScrollView, Modal, Pressable, GestureResponderEvent } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useExpense, Participant } from '../../context/ExpenseContext';
import { supabase } from '../../lib/supabase';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAlert } from '../../components/AppAlert';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';

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
  const { showAlert } = useAlert();
  const params = useLocalSearchParams();
  const {
    amount,
    description,
    payer: selectedPayer,
    setPayer,
    participants,
    setParticipants,
    groupId,
    setGroupId,
    editTransactionId
  } = useExpense();

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
      setSelectedGroup({ id: groupId, title: paramGroupName || 'Circle', icon: 'group', memberCount: participants.length });
    } else {
      setSelectedGroup(null);
    }
  }, [groupId, participants]);

  // Auto-populate participants when navigating from a group
  // A failed member fetch used to fall back to a list of just "You", which let
  // the expense go ahead as if the circle were empty. It now blocks Next and
  // offers Retry instead.
  const [membersError, setMembersError] = useState(false);
  const [membersLoading, setMembersLoading] = useState(false);

  useEffect(() => {
    if (!paramGroupId || participants.length > 0) return;

    setGroupId(paramGroupId);
    loadParticipants();
  }, [paramGroupId]);

  const loadParticipants = async () => {
      setMembersError(false);
      setMembersLoading(true);
      const youParticipant: Participant = {
        id: 'you',
        name: 'You',
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
          setMembersError(true);
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
        setMembersError(true);
      } finally {
        setMembersLoading(false);
      }
  };

  // A failed load leaves participants empty, so a non-empty list means the user
  // picked friends elsewhere instead; the stale error must not block Next.
  useEffect(() => {
    if (membersError && participants.length > 0) setMembersError(false);
  }, [participants, membersError]);

  // Next must not proceed while the circle's members are missing or loading.
  const membersBlocked = membersError || membersLoading;

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

  // Choosing the payer happens in a popup rather than on its own screen. It is
  // a one-tap choice from a short list, so pushing a whole route for it lost
  // the context of the expense being built.
  const [payerModalOpen, setPayerModalOpen] = useState(false);

  const payerOptions = participants.length > 0
    ? participants
    : [{ id: 'you', name: 'You', isYou: true, included: true } as Participant];

  const choosePayer = (p: Participant) => {
    setPayer({
      id: p.id,
      name: p.name,
      image: p.image,
      initials: p.initials,
      isYou: p.isYou,
    });
    setPayerModalOpen(false);
  };

  const handleNextStep = () => {
    if (membersBlocked) return;
    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      showAlert('Invalid amount', 'Please enter a valid amount greater than zero.');
      return;
    }
    // Description is required on the amount screen, which is the only way
    // into this one — nothing here can be reached with it still blank.
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
            <Avatar
              uri={friend.image}
              initials={friend.initials || '??'}
              textClassName="text-primary font-bold text-sm"
            />
          </View>
        );
      }

      // Overlapping multi-avatar preview
      return (
        <View className="flex-row items-center">
          <View className="w-10 h-10 rounded-full border-2 border-white bg-secondary-fixed items-center justify-center overflow-hidden z-10">
            <Avatar
              uri={selectedFriends[0].image}
              initials={selectedFriends[0].initials || '??'}
              textClassName="text-on-secondary-fixed font-bold text-xs"
            />
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
    return 'Select friend or circle';
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {/* Top Navigation */}
      <View className="flex-row items-center justify-between px-5 h-16 w-full z-50 border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.72)' }}>
        <AnimatedPressable
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="arrow-back" size={24} color="#1c1c19" />
        </AnimatedPressable>
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

          {/* Header — this step now asks exactly one question: who. The
              description and category moved to step 1, where they sit with the
              amount they describe. This screen previously carried four
              unrelated decisions at once, which is what made it overwhelming. */}
          <View className="mb-6 flex-row justify-between items-end">
            <View className="flex-1 mr-4">
              <Text className="font-headline-lg-mobile text-2xl font-semibold text-on-surface mb-2">
                Who was involved?
              </Text>
              <Text className="font-body-md text-base text-on-surface-variant">
                Pick who paid the bill and who it should be split between.
              </Text>
            </View>
            <View className="items-end">
              <Text className="text-xs text-on-surface-variant uppercase tracking-wider font-semibold">Amount</Text>
              <Text className="text-2xl font-bold text-primary">₹{parseFloat(amount).toFixed(2)}</Text>
              {!!description && (
                <Text className="text-xs text-on-surface-variant mt-0.5 max-w-[140px]" numberOfLines={1}>
                  {description}
                </Text>
              )}
            </View>
          </View>

          {membersError && (
            <View className="mb-4 p-4 rounded-xl border border-error/20 bg-error-container/30 flex-row items-center">
              <MaterialIcons name="error-outline" size={20} color="#ba1a1a" />
              <Text className="flex-1 text-sm text-error" style={{ marginLeft: 10 }}>
                Couldn't load this circle's members.
              </Text>
              <AnimatedPressable onPress={loadParticipants} className="px-3 py-2 rounded-full bg-primary">
                <Text className="text-white text-xs font-bold">Retry</Text>
              </AnimatedPressable>
            </View>
          )}

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
            {/* Paid By Row. Spacing is explicit marginLeft rather than
                `space-x-*`, which was not applying and left the avatar and the
                text crowded together. */}
            <AnimatedPressable
              onPress={() => setPayerModalOpen(true)}
              className="flex-row items-center justify-between p-5 border-b border-outline-variant/20 active:bg-surface-container-lowest"
            >
              <View className="flex-row items-center flex-1 mr-3">
                <View className="w-11 h-11 rounded-full items-center justify-center overflow-hidden bg-secondary-container">
                  <Avatar
                    uri={selectedPayer?.image}
                    initials={selectedPayer?.initials || selectedPayer?.name?.charAt(0) || 'Y'}
                    textClassName="text-primary font-bold text-sm"
                  />
                </View>
                <View style={{ marginLeft: 14, flex: 1 }}>
                  <Text className="font-label-sm text-[10px] text-on-surface-variant uppercase tracking-wider mb-0.5">Paid by</Text>
                  <Text className="font-body-md font-semibold text-on-surface text-base" numberOfLines={1}>
                    {selectedPayer?.name || 'You'}
                  </Text>
                </View>
              </View>
              <MaterialIcons name="expand-more" size={24} color="#707a6f" />
            </AnimatedPressable>

            {/* With Row */}
            <AnimatedPressable
              onPress={handleOpenPicker}
              className="flex-row items-center justify-between p-5 active:bg-surface-container-lowest"
            >
              <View className="flex-row items-center flex-1 mr-3">
                {renderWithAvatar()}
                <View style={{ marginLeft: 14, flex: 1 }}>
                  <Text className="font-label-sm text-[10px] text-on-surface-variant uppercase tracking-wider mb-0.5">Split between</Text>
                  <Text className="font-body-md font-semibold text-on-surface text-base" numberOfLines={1}>
                    {getWithLabel()}
                  </Text>
                </View>
              </View>
              <MaterialIcons name="chevron-right" size={24} color="#707a6f" />
            </AnimatedPressable>
          </View>

          {/* Paid-by popup */}
          <Modal
            visible={payerModalOpen}
            transparent
            animationType="fade"
            onRequestClose={() => setPayerModalOpen(false)}
          >
            <Pressable
              style={{ flex: 1, backgroundColor: 'rgba(28,28,25,0.45)', justifyContent: 'flex-end' }}
              onPress={() => setPayerModalOpen(false)}
            >
              <Pressable
                onPress={(e: GestureResponderEvent) => e.stopPropagation()}
                style={{
                  backgroundColor: '#fcf9f4',
                  borderTopLeftRadius: 28,
                  borderTopRightRadius: 28,
                  paddingTop: 10,
                  paddingBottom: 32,
                  paddingHorizontal: 20,
                }}
              >
                <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.15)', marginBottom: 16 }} />

                <Text className="font-headline-md text-lg font-bold text-on-surface mb-1">Who paid the bill?</Text>
                <Text className="text-sm text-on-surface-variant mb-4">
                  Whoever paid is owed by everyone else in the split.
                </Text>

                {payerOptions.map((p, index) => {
                  const active = selectedPayer?.id === p.id;
                  return (
                    <AnimatedListItem key={p.id} index={index}>
                      <AnimatedPressable
                        onPress={() => choosePayer(p)}
                        className="flex-row items-center py-3 px-3 rounded-2xl mb-1"
                        style={{
                          backgroundColor: active ? '#caead6' : 'transparent',
                          borderWidth: 1,
                          borderColor: active ? '#004c22' : 'transparent',
                        }}
                      >
                        <View className="w-10 h-10 rounded-full items-center justify-center overflow-hidden bg-secondary-container">
                          <Avatar
                            uri={p.image}
                            initials={p.initials || p.name?.charAt(0) || '?'}
                            textClassName="text-primary font-bold text-sm"
                          />
                        </View>
                        <Text
                          className="font-semibold text-on-surface text-base"
                          style={{ marginLeft: 14, flex: 1 }}
                          numberOfLines={1}
                        >
                          {p.isYou ? 'You' : p.name}
                        </Text>
                        {active && <MaterialIcons name="check-circle" size={22} color="#004c22" />}
                      </AnimatedPressable>
                    </AnimatedListItem>
                  );
                })}
              </Pressable>
            </Pressable>
          </Modal>
        </View>
      </ScrollView>

      {/* Bottom Action Button */}
      <View className="absolute bottom-0 left-0 w-full px-5 pt-10 pb-5" style={{ backgroundColor: 'rgba(252, 249, 244, 0.9)' }}>
        <AnimatedPressable
          scaleTo={0.9}
          onPress={handleNextStep}
          disabled={(selectedFriends.length === 0 && !selectedGroup) || membersBlocked}
          className={`w-full max-w-xl mx-auto h-14 rounded-xl flex-row items-center justify-center space-x-2 transition-all shadow-lg ${
            ((selectedFriends.length === 0 && !selectedGroup) || membersBlocked) ?'bg-outline-variant/30 opacity-50' : 'bg-primary shadow-primary/20'
          }`}
        >
          <Text className="text-white font-bold text-lg font-body-lg">Next Step</Text>
          <MaterialIcons name="arrow-forward" size={24} color="#ffffff" />
        </AnimatedPressable>
      </View>
    </SafeAreaView>
  );
}
