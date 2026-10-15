import React, { useState, useMemo } from 'react';
import { View, Text, TextInput, SectionList } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { supabase } from '../lib/supabase';
import { fetchBalances, FriendBalance } from '../lib/balances';
import { listPersonalTransactions, PersonalTransaction } from '../lib/personalTransactions';
import { categoryMeta } from '../lib/categories';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { AnimatedListItem } from '../components/AnimatedListItem';
import { SkeletonListRow } from '../components/Skeleton';
import { Avatar } from '../components/Avatar';

/**
 * Universal search — friends, groups, split expenses, and personal expenses
 * in one place, each result labelled by type. No full-text search exists
 * anywhere in this app (confirmed by grep — zero ilike/tsvector usage), and
 * Friends/Groups already establish the pattern this follows: fetch once,
 * then filter client-side on every keystroke, no debounce.
 *
 * Nothing is fetched until the user actually types (see `hasFetched`) — a
 * screen whose only job is search shouldn't cost a network round trip just
 * to open.
 */

const money = (n: number) =>
  `₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const GROUP_CATEGORY_META: Record<string, { label: string; icon: string; bg: string; color: string }> = {
  trip: { label: 'Travel', icon: 'flight', bg: 'bg-primary/10', color: '#004c22' },
  home: { label: 'Home', icon: 'home', bg: 'bg-secondary-container', color: '#486554' },
  food: { label: 'Food', icon: 'restaurant', bg: 'bg-[#DCFCE7]', color: '#004c22' },
};
const GROUP_CATEGORY_FALLBACK = { label: 'Other', icon: 'group', bg: 'bg-surface-container-high', color: '#004c22' };

interface GroupResult {
  id: string;
  title: string;
  category: string;
}

interface SplitResult {
  id: string;
  description: string;
  category: string;
  amount: number;
  createdAt: string;
  owedToYou: boolean;
}

// SectionList infers ItemT from the first section's data alone, so a plain
// `.map(item => ({ type: 'friend', item }))` per section (with no shared
// declared type) leaves every other section's rows rejected as the wrong
// item type. One discriminated union, used only at render time — the fetch/
// filter arrays above stay separately typed by their real source types.
type SearchRow =
  | { type: 'friend'; item: FriendBalance }
  | { type: 'group'; item: GroupResult }
  | { type: 'split'; item: SplitResult }
  | { type: 'personal'; item: PersonalTransaction };

// Bounds the personal-transaction fetch — that table's history is never
// deleted (voided rows are kept, not removed), so an unbounded fetch here is
// the one real scaling risk in this screen. A user searching for something
// older than this window won't find it; accepted for now, not solved.
const PERSONAL_SEARCH_MONTHS_BACK = 24;

function matches(query: string, ...fields: (string | null | undefined)[]): boolean {
  return fields.some((f) => !!f && f.toLowerCase().includes(query));
}

function rank(query: string, ...fields: (string | null | undefined)[]): number {
  return fields.some((f) => !!f && f.toLowerCase().startsWith(query)) ? 0 : 1;
}

export default function SearchScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [query, setQuery] = useState('');
  const [hasFetched, setHasFetched] = useState(false);
  const [loading, setLoading] = useState(false);

  const [friends, setFriends] = useState<FriendBalance[]>([]);
  const [groups, setGroups] = useState<GroupResult[]>([]);
  const [splitTx, setSplitTx] = useState<SplitResult[]>([]);
  const [personalTx, setPersonalTx] = useState<PersonalTransaction[]>([]);

  const loadAllSources = async () => {
    setLoading(true);
    try {
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;
      if (!userId) return;

      const since = new Date();
      since.setMonth(since.getMonth() - PERSONAL_SEARCH_MONTHS_BACK);

      const [balances, membershipsRes, paidByMeRes, splitWithMeRes, personalRows] = await Promise.all([
        fetchBalances(),
        supabase.from('group_members').select('group_id, groups(id, title, category)').eq('user_id', userId),
        supabase
          .from('transactions')
          .select('id, amount, description, category, paid_by, created_at, transaction_splits (user_id, share_amount)')
          .eq('paid_by', userId)
          .neq('type', 'settlement')
          .neq('status', 'voided')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('transactions')
          .select('id, amount, description, category, paid_by, created_at, transaction_splits!inner (user_id, share_amount)')
          .eq('transaction_splits.user_id', userId)
          .neq('type', 'settlement')
          .neq('status', 'voided')
          .order('created_at', { ascending: false })
          .limit(200),
        listPersonalTransactions({ since }),
      ]);

      setFriends(balances.friends);

      const groupRows: GroupResult[] = (membershipsRes.data ?? [])
        .map((m: any) => (Array.isArray(m.groups) ? m.groups[0] : m.groups))
        .filter(Boolean)
        .map((g: any) => ({ id: g.id, title: g.title, category: g.category || 'other' }));
      setGroups(groupRows);

      const byId = new Map<string, SplitResult>();
      for (const row of [...(paidByMeRes.data ?? []), ...(splitWithMeRes.data ?? [])] as any[]) {
        if (byId.has(row.id)) continue;
        const mine = (row.transaction_splits || []).find((s: any) => s.user_id === userId);
        byId.set(row.id, {
          id: row.id,
          description: row.description || 'Expense',
          category: row.category || 'other',
          amount: mine ? Number(mine.share_amount) : Number(row.amount),
          createdAt: row.created_at,
          owedToYou: row.paid_by === userId,
        });
      }
      setSplitTx(Array.from(byId.values()));

      setPersonalTx(personalRows);
    } catch (e) {
      console.error('Universal search fetch failed:', e);
    } finally {
      setLoading(false);
    }
  };

  const onChangeQuery = (text: string) => {
    setQuery(text);
    if (!hasFetched && text.trim().length > 0) {
      setHasFetched(true);
      loadAllSources();
    }
  };

  const q = query.trim().toLowerCase();

  const friendResults = useMemo(() => {
    if (!q) return [];
    return friends
      .filter((f) => matches(q, f.fullName, f.phoneNumber))
      .sort((a, b) => rank(q, a.fullName) - rank(q, b.fullName) || a.fullName.localeCompare(b.fullName))
      .slice(0, 20);
  }, [q, friends]);

  const groupResults = useMemo(() => {
    if (!q) return [];
    return groups
      .filter((g) => matches(q, g.title))
      .sort((a, b) => rank(q, a.title) - rank(q, b.title) || a.title.localeCompare(b.title))
      .slice(0, 20);
  }, [q, groups]);

  const splitResults = useMemo(() => {
    if (!q) return [];
    return splitTx
      .filter((t) => matches(q, t.description, t.category))
      .sort(
        (a, b) =>
          rank(q, a.description, a.category) - rank(q, b.description, b.category) ||
          b.createdAt.localeCompare(a.createdAt)
      )
      .slice(0, 20);
  }, [q, splitTx]);

  const personalResults = useMemo(() => {
    if (!q) return [];
    return personalTx
      .filter((t) => matches(q, t.merchant, t.description, t.category))
      .sort(
        (a, b) =>
          rank(q, a.merchant, a.description, a.category) - rank(q, b.merchant, b.description, b.category) ||
          b.occurredAt.localeCompare(a.occurredAt)
      )
      .slice(0, 20);
  }, [q, personalTx]);

  const sections: { key: string; title: string; data: SearchRow[] }[] = [
    { key: 'friends', title: 'Friends', data: friendResults.map((item): SearchRow => ({ type: 'friend', item })) },
    { key: 'groups', title: 'Groups', data: groupResults.map((item): SearchRow => ({ type: 'group', item })) },
    { key: 'split', title: 'Split Expenses', data: splitResults.map((item): SearchRow => ({ type: 'split', item })) },
    { key: 'personal', title: 'Personal Expenses', data: personalResults.map((item): SearchRow => ({ type: 'personal', item })) },
  ].filter((s) => s.data.length > 0);

  const showPlaceholder = q.length === 0;
  const showLoading = !showPlaceholder && loading && sections.length === 0;
  const showNoResults = !showPlaceholder && !loading && hasFetched && sections.length === 0;

  return (
    <View className="flex-1 bg-background">
      <View
        className="px-6 pb-4 flex-row items-center bg-background border-b border-outline-variant/20"
        style={{ paddingTop: Math.max(insets.top, 24) }}
      >
        <AnimatedPressable onPress={() => router.back()} className="w-10 h-10 rounded-full items-center justify-center bg-surface-container active:scale-95 mr-3">
          <MaterialIcons name="arrow-back" size={24} color="#404940" />
        </AnimatedPressable>
        <View className="flex-1 flex-row items-center bg-surface-container-low border border-outline-variant/40 rounded-full px-4 py-2.5">
          <MaterialIcons name="search" size={22} color="#707a6f" />
          <TextInput
            value={query}
            onChangeText={onChangeQuery}
            placeholder="Search friends, groups, and expenses"
            placeholderTextColor="rgba(64, 73, 64, 0.5)"
            className="flex-1 ml-3 text-base text-on-surface font-body"
            autoFocus
          />
          {query.length > 0 && (
            <AnimatedPressable onPress={() => setQuery('')}>
              <MaterialIcons name="close" size={20} color="#707a6f" />
            </AnimatedPressable>
          )}
        </View>
      </View>

      {showPlaceholder && (
        <View className="flex-1 items-center justify-center px-8">
          <MaterialIcons name="search" size={56} color="#bfc9bd" />
          <Text className="text-sm text-on-surface-variant mt-4 text-center leading-relaxed">
            Search friends, groups, and expenses
          </Text>
        </View>
      )}

      {showLoading && (
        <View className="px-6 pt-4 gap-2">
          {[0, 1, 2, 3].map((i) => (
            <SkeletonListRow key={i} />
          ))}
        </View>
      )}

      {showNoResults && (
        <View className="flex-1 items-center justify-center px-8">
          <MaterialIcons name="search-off" size={56} color="#bfc9bd" />
          <Text className="text-sm text-on-surface-variant mt-4 text-center">
            No results for "{query.trim()}"
          </Text>
        </View>
      )}

      {!showPlaceholder && !showLoading && sections.length > 0 && (
        <SectionList
          sections={sections}
          keyExtractor={(row) => `${row.type}-${row.item.id}`}
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 40, paddingTop: 8 }}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => (
            <Text className="font-bold text-sm text-on-surface-variant uppercase tracking-wide mt-5 mb-2">
              {section.title}
            </Text>
          )}
          renderItem={({ item: row, index }) => (
            <AnimatedListItem index={index}>
              {row.type === 'friend' ? (
                <FriendRow friend={row.item} router={router} />
              ) : row.type === 'group' ? (
                <GroupRow group={row.item} router={router} />
              ) : row.type === 'split' ? (
                <SplitRow tx={row.item} router={router} />
              ) : (
                <PersonalRow tx={row.item} router={router} />
              )}
            </AnimatedListItem>
          )}
        />
      )}
    </View>
  );
}

function FriendRow({ friend, router }: { friend: FriendBalance; router: ReturnType<typeof useRouter> }) {
  return (
    <AnimatedPressable
      onPress={() =>
        router.push({
          pathname: `/friend/${friend.id}`,
          params: { friendName: friend.fullName, friendPhone: friend.phoneNumber },
        })
      }
      className="flex-row items-center py-3 border-b border-outline-variant/15"
    >
      <View className="w-12 h-12 rounded-full mr-4">
        <Avatar uri={friend.avatarUrl} initials={friend.initials} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-on-surface">{friend.fullName}</Text>
        <Text className="text-xs text-on-surface-variant mt-0.5">{friend.phoneNumber || 'No phone added'}</Text>
      </View>
    </AnimatedPressable>
  );
}

function GroupRow({ group, router }: { group: GroupResult; router: ReturnType<typeof useRouter> }) {
  const meta = GROUP_CATEGORY_META[group.category] || GROUP_CATEGORY_FALLBACK;
  return (
    <AnimatedPressable
      onPress={() => router.push({ pathname: `/group/${group.id}`, params: { title: group.title, categoryLabel: meta.label } })}
      className="flex-row items-center py-3 border-b border-outline-variant/15"
    >
      <View className={`w-12 h-12 rounded-xl items-center justify-center mr-4 ${meta.bg}`}>
        <MaterialIcons name={meta.icon as any} size={24} color={meta.color} />
      </View>
      <View className="flex-1">
        <Text className="text-base font-semibold text-on-surface">{group.title}</Text>
        <Text className="text-xs text-on-surface-variant mt-0.5">{meta.label}</Text>
      </View>
    </AnimatedPressable>
  );
}

function SplitRow({ tx, router }: { tx: SplitResult; router: ReturnType<typeof useRouter> }) {
  const meta = categoryMeta(tx.category);
  const color = tx.owedToYou ? '#004c22' : '#ba1a1a';
  return (
    <AnimatedPressable
      onPress={() => router.push(`/transaction/${tx.id}`)}
      className="flex-row items-center py-3 border-b border-outline-variant/15"
    >
      <View className="w-12 h-12 rounded-xl items-center justify-center mr-4" style={{ backgroundColor: meta.bg }}>
        <MaterialIcons name={meta.icon as any} size={24} color={meta.color} />
      </View>
      <View className="flex-1 mr-2">
        <Text className="text-base font-semibold text-on-surface" numberOfLines={1}>{tx.description}</Text>
        <View className="flex-row items-center gap-1.5 mt-1">
          <View className="px-1.5 py-0.5 rounded" style={{ backgroundColor: '#DCFCE7' }}>
            <Text className="font-bold" style={{ fontSize: 9, color: '#004c22' }}>SPLIT</Text>
          </View>
        </View>
      </View>
      <Text className="text-sm font-bold" style={{ color }}>
        {tx.owedToYou ? '+' : '-'}{money(tx.amount)}
      </Text>
    </AnimatedPressable>
  );
}

function PersonalRow({ tx, router }: { tx: PersonalTransaction; router: ReturnType<typeof useRouter> }) {
  const meta = categoryMeta(tx.category);
  return (
    <AnimatedPressable
      onPress={() => router.push(`/finance/${tx.id}`)}
      className="flex-row items-center py-3 border-b border-outline-variant/15"
    >
      <View className="w-12 h-12 rounded-xl items-center justify-center mr-4" style={{ backgroundColor: 'rgba(217,119,6,0.14)' }}>
        <MaterialIcons name={meta.icon as any} size={24} color="#d97706" />
      </View>
      <View className="flex-1 mr-2">
        <Text className="text-base font-semibold text-on-surface" numberOfLines={1}>
          {tx.merchant || tx.description || 'Expense'}
        </Text>
        <View className="flex-row items-center gap-1.5 mt-1">
          <View className="px-1.5 py-0.5 rounded" style={{ backgroundColor: 'rgba(217,119,6,0.14)' }}>
            <Text className="font-bold" style={{ fontSize: 9, color: '#d97706' }}>PERSONAL</Text>
          </View>
        </View>
      </View>
      <Text className="text-sm font-bold text-on-surface">{money(tx.amount)}</Text>
    </AnimatedPressable>
  );
}
