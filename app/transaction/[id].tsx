import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Image, ActivityIndicator } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, useLocalSearchParams, useFocusEffect } from 'expo-router';
import { supabase } from '../../lib/supabase';

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
   */
  betweenUs: number;
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

  const load = useCallback(async () => {
    if (!txId) return;
    setLoading(true);
    try {
      const { data: authData } = await supabase.auth.getUser();
      const me = authData?.user?.id;
      if (!me) {
        setError('You appear to be signed out.');
        return;
      }

      const { data, error: txError } = await supabase
        .from('transactions')
        .select('id, amount, description, category, created_at, status, type, paid_by, group_id, transaction_splits (user_id, share_amount)')
        .eq('id', txId)
        .single();

      if (txError) throw new Error(txError.message);
      if (!data) throw new Error('This expense could not be found.');

      const splits = (data as any).transaction_splits || [];

      // Resolve names for everyone named on the expense.
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

      const built: Line[] = splits.map((s: any) => {
        const uid = s.user_id;
        const share = Number(s.share_amount) || 0;
        const isYou = uid === me;
        const isPayer = uid === data.paid_by;
        const full = isYou ? 'You' : (nameOf[uid]?.name || 'Unknown');

        // What moves between this person and me, specifically.
        let betweenUs = 0;
        if (!isYou && isPayerMe) {
          betweenUs = share;            // they owe me their share
        } else if (isYou && !isPayerMe) {
          betweenUs = -share;           // I owe the payer my share
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
    // Only this person's amount travels to settle-up, so settling one
    // participant leaves the others outstanding.
    const amount = Math.abs(line.betweenUs);
    const theyOweMe = line.betweenUs > 0;

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
      <TouchableOpacity
        onPress={() => router.back()}
        className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
      >
        <MaterialIcons name="arrow-back" size={24} color="#004c22" />
      </TouchableOpacity>
      <Text className="font-headline-md text-xl text-primary font-semibold" style={{ marginLeft: 6 }}>Expense</Text>
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
        {Header}
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color="#004c22" />
        </View>
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
          <TouchableOpacity onPress={load} className="mt-5 bg-primary px-6 py-3 rounded-xl">
            <Text className="text-white font-semibold">Try Again</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const isVoided = tx.status === 'voided';
  const isSettlement = tx.type === 'settlement';
  const settleable = lines.filter(l => Math.abs(l.betweenUs) > 0.005);
  const totalToYou = settleable.reduce((sum, l) => sum + (l.betweenUs > 0 ? l.betweenUs : 0), 0);
  const totalFromYou = settleable.reduce((sum, l) => sum + (l.betweenUs < 0 ? -l.betweenUs : 0), 0);

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

          {lines.map((l) => {
            const canSettle = !isVoided && Math.abs(l.betweenUs) > 0.005;
            return (
              <View
                key={l.userId}
                className="rounded-2xl p-4 mb-3"
                style={{
                  backgroundColor: 'rgba(255,255,255,0.72)',
                  borderWidth: 1,
                  borderColor: l.isPayer ? '#004c22' : 'rgba(255,255,255,0.4)',
                }}
              >
                <View className="flex-row items-center">
                  <View className="w-11 h-11 rounded-full items-center justify-center overflow-hidden" style={{ backgroundColor: '#caead6' }}>
                    {l.avatarUrl ? (
                      <Image source={{ uri: l.avatarUrl }} className="w-full h-full" />
                    ) : (
                      <Text className="text-primary font-bold text-sm">{l.initials}</Text>
                    )}
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
                    {Math.abs(l.betweenUs) > 0.005 && (
                      <Text
                        className="text-[11px] font-bold mt-0.5"
                        style={{ color: l.betweenUs > 0 ? '#1f6c3a' : '#ba1a1a' }}
                      >
                        {l.betweenUs > 0 ? 'owes you' : 'you owe'}
                      </Text>
                    )}
                  </View>
                </View>

                {canSettle && (
                  <TouchableOpacity
                    onPress={() => settleWith(l)}
                    activeOpacity={0.85}
                    className="flex-row items-center justify-center rounded-xl mt-3"
                    style={{ backgroundColor: '#004c22', paddingVertical: 11 }}
                  >
                    <MaterialIcons name="check-circle" size={17} color="white" />
                    <Text className="text-white font-bold text-sm" style={{ marginLeft: 7 }}>
                      {l.betweenUs > 0
                        ? `Settle ₹${Math.abs(l.betweenUs).toFixed(2)} with ${l.name.split(' ')[0]}`
                        : `Pay ${payerName.split(' ')[0]} ₹${Math.abs(l.betweenUs).toFixed(2)}`}
                    </Text>
                  </TouchableOpacity>
                )}
              </View>
            );
          })}

          {!isVoided && settleable.length === 0 && (
            <View
              className="rounded-2xl px-5 py-5 items-center"
              style={{ backgroundColor: 'rgba(255,255,255,0.5)', borderWidth: 1, borderColor: 'rgba(0,0,0,0.06)' }}
            >
              <MaterialIcons name="done-all" size={26} color="#004c22" />
              <Text className="text-sm text-on-surface-variant text-center mt-2">
                Nothing to settle here — this expense does not move money between you and anyone else.
              </Text>
            </View>
          )}

        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
