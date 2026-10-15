import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, Modal, TextInput } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Avatar } from '../../components/Avatar';
import { Skeleton, SkeletonListRow } from '../../components/Skeleton';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { SwipeableRow } from '../../components/SwipeableRow';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { useGlobalBalances } from '../../context/GlobalBalancesContext';
import { useToast } from '../../components/Toast';
import { useAlert } from '../../components/AppAlert';
import { dispatchPushNotification } from '../../lib/pushDispatcher';
import {
  fetchGroupMembers,
  addGroupMembers,
  removeGroupMember,
  renameGroup,
  GroupMember,
} from '../../lib/groups';
import { getRelatedUsers } from '../../lib/friendFetcher';
import { readCache, writeCache, isLikelyNetworkError } from '../../lib/offlineCache';
import { OfflineBanner } from '../../components/OfflineBanner';

// DB-native category ids, matching the `category` column values this screen
// already maps to labels below — not create.tsx's own UI ids (which get
// translated to these before saving), so no second translation layer here.
const EDIT_CATEGORIES: { id: string; icon: string; label: string }[] = [
  { id: 'trip', icon: 'flight', label: 'Travel' },
  { id: 'food', icon: 'restaurant', label: 'Food' },
  { id: 'home', icon: 'home', label: 'Home' },
  { id: 'other', icon: 'category', label: 'Other' },
];
// The ledger is computed in Postgres now (recalculate_group_settlements); this
// screen only renders what the database stores.
export interface SimplifiedTransfer {
  fromId: string;
  fromName: string;
  fromAvatarUrl?: string;
  toId: string;
  toName: string;
  toAvatarUrl?: string;
  amount: number;
}

interface Transaction {
  id: string;
  description: string;
  totalAmount: number;
  share: number; // Positive = You are owed, Negative = You owe
  paidBy: string;
  paidByUserId: string; // Actual UUID of the payer
  addedBy: string; // 'You' or other names
  time: string;
  icon: string;
  timestamp: number; // Unix Epoch timestamp (ms)
  status?: string;
  /** 'expense' or 'settlement' — settlements are payments, not new charges. */
  type?: string;
}

interface GroupData {
  title: string;
  categoryLabel: string;
  /** Raw DB category id (trip/food/home/other) — categoryLabel is derived from this. */
  category: string;
  memberCount: number;
  totalSpend: number;
  userBalance: number; // Positive = Owed, Negative = Owe, 0 = Settled
  spentByYou: number;
  yourShare: number;
  transactions: Transaction[];
  /** null/undefined = live. An ISO timestamp = this is a cached fallback. */
  cachedAt?: string | null;
}


const ONE_DAY = 24 * 60 * 60 * 1000;


type TimelineFilter = '30days' | '6months' | '1year' | 'all';

