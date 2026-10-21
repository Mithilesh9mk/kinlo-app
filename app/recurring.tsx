import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { SkeletonListRow } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { useAlert } from '../components/AppAlert';
import { formatINR, tabularNums } from '../lib/format';
import {
  RecurringRule,
  REPEAT_LABELS,
  fetchMyRules,
  setRuleActive,
  deleteRule,
  runDueRecurring,
  fromDateStr,
} from '../lib/recurringExpenses';

function formatDue(s: string): string {
  const d = fromDateStr(s);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export default function RecurringScreen() {
  const router = useRouter();
  const { showToast } = useToast();
  const { showAlert } = useAlert();

  const [rules, setRules] = useState<RecurringRule[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refreshing, setRefreshing] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Create anything that has come due first, so the list shows the new dates.
    await runDueRecurring();
    const res = await fetchMyRules();
    if (res) {
      setRules(res);
      setState('ready');
    } else {
      setState(prev => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const toggle = async (r: RecurringRule) => {
    setBusyId(r.id);
    const ok = await setRuleActive(r.id, !r.active);
    setBusyId(null);
    if (!ok) {
      showToast('Could not update. Try again.');
      return;
    }
    setRules(prev => prev.map(x => (x.id === r.id ? { ...x, active: !r.active, failCount: 0 } : x)));
  };

  const remove = (r: RecurringRule) => {
    showAlert(
      'Stop repeating?',
      `"${r.description}" will stop being added. Expenses already added stay as they are.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Stop repeating',
          style: 'destructive',
          onPress: async () => {
            setBusyId(r.id);
            const ok = await deleteRule(r.id);
            setBusyId(null);
            if (!ok) {
              showToast('Could not remove. Try again.');
              return;
            }
            setRules(prev => prev.filter(x => x.id !== r.id));
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center px-5 h-16 border-b border-outline-variant/30">
        <AnimatedPressable
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="arrow-back" size={24} color="#004c22" />
        </AnimatedPressable>
        <Text className="font-headline text-lg font-bold text-primary ml-2">Repeating expenses</Text>
      </View>

      <ScrollView
        className="flex-1 px-5 pt-5"
        contentContainerStyle={{ paddingBottom: 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Text className="text-xs text-on-surface-variant leading-relaxed mb-4">
          Each one is added again by this phone when you open Kinlo on or after its due date, with the same
          split. To start one, turn on “Repeat this expense” when you add an expense.
        </Text>

        {state === 'loading' && (
          <View className="gap-3">
            <SkeletonListRow />
            <SkeletonListRow />
          </View>
        )}

        {state === 'error' && (
          <View className="items-center py-10">
            <MaterialIcons name="cloud-off" size={36} color="#707a6f" />
            <Text className="text-on-surface font-semibold mt-3">Couldn’t load your repeating expenses</Text>
            <AnimatedPressable onPress={load} className="mt-4 px-5 py-2.5 rounded-full bg-primary">
              <Text className="text-white font-semibold text-sm">Try again</Text>
            </AnimatedPressable>
          </View>
        )}

        {state === 'ready' && rules.length === 0 && (
          <View className="items-center py-12">
            <View className="w-16 h-16 rounded-full bg-primary/10 items-center justify-center">
              <MaterialIcons name="autorenew" size={30} color="#004c22" />
            </View>
            <Text className="text-on-surface font-bold text-base mt-4">Nothing repeats yet</Text>
            <Text className="text-on-surface-variant text-sm text-center mt-1 leading-relaxed px-6">
              Rent, Wi-Fi, a shared subscription: add the expense once, switch on “Repeat this expense”, and
              Kinlo adds it for you every time.
            </Text>
            <AnimatedPressable
              onPress={() => router.push('/expense/amount' as any)}
              className="mt-5 px-5 py-2.5 rounded-full bg-primary"
            >
              <Text className="text-white font-semibold text-sm">Add an expense</Text>
            </AnimatedPressable>
          </View>
        )}

        {state === 'ready' &&
          rules.map(r => (
            <View
              key={r.id}
              className="rounded-2xl border border-outline-variant/25 bg-white/70 p-4 mb-3"
              style={{ opacity: busyId === r.id ? 0.5 : 1 }}
            >
              <View className="flex-row items-start justify-between">
                <View className="flex-1 pr-3">
                  <Text className="font-bold text-base text-on-surface" numberOfLines={1}>{r.description}</Text>
                  <Text className="text-xs text-on-surface-variant mt-0.5">
                    {REPEAT_LABELS[r.frequency]} · {r.groupId ? 'Circle' : 'Friends'} · {r.splits.length} {r.splits.length === 1 ? 'person' : 'people'}
                  </Text>
                </View>
                <Text className="font-bold text-base text-on-surface" style={tabularNums}>{formatINR(r.amount)}</Text>
              </View>

              <Text className="text-xs mt-2" style={{ color: r.active ? '#404940' : '#b45309' }}>
                {r.active
                  ? `Next: ${formatDue(r.nextDue)}`
                  : r.failCount >= 5
                    ? 'Paused — it could not be added several times (someone may have left). Resume to retry.'
                    : 'Paused'}
              </Text>

              <View className="flex-row gap-2 mt-3">
                <AnimatedPressable
                  disabled={busyId === r.id}
                  onPress={() => toggle(r)}
                  className="px-4 py-2 rounded-full border border-outline-variant/40 bg-white"
                >
                  <Text className="text-xs font-semibold text-on-surface-variant">{r.active ? 'Pause' : 'Resume'}</Text>
                </AnimatedPressable>
                <AnimatedPressable
                  disabled={busyId === r.id}
                  onPress={() => remove(r)}
                  className="px-4 py-2 rounded-full border border-error/30 bg-error/5"
                >
                  <Text className="text-xs font-semibold text-error">Stop repeating</Text>
                </AnimatedPressable>
              </View>
            </View>
          ))}
      </ScrollView>
    </SafeAreaView>
  );
}
