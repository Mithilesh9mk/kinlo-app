import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';
import { fetchBalanceRows, balanceMapForScope, LedgerRow } from '../../lib/balances';
import { Skeleton, SkeletonCircle, SkeletonListRow } from '../../components/Skeleton';
import { fetchTransactionHistory, describeEvent, relativeTime, ActivityEvent } from '../../lib/activity';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { Avatar } from '../../components/Avatar';

/**
 * One expense, in full.
 *
 * Previously tapping a shared expense navigated straight to a single
 * counterparty's screen, so a three-person dinner dropped you into one
 * friend's history with no sign the third person existed — and settling from
 * there could only ever mean "settle with whoever this screen happens to be".
 *
 * This screen shows every participant and what each of them owes, and offers
 * a settle action per person. Settling Sarvesh's ₹250 leaves Vaishnavi's ₹250
 * outstanding, which is what "who are you settling with?" actually needs to
 * mean.
 */

interface Line {
  userId: string;
  name: string;
  avatarUrl?: string;
  initials: string;
  /** This person's share of the bill. */
  share: number;
  isYou: boolean;
  isPayer: boolean;
  /**
   * Signed, from your point of view. Positive: they owe you. Negative: you
   * owe them. Zero: nothing moves between you (either it is you, or a third
   * party who owes the payer rather than you).
   *
   * This is the *original* position on the bill and never changes.
   */
  betweenUs: number;
  /**
   * What is still outstanding between you and this person on this expense,
   * after subtracting settlements already recorded against it. Same sign
   * convention as betweenUs.
   *
   * The two used to be the same number, because nothing subtracted prior
   * settlements — so the Settle button came back every time the screen was
   * reopened and each press wrote another offsetting row, driving the balance
   * negative. See migration 0012.
   */
  remaining: number;
}

const CATEGORY_ICONS: Record<string, string> = {
  food: 'restaurant',
  travel: 'flight',
  home: 'home',
  utilities: 'bolt',
  other: 'category',
};