export default function GroupDetailScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams();
  const { refreshBalances } = useGlobalBalances();
  const { id } = params; // e.g. 'euro-trip-24'

  const groupId = id as string;

  // Group Details with dynamic updates
  const [groupsData, setGroupsData] = useState<Record<string, GroupData>>({});
  const [timeline, setTimeline] = useState<TimelineFilter>('1year');
  const [isFilterSheetOpen, setIsFilterSheetOpen] = useState(false);

  const [settlements, setSettlements] = useState<SimplifiedTransfer[]>([]);

  // This screen rendered its fallback group object while loading, so an
  // unfinished fetch looked identical to a group with no expenses.
  const [txLoading, setTxLoading] = useState(true);
  // This screen had no error state at all before — a failed fetch left
  // txLoading false and the fallback (empty, ₹0) group object rendered
  // silently, indistinguishable from a group with genuinely nothing in it.
  const [txError, setTxError] = useState<string | null>(null);

  // Gates the header title. Without this, the very first render always used
  // the fallback below — which, absent a route param, derived a "title" by
  // splitting the raw group UUID on hyphens. Now the header shows a skeleton
  // instead of that garbled string until the real row loads.
  const [titleReady, setTitleReady] = useState(!!params.title);
  const [isSettleSheetOpen, setIsSettleSheetOpen] = useState(false);

  // Whether this group settles up by the fewest transfers, or keeps each debt
  // with the person it arose from. The setting belongs to the group rather than
  // the viewer — the two modes disagree about who pays whom, so two members on
  // different settings would settle inconsistently.
  const [simplifyDebts, setSimplifyDebts] = useState(true);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  // Collaborative Permission state machines
  const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
  const [isActionSheetOpen, setIsActionSheetOpen] = useState(false);
  const [isRequestPopupOpen, setIsRequestPopupOpen] = useState(false);

  // Group settings: rename, category, member list, add/remove.
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [isSettingsSheetOpen, setIsSettingsSheetOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editCategory, setEditCategory] = useState('other');
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [removingMemberId, setRemovingMemberId] = useState<string | null>(null);
  const [isAddMembersSheetOpen, setIsAddMembersSheetOpen] = useState(false);
  const [addMemberSearch, setAddMemberSearch] = useState('');
  const [addMemberCandidates, setAddMemberCandidates] = useState<
    { id: string; name: string; avatar: string; initials: string }[]
  >([]);
  const [selectedNewMemberIds, setSelectedNewMemberIds] = useState<string[]>([]);
  const [isAddingMembers, setIsAddingMembers] = useState(false);

  // Own effect rather than folded into fetchLiveGroupData below — this also
  // needs to be callable on its own after an add/remove, without re-running
  // the whole transaction fetch. Doubles as the fix for the header's "• N
  // Members" count, which was a stale route param and never this screen's
  // own live data before.
  const loadMembers = useCallback(async () => {
    const cacheKey = `groupMembers.${groupId}`;
    try {
      const list = await fetchGroupMembers(groupId);
      setMembers(list);
      await writeCache(cacheKey, list);
      setGroupsData(prev => {
        const base = prev[groupId];
        if (!base) return prev;
        return { ...prev, [groupId]: { ...base, memberCount: list.length } };
      });
    } catch (e) {
      console.error('Failed to load group members:', e);
      const cached = isLikelyNetworkError(e) ? await readCache<GroupMember[]>(cacheKey) : null;
      if (cached) {
        setMembers(cached.data);
        setGroupsData(prev => {
          const base = prev[groupId];
          if (!base) return prev;
          return { ...prev, [groupId]: { ...base, memberCount: cached.data.length } };
        });
      }
    }
  }, [groupId]);

  // Load real transactions and simplified settlements from Supabase for this group
  // Uses useFocusEffect so data refreshes when navigating back from settle-up
  useFocusEffect(
    useCallback(() => {
      async function fetchLiveGroupData() {
        try {
          const { supabase } = await import('../../lib/supabase');
          const { data: authData } = await supabase.auth.getUser();
          const currentUserId = authData?.user?.id;
          if (!currentUserId) {
            throw new Error('You appear to be signed out. Sign in again to see this group.');
          }
          setUserId(currentUserId);

          // This screen used to never read its own groups row — the heading
          // came from route params, and navigating here without them (the
          // normal case, from the Groups tab) fell back to deriving a title
          // from the raw UUID, split on hyphens and title-cased. That reads
          // as an id because it is one. Reading the real row fixes it.
          const groupCategoryLabels: Record<string, string> = {
            trip: 'Travel',
            home: 'Home',
            food: 'Food',
          };
          const { data: groupRow } = await supabase
            .from('groups')
            .select('title, category, simplify_debts')
            .eq('id', groupId)
            .maybeSingle();
          if (groupRow) {
            setSimplifyDebts(groupRow.simplify_debts !== false);
            setGroupsData(prev => ({
              ...prev,
              [groupId]: {
                ...(prev[groupId] || group),
                title: groupRow.title,
                category: groupRow.category || 'other',
                categoryLabel: groupCategoryLabels[groupRow.category] || 'Other',
              },
            }));
          }

          // Query transactions for this specific group
          const { data: txs, error } = await supabase
            .from('transactions')
            .select(`
              id,
              amount,
              description,
              category,
              paid_by,
              created_at,
              status,
              type,
              transaction_splits (user_id, share_amount)
            `)
            .eq('group_id', groupId);

          if (error) {
            throw new Error(error.message);
          }

          if (txs) {
            // Collect all payer user IDs so we can resolve names
            const payerIds = new Set<string>();
            for (const t of txs) {
              if (t.paid_by !== currentUserId) payerIds.add(t.paid_by);
            }

            // Fetch payer names in one batch
            let payerNames: Record<string, string> = {};
            if (payerIds.size > 0) {
              const { data: payerProfiles } = await supabase
                .from('users')
                .select('id, full_name')
                .in('id', [...payerIds]);
              if (payerProfiles) {
                for (const p of payerProfiles) {
                  payerNames[p.id] = p.full_name || 'Friend';
                }
              }
            }

            // Format transactions to fit UI structure
            const formatted: Transaction[] = txs.map(t => {
              const isPayerMe = t.paid_by === currentUserId;
              const splits = t.transaction_splits || [];
              
              // Share calculation
              let shareAmt = 0;
              const mySplit = splits.find((s: any) => s.user_id === currentUserId);
              const myShareAmount = mySplit ? Number(mySplit.share_amount) : 0;
              
              if (isPayerMe) {
                const othersSplits = splits.filter((s: any) => s.user_id !== currentUserId);
                shareAmt = othersSplits.reduce((sum: number, s: any) => sum + Number(s.share_amount), 0);
              } else {
                shareAmt = -myShareAmount;
              }

              const categoryIcons: Record<string, string> = {
                'food': 'restaurant',
                'travel': 'flight',
                'home': 'home',
                'other': 'receipt-long'
              };
              const isSettlement = (t as any).type === 'settlement';
              const payerDisplayName = isPayerMe ? 'You' : (payerNames[t.paid_by] || 'Friend');

              return {
                id: t.id,
                description: t.description,
                totalAmount: Number(t.amount),
                share: shareAmt,
                paidBy: payerDisplayName,
                paidByUserId: t.paid_by,
                addedBy: payerDisplayName,
                time: new Date(t.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                icon: isSettlement ? 'payments' : (categoryIcons[t.category] || 'receipt-long'),
                timestamp: new Date(t.created_at).getTime(),
                status: t.status,
                type: (t as any).type || 'expense'
              };
            });

            // Update state
            setGroupsData(prev => {
              const baseGroup = prev[groupId] || group;

              // Spend totals count live expenses only. Voided rows are fetched
              // on purpose — the list renders them struck through — but they
              // must not reach any figure. Settlements are money moving between
              // members rather than new spending, so they are excluded too.
              //
              // The query above has no status filter, and this loop used to
              // have none either: every voided expense stayed in the totals.
              let totalGroupSpend = 0, spentByYou = 0;
              // Newest first — same omission as the friend screen had.
              const allTxs = [...formatted].sort((a, b) => b.timestamp - a.timestamp);

              for (const t of allTxs) {
                if (t.status === 'voided' || t.type === 'settlement') continue;
                totalGroupSpend += t.totalAmount;
                if (t.paidBy === 'You') spentByYou += t.totalAmount;
              }

              return {
                ...prev,
                [groupId]: {
                  ...baseGroup,
                  transactions: allTxs,
                  totalSpend: totalGroupSpend,
                  spentByYou: spentByYou,
                  // userBalance and yourShare are set from the ledger below.
                  // They are deliberately not computed here — see the comment
                  // at the ledger read.
                }
              };
            });
          }

          // Calculate net balances dynamically
          const netBalancesMap: Record<string, number> = {};
          if (txs) {
            for (const tx of txs) {
              const payer = tx.paid_by;
              netBalancesMap[payer] = (netBalancesMap[payer] || 0) + Number(tx.amount);
              for (const split of tx.transaction_splits || []) {
                netBalancesMap[split.user_id] = (netBalancesMap[split.user_id] || 0) - Number(split.share_amount);
              }
            }

            // Also collect user IDs to get names for the simplified settlements
            const userIds = new Set<string>(Object.keys(netBalancesMap));
            let names: Record<string, string> = {};
            if (userIds.size > 0) {
              const { data: usersData } = await supabase
                .from('users')
                .select('id, full_name, avatar_url')
                .in('id', [...userIds]);
              if (usersData) {
                for (const u of usersData) {
                  names[u.id] = u.full_name || 'Friend';
                }
              }
            }

            // Read the settlements the database actually stores, rather than
            // recomputing them here with a second (float-based) algorithm. The
            // ledger is written atomically by recalculate_group_settlements();
            // recomputing locally is what let the screen and the database show
            // different numbers for the same group.
            const { data: ledger, error: ledgerError } = await supabase
              .from('simplified_settlements')
              .select('debtor_id, creditor_id, amount')
              .eq('group_id', groupId);

            if (ledgerError) throw ledgerError;

            // Names for anyone in the ledger but not in the balance map
            const ledgerIds = new Set<string>();
            for (const row of ledger ?? []) {
              ledgerIds.add(row.debtor_id);
              ledgerIds.add(row.creditor_id);
            }
            const missingIds = [...ledgerIds].filter(uid => !(uid in names));
            if (missingIds.length > 0) {
              const { data: extraUsers } = await supabase
                .from('users')
                .select('id, full_name')
                .in('id', missingIds);
              for (const u of extraUsers ?? []) {
                names[u.id] = u.full_name || 'Friend';
              }
            }

            const nameFor = (uid: string) =>
              uid === currentUserId ? 'You' : (names[uid] || 'Friend');

            const dynamicSettlements: SimplifiedTransfer[] = (ledger ?? []).map(row => ({
              fromId: row.debtor_id,
              fromName: nameFor(row.debtor_id),
              toId: row.creditor_id,
              toName: nameFor(row.creditor_id),
              amount: Number(row.amount) || 0,
            }));

            setSettlements(dynamicSettlements);

            // Your position in this group comes from the ledger, and only from
            // the ledger.
            //
            // It used to be re-derived here by summing every transaction row
            // this screen had fetched — with no status filter, so a voided
            // expense stayed in "You are owed" indefinitely while Home and
            // Friends, which read simplified_settlements, showed the corrected
            // figure. The same group, two screens, two numbers. It was also the
            // only balance in the app not coming from the shared engine, which
            // lib/balances.ts explicitly exists to prevent.
            //
            // simplified_settlements is written atomically by the recalculate /
            // admin_rebuild functions and already excludes voided rows, so
            // reading it is both correct and consistent by construction.
            let myGroupBalance = 0;
            for (const row of ledger ?? []) {
              const amt = Number(row.amount) || 0;
              if (row.creditor_id === currentUserId) myGroupBalance += amt;
              else if (row.debtor_id === currentUserId) myGroupBalance -= amt;
            }

            setGroupsData(prev => {
              const baseGroup = prev[groupId];
              if (!baseGroup) return prev;
              return {
                ...prev,
                [groupId]: {
                  ...baseGroup,
                  userBalance: myGroupBalance,
                  yourShare: Math.abs(myGroupBalance),
                }
              };
            });
          }

          // Cache the fully-assembled group (title, spend figures,
          // transactions, balance) now that every stage above has
          // succeeded — read back via a pass-through updater since state
          // set above is applied asynchronously and this needs the merged
          // result, not a stale closure over an earlier partial version.
          setGroupsData(prev => {
            const finalGroup = prev[groupId];
            if (finalGroup) void writeCache(`groupDetail.${groupId}`, { ...finalGroup, cachedAt: null });
            return prev;
          });
          setTxError(null);
        } catch (err: any) {
          console.error('Error loading dynamic group data:', err);
          const cached = isLikelyNetworkError(err)
            ? await readCache<GroupData>(`groupDetail.${groupId}`)
            : null;
          if (cached) {
            setGroupsData(prev => ({
              ...prev,
              [groupId]: { ...cached.data, cachedAt: cached.cachedAt },
            }));
            setTxError(null);
          } else {
            setTxError(err?.message || 'Could not load this group.');
          }
        } finally {
          // In `finally` so a failed load stops showing placeholders — a
          // skeleton that never resolves is worse than an empty state.
          setTxLoading(false);
          setTitleReady(true);
        }
      }

      fetchLiveGroupData();
      loadMembers();
    }, [groupId, loadMembers])
  );

  const { showToast: triggerToast } = useToast();
  const { showAlert } = useAlert();

  // Resolve active group details
  let group = groupsData[groupId];
  if (!group) {
    // No UUID-derived guess here — a wrong-looking name is worse than none.
    // The header renders a skeleton instead of this until titleReady.
    const title = (params.title as string) || '';
    const categoryLabel = (params.categoryLabel as string) || 'Other';
    const memberCount = parseInt(params.memberCount as string || '4');
    group = {
      title,
      categoryLabel,
      category: 'other',
      memberCount,
      totalSpend: 0,
      userBalance: 0,
      spentByYou: 0,
      yourShare: 0,
      transactions: []
    };
  }

  const handleAddExpense = () => {
    // Navigate to expense amount setting pass selected group info
    router.push({
      pathname: '/expense/amount',
      params: {
        groupId: groupId,
        groupName: group.title
      }
    });
  };

  const handleSaveSettings = async () => {
    if (!editTitle.trim()) return;
    setIsSavingSettings(true);
    try {
      await renameGroup({ groupId, title: editTitle.trim(), category: editCategory });
      setGroupsData(prev => {
        const base = prev[groupId] || group;
        const label = EDIT_CATEGORIES.find(c => c.id === editCategory)?.label || 'Other';
        return {
          ...prev,
          [groupId]: { ...base, title: editTitle.trim(), category: editCategory, categoryLabel: label },
        };
      });
      triggerToast('Group updated');
      setIsSettingsSheetOpen(false);
    } catch (e: any) {
      // Plain client write, not a crafted RPC message — could be a raw RLS
      // or constraint error. Log it, don't show it.
      console.error('Failed to rename group:', e?.message);
      triggerToast('Could not update this group. Please try again.');
    } finally {
      setIsSavingSettings(false);
    }
  };

  // Positive = owed to them, negative = they owe, within this group. Read
  // from `settlements` — the same simplified_settlements rows userBalance is
  // computed from above, not a second calculation of it.
  const getMemberNetBalance = (memberId: string): number => {
    let net = 0;
    for (const s of settlements) {
      if (s.toId === memberId) net += s.amount;
      if (s.fromId === memberId) net -= s.amount;
    }
    return net;
  };

  // The database already refuses this (0029's trigger, on the DELETE itself,
  // no matter who asks) — but finding that out only after tapping Remove or
  // Leave, as a raw rejection, isn't a warning. Checking first and saying so
  // upfront is the actual ask; the trigger stays as the real enforcement
  // underneath it, in case the balance changes between this check and the
  // confirm.
  const describeOutstanding = (net: number) =>
    net > 0
      ? `owed ₹${net.toFixed(2)} in this group`
      : `owes ₹${Math.abs(net).toFixed(2)} in this group`;

  const handleRemoveMember = (memberId: string, memberName: string) => {
    const net = getMemberNetBalance(memberId);
    if (Math.abs(net) > 0.005) {
      showAlert(
        'Settle up first',
        `${memberName} is still ${describeOutstanding(net)}. Everyone needs to be settled up with the whole group before they can be removed.`,
        [{ text: 'OK' }]
      );
      return;
    }

    showAlert(
      'Remove member?',
      `Remove ${memberName} from this group?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setRemovingMemberId(memberId);
            try {
              await removeGroupMember({ groupId, memberId });
              await loadMembers();
              triggerToast(`${memberName} removed from the group`);
            } catch (e: any) {
              triggerToast(e?.message || 'Could not remove this member.');
            } finally {
              setRemovingMemberId(null);
            }
          },
        },
      ]
    );
  };

  const handleLeaveGroup = () => {
    if (!userId) return;
    const net = getMemberNetBalance(userId);
    if (Math.abs(net) > 0.005) {
      showAlert(
        'Settle up first',
        `You're still ${describeOutstanding(net)}. Settle up with everyone in the group before you can leave.`,
        [
          { text: 'OK' },
          {
            text: 'Settle Up',
            onPress: () => {
              setIsSettingsSheetOpen(false);
              setIsSettleSheetOpen(true);
            },
          },
        ]
      );
      return;
    }

    showAlert(
      'Leave this group?',
      'You will no longer see this group or its expenses.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            try {
              await removeGroupMember({ groupId, memberId: userId });
              setIsSettingsSheetOpen(false);
              triggerToast('You left the group');
              router.replace('/groups');
            } catch (e: any) {
              triggerToast(e?.message || 'Could not leave this group.');
            }
          },
        },
      ]
    );
  };

  const loadAddMemberCandidates = useCallback(async () => {
    try {
      const users = await getRelatedUsers(userId || '', 'id, full_name, avatar_url');
      const existingIds = new Set(members.map(m => m.userId));
      setAddMemberCandidates(
        (users || [])
          .filter((u: any) => !existingIds.has(u.id))
          .map((u: any) => ({
            id: u.id,
            name: u.full_name || 'User',
            avatar: u.avatar_url || '',
            initials: (u.full_name || 'U').split(' ').map((n: string) => n.charAt(0)).join('').toUpperCase().slice(0, 2),
          }))
      );
    } catch (e) {
      console.error('Failed to load contacts for group:', e);
    }
  }, [userId, members]);

  const handleToggleNewMember = (id: string) => {
    setSelectedNewMemberIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  };

  const handleConfirmAddMembers = async () => {
    if (selectedNewMemberIds.length === 0) return;
    setIsAddingMembers(true);
    try {
      await addGroupMembers({ groupId, memberIds: selectedNewMemberIds });
      await loadMembers();
      triggerToast(
        selectedNewMemberIds.length === 1 ? 'Member added' : `${selectedNewMemberIds.length} members added`
      );
      setSelectedNewMemberIds([]);
      setAddMemberSearch('');
      setIsAddMembersSheetOpen(false);
    } catch (e: any) {
      // Same reasoning as renameGroup above — plain client write, log raw,
      // show generic.
      console.error('Failed to add members:', e?.message);
      triggerToast('Could not add members. Please try again.');
    } finally {
      setIsAddingMembers(false);
    }
  };

  // Stateful timeline calculations
  const getFilteredTransactions = () => {
    const NOW = Date.now();
    const limit = {
      '30days': 30 * ONE_DAY,
      '6months': 180 * ONE_DAY,
      '1year': 365 * ONE_DAY,
      'all': Infinity
    }[timeline];

    return group.transactions.filter(t => {
      const elapsed = NOW - t.timestamp;
      return elapsed <= limit;
    });
  };

  const handleTxPress = (tx: Transaction) => {
    setSelectedTx(tx);
    setIsActionSheetOpen(true);
  };

  const handleDeleteTx = async (txOverride?: Transaction) => {
    const tx = txOverride ?? selectedTx;
    setIsActionSheetOpen(false);
    if (!tx) return;

    try {
      const { supabase } = await import('../../lib/supabase');
      const { data: authData } = await supabase.auth.getUser();
      const userId = authData?.user?.id;

      // Real auth check - creator path vs non-creator path
      // Note: Because we use mocked transactions, we fall back to 'You' check if userId isn't available
      const isCreator = userId ? userId === tx.paidByUserId : tx.addedBy === 'You';

      if (isCreator) {
        // Creator Path
        if (userId) {
          // One call: status change and group ledger rebuild in a single
          // database transaction. Previously an update() followed by a separate
          // recalculateGroupSettlements(), where a failure of the second was
          // logged and swallowed — leaving the expense voided, the ledger
          // stale, and the user told it had worked.
          // See migrations/0015_void_transaction.sql.
          const { voidTransaction } = await import('../../lib/recalculateSettlements');
          const voidError = await voidTransaction(tx.id);

          if (voidError) {
            console.error('Void transaction error:', voidError.message);
            triggerToast('Could not void this expense. Please try again.');
            return;
          }

          await refreshBalances();
        }

        // Local state UI update
        const updatedTxs = group.transactions.map(t =>
          t.id === tx.id ? { ...t, status: 'voided' } : t
        );

        // Spend totals, live rows only.
        let totalGroupSpend = 0, spentByYou = 0;
        for (const t of updatedTxs) {
          if (t.status === 'voided' || t.type === 'settlement') continue;
          totalGroupSpend += t.totalAmount;
          if (t.paidBy === 'You') spentByYou += t.totalAmount;
        }

        // Re-read the position from the ledger that void_transaction just
        // rebuilt, rather than re-deriving it here. What stood here divided
        // each expense by memberCount — a naive equal split that ignored the
        // actual transaction_splits entirely, so any unequal or partial split
        // produced a wrong figure the moment anything was voided. It was a
        // third independent balance implementation in a codebase that is
        // supposed to have one.
        let myGroupBalance = group.userBalance;
        try {
          const { data: ledgerRows } = await supabase
            .from('simplified_settlements')
            .select('debtor_id, creditor_id, amount')
            .eq('group_id', groupId);

          myGroupBalance = 0;
          for (const row of ledgerRows ?? []) {
            const amt = Number(row.amount) || 0;
            if (row.creditor_id === userId) myGroupBalance += amt;
            else if (row.debtor_id === userId) myGroupBalance -= amt;
          }
        } catch (ledgerErr) {
          console.warn('Could not re-read group ledger after void:', ledgerErr);
        }

        setGroupsData(prev => ({
          ...prev,
          [groupId]: {
            ...group,
            transactions: updatedTxs,
            totalSpend: totalGroupSpend,
            userBalance: myGroupBalance,
            spentByYou: spentByYou,
            yourShare: Math.abs(myGroupBalance)
          }
        }));

        triggerToast('Expense voided successfully!');

        // Trigger P-6: Send Notification to group members about deletion
        const { data: members } = await supabase.from('group_members').select('user_id').eq('group_id', groupId);
        const memberIds = (members || []).map(m => m.user_id).filter(id => id !== userId);
        
        if (memberIds.length > 0) {
          dispatchPushNotification(
            memberIds,
            'Expense Deleted',
            `${authData?.user?.user_metadata?.full_name || 'Someone'} deleted the expense: ${tx.description}.`
          );
        }

      } else {
        // Non-Creator Path (Intercept). If this was triggered from a swipe
        // (tx passed explicitly, not from the tap-driven Actions Sheet),
        // selectedTx won't be populated yet — the request popup and
        // handleSendRequest below both read it for display/notification.
        if (tx !== selectedTx) setSelectedTx(tx);
        setIsRequestPopupOpen(true);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSendRequest = async () => {
    setIsRequestPopupOpen(false);
    triggerToast(`Request sent to ${selectedTx?.addedBy}!`);

    // Trigger P-6: Notify Creator
    try {
      if (selectedTx?.paidByUserId) {
        dispatchPushNotification(
          [selectedTx.paidByUserId],
          'Deletion Request 🗑️',
          `Someone requested to delete: ${selectedTx.description}. Tap to approve.`,
          { action: 'approve_delete' }
        );
      }
    } catch (e) {
      console.log('Error pushing to creator', e);
    }
  };

  const filteredTxs = getFilteredTransactions();

  return (
    <View className="flex-1 bg-background">
      {/* Top App Bar */}
      <View 
        className="px-5 pb-4 flex-row justify-between items-center z-50 border-b border-white/35 shadow-sm"
        style={{ 
          paddingTop: Math.max(insets.top, 24),
          backgroundColor: 'rgba(252, 249, 244, 0.72)' 
        }}
      >
        <View className="flex-row items-center gap-4">
          <AnimatedPressable 
            onPress={() => router.back()}
            className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
          >
            <MaterialIcons name="arrow-back" size={24} color="#004c22" />
          </AnimatedPressable>
          <Text className="font-headline-md font-bold text-primary text-xl">Kinlo</Text>
        </View>
        <View className="flex-row items-center gap-4">
          {titleReady
            ? <Text className="hidden md:flex font-label-md text-on-surface-variant">{group.title}</Text>
            : <View className="hidden md:flex"><Skeleton width={90} height={13} /></View>}
          <AnimatedPressable
            onPress={() => {
              setEditTitle(group.title);
              setEditCategory(group.category || 'other');
              setIsSettingsSheetOpen(true);
            }}
            className="w-10 h-10 rounded-full border border-outline-variant bg-surface-container items-center justify-center active:bg-surface-container-high"
            accessibilityLabel="Group settings"
          >
            <MaterialIcons name="settings" size={20} color="#004c22" />
          </AnimatedPressable>
        </View>
      </View>

      <OfflineBanner cachedAt={group.cachedAt} />
      {txError && !txLoading && !group.cachedAt && (
        <View className="mx-6 mt-2 mb-1 px-3 py-2 rounded-xl bg-error-container">
          <Text className="text-xs font-medium text-error">{txError}</Text>
        </View>
      )}

      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 120 }}>
        <View className="px-5 pt-8 max-w-7xl mx-auto w-full">
          
          {/* Header Section */}
          <View className="mb-8 flex-col md:flex-row md:items-end justify-between">
            <View>
              <View className="flex-row items-center gap-2 mb-2">
                <View className="bg-secondary-container px-3 py-1 rounded-full">
                  <Text className="text-on-secondary-container font-label-sm text-xs">{group.categoryLabel}</Text>
                </View>
                <Text className="text-on-surface-variant font-label-sm text-xs opacity-60">• {group.memberCount} Members</Text>
              </View>
              {titleReady
                ? <Text className="font-headline-lg-mobile text-3xl text-on-background mb-1 font-bold">{group.title}</Text>
                : <Skeleton width={160} height={28} radius={6} style={{ marginBottom: 4 }} />}
              <Text className="font-body-md text-on-surface-variant">
                Total Group Spend: ₹{group.totalSpend.toFixed(2)}
              </Text>
            </View>
            <AnimatedPressable 
              onPress={handleAddExpense}
              className="hidden md:flex flex-row items-center bg-primary px-6 py-3 rounded-2xl gap-2 mt-4 md:mt-0"
            >
              <MaterialIcons name="add" size={20} color="white" />
              <Text className="text-white font-label-md font-semibold text-base">Add Expense</Text>
            </AnimatedPressable>
          </View>

          {/* Balance Card - Liquid Glass */}
          <View 
            className="p-8 rounded-3xl mb-8 overflow-hidden"
            style={{
              // Opaque, not translucent — a semi-transparent background
              // paired with Android's `elevation` is a known rendering bug
              // there (elevation's shadow/outline math assumes an opaque
              // background). Same color, precomputed opaque over this app's
              // #fcf9f4 page background.
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
            <View className="absolute -top-24 -right-24 w-64 h-64 bg-primary/10 rounded-full blur-3xl" />
            <View className="flex-col md:flex-row justify-between md:items-center gap-6 md:gap-0 z-10">
              <View className="items-center md:items-start">
                <Text className="font-label-md text-sm text-on-surface-variant uppercase tracking-wider mb-2">Your Balance</Text>
                <Text className={`font-display-lg text-5xl font-bold mb-4 ${
                  group.userBalance > 0 ? 'text-primary' : group.userBalance < 0 ? 'text-error' : 'text-on-surface-variant'
                }`}>
                  {group.userBalance > 0 ? `+₹${group.userBalance.toFixed(2)}` : group.userBalance < 0 ? `-₹${Math.abs(group.userBalance).toFixed(2)}` : 'Settled'}
                </Text>
                <View className="flex-row items-center gap-2">
                  <View className={`flex-row items-center gap-2 px-4 py-2 rounded-xl ${
                    group.userBalance > 0 ? 'bg-[#DCFCE7]' : group.userBalance < 0 ? 'bg-error-container' : 'bg-surface-container-high'
                  }`}>
                    <MaterialIcons 
                      name={group.userBalance > 0 ? "check-circle" : group.userBalance < 0 ? "info" : "account-balance"} 
                      size={18} 
                      color={group.userBalance > 0 ? "#004c22" : group.userBalance < 0 ? "#ba1a1a" : "#707a6f"} 
                    />
                    <Text className={`font-label-md font-semibold text-sm ${
                      group.userBalance > 0 ? 'text-primary' : group.userBalance < 0 ? 'text-error' : 'text-on-surface-variant'
                    }`}>
                      {group.userBalance > 0 ? 'You are owed' : group.userBalance < 0 ? 'You owe' : 'Group settled'}
                    </Text>
                  </View>
                  
                  {group.userBalance !== 0 && (
                    <AnimatedPressable 
                      onPress={() => setIsSettleSheetOpen(true)}
                      className="bg-primary px-4 py-2 rounded-xl active:scale-95 duration-100 flex-row items-center gap-1"
                      style={{ marginLeft: 12 }}
                    >
                      <MaterialIcons name="payments" size={16} color="white" />
                      <Text className="text-white font-semibold text-sm">Settle Up</Text>
                    </AnimatedPressable>
                  )}
                </View>
              </View>

              <View className="flex-row gap-4">
                <View className="bg-surface/50 p-4 rounded-2xl border border-white/40 flex-1 md:flex-none">
                  <View className="flex-row items-center gap-1 mb-1">
                    <Text className="font-label-sm text-xs text-on-surface-variant">Spent by you</Text>
                    <AnimatedPressable
                      onPress={() => showAlert(
                        'Spent by you',
                        "Only counts expenses you added and paid for. Settle Up payments aren't included here since they clear an existing balance rather than add a new expense.",
                        [{ text: 'Got it' }]
                      )}
                      hitSlop={8}
                    >
                      <MaterialIcons name="info-outline" size={14} color="#707a6f" />
                    </AnimatedPressable>
                  </View>
                  <Text className="font-headline-md text-xl font-bold text-on-background">
                    ₹{group.spentByYou.toFixed(2)}
                  </Text>
                </View>
                <View className="bg-surface/50 p-4 rounded-2xl border border-white/40 flex-1 md:flex-none">
                  <Text className="font-label-sm text-xs text-on-surface-variant mb-1">Your share</Text>
                  <Text className="font-headline-md text-xl font-bold text-on-background">
                    ₹{group.yourShare.toFixed(2)}
                  </Text>
                </View>
              </View>
            </View>
          </View>

          {/* Transactions List */}
          <View>
            <View className="flex-row justify-between items-center mb-6">
              <Text className="font-headline-md text-2xl font-semibold">Recent Transactions</Text>
              
              {/* Timeline filter trigger badge dropdown */}
              <AnimatedPressable 
                onPress={() => setIsFilterSheetOpen(true)}
                className="flex-row items-center gap-1 bg-surface-container-high px-3 py-1.5 rounded-full border border-outline-variant/30 active:scale-95"
              >
                <MaterialIcons name="calendar-today" size={12} color="#004c22" />
                <Text className="text-primary text-[10px] font-bold uppercase tracking-wider pl-1">
                  {timeline === '30days' ? '30 Days' : timeline === '6months' ? '6 Months' : timeline === '1year' ? '1 Year' : 'All Time'}
                </Text>
                <MaterialIcons name="keyboard-arrow-down" size={14} color="#004c22" />
              </AnimatedPressable>
            </View>

            {txLoading && filteredTxs.length === 0 ? (
              [0, 1, 2, 3].map(i => (
                <View
                  key={`skeleton-${i}`}
                  className="p-5 rounded-2xl"
                  style={{
                    backgroundColor: 'rgba(255,255,255,0.72)',
                    borderWidth: 1,
                    borderColor: 'rgba(0,0,0,0.05)',
                    marginBottom: 12,
                  }}
                >
                  <SkeletonListRow avatarSize={48} />
                </View>
              ))
            ) : filteredTxs.length === 0 ? (
              // Empty State for newly created groups
              <View className="p-8 items-center bg-white/40 border border-dashed border-outline-variant/60 rounded-3xl">
                <View className="w-12 h-12 rounded-full bg-secondary-container items-center justify-center mb-3">
                  <MaterialIcons name="receipt-long" size={24} color="#004c22" />
                </View>
                <Text className="font-semibold text-on-surface text-base mb-1">No expenses yet</Text>
                <Text className="text-sm text-on-surface-variant/80 text-center max-w-[240px]">
                  Tap the + button to add your first shared expense to this circle.
                </Text>
              </View>
            ) : (
              <View className="gap-4">
                {filteredTxs.map((tx, txIndex) => {
                  const isVoided = tx.status === 'voided';
                  const isSettlementRow = tx.type === 'settlement';
                  // A settlement is money changing hands, not a new charge.
                  // Describing it as "you are owed" / "you owe" made settling
                  // look like it had created another debt.
                  const shareText = isVoided
                    ? 'Voided'
                    : isSettlementRow
                      ? 'Settled up'
                      : (tx.share > 0 ? `You are owed ₹${tx.share.toFixed(2)}` : tx.share < 0 ? `You owe ₹${Math.abs(tx.share).toFixed(2)}` : 'Settled');
                  const isYouPaid = tx.paidBy === 'You';
                  
                  return (
                    <AnimatedListItem index={txIndex} key={tx.id}>
                    <SwipeableRow
                      onDelete={() => handleDeleteTx(tx)}
                      disabled={isVoided}
                      confirmTitle="Void this expense?"
                      // Deliberately covers both outcomes: handleDeleteTx only
                      // voids when you added the expense, and otherwise sends a
                      // request to whoever did. Promising "balances update, this
                      // cannot be undone" would be false on that second path.
                      confirmMessage="If you added this, it will be voided and balances updated for everyone. If someone else did, they'll be asked to approve."
                      confirmLabel="Continue"
                    >
                    <AnimatedPressable
                      onPress={() => !isVoided && handleTxPress(tx)}
                      className={`p-5 rounded-2xl flex-row items-center justify-between ${isVoided ? 'opacity-50' : ''}`}
                      style={{
                        backgroundColor: '#fefdfc',
                        borderWidth: 1,
                        borderColor: 'rgba(255, 255, 255, 0.35)',
                        shadowColor: '#1c1917',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.04,
                        shadowRadius: 8,
                        elevation: 1,
                        marginBottom: 16
                      }}
                    >
                      <View className="flex-row items-center gap-4 flex-1">
                        <View className={`w-12 h-12 bg-surface-container rounded-xl items-center justify-center ${isVoided ? 'bg-outline-variant/30' : ''}`}>
                          <MaterialIcons name={tx.icon as any} size={24} color={isVoided ? "#9ca3af" : "#004c22"} />
                        </View>
                        <View className="flex-1 mr-2">
                          <Text className={`font-body-md font-semibold text-base ${isVoided ? 'text-outline line-through' : 'text-on-background'}`} numberOfLines={1}>
                            {isSettlementRow
                              ? (isYouPaid ? 'You made a payment' : `${tx.paidBy.split(' ')[0]} made a payment`)
                              : tx.description}
                          </Text>
                          <Text className="font-label-sm text-xs text-on-surface-variant mt-1" numberOfLines={1}>
                            {isSettlementRow ? `Payment • ${tx.time}` : `${tx.time} • Paid by ${tx.paidBy}`}
                            {!isSettlementRow && tx.status === 'settled' && ' • '}
                            {!isSettlementRow && tx.status === 'settled' && (
                              <Text className="text-primary font-bold">Settled</Text>
                            )}
                            {isVoided && ' • '}
                            {isVoided && (
                              <Text className="text-error font-bold tracking-tight">Voided by {tx.addedBy}</Text>
                            )}
                          </Text>
                        </View>
                      </View>
                      <View className="items-end justify-center">
                        <Text className={`font-body-md font-bold text-base ${
                          isVoided ? 'text-outline' : (isSettlementRow ? 'text-on-background' : tx.share > 0 ? 'text-primary' : tx.share < 0 ? 'text-error' : 'text-on-background')
                        }`}>₹{tx.totalAmount.toFixed(2)}</Text>
                        <Text className={`font-label-sm text-xs mt-1 font-semibold ${
                          isVoided ? 'text-outline' : (isSettlementRow ? 'text-primary' : tx.share > 0 ? 'text-primary' : tx.share < 0 ? 'text-error' : 'text-on-surface-variant')
                        }`}>
                          {shareText}
                        </Text>
                      </View>
                    </AnimatedPressable>
                    </SwipeableRow>
                    </AnimatedListItem>
                  );
                })}
              </View>
            )}
          </View>

        </View>
      </ScrollView>

      {/* Floating Action Button (Mobile) */}
      <AnimatedPressable 
        onPress={handleAddExpense}
        className="md:hidden absolute bottom-6 right-6 w-16 h-16 rounded-full bg-primary items-center justify-center shadow-lg z-30 active:scale-95 duration-100"
      >
        <MaterialIcons name="add" size={32} color="white" />
      </AnimatedPressable>

      {/* 1. Timeline Filter Sheet Bottom Modal */}
      <Modal
        visible={isFilterSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsFilterSheetOpen(false)}
      >
        <AnimatedPressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setIsFilterSheetOpen(false)}
        >
          <View 
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
          >
            {/* Top drag indicator */}
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />

            <Text className="font-headline text-lg font-bold text-on-surface mb-2">Timeline Filter</Text>
            <Text className="text-sm text-on-surface-variant mb-6">Select a period to filter circle transactions</Text>

            <View className="gap-3">
              {([
                { key: '30days', label: 'Past 30 Days' },
                { key: '6months', label: 'Past 6 Months' },
                { key: '1year', label: 'Past 1 Year (Default)' },
                { key: 'all', label: 'All Time' }
              ] as const).map((opt) => {
                const isActive = timeline === opt.key;
                return (
                  <AnimatedPressable
                    key={opt.key}
                    onPress={() => {
                      setTimeline(opt.key);
                      setIsFilterSheetOpen(false);
                    }}
                    className="p-4 rounded-2xl flex-row justify-between items-center"
                    style={{
                      backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255,255,255,0.6)',
                      borderWidth: 1,
                      borderColor: isActive ? '#004c22' : 'rgba(255, 255, 255, 0.35)',
                      marginBottom: 10
                    }}
                  >
                    <Text className={`font-semibold text-base ${isActive ? 'text-primary' : 'text-on-surface'}`}>
                      {opt.label}
                    </Text>
                    {isActive && <MaterialIcons name="check-circle" size={20} color="#004c22" />}
                  </AnimatedPressable>
                );
              })}
            </View>
          </View>
        </AnimatedPressable>
      </Modal>

      {/* 2. Collaborative Actions Sheet (Edit / Delete) */}
      <Modal
        visible={isActionSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsActionSheetOpen(false)}
      >
        <AnimatedPressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setIsActionSheetOpen(false)}
        >
          <View 
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
          >
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />

            {selectedTx && (
              <View className="mb-6 items-center">
                <Text className="font-headline text-lg font-bold text-on-surface text-center px-4">{selectedTx.description}</Text>
                <Text className="text-sm text-on-surface-variant mt-1">
                  Added by {selectedTx.addedBy === 'You' ? 'You' : selectedTx.addedBy}
                </Text>
              </View>
            )}

            <View className="gap-4">
              {/* Every participant and their share, with a settle action each.
                  In a group where you paid, the old flow could not name a
                  single counterparty and just showed a toast pointing
                  elsewhere; this replaces that dead end. */}
              {selectedTx && (
                <AnimatedPressable
                  onPress={() => {
                    setIsActionSheetOpen(false);
                    router.push({ pathname: `/transaction/${selectedTx.id}` });
                  }}
                  className="w-full h-14 rounded-2xl flex-row items-center px-4"
                  style={{ backgroundColor: 'rgba(0,0,0,0.05)', marginBottom: 10 }}
                >
                  <MaterialIcons name="receipt-long" size={22} color="#004c22" />
                  <Text className="text-primary font-semibold text-base" style={{ marginLeft: 10 }}>
                    View full expense
                  </Text>
                </AnimatedPressable>
              )}

              {/* There is deliberately no "Settle this Expense" button here.
                  A group expense has no single counterparty, so this sheet
                  cannot ask the right question, and the button that used to sit
                  here got the answer wrong three ways:

                    * it was gated on `status !== 'settled'` — one flag for the
                      whole row, so settling with one member hid the button for
                      everyone else who still owed;
                    * it offered `Math.abs(selectedTx.share)`, which when you
                      are the payer is what *everyone* owes you — on a five-way
                      expense it proposed settling four people's shares against
                      one person;
                    * and whenever you were the payer it could not name a
                      counterparty at all, so it dead-ended on a toast telling
                      you to go somewhere else.

                  Two correct paths already exist and cover every case:
                    · "View full expense" above — per participant, clamped to
                      what each actually still owes within this group's ledger;
                    · "Settle Up" on the balance card — the simplified
                      transfers, for clearing a whole position at once. */}

              <AnimatedPressable
                onPress={() => {
                  setIsActionSheetOpen(false);
                  if (selectedTx) {
                    router.push({
                      pathname: '/expense/amount',
                      params: { editTxId: selectedTx.id }
                    });
                  }
                }}
                className="w-full h-14 bg-white/70 border border-outline-variant/30 rounded-2xl flex-row items-center px-4"
                style={{ marginBottom: 10 }}
              >
                <MaterialIcons name="edit" size={22} color="#004c22" />
                <Text className="text-on-surface font-semibold text-base pl-3" style={{ marginLeft: 8 }}>
                  Edit Expense
                </Text>
              </AnimatedPressable>

              <AnimatedPressable
                onPress={() => handleDeleteTx()}
                className="w-full h-14 bg-[#FEE2E2] rounded-2xl flex-row items-center px-4"
              >
                <MaterialIcons name="delete" size={22} color="#DC2626" />
                <Text className="text-error font-semibold text-base pl-3" style={{ marginLeft: 8 }}>
                  Delete Transaction
                </Text>
              </AnimatedPressable>
            </View>
          </View>
        </AnimatedPressable>
      </Modal>

      {/* Group Settle Up Bottom Sheet Modal */}
      <Modal
        visible={isSettleSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsSettleSheetOpen(false)}
      >
        <AnimatedPressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setIsSettleSheetOpen(false)}
        >
          <View 
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)' }}
          >
            {/* Top drag indicator */}
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />

            <Text className="font-headline text-lg font-bold text-on-surface mb-2">Group Settlements</Text>
            <Text className="text-sm text-on-surface-variant mb-4">Select a settlement to record payment</Text>

            {/* How this group settles up (§17.2). Changing it rebuilds the
                group ledger, so the list below and everyone else's balances
                update together — which is why the setting belongs to the group
                rather than to whoever happens to be looking. */}
            <View
              className="flex-row rounded-2xl mb-2"
              style={{ padding: 4, backgroundColor: 'rgba(0,0,0,0.04)' }}
            >
              {([
                { simplify: true, label: 'Fewest payments' },
                { simplify: false, label: 'Pay who you owe' },
              ]).map(mode => {
                const isActive = simplifyDebts === mode.simplify;
                return (
                  <AnimatedPressable
                    key={String(mode.simplify)}
                    disabled={switchingMode || isActive}
                    onPress={async () => {
                      setSwitchingMode(true);
                      const { setGroupSimplification } = await import('../../lib/recalculateSettlements');
                      const err = await setGroupSimplification(groupId, mode.simplify);
                      setSwitchingMode(false);
                      if (err) {
                        triggerToast(err.message || 'Could not change how this group settles up.');
                        return;
                      }
                      setSimplifyDebts(mode.simplify);
                      await refreshBalances();
                      setIsSettleSheetOpen(false);
                      triggerToast(mode.simplify
                        ? 'Now settling with the fewest payments.'
                        : 'Now settling directly with each person.');
                    }}
                    style={{
                      flex: 1,
                      paddingVertical: 10,
                      borderRadius: 14,
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: isActive ? '#004c22' : 'transparent',
                      opacity: switchingMode ? 0.6 : 1,
                    }}
                  >
                    <Text style={{
                      fontSize: 13,
                      fontWeight: isActive ? '700' : '500',
                      color: isActive ? '#ffffff' : '#404940',
                    }}>
                      {mode.label}
                    </Text>
                  </AnimatedPressable>
                );
              })}
            </View>

            <Text className="text-xs text-on-surface-variant mb-6 leading-relaxed">
              {simplifyDebts
                ? 'Debts are combined so the group settles in as few payments as possible. You may be asked to pay someone you did not buy anything from.'
                : 'Each debt stays with the person it came from. More payments, but every one matches an actual expense.'}
              {' This applies to everyone in the group.'}
            </Text>

            <ScrollView className="max-h-[300px]" contentContainerStyle={{ paddingBottom: 24 }}>
              {settlements.length === 0 ? (
                <Text className="text-on-surface-variant text-center py-6">No pending settlements found in this group.</Text>
              ) : (
                settlements.map((s, index) => {
                  const isYouPaying = s.fromName === 'You';
                  
                  return (
                    <AnimatedListItem key={`settle-${index}`} index={index}>
                    <AnimatedPressable
                      onPress={() => {
                        setIsSettleSheetOpen(false);
                        router.push({
                          pathname: '/settle-up',
                          params: {
                            friendId: isYouPaying ? s.toId : s.fromId,
                            friendName: isYouPaying ? s.toName : s.fromName,
                            balance: s.amount.toFixed(2),
                            status: isYouPaying ? 'owes' : 'owed',
                            groupId: groupId,
                            groupName: group.title
                          }
                        });
                      }}
                      className="p-4 rounded-2xl flex-row justify-between items-center bg-white border border-outline-variant/20 mb-3"
                      style={{
                        shadowColor: '#1c1917',
                        shadowOffset: { width: 0, height: 2 },
                        shadowOpacity: 0.04,
                        shadowRadius: 8,
                        elevation: 1,
                      }}
                    >
                      <View className="flex-row items-center gap-3">
                        <MaterialIcons 
                          name={isYouPaying ? "arrow-upward" : "arrow-downward"} 
                          size={20} 
                          color={isYouPaying ? "#ba1a1a" : "#004c22"} 
                        />
                        <View>
                          <Text className="font-semibold text-on-surface text-base">
                            {isYouPaying ? `Pay ${s.toName}` : `${s.fromName} pays You`}
                          </Text>
                          <Text className="text-xs text-on-surface-variant">
                            {isYouPaying ? 'Record your payment' : 'Record payment received'}
                          </Text>
                        </View>
                      </View>
                      <Text className={`font-bold text-lg ${isYouPaying ? 'text-error' : 'text-primary'}`}>
                        ₹{s.amount.toFixed(2)}
                      </Text>
                    </AnimatedPressable>
                    </AnimatedListItem>
                  );
                })
              )}
            </ScrollView>
          </View>
        </AnimatedPressable>
      </Modal>

      {/* 3. Intercept Collaborative Permissions (Edit/Delete Request Popup) */}
      <Modal
        visible={isRequestPopupOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsRequestPopupOpen(false)}
      >
        <View className="flex-1 bg-black/40 justify-center items-center px-6">
          <View 
            className="w-full max-w-sm rounded-3xl p-6"
            style={{
              backgroundColor: '#fcf9f4',
              borderWidth: 1,
              borderColor: 'rgba(255, 255, 255, 0.4)',
              elevation: 4
            }}
          >
            <View className="w-12 h-12 bg-error-container/40 rounded-full items-center justify-center self-center mb-4">
              <MaterialIcons name="lock-outline" size={24} color="#BA1A1A" />
            </View>

            <Text className="font-headline text-lg font-bold text-on-surface text-center mb-2">Request Permission?</Text>
            <Text className="text-sm text-on-surface-variant text-center leading-relaxed mb-6">
              Only <Text className="font-bold">{selectedTx?.addedBy}</Text> can modify this expense directly since they recorded it. Would you like to send a deletion request to {selectedTx?.addedBy.split(' ')[0]}?
            </Text>

            <View className="flex-row gap-3">
              <AnimatedPressable 
                onPress={() => setIsRequestPopupOpen(false)}
                className="flex-1 h-12 rounded-xl border border-outline-variant items-center justify-center active:scale-95 bg-white/40"
              >
                <Text className="text-on-surface-variant font-semibold text-sm">Cancel</Text>
              </AnimatedPressable>
              <AnimatedPressable 
                onPress={handleSendRequest}
                className="flex-1 h-12 bg-primary rounded-xl items-center justify-center active:scale-95 shadow-sm"
              >
                <Text className="text-white font-semibold text-sm">Send Request</Text>
              </AnimatedPressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* Group Settings — rename, category, member list, add/remove, leave.
          Any member can do all of this, not just whoever created the group;
          the one exception (removing someone with a non-zero balance in this
          group) is enforced by the database, not by anything checked here. */}
      <Modal
        visible={isSettingsSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsSettingsSheetOpen(false)}
      >
        <AnimatedPressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setIsSettingsSheetOpen(false)}
        >
          <View
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)', maxHeight: '85%' }}
          >
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />
            <Text className="font-headline text-lg font-bold text-on-surface mb-4">Group Settings</Text>

            <ScrollView showsVerticalScrollIndicator={false}>
              <Text className="font-label-sm text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">
                Group Name
              </Text>
              <TextInput
                value={editTitle}
                onChangeText={setEditTitle}
                placeholder="Group name"
                placeholderTextColor="rgba(64, 73, 64, 0.4)"
                className="w-full bg-white/70 border border-outline-variant/30 rounded-2xl px-4 py-3 font-body text-base text-on-surface mb-5"
              />

              <Text className="font-label-sm text-xs font-semibold text-on-surface-variant uppercase tracking-wider mb-2">
                Category
              </Text>
              <View className="flex-row flex-wrap gap-2 mb-5">
                {EDIT_CATEGORIES.map(cat => {
                  const isActive = editCategory === cat.id;
                  return (
                    <AnimatedPressable
                      key={cat.id}
                      onPress={() => setEditCategory(cat.id)}
                      className={`flex-row items-center h-11 px-4 rounded-full border ${
                        isActive ? 'bg-[#DCFCE7] border-primary/30' : 'bg-white/40 border-outline-variant/30'
                      }`}
                    >
                      <MaterialIcons name={cat.icon as any} size={18} color={isActive ? '#004c22' : '#404940'} />
                      <Text className={`font-semibold text-sm ml-2 ${isActive ? 'text-primary' : 'text-on-surface-variant'}`}>
                        {cat.label}
                      </Text>
                    </AnimatedPressable>
                  );
                })}
              </View>

              <AnimatedPressable
                onPress={handleSaveSettings}
                disabled={isSavingSettings || !editTitle.trim()}
                className="w-full h-12 bg-primary rounded-2xl items-center justify-center mb-6"
                style={{ opacity: isSavingSettings || !editTitle.trim() ? 0.6 : 1 }}
              >
                <Text className="text-white font-semibold text-sm">
                  {isSavingSettings ? 'Saving…' : 'Save Changes'}
                </Text>
              </AnimatedPressable>

              <View className="flex-row items-center justify-between mb-3">
                <Text className="font-label-sm text-xs font-semibold text-on-surface-variant uppercase tracking-wider">
                  Members ({members.length})
                </Text>
                <AnimatedPressable
                  onPress={() => {
                    loadAddMemberCandidates();
                    setIsAddMembersSheetOpen(true);
                  }}
                  className="flex-row items-center"
                >
                  <MaterialIcons name="person-add" size={16} color="#004c22" />
                  <Text className="text-primary font-semibold text-xs ml-1">Add</Text>
                </AnimatedPressable>
              </View>

              <View className="gap-2 mb-6">
                {members.map((m, index) => (
                  <AnimatedListItem key={m.userId} index={index}>
                  <View
                    className="flex-row items-center justify-between p-3 bg-white/50 border border-outline-variant/20 rounded-2xl"
                  >
                    <View className="flex-row items-center gap-3 flex-1">
                      <Avatar
                        uri={m.avatarUrl}
                        initials={(m.fullName || '?').charAt(0).toUpperCase()}
                        size={36}
                        textClassName="text-primary font-bold text-xs"
                      />
                      <Text className="font-semibold text-on-surface text-sm flex-1" numberOfLines={1}>
                        {m.fullName}{m.userId === userId ? ' (You)' : ''}
                      </Text>
                    </View>
                    {m.userId !== userId && (
                      <AnimatedPressable
                        onPress={() => handleRemoveMember(m.userId, m.fullName)}
                        disabled={removingMemberId === m.userId}
                        className="w-8 h-8 items-center justify-center"
                        accessibilityLabel={`Remove ${m.fullName}`}
                      >
                        <MaterialIcons name="close" size={18} color="#ba1a1a" />
                      </AnimatedPressable>
                    )}
                  </View>
                  </AnimatedListItem>
                ))}
              </View>

              <AnimatedPressable
                onPress={handleLeaveGroup}
                className="w-full h-12 bg-[#FEE2E2] rounded-2xl items-center justify-center mb-2"
              >
                <Text className="text-error font-semibold text-sm">Leave Group</Text>
              </AnimatedPressable>
            </ScrollView>
          </View>
        </AnimatedPressable>
      </Modal>

      {/* Add Members — filtered to people not already in this group. */}
      <Modal
        visible={isAddMembersSheetOpen}
        transparent={true}
        animationType="fade"
        onRequestClose={() => setIsAddMembersSheetOpen(false)}
      >
        <AnimatedPressable
          className="flex-1 bg-black/40 justify-end"
          onPress={() => setIsAddMembersSheetOpen(false)}
        >
          <View
            className="w-full rounded-t-3xl p-6"
            style={{ backgroundColor: '#fcf9f4', borderTopWidth: 1, borderTopColor: 'rgba(255, 255, 255, 0.4)', maxHeight: '85%' }}
          >
            <View className="w-10 h-1 bg-outline-variant/60 rounded-full self-center mb-6" />
            <Text className="font-headline text-lg font-bold text-on-surface mb-4">Add Members</Text>

            <TextInput
              value={addMemberSearch}
              onChangeText={setAddMemberSearch}
              placeholder="Search friends by name..."
              placeholderTextColor="rgba(64, 73, 64, 0.4)"
              className="w-full bg-white/70 border border-outline-variant/30 rounded-2xl px-4 py-3 font-body text-base text-on-surface mb-4"
            />

            <ScrollView showsVerticalScrollIndicator={false} style={{ maxHeight: 320 }}>
              <View className="gap-2 mb-4">
                {addMemberCandidates
                  .filter(c => c.name.toLowerCase().includes(addMemberSearch.toLowerCase()))
                  .map((c, index) => {
                    const isSelected = selectedNewMemberIds.includes(c.id);
                    return (
                      <AnimatedListItem key={c.id} index={index}>
                      <AnimatedPressable
                        onPress={() => handleToggleNewMember(c.id)}
                        className="p-3 rounded-2xl flex-row items-center justify-between"
                        style={{
                          backgroundColor: isSelected ? 'rgba(202, 234, 214, 0.3)' : 'rgba(255, 255, 255, 0.5)',
                          borderWidth: 1,
                          borderColor: isSelected ? '#004c22' : 'rgba(0,0,0,0.05)',
                        }}
                      >
                        <View className="flex-row items-center gap-3">
                          <Avatar
                            uri={c.avatar}
                            initials={c.initials}
                            size={36}
                            textClassName="text-primary font-bold text-xs"
                          />
                          <Text className="font-semibold text-on-surface text-sm">{c.name}</Text>
                        </View>
                        <View
                          className={`w-6 h-6 rounded-full border-2 items-center justify-center ${
                            isSelected ? 'bg-primary border-primary' : 'border-outline-variant'
                          }`}
                        >
                          {isSelected && <MaterialIcons name="check" size={14} color="white" />}
                        </View>
                      </AnimatedPressable>
                      </AnimatedListItem>
                    );
                  })}
                {addMemberCandidates.length === 0 && (
                  <Text className="text-sm text-on-surface-variant text-center py-6">
                    Everyone you're connected to is already in this group.
                  </Text>
                )}
              </View>
            </ScrollView>

            <AnimatedPressable
              onPress={handleConfirmAddMembers}
              disabled={isAddingMembers || selectedNewMemberIds.length === 0}
              className="w-full h-12 bg-primary rounded-2xl items-center justify-center"
              style={{ opacity: isAddingMembers || selectedNewMemberIds.length === 0 ? 0.6 : 1 }}
            >
              <Text className="text-white font-semibold text-sm">
                {isAddingMembers ? 'Adding…' : `Add (${selectedNewMemberIds.length} selected)`}
              </Text>
            </AnimatedPressable>
          </View>
        </AnimatedPressable>
      </Modal>
    </View>
  );
}
