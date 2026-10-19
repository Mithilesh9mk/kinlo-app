import React, { useState, useCallback, useMemo, useRef } from 'react';
import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { SwipeableRow } from '../../components/SwipeableRow';
import { SkeletonListRow } from '../../components/Skeleton';
import { ParetoChart } from '../../components/ParetoChart';
import { useToast } from '../../components/Toast';
import { useAlert } from '../../components/AppAlert';
import { categoryMeta } from '../../lib/categories';
import { formatINR, tabularNums } from '../../lib/format';
import {
  listPersonalTransactions,
  voidPersonalTransaction,
  uploadReceiptImage,
  uploadReceiptImageBytes,
  receiptImagePath,
  newTransactionId,
  encodeBase64,
  PersonalTransaction,
} from '../../lib/personalTransactions';
import { stashPendingReceiptImage, registerReceiptUpload } from '../../lib/pendingReceiptImage';
import { saveReceiptDraft, listReceiptDrafts, deleteReceiptDraft, ReceiptDraft } from '../../lib/receiptDrafts';
import { prepareReceiptImage } from '../../lib/imagePrep';
import { File } from 'expo-file-system';
import { withOfflineFallback } from '../../lib/offlineCache';
import { OfflineBanner } from '../../components/OfflineBanner';

const AUTO_SCAN_KEY = 'kinlo.finance.autoScan.v1';

const money = (n: number) => formatINR(n);

function monthLabel(iso: string) {
  return new Date(iso).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
}

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

type Period = 'week' | 'month' | 'all';
interface SeriesPoint {
  label: string;
  value: number;
  /** Matches a tapped bar back to its underlying rows: for 'week' a day's
   *  toDateString(), for 'month'/'all' a "YYYY-M" month key. */
  key: string;
  /** Full label for the drill-down header, e.g. "Tuesday, 9 Sep" or "August 2026". */
  fullLabel: string;
}

/**
 * Trend bars computed client-side from the rows this screen already has —
 * no second network call, and no duplicate spend-calculation logic to keep
 * in sync with lib/analytics.ts (which does the same "confirmed only" rule
 * for the same reason: an unreviewed row is not a real number yet).
 */
function buildSeries(rows: PersonalTransaction[], period: Period): SeriesPoint[] {
  const confirmed = rows.filter((r) => r.status === 'confirmed');
  const now = new Date();

  if (period === 'week') {
    const byDay: Record<string, number> = {};
    for (const r of confirmed) {
      byDay[new Date(r.occurredAt).toDateString()] = (byDay[new Date(r.occurredAt).toDateString()] || 0) + r.amount;
    }
    const points: SeriesPoint[] = [];
    for (let back = 6; back >= 0; back--) {
      const d = new Date(now);
      d.setDate(now.getDate() - back);
      const key = d.toDateString();
      points.push({
        label: DAY_LABELS[d.getDay()],
        value: byDay[key] || 0,
        key,
        fullLabel: d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'short' }),
      });
    }
    return points;
  }

  const byMonth: Record<string, number> = {};
  for (const r of confirmed) {
    const d = new Date(r.occurredAt);
    byMonth[`${d.getFullYear()}-${d.getMonth()}`] = (byMonth[`${d.getFullYear()}-${d.getMonth()}`] || 0) + r.amount;
  }

  if (period === 'all') {
    // One bar per calendar month from the oldest confirmed row through this
    // month — every month recorded, not a fixed trailing window. rows is
    // already an unfiltered, unbounded fetch (listPersonalTransactions has
    // no date filter), so nothing extra needs loading for this.
    if (confirmed.length === 0) return [];
    const oldest = confirmed.reduce(
      (min, r) => (r.occurredAt < min ? r.occurredAt : min),
      confirmed[0].occurredAt
    );
    const oldestDate = new Date(oldest);
    const cursor = new Date(oldestDate.getFullYear(), oldestDate.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    const points: SeriesPoint[] = [];
    while (cursor <= end) {
      const key = `${cursor.getFullYear()}-${cursor.getMonth()}`;
      // Year suffix since this can span multiple years, unlike the fixed
      // 6-month window above where the year is never ambiguous.
      points.push({
        label: `${MONTH_LABELS[cursor.getMonth()]} '${String(cursor.getFullYear()).slice(2)}`,
        value: byMonth[key] || 0,
        key,
        fullLabel: cursor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
      });
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return points;
  }

  const points: SeriesPoint[] = [];
  for (let back = 5; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth() - back, 1);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    points.push({
      label: MONTH_LABELS[d.getMonth()],
      value: byMonth[key] || 0,
      key,
      fullLabel: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
    });
  }
  return points;
}

