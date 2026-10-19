import React, { useState, useCallback, useRef, useEffect } from 'react';
import { View, Text, ScrollView, Animated, StyleSheet, RefreshControl } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Skeleton, SkeletonCard } from '../../components/Skeleton';
import { AnimatedPressable } from '../../components/AnimatedPressable';
import { AnimatedListItem } from '../../components/AnimatedListItem';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { fetchAnalytics, AnalyticsData, SpendScope, WindowPreset } from '../../lib/analytics';
import { categoryMeta } from '../../lib/categories';
import { formatINR, tabularNums } from '../../lib/format';

// Premium HSL Tailored Kinlo Theme Colors
const COLORS = {
  primary: '#004c22', // Forest Green
  primaryContainer: '#166534',
  secondaryContainer: '#caead6', // Sage Pastel
  tertiaryContainer: '#27633b',
  onSurface: '#1c1c19',
  onSurfaceVariant: '#404940',
  outlineVariant: '#bfc9bd',
  background: '#fcf9f4', // Warm Sand
  success: '#15803d',
  error: '#b91c1c',
  amber: '#d97706',
};

const money = (n: number) => formatINR(n, { decimals: 2 });

/** Display strings per window preset — one place so the toggle pill, the headline label, the
 *  "no expenses ___" phrase, and the drill-down clear-pill can never disagree with each other. */
const WINDOW_TEXT: Record<WindowPreset, { pill: string; label: string; phrase: string; short: string }> = {
  '1w': { pill: '1 Week', label: 'Last 7 days', phrase: 'in the last 7 days', short: '7d' },
  '1m': { pill: '1 Month', label: 'Last 4 weeks', phrase: 'in the last 4 weeks', short: '4wk' },
  '6m': { pill: '6 Months', label: 'Last 6 months', phrase: 'in the last 6 months', short: '6 mo' },
  '12m': { pill: '12 Months', label: 'Last 12 months', phrase: 'in the last 12 months', short: '12 mo' },
};