export default function TransactionDetailScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams();
  const txId = Array.isArray(id) ? id[0] : id;

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tx, setTx] = useState<any>(null);
  const [lines, setLines] = useState<Line[]>([]);
  const [payerName, setPayerName] = useState('');
  const [payerIsYou, setPayerIsYou] = useState(false);
  // Edits and voids recorded against this expense. Without this the screen
  // shows whatever it currently says, with no sign anyone changed it — which
  // on a shared expense is exactly when you want to know.
  const [history, setHistory] = useState<ActivityEvent[]>([]);

  const load = useCallback(async () => {
    if (!txId) return;
    setLoading(true);
    try {
      // getSession reads the session already cached in storage. getUser makes a
      // network call to /auth/v1/user on every single load, and this screen sat
      // waiting on it before it could even begin fetching anything.
      const { data: sessionData } = await supabase.auth.getSession();
      const me = sessionData?.session?.user?.id;
      if (!me) {
        setError('You appear to be signed out.');
        return;
      }

      // These three need only values known up front — the route param and the
      // user id — so they go out together rather than one after another. This
      // screen used to make five sequential round trips before it could render,
      // which is what made opening an expense take several seconds.
      const [txResult, settlementResult, balanceResult, historyResult] = await Promise.all([
        supabase
          .from('transactions')
          .select('id, amount, description, category, created_at, status, type, paid_by, group_id, transaction_splits (user_id, share_amount)')
          .eq('id', txId)
          .single(),
        // Settlements recorded against this expense.
        supabase
          .from('transactions')
          .select('id, paid_by, transaction_splits (user_id, share_amount)')
          .eq('settles_transaction_id', txId)
          .eq('type', 'settlement')
          .in('status', ['active', 'settled']),
        // The raw ledger rows, not a collapsed map — this expense's scope is
        // not known until it loads, and a group debt must never offset a
        // 1-on-1 debt with the same person. A failed read must not silently
        // unlock the buttons, so it degrades to "everyone is settled" rather
        // than "everyone is owed".
        fetchBalanceRows(me).catch(balErr => {
          console.warn('Could not read ledger; suppressing settle actions:', balErr);
          return [] as LedgerRow[];
        }),
        // History is presentational — a failure here must not stop the expense
        // rendering, so it degrades to "no history known" rather than an error.
        fetchTransactionHistory(txId).catch(histErr => {
          console.warn('Could not read expense history:', histErr);
          return [] as ActivityEvent[];
        }),
      ]);

      const { data, error: txError } = txResult;
      if (txError) throw new Error(txError.message);
      if (!data) throw new Error('This expense could not be found.');

      const settlements = settlementResult.data;
      setHistory(historyResult);

      // Scoped to this expense: a group expense is measured against the group
      // ledger, a 1-on-1 expense against the 1-on-1 ledger. Mixing them lets a
      // separate debt with the same person unlock a settle that should not be
      // offered, or hide one that should.
      const pairBalance: Record<string, number> =
        balanceMapForScope(balanceResult, me, (data as any).group_id ?? null);

      const splits = (data as any).transaction_splits || [];

      // Names for everyone on the expense. This one genuinely depends on the
      // splits, so it cannot join the batch above.
      const ids = new Set<string>([data.paid_by, ...splits.map((s: any) => s.user_id)]);
      const { data: users } = await supabase
        .from('users')
        .select('id, full_name, avatar_url')
        .in('id', Array.from(ids));

      const nameOf: Record<string, { name: string; avatar?: string }> = {};
      for (const u of users ?? []) {
        nameOf[u.id] = { name: u.full_name || 'Unknown', avatar: u.avatar_url || undefined };
      }

      const isPayerMe = data.paid_by === me;

      // Settlements against this expense, keyed by counterparty in the same
      // sign convention as betweenUs so it can simply be added.
      //
      // A settlement where they paid me cancels what they owed me (negative);
      // one where I paid them cancels what I owed (positive). Rows written
      // before migration 0012 carry no link at all, which is why the pair
      // balance below — not this map — is what actually keeps the screen honest.
      const settledOff: Record<string, number> = {};
      for (const st of settlements ?? []) {
        for (const leg of ((st as any).transaction_splits ?? [])) {
          const paidAmount = Number(leg.share_amount) || 0;
          if (st.paid_by === me) {
            // I paid the counterparty, clearing what I owed them.
            settledOff[leg.user_id] = (settledOff[leg.user_id] ?? 0) + paidAmount;
          } else if (leg.user_id === me) {
            // They paid me, clearing what they owed.
            settledOff[st.paid_by] = (settledOff[st.paid_by] ?? 0) - paidAmount;
          }
        }
      }

      // pairBalance (fetched above) is the backstop, and the thing that makes
      // this screen safe.
      //
      // The per-expense link only sees settlements that name THIS expense. It
      // cannot see a settle-up done from the friend screen, which clears a
      // whole balance and has no single expense to point at — and it cannot see
      // any settlement recorded before 0012, which is all of them. With only
      // that check, a fully-settled friend still gets a Settle button on every
      // historical expense.
      //
      // simplified_settlements knows what is genuinely outstanding with each
      // person, from every source. Clamping to it enforces the rule that
      // matters: you can never be offered more to settle than you owe. Signed
      // the same way as betweenUs — positive means they owe you.

      const built: Line[] = splits.map((s: any) => {
        const uid = s.user_id;
        const share = Number(s.share_amount) || 0;
        const isYou = uid === me;
        const isPayer = uid === data.paid_by;
        const full = isYou ? 'You' : (nameOf[uid]?.name || 'Unknown');

        // What moves between this person and me, specifically, and who the
        // counterparty is for that flow.
        let betweenUs = 0;
        let counterparty: string | null = null;
        if (!isYou && isPayerMe) {
          betweenUs = share;            // they owe me their share
          counterparty = uid;
        } else if (isYou && !isPayerMe) {
          betweenUs = -share;           // I owe the payer my share
          counterparty = data.paid_by;
        }

        // Subtract what has already been settled against this expense. Clamped
        // at zero rather than allowed to cross it: an overpayment is a
        // balance-level matter, and letting it go negative here would re-offer
        // a Settle button pointing the wrong way.
        let remaining = betweenUs + (counterparty ? (settledOff[counterparty] ?? 0) : 0);
        if (betweenUs > 0) remaining = Math.max(0, Math.min(betweenUs, remaining));
        else if (betweenUs < 0) remaining = Math.min(0, Math.max(betweenUs, remaining));
        else remaining = 0;

        // Then clamp to what is actually outstanding with this person overall.
        // This is what catches settlements the link cannot see. If the ledger
        // says you are square with them, nothing on this expense is settleable
        // no matter what its splits say.
        if (counterparty) {
          const owedOverall = pairBalance[counterparty] ?? 0;
          if (remaining > 0) {
            // They owe me here; cap at what they still owe me in total.
            remaining = Math.min(remaining, Math.max(0, owedOverall));
          } else if (remaining < 0) {
            // I owe them here; cap at what I still owe them in total.
            remaining = Math.max(remaining, Math.min(0, owedOverall));
          }
        }

        return {
          userId: uid,
          name: full,
          avatarUrl: nameOf[uid]?.avatar,
          initials: (full === 'You' ? 'You' : full).split(' ').map(n => n.charAt(0)).join('').toUpperCase().slice(0, 2),
          share,
          isYou,
          isPayer,
          betweenUs,
          remaining,
        };
      });

      // Payer first, then largest share.
      built.sort((a, b) => (b.isPayer ? 1 : 0) - (a.isPayer ? 1 : 0) || b.share - a.share);

      setTx(data);
      setLines(built);
      setPayerIsYou(isPayerMe);
      setPayerName(isPayerMe ? 'You' : (nameOf[data.paid_by]?.name || 'Someone'));
      setError(null);
    } catch (e: any) {
      console.warn('Transaction detail load failed:', e);
      setError(e?.message || 'Could not load this expense.');
    } finally {
      setLoading(false);
    }
  }, [txId]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const settleWith = (line: Line) => {
    // Only this person's *outstanding* amount travels to settle-up, so
    // settling one participant leaves the others untouched and a partial
    // payment leaves the rest.
    const amount = Math.abs(line.remaining);
    const theyOweMe = line.remaining > 0;

    router.push({
      pathname: '/settle-up',
      params: {
        friendId: theyOweMe ? line.userId : tx.paid_by,
        friendName: theyOweMe ? line.name : payerName,
        balance: amount.toFixed(2),
        status: theyOweMe ? 'owed' : 'owes',
        groupId: tx.group_id || undefined,
        transactionId: tx.id,
        transactionDescription: tx.description,
      },
    });
  };

  const Header = (
    <View className="flex-row items-center px-5 h-16 w-full border-b border-outline-variant/30" style={{ backgroundColor: 'rgba(252, 249, 244, 0.9)' }}>
      <AnimatedPressable
        onPress={() => router.back()}
        className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
      >
        <MaterialIcons name="arrow-back" size={24} color="#004c22" />
      </AnimatedPressable>
      <Text className="font-headline-md text-xl text-primary font-semibold" style={{ marginLeft: 6 }}>Expense</Text>
    </View>
  );

  if (loading) {
    // Shaped like the screen it is standing in for — summary card, position
    // panel, then a participant per row — so nothing jumps when the data
    // lands. A spinner would say "wait"; this says what is arriving.
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
        {Header}
        <ScrollView className="flex-1 px-5 pt-6" scrollEnabled={false}>
          <View className="max-w-xl mx-auto w-full">

            {/* Summary card */}
            <View
              className="rounded-3xl p-6 items-center"
              style={{
                backgroundColor: 'rgba(255,255,255,0.72)',
                borderWidth: 1,
                borderColor: 'rgba(255,255,255,0.4)',
              }}
            >
              <SkeletonCircle size={48} />
              <Skeleton width="58%" height={17} radius={8} style={{ marginTop: 14 }} />
              <Skeleton width="38%" height={28} radius={9} style={{ marginTop: 10 }} />
              <View className="flex-row items-center justify-center mt-4">
                <Skeleton width={96} height={26} radius={13} style={{ marginRight: 8 }} />
                <Skeleton width={112} height={26} radius={13} />
              </View>
            </View>

            {/* What has happened to this expense since it was created.
              Only shown when something actually has — an expense nobody has
              touched needs no history section, and rendering "created by X"
              on every screen would be noise. */}
          {history.filter(h => h.eventType !== 'expense_created'
                            && h.eventType !== 'settlement_recorded').length > 0 && (
            <View
              className="rounded-2xl px-5 py-4 mt-4"
              style={{ backgroundColor: 'rgba(248,235,220,0.5)', borderWidth: 1, borderColor: 'rgba(154,85,17,0.2)' }}
            >
              <View className="flex-row items-center mb-2">
                <MaterialIcons name="history" size={14} color="#9a5511" />
                <Text
                  className="font-label-sm text-[11px] uppercase tracking-wider font-bold"
                  style={{ color: '#9a5511', marginLeft: 6 }}
                >
                  This expense has changed
                </Text>
              </View>
              {history
                .filter(h => h.eventType !== 'expense_created' && h.eventType !== 'settlement_recorded')
                .map(h => {
                  const d = describeEvent(h);
                  return (
                    <View key={h.id} className="flex-row items-baseline mt-1">
                      <Text className="text-sm text-on-surface flex-1" numberOfLines={2}>
                        {d.title}
                        {d.detail ? <Text className="font-semibold">{`  ${d.detail}`}</Text> : null}
                      </Text>
                      <Text className="text-[11px] text-on-surface-variant" style={{ marginLeft: 8 }}>
                        {relativeTime(h.createdAt)}
                      </Text>
                    </View>
                  );
                })}
            </View>
          )}

          {/* Your position */}
            <View
              className="rounded-2xl px-5 py-4 mt-4"
              style={{ backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' }}
            >
              <Skeleton width="30%" height={10} />
              <Skeleton width="80%" height={13} style={{ marginTop: 10 }} />
            </View>

            {/* Participants */}
            <Skeleton width="46%" height={12} style={{ marginTop: 26, marginBottom: 10 }} />

            {[0, 1, 2].map(i => (
              <View
                key={i}
                className="rounded-2xl p-4 mb-3"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.72)',
                  borderWidth: 1,
                  borderColor: 'rgba(255,255,255,0.4)',
                }}
              >
                <SkeletonListRow avatarSize={44} />
              </View>
            ))}

          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (error || !tx) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
        {Header}
        <View className="flex-1 items-center justify-center px-8">
          <MaterialIcons name="error-outline" size={44} color="#b91c1c" />
          <Text className="font-headline-md text-lg font-bold text-on-surface mt-3 text-center">Could not load this expense</Text>
          <Text className="text-sm text-on-surface-variant mt-2 text-center">{error}</Text>
          <AnimatedPressable onPress={load} className="mt-5 bg-primary px-6 py-3 rounded-xl">
            <Text className="text-white font-semibold">Try Again</Text>
          </AnimatedPressable>
        </View>
      </SafeAreaView>
    );
  }

  const isVoided = tx.status === 'voided';
  const isSettlement = tx.type === 'settlement';
  const settleable = lines.filter(l => Math.abs(l.remaining) > 0.005);
  const totalToYou = settleable.reduce((sum, l) => sum + (l.remaining > 0 ? l.remaining : 0), 0);
  const totalFromYou = settleable.reduce((sum, l) => sum + (l.remaining < 0 ? -l.remaining : 0), 0);
  // Had a position on this expense, and it has been cleared.
  const fullySettled = lines.some(l => Math.abs(l.betweenUs) > 0.005) && settleable.length === 0;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      {Header}

      <ScrollView className="flex-1 px-5 pt-6" contentContainerStyle={{ paddingBottom: 60 }}>
        <View className="max-w-xl mx-auto w-full">

          {/* Summary */}
          <View
            className="rounded-3xl p-6 items-center"
            style={{
              backgroundColor: 'rgba(255,255,255,0.72)',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.4)',
            }}
          >
            <View
              className="w-12 h-12 rounded-full items-center justify-center"
              style={{ backgroundColor: '#caead6' }}
            >
              <MaterialIcons
                name={(isSettlement ? 'payments' : (CATEGORY_ICONS[tx.category] || 'receipt-long')) as any}
                size={24}
                color="#004c22"
              />
            </View>

            <Text className="font-headline-md text-lg font-bold text-on-surface text-center mt-3" numberOfLines={3}>
              {tx.description || 'Expense'}
            </Text>

            <Text className="font-display-lg text-3xl font-bold text-primary mt-1">
              ₹{Number(tx.amount).toFixed(2)}
            </Text>

            <View className="flex-row flex-wrap items-center justify-center mt-3">
              <View
                className="flex-row items-center px-3 py-1.5 rounded-full"
                style={{ backgroundColor: '#caead6', marginRight: 8, marginBottom: 6 }}
              >
                <MaterialIcons name="account-balance-wallet" size={14} color="#004c22" />
                <Text className="text-xs font-bold text-primary" style={{ marginLeft: 6 }}>
                  {payerIsYou ? 'You paid' : `${payerName.split(' ')[0]} paid`}
                </Text>
              </View>
              <View
                className="flex-row items-center px-3 py-1.5 rounded-full"
                style={{ backgroundColor: 'rgba(0,0,0,0.05)', marginBottom: 6 }}
              >
                <MaterialIcons name="event" size={14} color="#707a6f" />
                <Text className="text-xs font-medium text-on-surface-variant" style={{ marginLeft: 6 }}>
                  {new Date(tx.created_at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}
                </Text>
              </View>
            </View>

            {isVoided && (
              <View className="mt-3 px-3 py-1 rounded-full" style={{ backgroundColor: 'rgba(185,28,28,0.1)' }}>
                <Text className="text-xs font-bold" style={{ color: '#b91c1c' }}>VOIDED</Text>
              </View>
            )}
          </View>

          {/* Your position */}
          {!isVoided && (totalToYou > 0 || totalFromYou > 0) && (
            <View
              className="rounded-2xl px-5 py-4 mt-4"
              style={{ backgroundColor: 'rgba(255,255,255,0.6)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' }}
            >
              <Text className="font-label-sm text-[11px] uppercase tracking-wider text-on-surface-variant font-bold mb-1">
                Your position
              </Text>
              <Text className="text-sm text-on-surface leading-relaxed">
                {totalToYou > 0 && (
                  <Text>You get back <Text className="font-bold" style={{ color: '#1f6c3a' }}>₹{totalToYou.toFixed(2)}</Text> from {settleable.filter(l => l.betweenUs > 0).length} {settleable.filter(l => l.betweenUs > 0).length === 1 ? 'person' : 'people'}. </Text>
                )}
                {totalFromYou > 0 && (
                  <Text>You owe <Text className="font-bold" style={{ color: '#ba1a1a' }}>₹{totalFromYou.toFixed(2)}</Text> to {payerName}.</Text>
                )}
              </Text>
            </View>
          )}

          {/* Participants */}
          <Text className="font-label-md text-sm text-on-surface-variant uppercase font-semibold mt-6 mb-3 px-1">
            Split between {lines.length} {lines.length === 1 ? 'person' : 'people'}
          </Text>

          {lines.map((l, index) => {
            // isSettlement matters: a settlement row has a payer and a split
            // like any other, so without this check the screen offered a
            // Settle button on a payment. The live data contained the result —
            // "You settled ₹81.66 for 'Vaishnavi settled ₹81.66 with You'".
            const canSettle = !isVoided && !isSettlement && Math.abs(l.remaining) > 0.005;
            const clearedWithThisPerson = Math.abs(l.betweenUs) > 0.005 && Math.abs(l.remaining) <= 0.005;
            return (
              <AnimatedListItem key={l.userId} index={index}>
              <View
                className="rounded-2xl p-4 mb-3"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.72)',
                  borderWidth: 1,
                  borderColor: l.isPayer ? '#004c22' : 'rgba(255,255,255,0.4)',
                }}
              >
                <View className="flex-row items-center">
                  <View className="w-11 h-11 rounded-full items-center justify-center overflow-hidden" style={{ backgroundColor: '#caead6' }}>
                    <Avatar uri={l.avatarUrl} initials={l.initials} textClassName="text-primary font-bold text-sm" />
                  </View>

                  <View style={{ marginLeft: 13, flex: 1 }}>
                    <Text className="font-semibold text-on-surface text-base" numberOfLines={1}>{l.name}</Text>
                    {l.isPayer ? (
                      <Text className="text-[11px] font-bold text-primary uppercase tracking-wider mt-0.5">Paid the bill</Text>
                    ) : (
                      <Text className="text-xs text-on-surface-variant mt-0.5">
                        Share of the bill
                      </Text>
                    )}
                  </View>

                  <View className="items-end">
                    <Text className="font-bold text-on-surface text-base">₹{l.share.toFixed(2)}</Text>
                    {clearedWithThisPerson ? (
                      <View className="flex-row items-center mt-0.5">
                        <MaterialIcons name="check-circle" size={12} color="#1f6c3a" />
                        <Text className="text-[11px] font-bold" style={{ color: '#1f6c3a', marginLeft: 3 }}>
                          settled
                        </Text>
                      </View>
                    ) : Math.abs(l.remaining) > 0.005 ? (
                      <Text
                        className="text-[11px] font-bold mt-0.5"
                        style={{ color: l.remaining > 0 ? '#1f6c3a' : '#ba1a1a' }}
                      >
                        {l.remaining > 0 ? 'owes you' : 'you owe'}
                        {Math.abs(l.remaining) < Math.abs(l.betweenUs) && ' (part paid)'}
                      </Text>
                    ) : null}
                  </View>
                </View>

                {canSettle && (
                  <AnimatedPressable
                    onPress={() => settleWith(l)}
                    className="flex-row items-center justify-center rounded-xl mt-3"
                    style={{ backgroundColor: '#004c22', paddingVertical: 11 }}
                  >
                    <MaterialIcons name="check-circle" size={17} color="white" />
                    <Text className="text-white font-bold text-sm" style={{ marginLeft: 7 }}>
                      {l.remaining > 0
                        ? `Settle ₹${Math.abs(l.remaining).toFixed(2)} with ${l.name.split(' ')[0]}`
                        : `Pay ${payerName.split(' ')[0]} ₹${Math.abs(l.remaining).toFixed(2)}`}
                    </Text>
                  </AnimatedPressable>
                )}
              </View>
              </AnimatedListItem>
            );
          })}

          {!isVoided && (isSettlement || settleable.length === 0) && (
            <View
              className="rounded-2xl px-5 py-5 items-center"
              style={{ backgroundColor: 'rgba(255,255,255,0.5)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' }}
            >
              <MaterialIcons name="done-all" size={26} color="#004c22" />
              <Text className="text-sm text-on-surface-variant text-center mt-2">
                {fullySettled
                  ? 'All settled — every share on this expense has been paid back.'
                  : isSettlement
                    ? 'This is a payment, not an expense. There is nothing to settle on it.'
                    : 'Nothing to settle here — this expense does not move money between you and anyone else.'}
              </Text>
            </View>
          )}

        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