export default function FinanceHomeScreen() {
  const router = useRouter();
  const { showToast } = useToast();
  const { showAlert } = useAlert();

  const [rows, setRows] = useState<PersonalTransaction[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  // True once any load has succeeded; a later failure then keeps the rows.
  const hasLoadedRef = useRef(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [drafts, setDrafts] = useState<ReceiptDraft[]>([]);
  const [period, setPeriod] = useState<Period>('month');
  // A tapped bar's key ("week" -> a day, "month"/"all" -> a month). Cleared
  // whenever the period switches, since a bar from one period's series has
  // no counterpart in another's.
  const [selectedBarKey, setSelectedBarKey] = useState<string | null>(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    // Only show the loading state until something has loaded once; coming back
    // to the screen with good data on it shouldn't blank to "Loading…".
    else if (!hasLoadedRef.current) setLoadState('loading');
    try {
      const { data, cachedAt: resultCachedAt } = await withOfflineFallback(
        'finance.personalTransactions',
        () => listPersonalTransactions(),
      );
      setRows(data);
      setCachedAt(resultCachedAt);
      hasLoadedRef.current = true;
      setRefreshFailed(false);
      setLoadState('ready');
    } catch (e) {
      console.error('Failed to load personal transactions:', e);
      // Why: once rows exist, a failed refresh must not wipe them or turn the
      // headline into a false ₹0.00 — keep them and flag a retry banner.
      // Only a first load with nothing to show is a full 'error'.
      if (hasLoadedRef.current) {
        setRefreshFailed(true);
        setLoadState('ready');
      } else {
        setLoadState('error');
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
      listReceiptDrafts().then(setDrafts).catch(() => {});
    }, [load])
  );

  const series = useMemo(() => buildSeries(rows, period), [rows, period]);
  const maxSeries = Math.max(...series.map((s) => s.value), 1);
  // Headline figure: the trailing bucket (this week's 7 days summed, or this
  // month alone) — the bars beside it are trend context, not what's summed.
  // "All" has no single trailing bucket to isolate, so it sums every bar —
  // a lifetime total, same idea as the week sum.
  const periodTotal = period === 'month'
    ? series[series.length - 1]?.value ?? 0
    : series.reduce((sum, s) => sum + s.value, 0);

  /** Rows inside the selected window — the one definition both the count and the category breakdown read from. */
  const periodRows = useMemo(() => {
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - 6);
    weekStart.setHours(0, 0, 0, 0);
    return rows.filter((r) => {
      if (r.status !== 'confirmed') return false;
      if (period === 'all') return true;
      const d = new Date(r.occurredAt);
      return period === 'week'
        ? d >= weekStart
        : d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
    });
  }, [rows, period]);

  // Tapped bar, if any, and the rows it represents — a day's rows for
  // 'week', a month's rows for 'month'/'all'. Drills the headline figure and
  // category breakdown below into just that bar, same idea as Insights'
  // month drill-down.
  const selectedPoint = selectedBarKey ? series.find((s) => s.key === selectedBarKey) ?? null : null;
  const selectedBarRows = useMemo(() => {
    if (!selectedBarKey) return null;
    return rows.filter((r) => {
      if (r.status !== 'confirmed') return false;
      const d = new Date(r.occurredAt);
      const key = period === 'week' ? d.toDateString() : `${d.getFullYear()}-${d.getMonth()}`;
      return key === selectedBarKey;
    });
  }, [rows, period, selectedBarKey]);

  const displayRows = selectedBarRows ?? periodRows;
  const displayTotal = selectedPoint ? selectedPoint.value : periodTotal;
  const displayCount = displayRows.length;

  const categoryBreakdown = useMemo(() => {
    const byCategory: Record<string, number> = {};
    for (const r of displayRows) {
      const key = r.category || 'other';
      byCategory[key] = (byCategory[key] || 0) + r.amount;
    }
    const total = Object.values(byCategory).reduce((a, b) => a + b, 0);
    return Object.entries(byCategory)
      .map(([id, amount]) => {
        const meta = categoryMeta(id);
        return {
          id,
          label: meta.label,
          name: meta.name,
          icon: meta.icon,
          color: meta.color,
          bg: meta.bg,
          amount,
          percentage: total > 0 ? Math.round((amount / total) * 100) : 0,
        };
      })
      .sort((a, b) => b.amount - a.amount);
  }, [displayRows]);

  const handleVoid = async (id: string) => {
    try {
      await voidPersonalTransaction(id);
      setRows((prev) => prev.filter((r) => r.id !== id));
      showToast('Removed from personal spending');
    } catch (e) {
      console.error('Failed to void personal transaction:', e);
      showToast('Could not remove this — try again');
    }
  };

  const handleAddFromScreenshot = async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      showAlert(
        'Photos access needed',
        'Kinlo needs access to your photos to pick a payment screenshot. Enable it in your device Settings.',
      );
      return;
    }

    // No quality/base64 options here — prepareReceiptImage below does the
    // real downscale+recompress; asking the picker to also compress would
    // only add a second, redundant JPEG re-encode.
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });

    if (result.canceled || !result.assets?.[0]?.uri) return;
    const uri = result.assets[0].uri;

    const autoScan = (await AsyncStorage.getItem(AUTO_SCAN_KEY)) !== 'false';
    const txId = newTransactionId();

    setUploading(true);
    try {
      let base64: string;
      let mimeType: string;
      let uploadUri: string | null = null;
      try {
        const prepared = await prepareReceiptImage(uri);
        ({ base64, mimeType } = prepared);
        uploadUri = prepared.uri;
      } catch (e) {
        console.error('Image compression failed, falling back to original:', e);
        base64 = encodeBase64(new Uint8Array(await new File(uri).arrayBuffer()));
        mimeType = 'image/jpeg';
      }

      // Stash for entry.tsx to scan/preview from immediately, and let the
      // Storage upload (the audit-trail copy) happen in the background
      // rather than blocking navigation on it. Upload straight from the
      // compressed file when there is one — passing base64 instead would
      // make the upload decode it back in JS, blocking this thread right as
      // we navigate.
      stashPendingReceiptImage(txId, base64, mimeType);
      const path = await receiptImagePath(txId);
      // Local-only draft so the screenshot survives a failed scan or leaving
      // the review screen (see lib/receiptDrafts.ts).
      saveReceiptDraft(txId, path, base64, mimeType).catch((e) => console.error('Could not save receipt draft:', e));
      const upload = uploadUri
        ? new File(uploadUri).bytes().then((bytes) => uploadReceiptImageBytes(txId, bytes))
        : uploadReceiptImage(txId, base64);
      registerReceiptUpload(txId, upload);
      upload
        .catch((e) => console.error('Background receipt upload failed:', e))
        .finally(() => {
          // The compressed file on disk was only ever a read source for the
          // upload above — entry.tsx previews from the in-memory stash, not
          // this path. Once the upload settles (success or failure) it's a
          // plaintext payment screenshot with no further purpose.
          if (uploadUri) {
            try { new File(uploadUri).delete(); } catch {}
          }
        });

      router.push({
        pathname: '/finance/entry',
        params: { id: txId, path, autoScan: autoScan ? '1' : '0' },
      });
    } catch (e) {
      console.error('Failed to prepare receipt image:', e);
      showToast('Could not upload that image — try again');
    } finally {
      setUploading(false);
    }
  };

  const handleEnterManually = () => {
    router.push({ pathname: '/finance/entry', params: { id: newTransactionId() } });
  };

  // Group rows by month, newest first — rows already arrive sorted by
  // occurred_at desc from listPersonalTransactions.
  const groups: { label: string; items: PersonalTransaction[] }[] = [];
  for (const row of rows) {
    const label = monthLabel(row.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(row);
    else groups.push({ label, items: [row] });
  }

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center justify-between px-5 h-16">
        <AnimatedPressable
          onPress={() => router.back()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          className="w-10 h-10 items-center justify-center rounded-full"
        >
          <MaterialIcons name="arrow-back" size={22} color="#1c1c19" />
        </AnimatedPressable>
        <Text className="font-headline-md text-lg font-semibold text-on-surface">Personal Spending</Text>
        {/* Mirrors the "Personal" pill on Home — the same toggle, in
            reverse, so this never reads as a dead end back to Profile. */}
        <AnimatedPressable
          onPress={() => router.push('/')}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          className="flex-row items-center gap-1.5 pl-2.5 pr-3 h-9 rounded-full bg-secondary-container"
          accessibilityLabel="Split expenses"
        >
          <MaterialIcons name="call-split" size={16} color="#004c22" />
          <Text className="text-primary font-bold text-xs">Split</Text>
        </AnimatedPressable>
      </View>

      <OfflineBanner cachedAt={cachedAt} />

      {loadState === 'ready' && refreshFailed && (
        <View className="flex-row items-center justify-between mx-5 mb-2 px-3 py-2 rounded-xl bg-surface-container border border-outline-variant/30">
          <Text className="flex-1 text-xs text-on-surface-variant mr-2">Couldn't refresh — showing what we had</Text>
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
        <View
          className="p-5 rounded-3xl mb-5"
          style={{
            backgroundColor: '#fefdfc',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.4)',
            shadowColor: '#1c1917',
            shadowOffset: { width: 0, height: 4 },
            shadowOpacity: 0.05,
            shadowRadius: 12,
            elevation: 2,
          }}
        >
          <View className="mb-3">
            <View className="flex-row items-center gap-2">
              <Text className="font-label-sm text-xs text-on-surface-variant uppercase tracking-wide">
                {selectedPoint ? selectedPoint.fullLabel : period === 'week' ? 'Last 7 days' : period === 'month' ? 'This month' : 'All time'}
              </Text>
              {selectedPoint && (
                <AnimatedPressable
                  onPress={() => setSelectedBarKey(null)}
                  hitSlop={6}
                  className="flex-row items-center gap-0.5 bg-primary/10 rounded-full px-2 py-0.5"
                >
                  <MaterialIcons name="close" size={11} color="#004c22" />
                  <Text className="text-[10px] font-bold text-primary">
                    {period === 'week' ? '7d' : period === 'month' ? 'month' : 'all'}
                  </Text>
                </AnimatedPressable>
              )}
            </View>
            <Text className="font-headline-md text-3xl font-bold text-primary mt-1" style={tabularNums} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{loadState === 'error' ? '—' : money(displayTotal)}</Text>
            <Text className="text-[11px] text-on-surface-variant font-medium mt-0.5">
              {loadState === 'error'
                ? 'Could not load'
                : loadState === 'loading'
                  ? 'Loading…'
                  : displayCount === 0 ? 'No expenses' : `${displayCount} expense${displayCount === 1 ? '' : 's'}`}
            </Text>
          </View>

          {/* Week/Month toggle — same segmented-pill treatment used for the
              Overall/Split/Personal switch on Insights. Own row rather than
              squeezed next to the amount above: React Native doesn't shrink
              flex-row children by default, and crammed alongside a 3xl-bold
              currency amount, this row could exceed the card's width on
              narrower phones — pushing the pills (especially the last one)
              past the tappable area even though they still render. Insights'
              equivalent toggle already gets its own full-width row for the
              same reason. */}
          <View className="flex-row p-1 rounded-2xl self-start mb-1" style={{ backgroundColor: 'rgba(0,0,0,0.05)' }}>
            {(['week', 'month', 'all'] as Period[]).map((p) => {
              const active = period === p;
              return (
                <AnimatedPressable
                  key={p}
                  onPress={() => { setPeriod(p); setSelectedBarKey(null); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={{
                    paddingHorizontal: 12,
                    paddingVertical: 6,
                    borderRadius: 12,
                    backgroundColor: active ? '#caead6' : 'transparent',
                    borderWidth: active ? 1 : 0,
                    borderColor: '#004c22',
                  }}
                >
                  <Text style={{ fontSize: 11, fontWeight: '700', color: active ? '#004c22' : '#707a6f' }}>
                    {p === 'week' ? 'Week' : p === 'month' ? 'Month' : 'All'}
                  </Text>
                </AnimatedPressable>
              );
            })}
          </View>

          {/* Trend bars, same plain-View bar chart already used on Insights
              — no chart library, consistent look across both screens.
              "All" can be many months, so it scrolls horizontally with a
              fixed bar width instead of squeezing flex-1 bars into
              illegibility; week/month stay the original fixed-width row
              since 6-7 bars always fit. nestedScrollEnabled: same Android
              nested-ScrollView fix as Home's friends strip — this sits
              inside the page's outer vertical ScrollView too. */}
          {period === 'all' ? (
            <ScrollView
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator={false}
              className="mt-3"
              contentContainerStyle={{ alignItems: 'flex-end', height: 80, paddingRight: 8 }}
            >
              {series.map((point, idx) => {
                const isCurrent = idx === series.length - 1;
                const isSelected = point.key === selectedBarKey;
                const heightPct = Math.max((point.value / maxSeries) * 100, 2);
                return (
                  <AnimatedPressable
                    key={`${point.label}-${idx}`}
                    style={{ width: 36 }}
                    className="items-center justify-end h-full mx-0.5"
                    disabled={point.value === 0}
                    onPress={() => setSelectedBarKey((prev) => (prev === point.key ? null : point.key))}
                  >
                    <View
                      style={{
                        height: `${heightPct}%`,
                        width: '60%',
                        backgroundColor: isSelected ? '#d97706' : isCurrent ? '#004c22' : 'rgba(0,76,34,0.25)',
                        borderRadius: 5,
                      }}
                    />
                    <Text
                      className="text-[10px] font-medium mt-1"
                      style={{ color: isSelected ? '#d97706' : '#707a6f', fontWeight: isSelected ? '700' : '500' }}
                    >
                      {point.label}
                    </Text>
                  </AnimatedPressable>
                );
              })}
            </ScrollView>
          ) : (
            <View className="h-20 w-full mt-3 flex-row items-end justify-between">
              {series.map((point, idx) => {
                const isCurrent = idx === series.length - 1;
                const isSelected = point.key === selectedBarKey;
                const heightPct = Math.max((point.value / maxSeries) * 100, 2);
                return (
                  <AnimatedPressable
                    key={`${point.label}-${idx}`}
                    className="flex-1 items-center justify-end h-full mx-0.5"
                    disabled={point.value === 0}
                    onPress={() => setSelectedBarKey((prev) => (prev === point.key ? null : point.key))}
                  >
                    <View
                      style={{
                        height: `${heightPct}%`,
                        width: '60%',
                        backgroundColor: isSelected ? '#d97706' : isCurrent ? '#004c22' : 'rgba(0,76,34,0.25)',
                        borderRadius: 5,
                      }}
                    />
                    <Text
                      className="text-[10px] font-medium mt-1"
                      style={{ color: isSelected ? '#d97706' : '#707a6f', fontWeight: isSelected ? '700' : '500' }}
                    >
                      {point.label}
                    </Text>
                  </AnimatedPressable>
                );
              })}
            </View>
          )}
        </View>

        <View className="flex-row gap-3 mb-6">
          <AnimatedPressable
            onPress={handleAddFromScreenshot}
            disabled={uploading}
            className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-2xl bg-primary"
          >
            <MaterialIcons name="document-scanner" size={18} color="#ffffff" />
            <Text className="text-white font-bold text-sm">{uploading ? 'Uploading…' : 'Add from screenshot'}</Text>
          </AnimatedPressable>
          <AnimatedPressable
            onPress={handleEnterManually}
            className="flex-1 flex-row items-center justify-center gap-2 py-3.5 rounded-2xl"
            style={{ backgroundColor: 'rgba(0,0,0,0.05)' }}
          >
            <MaterialIcons name="edit" size={18} color="#404940" />
            <Text className="text-on-surface font-bold text-sm">Enter manually</Text>
          </AnimatedPressable>
        </View>

        {/* Category analytics — scoped to the same Week/Month window as the
            trend chart above, so the two never describe different periods. */}
        {loadState === 'ready' && categoryBreakdown.length > 0 && (
          <View
            className="p-5 rounded-3xl mb-5"
            style={{
              backgroundColor: '#fefdfc',
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.4)',
              shadowColor: '#1c1917',
              shadowOffset: { width: 0, height: 4 },
              shadowOpacity: 0.05,
              shadowRadius: 12,
              elevation: 2,
            }}
          >
            <Text className="font-headline-md text-base font-bold text-on-surface mb-1">
              Where it goes
            </Text>
            <Text className="text-[11px] text-on-surface-variant mb-4">
              Categories ordered by size, with the running share across them.
            </Text>

            <ParetoChart
              data={categoryBreakdown.map((c) => ({
                id: c.id,
                label: c.label,
                amount: c.amount,
                color: c.color,
              }))}
            />

            <View className="mt-5 gap-2.5">
              {categoryBreakdown.map((c, index) => (
                <AnimatedListItem key={c.id} index={index}>
                  <View className="flex-row items-center gap-3">
                    <View
                      className="w-9 h-9 rounded-xl items-center justify-center"
                      style={{ backgroundColor: c.bg }}
                    >
                      <MaterialIcons name={c.icon as any} size={18} color={c.color} />
                    </View>
                    <View className="flex-1 mr-2">
                      <Text className="font-semibold text-sm text-on-surface" numberOfLines={1}>
                        {c.name}
                      </Text>
                      <View className="w-full h-1.5 bg-outline-variant/30 rounded-full mt-1.5 overflow-hidden">
                        <View
                          className="h-full rounded-full"
                          style={{ width: `${c.percentage}%`, backgroundColor: c.color }}
                        />
                      </View>
                    </View>
                    <View className="items-end">
                      <Text className="font-bold text-sm text-on-surface" style={tabularNums}>{money(c.amount)}</Text>
                      <Text className="text-[10px] text-on-surface-variant mt-0.5">{c.percentage}%</Text>
                    </View>
                  </View>
                </AnimatedListItem>
              ))}
            </View>
          </View>
        )}

        {drafts.length > 0 && (
          <View className="mb-5 rounded-2xl bg-surface-container border border-outline-variant/30 p-4">
            <Text className="text-sm font-semibold text-on-surface mb-1">Unsaved scans</Text>
            <Text className="text-xs text-on-surface-variant mb-3">
              Saved on this device only. Open one to scan or finish it.
            </Text>
            {drafts.map((d) => (
              <View key={d.id} className="flex-row items-center gap-2 mb-2">
                <AnimatedPressable
                  className="flex-1 flex-row items-center gap-2 h-11 px-3 rounded-xl bg-surface-container-highest"
                  onPress={() =>
                    router.push({ pathname: '/finance/entry', params: { id: d.id, path: d.path, autoScan: '0' } })
                  }
                >
                  <MaterialIcons name="receipt-long" size={18} color="#004c22" />
                  <Text className="flex-1 text-sm text-on-surface" numberOfLines={1}>
                    Screenshot from {new Date(d.createdAt).toLocaleString()}
                  </Text>
                  <MaterialIcons name="chevron-right" size={18} color="#404940" />
                </AnimatedPressable>
                <AnimatedPressable
                  className="w-11 h-11 rounded-xl items-center justify-center bg-surface-container-highest"
                  accessibilityLabel="Discard unsaved scan"
                  onPress={async () => {
                    await deleteReceiptDraft(d.id).catch(() => {});
                    setDrafts((prev) => prev.filter((x) => x.id !== d.id));
                  }}
                >
                  <MaterialIcons name="delete-outline" size={18} color="#404940" />
                </AnimatedPressable>
              </View>
            ))}
          </View>
        )}

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
            <Text className="text-on-surface font-bold text-lg mb-1 mt-3">Could not load your spending</Text>
            <Text className="text-on-surface-variant text-center max-w-xs text-sm">
              Check your connection and try again.
            </Text>
            <AnimatedPressable onPress={() => load()} className="mt-5 bg-primary px-6 py-3 rounded-xl">
              <Text className="text-white font-semibold">Try Again</Text>
            </AnimatedPressable>
          </View>
        )}

        {loadState === 'ready' && rows.length === 0 && (
          <View className="items-center py-10 gap-3">
            <View className="w-16 h-16 rounded-full bg-secondary-container items-center justify-center">
              <MaterialIcons name="document-scanner" size={28} color="#004c22" />
            </View>
            <View className="gap-1">
              <Text className="text-base font-bold text-on-surface text-center">No personal expenses yet</Text>
              <Text className="text-sm text-on-surface-variant text-center">
                Scan a payment screenshot and Kinlo will fill in the amount, merchant, and category for you.
              </Text>
            </View>
            <AnimatedPressable
              onPress={handleAddFromScreenshot}
              disabled={uploading}
              className="flex-row items-center gap-2 px-4 py-2.5 rounded-xl bg-primary mt-1"
            >
              <MaterialIcons name="document-scanner" size={16} color="#ffffff" />
              <Text className="text-white font-bold text-xs">{uploading ? 'Uploading…' : 'Scan a payment screenshot'}</Text>
            </AnimatedPressable>
          </View>
        )}

        {loadState === 'ready' &&
          groups.map((group) => (
            <View key={group.label} className="mb-5">
              <Text className="text-xs font-bold text-on-surface-variant uppercase tracking-wide mb-2 pl-1">
                {group.label}
              </Text>
              {group.items.map((row, index) => {
                const meta = categoryMeta(row.category);
                const unverified = row.confidence !== null && row.confidence < 0.75 && row.editedFields.length === 0;
                return (
                  <AnimatedListItem key={row.id} index={index}>
                    <SwipeableRow
                      onDelete={() => handleVoid(row.id)}
                      confirmTitle="Remove this expense?"
                      confirmMessage="This removes it from your personal spending and Insights. The receipt image stays as a record."
                      confirmLabel="Remove"
                    >
                      <AnimatedPressable
                        onPress={() => router.push(`/finance/${row.id}`)}
                        className="p-4 rounded-2xl flex-row items-center justify-between mb-2"
                        style={{
                          backgroundColor: '#fefdfc',
                          borderWidth: 1,
                          borderColor: 'rgba(255,255,255,0.35)',
                        }}
                      >
                        <View className="flex-row items-center gap-3 flex-1">
                          <View className="w-11 h-11 rounded-xl items-center justify-center" style={{ backgroundColor: meta.bg }}>
                            <MaterialIcons name={meta.icon as any} size={20} color={meta.color} />
                          </View>
                          <View className="flex-1 mr-2">
                            <Text className="font-semibold text-base text-on-surface" numberOfLines={1}>
                              {row.merchant || row.description || 'Untitled'}
                            </Text>
                            <Text className="text-xs text-on-surface-variant mt-0.5">
                              {new Date(row.occurredAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
                              {unverified && '  •  '}
                              {unverified && <Text className="text-amber-600 font-bold">Unverified</Text>}
                            </Text>
                          </View>
                        </View>
                        <Text className="font-bold text-base text-on-surface" style={tabularNums}>{money(row.amount)}</Text>
                      </AnimatedPressable>
                    </SwipeableRow>
                  </AnimatedListItem>
                );
              })}
            </View>
          ))}
      </ScrollView>
    </SafeAreaView>
  );
}