export default function AnalyticsScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [scope, setScope] = useState<SpendScope>('overall');
  const [windowPreset, setWindowPreset] = useState<WindowPreset>('6m');
  // "YYYY-MM" of a tapped bar — drills every figure below into that single
  // month instead of the whole 6/12-month window. Tapping the same bar again
  // (or switching scope/window) clears it back to the aggregate view.
  const [selectedMonthKey, setSelectedMonthKey] = useState<string | null>(null);

  // A category selected in one scope may not exist in another — clear it on
  // switch rather than carrying over a stale highlight. Same reasoning for a
  // month drill-down: a different scope's month may have no data at all.
  const changeScope = (next: SpendScope) => {
    setScope(next);
    setSelectedCategory(null);
    setSelectedMonthKey(null);
  };

  // Optional deep link from Home's spend tiles so the figure tapped there is
  // the one shown here. Absent params (the tab bar, any other caller) leave
  // every default above untouched. `t` is a nonce so tapping the same tile
  // again re-applies the view after the user has changed the toggles.
  const params = useLocalSearchParams<{ scope?: string; window?: string; month?: string; t?: string }>();
  useEffect(() => {
    if (!params.t) return;
    const nextScope: SpendScope | null =
      params.scope === 'split' || params.scope === 'personal' || params.scope === 'overall' ? params.scope : null;
    const nextWindow: WindowPreset | null =
      params.window === '1w' || params.window === '1m' || params.window === '6m' || params.window === '12m'
        ? params.window
        : null;
    if (nextScope) setScope(nextScope);
    if (nextWindow) setWindowPreset(nextWindow);
    setSelectedCategory(null);
    if (params.month === 'current') {
      const now = new Date();
      setSelectedMonthKey(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
    } else {
      setSelectedMonthKey(null);
    }
  }, [params.t, params.scope, params.window, params.month]);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoadState('loading');
    try {
      const result = await fetchAnalytics(windowPreset);
      setData(result);
      setLoadState('ready');
      setErrorMessage(null);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 500, useNativeDriver: true }),
      ]).start();
    } catch (e: any) {
      console.warn('Analytics load failed:', e);
      setLoadState('error');
      setErrorMessage(e?.message || 'Could not load your spending data.');
    }
  }, [fadeAnim, slideAnim, windowPreset]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  // Also refetch immediately when the window toggle changes while already
  // focused — useFocusEffect above only fires on (re)focus, not on this.
  // Skips its own first run: the focus effect already covers initial mount,
  // and firing both here would double-fetch on load.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowPreset]);

  const onRefresh = async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  };

  const Header = (
    <View
      className="px-5 pb-4 flex-row justify-between items-center z-50 border-b border-outline-variant/30 shadow-sm"
      style={{
        paddingTop: Math.max(insets.top, 24),
        backgroundColor: 'rgba(252, 249, 244, 0.72)',
      }}
    >
      <Text className="font-headline-md font-bold text-primary text-xl">Insights</Text>
      <AnimatedPressable onPress={() => load()} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
        <MaterialIcons name="refresh" size={22} color="#1c1c19" />
      </AnimatedPressable>
    </View>
  );

  if (loadState === 'loading') {
    // Shaped like the insights that are coming — a headline figure, then the
    // breakdown rows — so the page does not reflow when they arrive.
    return (
      <View className="flex-1 bg-background">
        {Header}
        <ScrollView className="flex-1 px-5 pt-4" scrollEnabled={false}>
          <SkeletonCard height={132} />

          <View className="flex-row mt-4">
            <SkeletonCard height={104} style={{ flex: 1, marginRight: 12 }} />
            <SkeletonCard height={104} style={{ flex: 1 }} />
          </View>

          <Skeleton width="40%" height={12} style={{ marginTop: 28, marginBottom: 6 }} />
          <View
            className="rounded-3xl p-5 mt-2"
            style={{
              backgroundColor: 'rgba(255,255,255,0.6)',
              borderWidth: 1,
              borderColor: 'rgba(0,0,0,0.05)',
            }}
          >
            {[0, 1, 2, 3].map(i => (
              <View key={i} style={{ marginBottom: i === 3 ? 0 : 18 }}>
                <View className="flex-row items-center justify-between mb-2">
                  <Skeleton width="34%" height={12} />
                  <Skeleton width={62} height={12} />
                </View>
                {/* The bar each category row draws. */}
                <Skeleton width={`${88 - i * 18}%`} height={9} radius={5} />
              </View>
            ))}
          </View>
        </ScrollView>
      </View>
    );
  }

  if (loadState === 'error') {
    return (
      <View className="flex-1 bg-background">
        {Header}
        <View className="flex-1 items-center justify-center px-8">
          <MaterialIcons name="error-outline" size={48} color={COLORS.error} />
          <Text className="font-headline-md text-lg font-bold text-on-surface mt-4 text-center">Could not load insights</Text>
          <Text className="text-sm text-on-surface-variant mt-2 text-center leading-relaxed">{errorMessage}</Text>
          <AnimatedPressable onPress={() => load()} className="mt-6 bg-primary px-6 py-3 rounded-xl">
            <Text className="text-white font-semibold">Try Again</Text>
          </AnimatedPressable>
        </View>
      </View>
    );
  }

  // No expenses at all. Show an empty state rather than a page of zeroes,
  // which would read as "you spent nothing" instead of "nothing recorded yet".
  if (!data || !data.hasAnyData) {
    return (
      <View className="flex-1 bg-background">
        {Header}
        <View className="flex-1 items-center justify-center px-8">
          <MaterialIcons name="insights" size={56} color={COLORS.outlineVariant} />
          <Text className="font-headline-md text-lg font-bold text-on-surface mt-4 text-center">No spending yet</Text>
          <Text className="text-sm text-on-surface-variant mt-2 text-center leading-relaxed">
            Once you add a few expenses, this screen will show where your money goes each month and how it compares with the people you split with.
          </Text>
        </View>
      </View>
    );
  }

  const view = data[scope];
  const maxSeries = Math.max(...view.series.map(s => s.value), 1);

  // A tapped bar drills every headline figure, the category list, and the
  // split/personal mix into that single month. Cleared (monthDetail null)
  // falls back to the whole 6/12-month window exactly as before.
  const monthDetail = selectedMonthKey ? view.monthlyDetail[selectedMonthKey] : null;
  const displaySpend = monthDetail ? monthDetail.spend : view.windowSpend;
  const displayCount = monthDetail ? monthDetail.count : view.windowExpenseCount;
  const displayCategories = monthDetail ? monthDetail.categories : view.categories;
  const displayTopCategory = monthDetail ? (monthDetail.categories[0] || null) : view.topCategory;

  const activeCategory =
    displayCategories.find(c => c.id === selectedCategory) || displayTopCategory;

  const changeIsDown = view.changePercent !== null && view.changePercent < 0;
  const changeLabel =
    view.changePercent === null
      ? null
      : `${Math.abs(view.changePercent).toFixed(1)}%`;

  // Only claim a comparison when there is actually someone to compare
  // against — and only on scopes where a group average means anything.
  // Comparing personal spend to a group average is meaningless (nobody else
  // is party to it), so this section is split/overall-only.
  const canCompare =
    scope !== 'personal' &&
    view.myMonthlyAverage !== null && data.groupMonthlyAverage !== null && data.groupMonthlyAverage > 0;
  const comparePercent = canCompare
    ? ((view.myMonthlyAverage! - data.groupMonthlyAverage!) / data.groupMonthlyAverage!) * 100
    : null;
  const compareMax = canCompare
    ? Math.max(view.myMonthlyAverage!, data.groupMonthlyAverage!, 1)
    : 1;

  const mixTotal = selectedMonthKey ? (data.overall.monthlyDetail[selectedMonthKey]?.spend ?? 0) : data.overall.windowSpend;
  const mixSplitSpend = selectedMonthKey ? (data.split.monthlyDetail[selectedMonthKey]?.spend ?? 0) : data.split.windowSpend;
  const splitPct = mixTotal > 0 ? Math.round((mixSplitSpend / mixTotal) * 100) : 0;
  const personalPct = mixTotal > 0 ? 100 - splitPct : 0;

  const SCOPE_TABS: { id: SpendScope; label: string }[] = [
    { id: 'overall', label: 'Overall' },
    { id: 'split', label: 'Split' },
    { id: 'personal', label: 'Personal' },
  ];

  const windowLabel = monthDetail ? monthDetail.fullLabel : WINDOW_TEXT[windowPreset].label;
  const periodPhrase = monthDetail ? `in ${monthDetail.fullLabel}` : WINDOW_TEXT[windowPreset].phrase;

  return (
    <View className="flex-1 bg-background">
      {Header}

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
      >
        {/* Explicit gap rather than a `space-y-*` class — that utility did not
            apply reliably here and the cards ended up touching at the corners. */}
        <Animated.View
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }], gap: 18 }}
          className="px-5 pt-6 max-w-xl mx-auto w-full"
        >

          {/* Scope segmented control — switching is pure client-side (all
              three breakdowns already arrived in one fetchAnalytics() call),
              so there is no refetch and no loading flash. Own row from the
              window toggle below rather than crammed onto one row — Home's
              header taught this app that a tight row of pills has no slack
              for a second control before it overflows on narrower phones. */}
          <View className="flex-row p-1 rounded-2xl self-start" style={{ backgroundColor: 'rgba(255,255,255,0.65)' }}>
            {SCOPE_TABS.map((tab) => {
              const active = scope === tab.id;
              return (
                <AnimatedPressable
                  key={tab.id}
                  onPress={() => changeScope(tab.id)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={{
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    borderRadius: 14,
                    backgroundColor: active ? '#caead6' : 'transparent',
                    borderWidth: active ? 1 : 0,
                    borderColor: '#004c22',
                  }}
                >
                  <Text style={{ fontSize: 13, fontWeight: '700', color: active ? '#004c22' : '#707a6f' }}>
                    {tab.label}
                  </Text>
                </AnimatedPressable>
              );
            })}
          </View>

          {/* Window toggle — this changes the fetched data (unlike the scope
              tabs above), so switching does show a brief loading flash while
              fetchAnalytics re-runs with the new preset. Custom range is
              deliberately not here yet — needs a date-picker dependency this
              project doesn't have, queued for a later build.
              Tighter padding/font than the scope tabs above (10/7/12 vs
              16/8/13) — 4 pills at the original sizing overflow a narrow
              phone's content width, the same crowding bug already found and
              fixed on the personal-finance screen's toggle. */}
          <View className="flex-row p-1 rounded-2xl self-start" style={{ backgroundColor: 'rgba(255,255,255,0.65)' }}>
            {(['1w', '1m', '6m', '12m'] as WindowPreset[]).map((p) => {
              const active = windowPreset === p;
              return (
                <AnimatedPressable
                  key={p}
                  onPress={() => { setWindowPreset(p); setSelectedMonthKey(null); }}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 7,
                    borderRadius: 14,
                    backgroundColor: active ? '#caead6' : 'transparent',
                    borderWidth: active ? 1 : 0,
                    borderColor: '#004c22',
                  }}
                >
                  <Text style={{ fontSize: 12, fontWeight: '700', color: active ? '#004c22' : '#707a6f' }}>
                    {WINDOW_TEXT[p].pill}
                  </Text>
                </AnimatedPressable>
              );
            })}
          </View>

          {/* 1. Spending in the selected window */}
          <View className="p-6 rounded-3xl relative overflow-hidden" style={styles.liquidGlass}>
            <View className="flex-row justify-between items-start mb-4">
              {/* flexShrink only matters when the row would overflow (a very
                  large total next to the change pill); normal amounts keep
                  their natural width, so the layout is unchanged. */}
              <View className="gap-1" style={{ flexShrink: 1 }}>
                <View className="flex-row items-center gap-2">
                  <Text className="font-label-md text-sm text-on-surface-variant font-semibold">
                    {scope === 'personal' ? 'Personal Spending' : 'Your Spending'} · {windowLabel}
                  </Text>
                  {monthDetail && (
                    <AnimatedPressable
                      onPress={() => setSelectedMonthKey(null)}
                      hitSlop={6}
                      className="flex-row items-center gap-0.5 bg-primary/10 rounded-full px-2 py-0.5"
                    >
                      <MaterialIcons name="close" size={11} color={COLORS.primary} />
                      <Text className="text-[10px] font-bold text-primary">{WINDOW_TEXT[windowPreset].short}</Text>
                    </AnimatedPressable>
                  )}
                </View>
                <Text className="font-display-lg text-4xl font-bold text-primary" style={tabularNums} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>{money(displaySpend)}</Text>
                <Text className="text-[11px] text-on-surface-variant font-medium mt-0.5">
                  {displayCount === 0
                    ? `No expenses ${periodPhrase}`
                    : scope === 'split'
                    ? `Your share of ${displayCount} expense${displayCount === 1 ? '' : 's'}`
                    : scope === 'personal'
                    ? `${displayCount} personal expense${displayCount === 1 ? '' : 's'}`
                    : `${displayCount} expense${displayCount === 1 ? '' : 's'} ${periodPhrase}`}
                </Text>
              </View>

              {changeLabel && (
                <View
                  className="flex-row items-center px-3 py-1 rounded-full gap-1"
                  style={{ backgroundColor: changeIsDown ? '#DCFCE7' : '#FEE2E2' }}
                >
                  <MaterialIcons
                    name={changeIsDown ? 'trending-down' : 'trending-up'}
                    size={14}
                    color={changeIsDown ? COLORS.primary : COLORS.error}
                  />
                  <Text className="font-bold text-xs" style={{ color: changeIsDown ? COLORS.primary : COLORS.error }}>
                    {changeLabel}
                  </Text>
                </View>
              )}
            </View>

            {/* Bar chart, drawn with plain views (no SVG dependency).
                1 Week: 7 daily bars. 1 Month: 4 trailing weekly bars. 6/12
                Months: 6 or 12 trailing calendar-month bars
                (lib/analytics.ts's buildBucketBreakdown / buildMonthlySeries)
                — flex-1 per bar divides the row evenly regardless of count,
                so all four fit without scrolling. */}
            <View className="h-28 w-full mt-2 flex-row items-end justify-between">
              {view.series.map((point, idx) => {
                const isCurrent = idx === view.series.length - 1;
                const isSelected = point.monthKey === selectedMonthKey;
                const hasData = point.value > 0;
                const heightPct = Math.max((point.value / maxSeries) * 100, 2);
                return (
                  <AnimatedPressable
                    key={`${point.label}-${idx}`}
                    className="flex-1 items-center justify-end h-full mx-0.5"
                    disabled={!hasData}
                    // Tapping the already-selected bar clears the drill-down
                    // back to the whole window, matching the "×" pill above.
                    onPress={() => setSelectedMonthKey(prev => (prev === point.monthKey ? null : point.monthKey))}
                  >
                    <View
                      style={{
                        height: `${heightPct}%`,
                        width: '70%',
                        backgroundColor: isSelected
                          ? COLORS.amber
                          : isCurrent
                          ? COLORS.primary
                          : 'rgba(0,76,34,0.25)',
                        borderRadius: 6,
                      }}
                    />
                    <Text
                      className="text-[10px] font-medium mt-1.5"
                      style={{ color: isSelected ? COLORS.amber : COLORS.onSurfaceVariant, fontWeight: isSelected ? '700' : '500' }}
                    >
                      {point.label}
                    </Text>
                  </AnimatedPressable>
                );
              })}
            </View>
            {!selectedMonthKey && (
              <Text className="text-[10px] text-on-surface-variant text-center mt-1.5 opacity-70">
                Tap a bar to see that month
              </Text>
            )}
            {view.previousWindowSpend === 0 && (
              <Text className="text-[11px] text-on-surface-variant text-center mt-2">
                No spending recorded in the previous period, so there is nothing to compare against yet.
              </Text>
            )}

            {/* Split vs. personal mix — directly answers "segregated values
                of personal and split and overall" in one glance. Overall
                scope only; on split/personal scopes this card already shows
                nothing but that one number. */}
            {scope === 'overall' && mixTotal > 0 && (
              <View className="mt-4 pt-4" style={{ borderTopWidth: 1, borderTopColor: 'rgba(0,0,0,0.06)' }}>
                <View className="flex-row justify-between mb-1.5">
                  <Text className="text-[11px] font-semibold text-on-surface-variant">{splitPct}% Split</Text>
                  <Text className="text-[11px] font-semibold text-on-surface-variant">{personalPct}% Personal</Text>
                </View>
                <View className="w-full h-2 rounded-full overflow-hidden flex-row" style={{ backgroundColor: 'rgba(0,0,0,0.06)' }}>
                  <View style={{ width: `${splitPct}%`, backgroundColor: COLORS.primary }} />
                  <View style={{ width: `${personalPct}%`, backgroundColor: COLORS.amber }} />
                </View>
              </View>
            )}
          </View>

          {/* 2. Expense count + Top category
              Both cards used to be sized with aspectRatio: 1, the only cards
              on this screen sized that way rather than with a fixed height.
              Combined with this card's shadow/elevation, that's a known
              Android rendering bug: aspectRatio needs a second layout pass to
              resolve a height from the measured width, and the elevation
              shadow layer can get painted at the pre-resolution size before
              that pass completes — a smaller, squared-off box left behind
              inside the correctly-sized rounded card. A fixed height needs
              only one layout pass, so there's nothing for the shadow to fall
              out of sync with. */}
          <View className="flex-row justify-between">
            <View style={[styles.liquidGlass, { width: '48%', height: 172 }]} className="p-5 rounded-3xl justify-between flex-col">
              <View className="w-10 h-10 rounded-full bg-[#dcfce7] items-center justify-center">
                <MaterialIcons name="receipt-long" size={20} color={COLORS.primaryContainer} />
              </View>
              <View>
                <Text className="font-label-sm text-xs text-on-surface-variant uppercase tracking-wide">Expenses</Text>
                <Text className="font-headline-md text-2xl font-bold text-primary mt-0.5">{displayCount}</Text>
                <Text className="text-[9px] text-on-surface-variant font-semibold uppercase tracking-wider mt-1">{windowLabel}</Text>
              </View>
            </View>

            <View style={[styles.liquidGlass, { width: '48%', height: 172 }]} className="p-5 rounded-3xl justify-between flex-col border border-primary/20">
              <View className="flex-row justify-between items-start w-full">
                <View
                  className="w-10 h-10 rounded-full items-center justify-center"
                  style={{ backgroundColor: displayTopCategory ? categoryMeta(displayTopCategory.id).bg : '#e5e7eb' }}
                >
                  <MaterialIcons
                    name={(displayTopCategory?.icon as any) || 'category'}
                    size={20}
                    color={displayTopCategory ? categoryMeta(displayTopCategory.id).color : COLORS.onSurfaceVariant}
                  />
                </View>
                {displayTopCategory && (
                  <View className="bg-primary/10 px-2 py-0.5 rounded-full">
                    <Text className="text-primary font-bold text-[9px]">{displayTopCategory.percentage}%</Text>
                  </View>
                )}
              </View>
              <View>
                <Text className="font-label-sm text-xs text-on-surface-variant uppercase tracking-wide">Top Category</Text>
                <Text className="font-headline-md text-xl font-bold text-primary mt-0.5" numberOfLines={1}>
                  {displayTopCategory?.name || '—'}
                </Text>
                <Text className="text-[9px] text-on-surface-variant font-semibold uppercase tracking-wider mt-1">
                  {displayTopCategory ? money(displayTopCategory.amount) : 'No expenses yet'}
                </Text>
              </View>
            </View>
          </View>

          {/* 3. Category breakdown */}
          <View className="p-6 rounded-3xl" style={styles.liquidGlass}>
            <Text className="font-headline-md text-lg font-bold text-on-surface mb-4">Spend Breakdown</Text>

            {displayCategories.length === 0 ? (
              scope === 'personal' && !monthDetail ? (
                <View className="items-center py-6 gap-3">
                  <Text className="text-sm text-on-surface-variant text-center">
                    No personal expenses yet.
                  </Text>
                  <AnimatedPressable
                    onPress={() => router.push('/finance')}
                    className="flex-row items-center gap-2 px-4 py-2.5 rounded-xl bg-primary"
                  >
                    <MaterialIcons name="document-scanner" size={16} color="#ffffff" />
                    <Text className="text-white font-bold text-xs">Scan a payment screenshot</Text>
                  </AnimatedPressable>
                </View>
              ) : (
                <Text className="text-sm text-on-surface-variant text-center py-4">
                  No expenses {periodPhrase} yet.
                </Text>
              )
            ) : (
              <View className="gap-4">
                {displayCategories.map((c, cIndex) => {
                  const isActive = (selectedCategory || displayTopCategory?.id) === c.id;
                  const palette = categoryMeta(c.id);
                  return (
                    <AnimatedListItem key={c.id} index={cIndex}>
                    <AnimatedPressable
                      onPress={() => setSelectedCategory(c.id)}
                      className="p-3.5 rounded-2xl flex-row items-center justify-between"
                      style={{
                        backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.4)',
                        borderWidth: 1,
                        borderColor: isActive ? COLORS.primary : 'rgba(255, 255, 255, 0.2)',
                        marginBottom: 10,
                      }}
                    >
                      <View className="flex-row items-center gap-3 flex-1">
                        <View className="w-10 h-10 rounded-xl items-center justify-center" style={{ backgroundColor: palette.bg }}>
                          <MaterialIcons name={c.icon as any} size={20} color={palette.color} />
                        </View>
                        <View className="flex-1 mr-2">
                          <Text className="font-semibold text-on-surface text-base">{c.name}</Text>
                          <View className="w-full h-1.5 bg-outline-variant/30 rounded-full mt-2 overflow-hidden">
                            <View className="h-full rounded-full" style={{ width: `${c.percentage}%`, backgroundColor: palette.color }} />
                          </View>
                        </View>
                      </View>
                      <View className="items-end pl-2">
                        <Text className="font-bold text-on-surface text-base" style={tabularNums}>{money(c.amount)}</Text>
                        <Text className="text-xs text-on-surface-variant font-medium mt-0.5">{c.percentage}%</Text>
                      </View>
                    </AnimatedPressable>
                    </AnimatedListItem>
                  );
                })}
              </View>
            )}

            {activeCategory && (
              <View className="bg-primary/5 p-4 rounded-2xl border border-primary/10 flex-row gap-3 items-start mt-4">
                <MaterialIcons name="insights" size={20} color={COLORS.primary} />
                <Text className="flex-1 text-sm text-primary leading-relaxed font-medium">
                  {activeCategory.name} is {activeCategory.percentage}% of your spending {periodPhrase}, at {money(activeCategory.amount)}.
                </Text>
              </View>
            )}
          </View>

          {/* 4. You vs the people you split with — meaningless for personal
              spend (nobody else is party to it), so that scope gets a note
              instead of a comparison nobody asked for. */}
          {scope === 'personal' ? (
            <View className="p-6 rounded-3xl" style={styles.liquidGlass}>
              <Text className="text-sm text-on-surface-variant text-center leading-relaxed">
                Comparison uses expenses you split with others.
              </Text>
            </View>
          ) : canCompare ? (
            <View className="p-6 rounded-3xl" style={styles.liquidGlass}>
              <Text className="font-headline-md text-lg font-bold text-on-surface mb-4">How You Compare</Text>

              <View className="gap-4 pt-2">
                <View className="gap-1.5">
                  <View className="flex-row justify-between items-center">
                    <Text className="text-sm font-semibold text-on-surface-variant">Your Monthly Average</Text>
                    <Text className="text-sm font-bold text-primary" style={tabularNums}>{money(view.myMonthlyAverage!)}</Text>
                  </View>
                  <View className="w-full h-8 bg-surface-container rounded-xl overflow-hidden justify-center pl-3">
                    <View
                      style={{ width: `${(view.myMonthlyAverage! / compareMax) * 100}%` }}
                      className="h-full bg-primary absolute left-0 top-0 rounded-l-xl"
                    />
                    <Text
                      className="text-xs font-bold z-10"
                      style={{ color: (view.myMonthlyAverage! / compareMax) < 0.2 ? COLORS.onSurface : '#ffffff' }}
                    >
                      You
                    </Text>
                  </View>
                </View>

                <View className="gap-1.5">
                  <View className="flex-row justify-between items-center">
                    <Text className="text-sm font-semibold text-on-surface-variant">Others You Split With</Text>
                    <Text className="text-sm font-bold text-on-surface" style={tabularNums}>{money(data.groupMonthlyAverage!)}</Text>
                  </View>
                  <View className="w-full h-8 bg-surface-container rounded-xl overflow-hidden justify-center pl-3">
                    <View
                      style={{ width: `${(data.groupMonthlyAverage! / compareMax) * 100}%` }}
                      className="h-full bg-outline absolute left-0 top-0 rounded-l-xl opacity-60"
                    />
                    <Text className="text-on-surface text-xs font-bold z-10">Average</Text>
                  </View>
                </View>
              </View>

              {comparePercent !== null && Math.abs(comparePercent) >= 0.1 && (
                <Text className="text-xs text-on-surface-variant font-medium mt-5 text-center leading-relaxed bg-surface-container-high/40 p-3.5 rounded-2xl">
                  💡 <Text className="font-bold text-primary">Kinlo Tip:</Text> You spend{' '}
                  <Text className="font-bold text-primary">{Math.abs(comparePercent).toFixed(1)}% {comparePercent < 0 ? 'less' : 'more'}</Text>{' '}
                  than the people you split with, on average.
                </Text>
              )}
            </View>
          ) : null}

        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  liquidGlass: {
    // Was rgba(255,255,255,0.72) — a translucent background paired with
    // `elevation` (Android's Material shadow) is a known Android rendering
    // bug: elevation's shadow/outline is computed assuming an opaque
    // background, and a transparent one leaves a mismatched rectangle
    // painted behind the actual rounded content, roughly the size of
    // whatever forced the first layout pass. #fefdfc is the same color
    // solved once, opaquely: white at 72% over this app's #fcf9f4 page
    // background, precomputed rather than composited at paint time.
    backgroundColor: '#fefdfc',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 32,
    elevation: 2,
  },
});
