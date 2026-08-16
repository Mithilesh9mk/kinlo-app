import React, { useState, useEffect } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';

interface Group {
  id: string;
  title: string;
  categoryId: string;
  categoryLabel: string;
  categoryIcon: string;
  memberCount: number;
  members: string[];
  lastActivity?: string;
  subText?: string;
  balanceText: string;
  isDebt?: boolean;
}

export default function GroupsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams();

  const [groups, setGroups] = useState<Group[]>([]);

  // Fetch real groups from Supabase on mount
  useEffect(() => {
    async function fetchGroups() {
      try {
        const { supabase } = await import('../../lib/supabase');
        const { data: authData } = await supabase.auth.getUser();
        if (!authData?.user) return;
        const userId = authData.user.id;

        const { data: memberships, error } = await supabase
          .from('group_members')
          .select('group_id, groups(id, title, category)')
          .eq('user_id', userId);

        if (error || !memberships) return;

        const groupsFormatted: Group[] = [];
        for (const m of memberships) {
          const g = Array.isArray(m.groups) ? m.groups[0] : m.groups as any;
          if (!g) continue;

          // Count members
          const { data: members } = await supabase
            .rpc('get_group_members', { target_group_id: g.id });

          const categoryMap: Record<string, { label: string; icon: string }> = {
            trip: { label: 'Travel', icon: 'flight' },
            home: { label: 'Home', icon: 'home' },
            food: { label: 'Food', icon: 'restaurant' },
          };
          const cat = categoryMap[g.category] || { label: 'Other', icon: 'group' };

          groupsFormatted.push({
            id: g.id,
            title: g.title,
            categoryId: g.category || 'other',
            categoryLabel: cat.label,
            categoryIcon: cat.icon,
            memberCount: members?.length || 0,
            members: [],
            lastActivity: 'Active',
            balanceText: 'View',
          });
        }
        setGroups(groupsFormatted);
      } catch (err) {
        console.error('Error fetching groups:', err);
      }
    }
    fetchGroups();
  }, []);

  // Check for newly created groups returned as query parameters
  useEffect(() => {
    if (params.newGroup) {
      try {
        const parsed = JSON.parse(params.newGroup as string) as Group;
        
        // Prevent duplicate appending
        setGroups(prev => {
          if (prev.some(g => g.id === parsed.id)) return prev;
          
          const formattedGroup: Group = {
            ...parsed,
            lastActivity: 'Just Created • Active Now',
            balanceText: 'Settled'
          };
          return [formattedGroup, ...prev];
        });
      } catch (e) {
        console.error('Failed to parse returned newGroup parameter', e);
      }
    }
  }, [params.newGroup]);

  const handleCreateGroupPress = () => {
    router.push('/group/create');
  };

  const getAccentBg = (group: Group) => {
    if (group.categoryId === 'travel') return 'bg-primary/10';
    if (group.categoryId === 'home') return 'bg-secondary-container';
    if (group.categoryId === 'food') return 'bg-[#DCFCE7]';
    return 'bg-surface-container-high';
  };

  const getIconColor = (group: Group) => {
    if (group.categoryId === 'home') return '#486554';
    if (group.categoryId === 'food') return '#004c22';
    return '#004c22';
  };

  return (
    <View className="flex-1 bg-background">
      {/* Top App Bar */}
      <View 
        className="px-5 pb-4 flex-row justify-between items-center z-20 border-b border-white/35 shadow-sm"
        style={{ 
          paddingTop: Math.max(insets.top, 24),
          backgroundColor: 'rgba(252, 249, 244, 0.72)' 
        }}
      >
        <View className="flex-row items-center space-x-2">
          <MaterialIcons name="menu" size={24} color="#004c22" />
          <Text className="font-headline-md font-bold text-primary text-xl">Kinlo</Text>
        </View>
        
        {/* Dynamic Plus Circle button in Header */}
        <TouchableOpacity 
          onPress={handleCreateGroupPress}
          className="w-10 h-10 rounded-full bg-secondary-container items-center justify-center border border-white/50 active:scale-95"
        >
          <MaterialIcons name="group-add" size={22} color="#004c22" />
        </TouchableOpacity>
      </View>

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 120 }}>
        <View className="px-5 pt-8 max-w-7xl mx-auto w-full">
          {/* Header Section */}
          <View className="mb-8 flex-row justify-between items-end">
            <View className="flex-1 mr-4">
              <Text className="font-headline-lg-mobile text-3xl font-semibold text-primary mb-2">Your Circles</Text>
              <Text className="font-body-md text-on-surface-variant max-w-lg">
                Manage shared expenses and balances across your different groups with mindful clarity.
              </Text>
            </View>
            <TouchableOpacity 
              onPress={handleCreateGroupPress}
              className="hidden md:flex flex-row items-center bg-primary px-6 py-3 rounded-2xl space-x-2"
            >
              <MaterialIcons name="group-add" size={20} color="white" />
              <Text className="text-white font-label-md font-semibold text-base">New Circle</Text>
            </TouchableOpacity>
          </View>

          {/* Groups Grid */}
          <View className="flex-col gap-6">
            {groups.map(group => (
              <TouchableOpacity 
                key={group.id}
                onPress={() => router.push(`/group/${group.id}`)}
                className="p-6 rounded-xl w-full active:scale-98 transition-all overflow-hidden"
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
                <View className="absolute -top-10 -right-10 w-32 h-32 bg-primary/10 rounded-full blur-3xl" />
                <View className="flex-row justify-between items-start mb-6">
                  <View className={`w-12 h-12 rounded-xl items-center justify-center ${getAccentBg(group)}`}>
                    <MaterialIcons name={group.categoryIcon as any} size={24} color={getIconColor(group)} />
                  </View>
                  <View className="bg-[#DCFCE7] px-3 py-1 rounded-full">
                    <Text className="text-primary font-label-sm text-xs">
                      {group.categoryLabel}
                    </Text>
                  </View>
                </View>
                
                <Text className="font-headline-md text-xl mb-2">{group.title}</Text>
                <Text className="font-label-md text-sm text-on-surface-variant mb-6">
                  {group.memberCount} Members • {group.lastActivity}
                </Text>
                
                <View className="pt-4 border-t border-white/35 flex-row justify-between items-center">
                  <Text className="font-label-md text-sm text-on-surface-variant">Balance</Text>
                  <Text className={`font-bold text-lg ${group.isDebt ? 'text-[#E25E4E]' : 'text-primary'}`}>
                    {group.balanceText}
                  </Text>
                </View>
              </TouchableOpacity>
            ))}
          </View>

          {/* Featured Insight Section */}
          <View className="mt-8 flex-col space-y-6">
            <View 
              className="p-6 rounded-xl flex-col justify-center"
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
              <Text className="font-headline-md text-xl text-primary mb-2">Monthly Breakdown</Text>
              <Text className="font-body-md text-on-surface-variant mb-4">
                Your overall spending in groups is down by 12% compared to last month. Great job managing your shared finances mindfully.
              </Text>
              <TouchableOpacity className="bg-primary px-6 py-3 rounded-xl self-start active:bg-tertiary transition-colors">
                <Text className="text-white font-label-md font-medium">View Full Report</Text>
              </TouchableOpacity>
            </View>
          </View>

        </View>
      </ScrollView>

      {/* Floating Action Button (Mobile Group Creation Link) */}
      <TouchableOpacity 
        onPress={handleCreateGroupPress}
        className="absolute bottom-6 right-6 w-16 h-16 rounded-full bg-primary items-center justify-center shadow-lg z-30"
      >
        <MaterialIcons name="group-add" size={32} color="white" />
      </TouchableOpacity>
    </View>
  );
}
