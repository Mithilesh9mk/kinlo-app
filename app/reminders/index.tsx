import React, { useState, useCallback, useRef } from 'react';
import { View, Text, TextInput, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { SkeletonListRow } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { useAlert } from '../../components/AppAlert';
import { formatINR, tabularNums } from '../../lib/format';
import { fetchMyPlan, FREE_ACTIVE_REMINDERS } from '../../lib/plan';
import {
  PersonalReminder,
  ReminderRecurrence,
  listReminders,
  createReminder,
  updateReminder,
  markReminderDone,
  removeReminder,
} from '../../lib/personalReminders';

const RECURRENCES: { value: ReminderRecurrence; label: string }[] = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function formatDate(d: Date): string {
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

function formatTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** DD/MM/YYYY + HH:MM -> Date, or null. Rejects rolled-over dates (31/02). */
function parseDateTime(dateText: string, timeText: string): Date | null {
  const m = dateText.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const t = timeText.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  const hh = Number(t[1]);
  const mi = Number(t[2]);
  if (hh > 23 || mi > 59 || yyyy < 2000) return null;
  const d = new Date(yyyy, mm - 1, dd, hh, mi, 0, 0);
  if (isNaN(d.getTime()) || d.getDate() !== dd || d.getMonth() !== mm - 1) return null;
  return d;
}

function dueLabel(iso: string): { text: string; overdue: boolean } {
  const d = new Date(iso);
  return { text: `${formatDate(d)} · ${formatTime(d)}`, overdue: d.getTime() < Date.now() };
}

export default function RemindersScreen() {
  const router = useRouter();
  const { showToast } = useToast();
  const { showAlert } = useAlert();

  const [rows, setRows] = useState<PersonalReminder[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const hasLoadedRef = useRef(false);

  // Form: null = closed, 'new' = add, otherwise the reminder being edited.
  const [editing, setEditing] = useState<PersonalReminder | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [dateText, setDateText] = useState('');
  const [timeText, setTimeText] = useState('');
  const [recurrence, setRecurrence] = useState<ReminderRecurrence>('once');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else if (!hasLoadedRef.current) setLoadState('loading');
    const res = await listReminders();
    if (res.ok) {
      setRows(res.data);
      hasLoadedRef.current = true;
      setRefreshFailed(false);
      setLoadState('ready');
    } else if (hasLoadedRef.current) {
      setRefreshFailed(true);
    } else {
      setLoadState('error');
    }
    setRefreshing(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  function openForm(r: PersonalReminder | 'new') {
    if (r === 'new') {
      const d = new Date(Date.now() + 60 * 60 * 1000);
      d.setMinutes(0, 0, 0);
      setTitle('');
      setAmount('');
      setDateText(formatDate(d));
      setTimeText(formatTime(d));
      setRecurrence('once');
    } else {
      const d = new Date(r.nextDueAt);
      setTitle(r.title);
      setAmount(r.amount !== null ? String(r.amount) : '');
      setDateText(formatDate(d));
      setTimeText(formatTime(d));
      setRecurrence(r.recurrence);
    }
    setEditing(r);
  }

  // Free plan keeps FREE_ACTIVE_REMINDERS active reminders; Gold is unlimited.
  // Display-level gate (reminders are the user's own data and cost us almost
  // nothing), and it fails OPEN: if the plan can't be read, adding still works.
  async function startNew() {
    if (rows.length >= FREE_ACTIVE_REMINDERS) {
      const plan = await fetchMyPlan();
      if (plan && plan.plan !== 'gold') {
        showAlert(
          'Reminder limit reached',
          `The free plan includes ${FREE_ACTIVE_REMINDERS} active reminders. Kinlo Gold removes the limit.`,
          [
            { text: 'Not now', style: 'cancel' },
            { text: 'See Gold', onPress: () => router.push('/gold' as any) },
          ],
        );
        return;
      }
    }
    openForm('new');
  }

  const parsedDue = parseDateTime(dateText, timeText);
  const parsedAmount = amount === '' ? null : Number(amount);
  const amountInvalid = amount !== '' && (parsedAmount === null || !Number.isFinite(parsedAmount) || parsedAmount <= 0);
  const titleTrim = title.trim();
  const titleInvalid = titleTrim.length < 1 || titleTrim.length > 80;
  const canSave = !saving && !titleInvalid && !amountInvalid && parsedDue !== null;

  async function handleSave() {
    if (!canSave || !parsedDue || editing === null) return;
    setSaving(true);
    const draft = { title: titleTrim, amount: parsedAmount, recurrence, nextDueAt: parsedDue };
    const res = editing === 'new' ? await createReminder(draft) : await updateReminder(editing, draft);
    setSaving(false);
    if (!res.ok) {
      showToast(res.error);
      return;
    }
    setEditing(null);
    showToast(editing === 'new' ? 'Reminder added' : 'Reminder updated');
    load(true);
  }

  async function handleDone(r: PersonalReminder) {
    setBusyId(r.id);
    const res = await markReminderDone(r.id);
    setBusyId(null);
    if (!res.ok) {
      showToast(res.error);
      return;
    }
    showToast(r.recurrence === 'once' ? 'Marked done' : 'Done. Next one scheduled');
    load(true);
  }

  function handleDelete(r: PersonalReminder) {
    showAlert('Delete reminder?', `"${r.title}" will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setBusyId(r.id);
          const res = await removeReminder(r.id);
          setBusyId(null);
          if (!res.ok) {
            showToast(res.error);
            return;
          }
          setRows((prev) => prev.filter((x) => x.id !== r.id));
          showToast('Reminder deleted');
        },
      },
    ]);
  }

  function handleBack() {
    if (editing !== null) setEditing(null);
    else router.back();
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center justify-between px-5 h-16">
        <AnimatedPressable
          onPress={handleBack}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          className="w-10 h-10 items-center justify-center rounded-full"
          accessibilityLabel="Back"
        >
          <MaterialIcons name="arrow-back" size={22} color="#1c1c19" />
        </AnimatedPressable>
        <Text className="font-headline-md text-base font-semibold text-on-surface">
          {editing === 'new' ? 'New reminder' : editing ? 'Edit reminder' : 'Reminders'}
        </Text>
        {editing === null ? (
          <AnimatedPressable
            onPress={startNew}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            className="w-10 h-10 items-center justify-center rounded-full bg-secondary-container"
            accessibilityLabel="Add reminder"
          >
            <MaterialIcons name="add" size={22} color="#004c22" />
          </AnimatedPressable>
        ) : (
          <View className="w-10 h-10" />
        )}
      </View>

      {editing !== null ? (
        <ScrollView className="flex-1 px-5" contentContainerStyle={{ paddingBottom: 40 }} keyboardShouldPersistTaps="handled">
          <Text className="text-xs text-on-surface-variant uppercase tracking-wide mb-2">Title</Text>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder="Rent, credit card, medicine"
            placeholderTextColor="rgba(64,73,64,0.4)"
            maxLength={80}
            className="w-full text-sm text-on-surface px-4 py-3 rounded-2xl bg-surface-container mb-4"
          />

          <Text className="text-xs text-on-surface-variant uppercase tracking-wide mb-2">Amount (optional)</Text>
          <TextInput
            value={amount}
            onChangeText={(t) => setAmount(t.replace(/[^0-9.]/g, ''))}
            placeholder="0"
            keyboardType="decimal-pad"
            placeholderTextColor="rgba(64,73,64,0.4)"
            className="w-full text-sm text-on-surface px-4 py-3 rounded-2xl bg-surface-container mb-1"
          />
          {amountInvalid ? (
            <Text className="text-xs text-red-700 mb-3">Enter an amount above zero, or leave it empty.</Text>
          ) : parsedAmount ? (
            <Text className="text-xs text-on-surface-variant mb-3" style={tabularNums}>{formatINR(parsedAmount)}</Text>
          ) : (
            <View className="mb-3" />
          )}

          <Text className="text-xs text-on-surface-variant uppercase tracking-wide mb-2">Due date and time</Text>
          <View className="flex-row gap-3 mb-1">
            <TextInput
              value={dateText}
              onChangeText={setDateText}
              placeholder="DD/MM/YYYY"
              placeholderTextColor="rgba(64,73,64,0.4)"
              keyboardType="numbers-and-punctuation"
              className="flex-1 text-sm text-on-surface px-4 py-3 rounded-2xl bg-surface-container"
            />
            <TextInput
              value={timeText}
              onChangeText={setTimeText}
              placeholder="HH:MM"
              placeholderTextColor="rgba(64,73,64,0.4)"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              className="w-28 text-sm text-on-surface px-4 py-3 rounded-2xl bg-surface-container"
            />
          </View>
          {parsedDue === null && (
            <Text className="text-xs text-red-700">Use a real date as DD/MM/YYYY and a 24-hour time as HH:MM.</Text>
          )}

          <Text className="text-xs text-on-surface-variant uppercase tracking-wide mb-2 mt-4">Repeats</Text>
          <View className="flex-row gap-2 mb-6">
            {RECURRENCES.map((o) => (
              <AnimatedPressable
                key={o.value}
                onPress={() => setRecurrence(o.value)}
                className={`flex-1 items-center py-2.5 rounded-xl ${recurrence === o.value ? 'bg-primary' : 'bg-surface-container-highest'}`}
              >
                <Text className={`text-xs font-bold ${recurrence === o.value ? 'text-white' : 'text-on-surface'}`}>{o.label}</Text>
              </AnimatedPressable>
            ))}
          </View>

          <AnimatedPressable
            onPress={handleSave}
            disabled={!canSave}
            className={`py-3.5 rounded-xl items-center ${canSave ? 'bg-primary' : 'bg-primary/40'}`}
          >
            {saving ? (
              <ActivityIndicator color="#ffffff" />
            ) : (
              <Text className="text-white font-semibold text-base">Save reminder</Text>
            )}
          </AnimatedPressable>
        </ScrollView>
      ) : (
        <>
          {loadState === 'ready' && refreshFailed && (
            <View className="flex-row items-center justify-between mx-5 mb-2 px-3 py-2 rounded-xl bg-surface-container border border-outline-variant/30">
              <Text className="flex-1 text-xs text-on-surface-variant mr-2">Couldn't refresh, showing what we had</Text>
              <AnimatedPressable onPress={() => load(true)} className="px-3 py-1.5 rounded-lg bg-primary">
                <Text className="text-white font-bold text-xs">Retry</Text>
              </AnimatedPressable>
            </View>
          )}

          <ScrollView
            className="flex-1 px-5"
            contentContainerStyle={{ paddingBottom: 40 }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} />}
          >
            {loadState === 'loading' && (
              <View className="gap-2">
                <SkeletonListRow />
                <SkeletonListRow />
                <SkeletonListRow />
              </View>
            )}

            {loadState === 'error' && (
              <View className="items-center py-8 px-6">
                <MaterialIcons name="error-outline" size={40} color="#b91c1c" />
                <Text className="text-on-surface font-bold text-base mb-1 mt-3">Could not load your reminders</Text>
                <Text className="text-on-surface-variant text-center max-w-xs text-sm">
                  Check your connection and try again.
                </Text>
                <AnimatedPressable onPress={() => load()} className="mt-5 bg-primary px-6 py-3 rounded-xl">
                  <Text className="text-white font-semibold text-sm">Retry</Text>
                </AnimatedPressable>
              </View>
            )}

            {loadState === 'ready' && rows.length === 0 && (
              <View className="items-center py-10 gap-3">
                <View className="w-16 h-16 rounded-full bg-secondary-container items-center justify-center">
                  <MaterialIcons name="notifications-none" size={28} color="#004c22" />
                </View>
                <Text className="text-base font-bold text-on-surface text-center">No reminders yet</Text>
                <Text className="text-sm text-on-surface-variant text-center">
                  Add rent, bills or EMIs and Kinlo will remind you when they are due.
                </Text>
                <AnimatedPressable onPress={startNew} className="mt-2 bg-primary px-6 py-3 rounded-xl">
                  <Text className="text-white font-semibold text-sm">Add reminder</Text>
                </AnimatedPressable>
              </View>
            )}

            {loadState === 'ready' &&
              rows.map((r) => {
                const due = dueLabel(r.nextDueAt);
                const busy = busyId === r.id;
                return (
                  <View key={r.id} className="mb-3 p-4 rounded-2xl bg-surface-container border border-outline-variant/30">
                    <AnimatedPressable onPress={() => openForm(r)} disabled={busy}>
                      <View className="flex-row items-start justify-between">
                        <View className="flex-1 mr-3">
                          <Text className="text-base font-bold text-on-surface" numberOfLines={2}>{r.title}</Text>
                          <Text className={`text-xs mt-1 ${due.overdue ? 'text-red-700 font-bold' : 'text-on-surface-variant'}`}>
                            {due.overdue ? 'Overdue · ' : ''}{due.text}
                            {r.recurrence !== 'once' ? ` · ${r.recurrence}` : ''}
                          </Text>
                        </View>
                        {r.amount !== null && (
                          <Text className="text-sm font-bold text-primary" style={tabularNums}>{formatINR(r.amount)}</Text>
                        )}
                      </View>
                    </AnimatedPressable>
                    <View className="flex-row gap-2 mt-3">
                      <AnimatedPressable
                        onPress={() => handleDone(r)}
                        disabled={busy}
                        className="flex-1 flex-row items-center justify-center gap-1.5 py-2 rounded-xl bg-primary"
                      >
                        <MaterialIcons name="check" size={16} color="#ffffff" />
                        <Text className="text-white font-bold text-xs">Mark done</Text>
                      </AnimatedPressable>
                      <AnimatedPressable
                        onPress={() => handleDelete(r)}
                        disabled={busy}
                        className="px-4 flex-row items-center justify-center gap-1.5 py-2 rounded-xl bg-surface-container-highest"
                        accessibilityLabel="Delete reminder"
                      >
                        <MaterialIcons name="delete-outline" size={16} color="#b91c1c" />
                        <Text className="text-xs font-bold text-red-700">Delete</Text>
                      </AnimatedPressable>
                    </View>
                  </View>
                );
              })}
          </ScrollView>
        </>
      )}
    </SafeAreaView>
  );
}
