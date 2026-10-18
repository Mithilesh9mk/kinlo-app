import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { View, Text, ScrollView, TextInput, FlatList, ActivityIndicator, RefreshControl } from 'react-native';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Contacts from 'expo-contacts/legacy';
import { useGlobalBalances } from '../../context/GlobalBalancesContext';
import { supabase } from '../../lib/supabase';
import { getRelatedUsers } from '../../lib/friendFetcher';
import { fetchBalances } from '../../lib/balances';
import { fetchUnreadActivityCount } from '../../lib/activity';
import { fetchPendingConnectionCount } from '../../lib/connections';
import { personalMonthSummary } from '../../lib/personalTransactions';
import { withOfflineFallback } from '../../lib/offlineCache';
import { Avatar } from '../../components/Avatar';
import AddFriendModal from '../../components/AddFriendModal';
import { Skeleton, SkeletonListRow } from '../../components/Skeleton';
import { OfflineBanner } from '../../components/OfflineBanner';
import { FirstRunHintCard } from '../../components/FirstRunHintCard';
import { useFirstRunHints } from '../../lib/useFirstRunHints';
import { formatINR, tabularNums } from '../../lib/format';

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
  /**
   * 'expense' or 'settlement'. This field was missing entirely, so the
   * settlement check on the card always read undefined and every payment
   * rendered as an ordinary expense — including the payments icon, which had
   * never worked for the same reason.
   */
  type?: string;
}

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { totalBalance, loading: balancesLoading, error: balancesError, cachedAt: balancesCachedAt, refreshBalances } = useGlobalBalances();
  // The context keeps the previous snapshot when a refresh fails, so `error`
  // alone can't tell "no data ever" from "stale-but-real data". Only show the
  // error branch if a balance has never loaded successfully this session and
  // no offline cache is standing in for it.
  const balanceEverLoaded = useRef(false);
  if (!balancesLoading && !balancesError) balanceEverLoaded.current = true;
  const balanceFailed = !!balancesError && !balancesLoading && !balanceEverLoaded.current && !balancesCachedAt;

  // Oldest cachedAt across every source feeding this screen — the one
  // OfflineBanner shown reflects the stalest thing on the page, not just
  // whichever fetch happened to fail last. Each source writes its own slot
  // (null = live) rather than one shared boolean, since Home has four
  // independent fetches that can each fail or recover on their own.
  const [staleSources, setStaleSources] = useState<Record<'recent' | 'monthly' | 'today', string | null>>({
    recent: null,
    monthly: null,
    today: null,
  });
  const staleAt = useMemo(() => {
    const all = [balancesCachedAt, staleSources.recent, staleSources.monthly, staleSources.today]
      .filter((v): v is string => !!v);
    if (all.length === 0) return null;
    return all.reduce((oldest, v) => (Date.parse(v) < Date.parse(oldest) ? v : oldest));
  }, [balancesCachedAt, staleSources]);

  // Home had no loading state at all — it rendered empty containers until data
  // arrived, so a slow connection looked like an empty account rather than a
  // loading one. These drive the placeholders below.
  const [activityLoading, setActivityLoading] = useState(true);

  // A failed fetch used to only console.error, leaving the 0 / [] initial
  // state on screen, which read as "no activity" and "₹0 spent". 'failed' is
  // only ever set when nothing has loaded yet — a failed refresh after a good
  // load keeps the data already in state.
  const [loadStatus, setLoadStatus] = useState<Record<'recent' | 'monthly' | 'today', 'pending' | 'ok' | 'failed'>>({
    recent: 'pending',
    monthly: 'pending',
    today: 'pending',
  });
  const markLoad = useCallback((key: 'recent' | 'monthly' | 'today', ok: boolean) => {
    setLoadStatus((prev) => {
      const next = ok ? 'ok' : prev[key] === 'ok' ? 'ok' : 'failed';
      return prev[key] === next ? prev : { ...prev, [key]: next };
    });
  }, []);

  // Was a hardcoded lh3.googleusercontent.com preset URL — an ephemeral
  // AI-generated link that eventually 404s. Avatar's onError already caught
  // the failure and fell back to initials, but only after one failed network
  // attempt and a visible flash. null skips straight to initials, and is now
  // the common case since onboarding/avatar.tsx defaults to skip.
  const [userAvatar, setUserAvatar] = useState<string | null>(null);

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

  const [userFirstName, setUserFirstName] = useState('');
  useEffect(() => {
    async function loadUserName() {
      try {
        const { data: authData } = await supabase.auth.getUser();
        const userId = authData?.user?.id;
        if (!userId) return;
        const { data } = await supabase
          .from('users')
          .select('full_name')
          .eq('id', userId)
          .maybeSingle();
        if (data?.full_name) setUserFirstName(data.full_name.split(' ')[0]);
      } catch (e) {
        console.error('Failed to load home greeting name:', e);
      }
    }
    loadUserName();
  }, []);

  // "Late night" rather than "Good night" for the small hours — this app
  // opens to check a balance, not to say goodnight to.
  const greeting = (() => {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'Good morning';
    if (hour >= 12 && hour < 17) return 'Good afternoon';
    if (hour >= 17 && hour < 22) return 'Good evening';
    return 'Late night';
  })();

  const [friendsList, setFriendsList] = useState<Friend[]>([]);
  const [recentActivity, setRecentActivity] = useState<RecentActivity[]>([]);
  const [monthlySpend, setMonthlySpend] = useState(0);
  // This month's personal spending, driving the card below. null = not
  // loaded yet, so the card renders nothing rather than flashing "₹0.00"
  // for a moment on every open.
  const [personalSummary, setPersonalSummary] = useState<{ total: number; count: number } | null>(null);

  // First-run guidance cards. Only trust "no activity" once the live load has
  // finished — not while loading, and not when showing offline-cached data.
  const { showSplit, showPersonal, dismiss: dismissHint } = useFirstRunHints({
    activityReady: !activityLoading && staleSources.recent === null && loadStatus.recent !== 'failed',
    activityCount: recentActivity.length,
  });

  // Balances come from the shared snapshot (lib/balances.ts) so this list and
  // the headline total below it are the same numbers. This used to run its own
  // ledger query with `.is('group_id', null)`, which quietly disagreed with the
  // total and with the settle-up picker.
  const fetchFriends = useCallback(async () => {
    try {
      const { friends } = await fetchBalances();
      setFriendsList(
        friends.map((f) => ({
          id: f.id,
          name: f.name,
          fullName: f.fullName,
          phoneNumber: f.phoneNumber,
          balance: Math.abs(f.balance),
          status: f.status,
          image: f.avatarUrl,
          initials: f.initials,
        }))
      );
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

  // Refreshed on every focus so coming back from Activity — which marks
  // everything read on open — clears the badge immediately, and coming back
  // from anywhere else picks up anything new since the last check.
  const [unreadActivityCount, setUnreadActivityCount] = useState(0);
  const fetchUnreadActivity = useCallback(async () => {
    try {
      // Connection requests count toward the badge, but unlike events they
      // aren't cleared by opening Activity — they stay until answered, which
      // is the point: one is news, the other is a decision waiting on you.
      const [unread, pendingConnections] = await Promise.all([
        fetchUnreadActivityCount(),
        fetchPendingConnectionCount(),
      ]);
      setUnreadActivityCount(unread + pendingConnections);
    } catch (e) {
      console.error('Failed to fetch unread activity count:', e);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchUnreadActivity();
    }, [fetchUnreadActivity])
  );

  // Re-fetch recent activity every time home screen is focused
  // Phase 1B fix: Use two targeted queries instead of global fetch + JS filter
  const fetchRecentActivity = useCallback(async () => {
    try {
      const { data: recent, cachedAt } = await withOfflineFallback(
        'home.recentActivity',
        fetchRecentActivityLive,
      );
      setRecentActivity(recent);
      setStaleSources((prev) => ({ ...prev, recent: cachedAt }));
      markLoad('recent', true);
    } catch (e) {
      console.error('Failed to fetch recent activity:', e);
      markLoad('recent', false);
    } finally {
      // In `finally` so a failed load stops showing placeholders too — a
      // skeleton that never resolves is worse than an empty state.
      setActivityLoading(false);
    }
  }, [markLoad]);

  const fetchRecentActivityLive = useCallback(async (): Promise<RecentActivity[]> => {
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;
      if (!userId) return [];

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

      if ((err1 && err2) || (!paidByMe && !splitWithMe)) return [];

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
        const groupName = groupId ? (groupMap[groupId] || 'Circle') : undefined;

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

            // Name everyone, not whoever Postgres returned first. This used to
            // read `nameMap[otherShares[0].user_id]`, so a three-way dinner was
            // labelled "with Sarvesh" — true of one participant and misleading
            // about the other two.
            const names = otherShares.map(
              (sp: any) => (nameMap[sp.user_id] || 'Friend').split(' ')[0],
            );
            friendName =
              names.length === 1 ? names[0]
              : names.length === 2 ? `${names[0]} and ${names[1]}`
              : `${names[0]} and ${names.length - 1} others`;
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
          status: tx.status || 'active',
          type: (tx as any).type || 'expense'
        };
      });

      return recent;
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchRecentActivity();
    }, [fetchRecentActivity])
  );

  // Feeds the Personal Spending card below — refetched on every focus so the
  // total is current the moment you come back from adding an expense, by
  // either entry path.
  useFocusEffect(
    useCallback(() => {
      personalMonthSummary()
        .then(setPersonalSummary)
        .catch((e) => console.error('Failed to load personal spending summary:', e));
    }, [])
  );

  // Shared by Monthly Spend and Today's Spend below. Split into two queries
  // (mine as payer, mine as a split-only participant) rather than a single
  // `.or('paid_by.eq.X,transaction_splits.user_id.eq.X')` — that clause
  // filters an *embedded* table inside a top-level `.or()`, which PostgREST
  // doesn't honor without an inner join, so it silently dropped every
  // transaction where the user only had a split and hadn't paid. Same fix
  // already applied to fetchRecentActivity above; this tile still had the
  // broken version.
  const fetchSpendSince = useCallback(async (sinceISO: string): Promise<number> => {
    const { data: authData } = await supabase.auth.getUser();
    const userId = authData?.user?.id;
    if (!userId) return 0;

    const [{ data: paidByMe, error: paidErr }, { data: splitWithMe, error: splitErr }] = await Promise.all([
      supabase
        .from('transactions')
        .select('id, amount, paid_by, transaction_splits (user_id, share_amount)')
        .eq('paid_by', userId)
        .neq('type', 'settlement')
        .gte('created_at', sinceISO),
      supabase
        .from('transactions')
        .select('id, amount, paid_by, transaction_splits!inner (user_id, share_amount)')
        .eq('transaction_splits.user_id', userId)
        .neq('paid_by', userId)
        .neq('type', 'settlement')
        .gte('created_at', sinceISO),
    ]);

    // A failed query used to fall through as null -> a fake "₹0 spent" that was
    // then cached. Throw so the tile shows '—' (or the offline cache) instead.
    if (paidErr || splitErr) throw (paidErr || splitErr);

    const txMap = new Map<string, any>();
    for (const tx of paidByMe || []) txMap.set(tx.id, tx);
    for (const tx of splitWithMe || []) if (!txMap.has(tx.id)) txMap.set(tx.id, tx);

    let total = 0;
    for (const tx of txMap.values()) {
      const splits = tx.transaction_splits || [];
      const mySplit = splits.find((s: any) => s.user_id === userId);
      total += mySplit ? Number(mySplit.share_amount) : (tx.paid_by === userId ? Number(tx.amount) : 0);
    }
    return total;
  }, []);

  const fetchMonthlySpend = useCallback(async () => {
    try {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
      const { data, cachedAt } = await withOfflineFallback(
        'home.monthlySpend',
        () => fetchSpendSince(startOfMonth),
      );
      setMonthlySpend(data);
      setStaleSources((prev) => ({ ...prev, monthly: cachedAt }));
      markLoad('monthly', true);
    } catch (e) {
      console.error('Failed to fetch monthly spend:', e);
      markLoad('monthly', false);
    }
  }, [fetchSpendSince, markLoad]);

  const [todaySpend, setTodaySpend] = useState(0);
  const fetchTodaySpend = useCallback(async () => {
    try {
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const { data, cachedAt } = await withOfflineFallback(
        'home.todaySpend',
        () => fetchSpendSince(startOfDay),
      );
      setTodaySpend(data);
      setStaleSources((prev) => ({ ...prev, today: cachedAt }));
      markLoad('today', true);
    } catch (e) {
      console.error('Failed to fetch today spend:', e);
      markLoad('today', false);
    }
  }, [fetchSpendSince, markLoad]);

  useEffect(() => {
    fetchMonthlySpend();
    fetchTodaySpend();
  }, [fetchMonthlySpend, fetchTodaySpend]);

  // Pull-to-refresh. Re-runs every fetch on this screen in parallel; each
  // one already has its own try/catch, so nothing here needs to. Balances
  // go through the shared context's own refresh rather than a duplicate
  // query, so Home stays in agreement with every other screen that reads it.
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([
      fetchFriends(),
      fetchUnreadActivity(),
      fetchRecentActivity(),
      personalMonthSummary().then(setPersonalSummary).catch((e) =>
        console.error('Failed to load personal spending summary:', e)
      ),
      fetchMonthlySpend(),
      fetchTodaySpend(),
      refreshBalances(),
    ]);
    setRefreshing(false);
  }, [fetchFriends, fetchUnreadActivity, fetchRecentActivity, fetchMonthlySpend, fetchTodaySpend, refreshBalances]);

  // Modal Input State
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);

  const getBorderColor = (friend: Friend) => {
    if (friend.status === 'owed') return 'border-primary';
    if (friend.status === 'owes') return 'border-error';
    return 'border-[#bfc9bd]';
  };

  const getBalanceTextColor = (friend: Friend) => {
    if (friend.status === 'owed') return 'text-primary';
    if (friend.status === 'owes') return 'text-error';
    return 'text-on-surface-variant';
  };

  const getBalanceLabel = (friend: Friend) => {
    if (friend.status === 'owed') return formatINR(friend.balance, { decimals: 0, signed: true });
    if (friend.status === 'owes') return formatINR(-friend.balance, { decimals: 0 });
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
    if (totalBalance > 0) return "You are owed";
    if (totalBalance < 0) return 'You owe';
    return 'Settled';
  };

  const getBalanceCardAmount = () => {
    return formatINR(totalBalance);
  };

  const getBalanceCardColor = () => {
    if (totalBalance > 0) return 'text-primary';
    if (totalBalance < 0) return 'text-error';
    return 'text-on-surface-variant';
  };

  return (
    <View className="flex-1 bg-surface">
      {/* Header */}
      {/* The avatar and the settings gear that used to sit here both pushed
          /profile, which the Profile tab already reaches — three controls,
          one destination. The tab is now the single way in. The avatar stays
          as identity, not navigation. */}
      <View
        className="px-6 pb-4 flex-row items-center bg-surface/90 z-20"
        style={{ paddingTop: Math.max(insets.top, 24) }}
      >
        <View className="w-10 h-10 rounded-full overflow-hidden border-2 border-white shadow-sm">
          <Avatar uri={userAvatar} initials={(userFirstName || '').charAt(0).toUpperCase() || undefined} />
        </View>
        <Text className="ml-3" numberOfLines={1}>
          <Text className="font-bold text-2xl text-primary tracking-tight">Kinlo</Text>
          <Text className="font-semibold text-base text-surface-tint"> - The Split</Text>
        </Text>

        <View className="ml-auto flex-row items-center gap-2">
          {/* Personal spending used to live three taps deep in Profile —
              invisible next to the one thing everyone already reaches for
              here, "add an expense". Same size/shape as search and history
              beside it, so it reads as a peer of those, not an afterthought
              — a text pill was tried first but risked overflowing this row
              on narrower phones since the title has no width limit. */}
          <AnimatedPressable
            onPress={() => router.push('/finance')}
            className="w-10 h-10 rounded-full items-center justify-center active:bg-surface-container"
            accessibilityLabel="Personal spending"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <MaterialIcons name="document-scanner" size={22} color="#004c22" />
          </AnimatedPressable>

          {/* Universal search — friends, groups, split expenses, and
              personal expenses, each labelled by type (app/search.tsx). The
              "View All" button in the friends strip below still goes
              straight to /friends for browsing everyone; this is for
              finding one specific thing across all four. */}
          <AnimatedPressable
            onPress={() => router.push('/search')}
            className="w-10 h-10 rounded-full items-center justify-center active:bg-surface-container"
            accessibilityLabel="Search"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <MaterialIcons name="search" size={24} color="#004c22" />
          </AnimatedPressable>

          {/* The history log. Distinct from "See all" below, which opens the
              Statement — that is every transaction; this is what changed. */}
          <AnimatedPressable
            onPress={() => router.push('/activity')}
            className="w-10 h-10 rounded-full items-center justify-center active:bg-surface-container"
            accessibilityLabel={
              unreadActivityCount > 0
                ? `Activity, ${unreadActivityCount} unread`
                : 'Activity'
            }
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <MaterialIcons name="history" size={24} color="#004c22" />
            {unreadActivityCount > 0 && (
              <View
                className="absolute top-0.5 right-0.5 bg-error rounded-full items-center justify-center px-1"
                style={{ minWidth: 16, height: 16 }}
              >
                <Text className="text-white font-bold" style={{ fontSize: 10, lineHeight: 12 }}>
                  {unreadActivityCount > 9 ? '9+' : unreadActivityCount}
                </Text>
              </View>
            )}
          </AnimatedPressable>
        </View>
      </View>

      <OfflineBanner cachedAt={staleAt} />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 120 }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#004c22" />
        }
      >

        <Text className="px-6 pt-3 pb-1 font-bold text-lg text-surface-tint">
          {greeting}{userFirstName ? `, ${userFirstName}` : ''}
        </Text>

        {/* Friends row: a horizontally-scrolling strip plus a fixed "View
            All" button outside it. View All used to be the last item INSIDE
            the ScrollView — on Android, a tap there competes with that
            ScrollView's own horizontal-pan gesture recognition (two scroll
            axes nested inside each other fighting over the touch responder),
            and adding nestedScrollEnabled only reduced, not eliminated, the
            misfires users kept hitting. Moving it to a sibling View outside
            the ScrollView removes it from that contention entirely — it's
            still inside the page's outer vertical ScrollView like every
            other button here, which was never the problem axis. */}
        <View className="flex-row items-center pl-6 mb-4">
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexShrink: 1 }}
            contentContainerStyle={{ gap: 16, paddingVertical: 8 }}
          >
            {/* Add Friend Button */}
            <AnimatedPressable
              onPress={() => setIsAddModalOpen(true)}
              className="items-center gap-1.5"
            >
              <View className="w-16 h-16 rounded-full border-[2.5px] border-dashed border-primary bg-surface items-center justify-center">
                <MaterialIcons name="person-add" size={28} color="#004c22" />
              </View>
              <Text className="text-xs font-semibold text-primary">Add</Text>
            </AnimatedPressable>

            {/* Dynamic Friends List */}
            {friendsList.slice(0, 10).map((friend, friendIndex) => (
              <AnimatedListItem key={friend.id} index={friendIndex}>
                <AnimatedPressable
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
                    <Avatar uri={friend.image} initials={friend.initials} />
                  </View>
                  <View className="items-center">
                    <Text className="text-xs font-semibold text-on-surface">{friend.name}</Text>
                    <Text className={`text-[10px] font-bold mt-0.5 ${getBalanceTextColor(friend)}`} style={tabularNums}>
                      {getBalanceLabel(friend)}
                    </Text>
                  </View>
                </AnimatedPressable>
              </AnimatedListItem>
            ))}
          </ScrollView>

          {/* The search icon in the header above is the reachable-in-zero-
              scrolls entry point to the same screen. This stays as a second,
              always-visible way to reach it — distinct intent (browse the
              rest) from search, so it keeps its own icon rather than
              duplicating that one. Previously gated on length > 10, which
              meant no way to reach the full list at all below that count. */}
          {friendsList.length > 0 && (
            <AnimatedPressable
              onPress={() => router.push('/friends')}
              className="items-center gap-1.5 pl-4 pr-6"
              hitSlop={12}
            >
              {/* No active: styling here — this View sits INSIDE the
                  AnimatedPressable above, not as the pressable itself. On
                  native, NativeWind's active: variant needs to track its own
                  touch state, which meant this inner View was claiming the
                  responder to show ITS press effect and never let the tap
                  bubble up to the outer AnimatedPressable's onPress — the
                  actual cause of "tapping the circle does nothing, tapping
                  the text works" (the icon sat inside this View, the label
                  didn't). The outer AnimatedPressable already provides its
                  own scale-press animation for the whole button; this was
                  redundant as well as broken. Every other active: usage in
                  this codebase is on the pressable component itself — this
                  was the one exception. */}
              <View className="w-16 h-16 rounded-full border-[2.5px] border-outline-variant/50 bg-surface-container items-center justify-center">
                <MaterialIcons name="arrow-forward" size={26} color="#404940" />
              </View>
              <Text className="text-xs font-semibold text-on-surface-variant">View All</Text>
            </AnimatedPressable>
          )}
        </View>

        {/* Balance Card */}
        <View className="px-6 mb-6">
          <View className="liquid-glass rounded-3xl p-6 items-center">
            <Text className="text-sm font-medium text-on-surface-variant uppercase tracking-wider mb-2">{getBalanceCardLabel()}</Text>
            {balancesLoading ? (
              <Skeleton width={186} height={44} radius={12} style={{ marginBottom: 24 }} />
            ) : balanceFailed ? (
              // "—", not "All settled ₹0.00": a failed load is not the same as
              // owing nothing.
              <View className="items-center mb-6">
                <Text className="text-5xl font-bold text-on-surface-variant">—</Text>
                <Text className="text-xs text-on-surface-variant mt-2">Couldn't refresh your balance</Text>
                <AnimatedPressable
                  onPress={refreshBalances}
                  className="flex-row items-center px-4 py-2 rounded-full bg-error/10 mt-3"
                  accessibilityRole="button"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <MaterialIcons name="refresh" size={14} color="#ba1a1a" />
                  <Text className="font-bold text-[10px] uppercase tracking-wide text-error ml-1">Retry</Text>
                </AnimatedPressable>
              </View>
            ) : (
              <Text
                className={`text-5xl font-bold mb-6 ${getBalanceCardColor()}`}
                style={tabularNums}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.6}
              >{getBalanceCardAmount()}</Text>
            )}
            <View className="flex-row gap-3 w-full">
              <AnimatedPressable 
                onPress={() => router.push('/settle-up')}
                className="flex-1 bg-primary py-3.5 rounded-2xl items-center shadow-sm"
              >
                <Text className="text-white font-semibold text-base">Settle Up</Text>
              </AnimatedPressable>
              <AnimatedPressable 
                onPress={() => router.push('/statement')}
                className="flex-1 liquid-glass py-3.5 rounded-2xl items-center"
              >
                <Text className="text-primary font-semibold text-base">Statement</Text>
              </AnimatedPressable>
            </View>
          </View>
        </View>

        {/* Insights Grid — both tiles real numbers now, both navigate to the
            same monthly breakdown (Today's Spend is a subset of that story,
            not a separate screen). Eco Impact (a static "Coming Soon" View)
            is gone; can come back once there's real data behind it. Compacted
            padding/icon size from the original single-tile version since two
            tiles now share this row. */}
        <View className="px-6 flex-row gap-3 mb-6">
          <AnimatedPressable
            onPress={() => router.push('/(tabs)/analytics')}
            className="flex-1 liquid-glass rounded-2xl p-4"
          >
            <View className="w-8 h-8 rounded-full bg-surface mb-2 items-center justify-center">
              <MaterialIcons name="trending-up" size={16} color="#004c22" />
            </View>
            <Text className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider mb-0.5">This month (split)</Text>
            <Text className="text-lg font-bold text-on-surface" style={tabularNums}>{loadStatus.monthly === 'failed' ? '—' : formatINR(monthlySpend, { decimals: 0 })}</Text>
          </AnimatedPressable>

          <AnimatedPressable
            onPress={() => router.push('/(tabs)/analytics')}
            className="flex-1 liquid-glass rounded-2xl p-4"
          >
            <View className="w-8 h-8 rounded-full bg-surface mb-2 items-center justify-center">
              <MaterialIcons name="today" size={16} color="#004c22" />
            </View>
            <Text className="text-[11px] font-medium text-on-surface-variant uppercase tracking-wider mb-0.5">Today (split)</Text>
            <Text className="text-lg font-bold text-on-surface" style={tabularNums}>{loadStatus.today === 'failed' ? '—' : formatINR(todaySpend, { decimals: 0 })}</Text>
          </AnimatedPressable>
        </View>

        {/* First-run guidance — dismissible, per device; hides itself once the
            user has any splits / personal entries. */}
        {(showSplit || showPersonal) && (
          <View className="px-6 mb-6 gap-3">
            {showSplit && (
              <FirstRunHintCard
                icon="group-add"
                accent="#004c22"
                backgroundColor="rgba(139,215,155,0.2)"
                borderColor="rgba(0,76,34,0.2)"
                title="Your first split"
                body="Add an expense and split it with a friend."
                ctaLabel="Add an expense"
                onCta={() => router.push('/expense/amount')}
                onDismiss={() => dismissHint('split')}
              />
            )}
            {showPersonal && (
              <FirstRunHintCard
                icon="document-scanner"
                accent="#d97706"
                backgroundColor="rgba(217,119,6,0.14)"
                borderColor="rgba(217,119,6,0.35)"
                title="Track your own spending"
                body="Scan a payment screenshot to log a personal expense."
                ctaLabel="Start tracking"
                onCta={() => router.push('/finance')}
                onDismiss={() => dismissHint('personal')}
              />
            )}
          </View>
        )}

        {/* Smart Suggestion */}
        <View className="px-6 mb-8">
          {/* The chevron on the right specifically signals navigation, and
              this went nowhere. Both states of the copy point at reviewing
              recent activity, which is what Statement shows. */}
          <AnimatedPressable
            onPress={() => router.push('/statement')}
            className="bg-[#8bd79b]/20 border border-[#004c22]/20 rounded-2xl p-4 flex-row gap-4 items-center"
          >
            <View className="w-12 h-12 rounded-full bg-white items-center justify-center shadow-sm">
              <MaterialIcons name="auto-awesome" size={24} color="#004c22" />
            </View>
            <View className="flex-1">
              <Text className="text-xs font-bold text-primary uppercase tracking-wider mb-0.5">Smart Split</Text>
              <Text className="font-semibold text-on-surface" numberOfLines={1}>{recentActivity.length > 0 ? 'Review your recent splits and settle up!' : 'Start splitting expenses with friends!'}</Text>
            </View>
            <MaterialIcons name="chevron-right" size={24} color="#004c22" />
          </AnimatedPressable>
        </View>

        {/* Personal Spending card — amber, not the Smart Suggestion card's
            green, so the two read as distinct at a glance despite sharing
            the same shape. */}
        {personalSummary !== null && (
          <View className="px-6 mb-8">
            <AnimatedPressable
              onPress={() => router.push('/finance')}
              className="rounded-2xl p-4 flex-row gap-4 items-center"
              style={{ backgroundColor: 'rgba(217,119,6,0.14)', borderWidth: 1, borderColor: 'rgba(217,119,6,0.35)' }}
            >
              <View className="w-12 h-12 rounded-full bg-white items-center justify-center shadow-sm">
                <MaterialIcons name="document-scanner" size={24} color="#d97706" />
              </View>
              <View className="flex-1">
                <Text className="text-xs font-bold uppercase tracking-wider mb-0.5" style={{ color: '#9a5511' }}>Personal Spending</Text>
                {/* Once there is data the card reports it instead of repeating
                    a prompt the user has already acted on — that is what earns
                    it a permanent slot on Home rather than being a first-run
                    nudge that disappears. */}
                {personalSummary.count === 0 ? (
                  <Text className="font-semibold text-on-surface" numberOfLines={1}>
                    Track your own spending — scan a screenshot to start
                  </Text>
                ) : (
                  <>
                    <Text className="font-bold text-on-surface text-lg" numberOfLines={1} style={tabularNums}>
                      {formatINR(personalSummary.total)}
                    </Text>
                    <Text className="text-xs text-on-surface-variant" numberOfLines={1}>
                      {personalSummary.count} expense{personalSummary.count === 1 ? '' : 's'} this month
                    </Text>
                  </>
                )}
              </View>
              <MaterialIcons name="chevron-right" size={24} color="#d97706" />
            </AnimatedPressable>
          </View>
        )}

        {/* Recent Activity */}
        <View className="px-6 mb-4">
          <View className="flex-row justify-between items-center mb-4">
            <Text className="font-semibold text-xl text-on-surface">Recent Activity</Text>
            <AnimatedPressable onPress={() => router.push('/statement')} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Text className="text-primary font-semibold text-sm">See all</Text>
            </AnimatedPressable>
          </View>

          <View className="gap-3">
            {activityLoading ? (
              [0, 1, 2, 3].map(i => (
                <View key={i} className="liquid-glass rounded-2xl px-4">
                  <SkeletonListRow avatarSize={44} />
                </View>
              ))
            ) : loadStatus.recent === 'failed' ? (
              // Not the empty state: that copy is only true after a successful
              // load that returned zero rows.
              <View className="bg-error/5 p-5 rounded-2xl border border-error/20 items-center">
                <Text className="text-sm font-bold text-error">Couldn't load recent activity</Text>
                <AnimatedPressable
                  onPress={() => { setActivityLoading(true); fetchRecentActivity(); }}
                  className="flex-row items-center px-4 py-2 rounded-full bg-error/10 mt-3"
                  accessibilityRole="button"
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                >
                  <MaterialIcons name="refresh" size={14} color="#ba1a1a" />
                  <Text className="font-bold text-[10px] uppercase tracking-wide text-error ml-1">Retry</Text>
                </AnimatedPressable>
              </View>
            ) : recentActivity.length === 0 ? (
              <View className="liquid-glass rounded-2xl p-6 items-center justify-center">
                <Text className="font-semibold text-on-surface-variant">No recent activity</Text>
                <AnimatedPressable onPress={() => router.push('/expense/amount')} className="mt-3" hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Text className="text-primary font-semibold text-sm">Add your first expense</Text>
                </AnimatedPressable>
              </View>
            ) : (
              recentActivity.map((item, itemIndex) => {
                const isVoided = item.status === 'voided';
                const isSettlement = (item as any).type === 'settlement';

                return (
                  <AnimatedListItem key={item.id} index={itemIndex}>
                  <AnimatedPressable
                    onPress={() => {
                      // Open the expense itself, not one of its participants.
                      // This used to jump to a single counterpartyId, so a
                      // three-person expense landed you in one friend's history
                      // with no sign the others were involved.
                      router.push({ pathname: `/transaction/${item.id}` });
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
                      <Text className={`font-semibold text-sm ${isVoided ? 'text-outline line-through' : 'text-on-surface'}`} numberOfLines={1}>
                        {isSettlement
                          ? (item.paidByName === 'You' ? `You paid ${item.friendName?.split(' ')[0] || 'a friend'}` : `${item.paidByName?.split(' ')[0]} paid you`)
                          : item.description}
                      </Text>
                      <Text className="text-xs text-on-surface-variant mt-0.5">
                        {isSettlement
                          ? `Payment • ${item.date}`
                          : `${item.paidByName} paid ${formatINR(item.amount, { decimals: 0 })}${item.locationLabel ? ` • ${item.locationLabel}` : ''} • ${item.date}`}
                      </Text>
                      {/* A settlement is money changing hands, not a new charge.
                          Showing it with the same owe/owed wording made settling
                          look like it had created another debt. */}
                      <Text className={`text-xs font-semibold mt-0.5 ${isVoided ? 'text-outline' : (isSettlement || item.status === 'settled' || item.displayAmount <= 0 ? 'text-primary' : (item.isOwed ? 'text-primary' : 'text-error'))}`} style={tabularNums}>
                        {isVoided
                          ? 'Voided'
                          : isSettlement
                            ? 'Settled up'
                            : (item.status === 'settled' || item.displayAmount <= 0
                              ? 'Settled'
                              : (item.isOwed ? `You are owed ${formatINR(item.displayAmount)}` : `You owe ${formatINR(item.displayAmount)}`))}
                      </Text>
                    </View>
                    {isSettlement ? (
                      <Text className="font-bold text-base" style={[tabularNums, { color: isVoided ? '#9ca3af' : '#4d5a51' }]}>
                        {formatINR(item.amount)}
                      </Text>
                    ) : (
                      <Text className={`font-bold text-base ${isVoided ? 'text-outline' : (item.displayAmount === 0 ? 'text-[#404940]' : (item.isOwed ? 'text-primary' : 'text-error'))}`} style={tabularNums}>
                        {formatINR(item.displayAmount > 0 && !item.isOwed ? -item.displayAmount : item.displayAmount, { signed: true })}
                      </Text>
                    )}
                  </AnimatedPressable>
                  </AnimatedListItem>
                );
              })
            )}
          </View>
        </View>
      </ScrollView>

      {/* Floating Action Button */}
      <AnimatedPressable 
        onPress={() => router.push('/expense/amount')}
        className="absolute bottom-[100px] right-6 w-16 h-16 rounded-2xl bg-primary items-center justify-center shadow-lg z-30"
      >
        <MaterialIcons name="add" size={32} color="white" />
      </AnimatedPressable>

      {/* Add Friend Full Modal */}
      <AddFriendModal 
        isOpen={isAddModalOpen} 
        onClose={() => setIsAddModalOpen(false)} 
        onSuccess={fetchFriends} 
      />
    </View>
  );
}
