import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Image, TextInput, Platform, RefreshControl } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Skeleton, SkeletonCircle } from '../../components/Skeleton';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { fetchBalanceRows, groupBalanceMap } from '../../lib/balances';
import { formatINR, tabularNums } from '../../lib/format';
import { withOfflineFallback } from '../../lib/offlineCache';
import { OfflineBanner } from '../../components/OfflineBanner';

interface Group {
  id: string;
  title: string;
  categoryId: string;
  categoryLabel: string;
  categoryIcon: string;
  memberCount: number;
  members: string[];
  subText?: string;
  balanceText: string;
  isDebt?: boolean;
}

export default function GroupsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams();

  const [groups, setGroups] = useState<Group[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  // This screen previously rendered an empty list while loading, so a slow
  // connection was indistinguishable from having no groups.
  const [groupsLoading, setGroupsLoading] = useState(true);
  // True when the last load threw, so an empty list is not mistaken for "no circles".
  const [groupsFailed, setGroupsFailed] = useState(false);

  const fetchGroupsLive = useCallback(async (supabase: any, userId: string): Promise<Group[]> => {
    const [{ data: memberships, error }, rows] = await Promise.all([
      supabase
        .from('group_members')
        .select('group_id, groups(id, title, category)')
        .eq('user_id', userId),
      fetchBalanceRows(userId),
    ]);

    if (error) throw new Error(error.message);
    if (!memberships) return [];

    const balances = groupBalanceMap(rows, userId);

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

      const balance = balances[g.id] || 0;

      groupsFormatted.push({
        id: g.id,
        title: g.title,
        categoryId: g.category || 'other',
        categoryLabel: cat.label,
        categoryIcon: cat.icon,
        memberCount: members?.length || 0,
        members: [],
        // Whole rupees, except under ₹1 where rounding would show a coloured ₹0.
        balanceText: Math.abs(balance) > 0.005
          ? formatINR(balance, { decimals: Math.abs(balance) < 1 ? 2 : 0, signed: true })
          : 'Settled',
        isDebt: balance < -0.005,
      });
    }
    return groupsFormatted;
  }, []);

  // Lifted to a useCallback (was an inline function inside this useEffect)
  // so both the mount effect and pull-to-refresh below can call it.
  const fetchGroups = useCallback(async () => {
    try {
      const { supabase } = await import('../../lib/supabase');
      // getSession() reads locally (no network) so a degraded connection
      // can't be mistaken for "signed out" and silently return empty — see
      // the same fix in lib/balances.ts for why that's worse than an error.
      const { data: sessionData } = await supabase.auth.getSession();
      if (!sessionData?.session?.user) return;
      const userId = sessionData.session.user.id;

      const { data, cachedAt: fetchedCachedAt } = await withOfflineFallback(
        'groupsList',
        () => fetchGroupsLive(supabase, userId),
      );
      setGroups(data);
      setCachedAt(fetchedCachedAt);
      setGroupsFailed(false);
    } catch (err) {
      console.error('Error fetching groups:', err);
      setGroupsFailed(true);
    } finally {
      setGroupsLoading(false);
    }
  }, [fetchGroupsLive]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  // Pull-to-refresh. The loading skeleton above is gated on
  // `groupsLoading && groups.length === 0`, so a refresh with existing
  // groups already on screen never re-shows it — matching how Activity's
  // pull-to-refresh skips its own full-screen skeleton.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchGroups();
    setRefreshing(false);
  }, [fetchGroups]);

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
        <View className="flex-row items-center gap-2">
          <MaterialIcons name="menu" size={24} color="#004c22" />
          <Text className="font-headline-md font-bold text-primary text-xl">Kinlo</Text>
        </View>
        
        {/* Dynamic Plus Circle button in Header */}
        <AnimatedPressable 
          onPress={handleCreateGroupPress}
          className="w-10 h-10 rounded-full bg-secondary-container items-center justify-center border border-white/50 active:scale-95"
        >
          <MaterialIcons name="group-add" size={22} color="#004c22" />
        </AnimatedPressable>
      </View>

      <OfflineBanner cachedAt={cachedAt} />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#004c22" />
        }
      >
        <View className="px-5 pt-8 max-w-7xl mx-auto w-full">
          {/* Header Section */}
          <View className="mb-8 flex-row justify-between items-end">
            <View className="flex-1 mr-4">
              <Text className="font-headline-lg-mobile text-3xl font-semibold text-primary mb-2">Your Circles</Text>
              <Text className="font-body-md text-on-surface-variant max-w-lg">
                Manage shared expenses and balances across your different circles with mindful clarity.
              </Text>
            </View>
            <AnimatedPressable
              onPress={handleCreateGroupPress}
              className="hidden md:flex flex-row items-center bg-primary px-6 py-3 rounded-2xl gap-2"
            >
              <MaterialIcons name="group-add" size={20} color="white" />
              <Text className="text-white font-label-md font-semibold text-base">New Circle</Text>
            </AnimatedPressable>
          </View>

          {/* Search */}
          {groups.length > 0 && (
            <View className="flex-row items-center bg-surface-container-low border border-outline-variant/40 rounded-full px-4 py-2.5 mb-6">
              <MaterialIcons name="search" size={22} color="#707a6f" />
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search circles by name..."
                placeholderTextColor="rgba(64, 73, 64, 0.5)"
                className="flex-1 ml-3 text-base text-on-surface font-body"
              />
              {searchQuery.length > 0 && (
                <AnimatedPressable onPress={() => setSearchQuery('')}>
                  <MaterialIcons name="close" size={20} color="#707a6f" />
                </AnimatedPressable>
              )}
            </View>
          )}

          {/* Groups Grid */}
          <View className="flex-col gap-6">
            {groupsLoading && groups.length === 0 && [0, 1, 2].map(i => (
              <View
                key={`skeleton-${i}`}
                className="rounded-3xl p-5"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.72)',
                  borderWidth: 1,
                  borderColor: 'rgba(0,0,0,0.05)',
                }}
              >
                <View className="flex-row items-center">
                  <SkeletonCircle size={52} />
                  <View style={{ flex: 1, marginLeft: 14 }}>
                    <Skeleton width="52%" height={15} />
                    <Skeleton width="30%" height={11} style={{ marginTop: 8 }} />
                  </View>
                </View>
                <Skeleton width="100%" height={10} radius={5} style={{ marginTop: 18 }} />
                <View className="flex-row justify-between" style={{ marginTop: 14 }}>
                  <Skeleton width={92} height={12} />
                  <Skeleton width={68} height={12} />
                </View>
              </View>
            ))}

            {!groupsLoading && groups.length === 0 && groupsFailed && (
              <View className="items-center py-10">
                <MaterialIcons name="cloud-off" size={36} color="#707a6f" />
                <Text className="text-on-surface font-semibold mt-3">Couldn’t load your circles</Text>
                <AnimatedPressable
                  onPress={() => { setGroupsLoading(true); fetchGroups(); }}
                  className="mt-4 px-5 py-2.5 rounded-full bg-primary"
                >
                  <Text className="text-white font-semibold text-sm">Try again</Text>
                </AnimatedPressable>
              </View>
            )}

            {!groupsLoading && groups.length === 0 && !groupsFailed && (
              <View className="items-center py-10 px-4">
                <View className="w-20 h-20 rounded-full bg-primary/10 items-center justify-center">
                  <MaterialIcons name="groups" size={40} color="#004c22" />
                </View>
                <Text className="text-on-surface font-bold text-lg mt-5 text-center">No circles yet</Text>
                <Text className="text-on-surface-variant text-sm text-center mt-1.5 leading-relaxed">
                  A circle is a shared pot for a trip, your flat or a group of friends. Everyone adds
                  expenses, and Kinlo works out who owes whom.
                </Text>
                <AnimatedPressable
                  onPress={handleCreateGroupPress}
                  className="mt-5 flex-row items-center bg-primary px-6 py-3 rounded-2xl gap-2"
                >
                  <MaterialIcons name="group-add" size={20} color="white" />
                  <Text className="text-white font-semibold text-base">Create your first circle</Text>
                </AnimatedPressable>
              </View>
            )}

            {groups
              .filter(group => group.title.toLowerCase().includes(searchQuery.toLowerCase()))
              .map((group, groupIndex) => (
              <AnimatedListItem key={group.id} index={groupIndex}>
              <AnimatedPressable
                scaleTo={0.98}
                onPress={() => router.push({
                  pathname: `/group/${group.id}`,
                  params: {
                    title: group.title,
                    categoryLabel: group.categoryLabel,
                    memberCount: String(group.memberCount),
                  },
                })}
                className="p-6 rounded-xl w-full overflow-hidden"
                style={{
                  // #fefdfc, not rgba(255,255,255,0.72): a translucent
                  // background paired with Android's `elevation` is a known
                  // rendering bug there — elevation's shadow/outline math
                  // assumes an opaque background, and a transparent one
                  // leaves a mismatched rectangle behind the real rounded
                  // card. This is the same color, precomputed opaque: white
                  // at 72% over this app's #fcf9f4 page background.
                  backgroundColor: '#fefdfc',
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
                  {group.memberCount} {group.memberCount === 1 ? 'Member' : 'Members'}
                </Text>
                
                <View className="pt-4 border-t border-white/35 flex-row justify-between items-center">
                  <Text className="font-label-md text-sm text-on-surface-variant">Balance</Text>
                  <Text className={`font-bold text-lg ${group.isDebt ? 'text-error' : 'text-primary'}`} style={tabularNums}>
                    {group.balanceText}
                  </Text>
                </View>
              </AnimatedPressable>
              </AnimatedListItem>
            ))}
          </View>

          {/* The "Monthly Breakdown" card that stood here has been removed.
              It claimed "Your overall spending in groups is down by 12%
              compared to last month" — a hardcoded sentence, identical for
              every user and every month, computed from nothing. In an app about
              someone's money, an invented statistic is not a placeholder.
              Its "View Full Report" button had no handler either.

              Insights already does this job with real figures. */}

        </View>
      </ScrollView>

      {/* Floating Action Button (Mobile Group Creation Link)
          The tab bar (app/(tabs)/_layout.tsx) floats above the screen as a
          sibling drawn by the navigator, not a child of this view — no
          z-index here can raise the FAB above it. `bottom-6` (24px) put the
          FAB's top edge at 88px, inside the tab bar's own 80-90px range, so
          it rendered underneath. This offset clears the tab bar's own
          bottom inset + height, plus a gap. */}
      <AnimatedPressable
        onPress={handleCreateGroupPress}
        className="absolute right-6 w-16 h-16 rounded-2xl bg-primary items-center justify-center shadow-lg z-30"
        style={{ bottom: (Platform.OS === 'ios' ? 26 : 16) + 64 + 16 }}
      >
        <MaterialIcons name="group-add" size={32} color="white" />
      </AnimatedPressable>
    </View>
  );
}
