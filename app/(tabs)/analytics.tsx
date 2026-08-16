import React, { useState, useCallback, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, Animated, StyleSheet, ActivityIndicator, RefreshControl } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from 'expo-router';
import { fetchAnalytics, AnalyticsData } from '../../lib/analytics';

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

// Per-category accent colours. Keyed to the ids lib/analytics.ts emits, which
// come from transactions.category.
const CATEGORY_COLORS: Record<string, { color: string; bg: string }> = {
  food: { color: COLORS.primary, bg: COLORS.secondaryContainer },
  travel: { color: COLORS.tertiaryContainer, bg: '#dcfce7' },
  home: { color: COLORS.primaryContainer, bg: '#d1fae5' },
  utilities: { color: COLORS.amber, bg: '#fef3c7' },
  other: { color: COLORS.onSurfaceVariant, bg: '#e5e7eb' },
};

const money = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function AnalyticsScreen() {
  const insets = useSafeAreaInsets();

  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;

  const load = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setLoadState('loading');
    try {
      const result = await fetchAnalytics();
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
  }, [fadeAnim, slideAnim]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

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
      <TouchableOpacity onPress={() => load()} className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container">
        <MaterialIcons name="refresh" size={22} color="#1c1c19" />
      </TouchableOpacity>
    </View>
  );

  if (loadState === 'loading') {
    return (
      <View className="flex-1 bg-background">
        {Header}
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={COLORS.primary} />
          <Text className="text-on-surface-variant mt-3 font-medium">Crunching your numbers…</Text>
        </View>
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
          <TouchableOpacity onPress={() => load()} className="mt-6 bg-primary px-6 py-3 rounded-xl">
            <Text className="text-white font-semibold">Try Again</Text>
          </TouchableOpacity>
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

  const maxSeries = Math.max(...data.series.map(s => s.value), 1);
  const activeCategory =
    data.categories.find(c => c.id === selectedCategory) || data.topCategory;

  const changeIsDown = data.changePercent !== null && data.changePercent < 0;
  const changeLabel =
    data.changePercent === null
      ? null
      : `${Math.abs(data.changePercent).toFixed(1)}%`;

  // Only claim a comparison when there is actually someone to compare against.
  const canCompare =
    data.myMonthlyAverage !== null && data.groupMonthlyAverage !== null && data.groupMonthlyAverage > 0;
  const comparePercent = canCompare
    ? ((data.myMonthlyAverage! - data.groupMonthlyAverage!) / data.groupMonthlyAverage!) * 100
    : null;
  const compareMax = canCompare
    ? Math.max(data.myMonthlyAverage!, data.groupMonthlyAverage!, 1)
    : 1;

  return (
    <View className="flex-1 bg-background">
      {Header}

      <ScrollView
        className="flex-1"
        contentContainerStyle={{ paddingBottom: 100 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.primary} />}
      >
        <Animated.View
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-5 pt-6 max-w-xl mx-auto w-full space-y-6"
        >

          {/* 1. Monthly Spending */}
          <View className="p-6 rounded-3xl relative overflow-hidden" style={styles.liquidGlass}>
            <View className="flex-row justify-between items-start mb-4">
              <View className="space-y-1">
                <Text className="font-label-md text-sm text-on-surface-variant font-semibold">Your Spending This Month</Text>
                <Text className="font-display-lg text-4xl font-bold text-primary">{money(data.monthlySpend)}</Text>
                <Text className="text-[11px] text-on-surface-variant font-medium mt-0.5">
                  Your share of {data.monthExpenseCount} expense{data.monthExpenseCount === 1 ? '' : 's'}
                </Text>
              </View>

              {changeLabel && (
                <View
                  className="flex-row items-center px-3 py-1 rounded-full space-x-1"
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

            {/* Six-month bar chart, drawn with plain views (no SVG dependency) */}
            <View className="h-28 w-full mt-2 flex-row items-end justify-between">
              {data.series.map((point, idx) => {
                const isCurrent = idx === data.series.length - 1;
                const heightPct = Math.max((point.value / maxSeries) * 100, 2);
                return (
                  <View key={`${point.label}-${idx}`} className="flex-1 items-center justify-end h-full mx-0.5">
                    <View
                      style={{
                        height: `${heightPct}%`,
                        width: '70%',
                        backgroundColor: isCurrent ? COLORS.primary : 'rgba(0,76,34,0.25)',
                        borderRadius: 6,
                      }}
                    />
                    <Text className="text-[10px] text-on-surface-variant font-medium mt-1.5">{point.label}</Text>
                  </View>
                );
              })}
            </View>
            {data.previousMonthSpend === 0 && (
              <Text className="text-[11px] text-on-surface-variant text-center mt-2">
                No spending recorded last month, so there is nothing to compare against yet.
              </Text>
            )}
          </View>

          {/* 2. Expense count + Top category */}
          <View className="flex-row justify-between">
            <View style={[styles.liquidGlass, { width: '48%', aspectRatio: 1 }]} className="p-5 rounded-3xl justify-between flex-col">
              <View className="w-10 h-10 rounded-full bg-[#dcfce7] items-center justify-center">
                <MaterialIcons name="receipt-long" size={20} color={COLORS.primaryContainer} />
              </View>
              <View>
                <Text className="font-label-sm text-xs text-on-surface-variant uppercase tracking-wide">Expenses</Text>
                <Text className="font-headline-md text-2xl font-bold text-primary mt-0.5">{data.monthExpenseCount}</Text>
                <Text className="text-[9px] text-outline-variant font-semibold uppercase tracking-wider mt-1">This month</Text>
              </View>
            </View>

            <View style={[styles.liquidGlass, { width: '48%', aspectRatio: 1 }]} className="p-5 rounded-3xl justify-between flex-col border border-primary/20">
              <View className="flex-row justify-between items-start w-full">
                <View
                  className="w-10 h-10 rounded-full items-center justify-center"
                  style={{ backgroundColor: data.topCategory ? (CATEGORY_COLORS[data.topCategory.id]?.bg || '#e5e7eb') : '#e5e7eb' }}
                >
                  <MaterialIcons
                    name={(data.topCategory?.icon as any) || 'category'}
                    size={20}
                    color={data.topCategory ? (CATEGORY_COLORS[data.topCategory.id]?.color || COLORS.onSurfaceVariant) : COLORS.onSurfaceVariant}
                  />
                </View>
                {data.topCategory && (
                  <View className="bg-primary/10 px-2 py-0.5 rounded-full">
                    <Text className="text-primary font-bold text-[9px]">{data.topCategory.percentage}%</Text>
                  </View>
                )}
              </View>
              <View>
                <Text className="font-label-sm text-xs text-on-surface-variant uppercase tracking-wide">Top Category</Text>
                <Text className="font-headline-md text-xl font-bold text-primary mt-0.5" numberOfLines={1}>
                  {data.topCategory?.name || '—'}
                </Text>
                <Text className="text-[9px] text-outline-variant font-semibold uppercase tracking-wider mt-1">
                  {data.topCategory ? money(data.topCategory.amount) : 'No expenses yet'}
                </Text>
              </View>
            </View>
          </View>

          {/* 3. Category breakdown */}
          <View className="p-6 rounded-3xl" style={styles.liquidGlass}>
            <Text className="font-headline-md text-lg font-bold text-on-surface mb-4">Spend Breakdown</Text>

            {data.categories.length === 0 ? (
              <Text className="text-sm text-on-surface-variant text-center py-4">
                No expenses recorded this month yet.
              </Text>
            ) : (
              <View className="space-y-4">
                {data.categories.map((c) => {
                  const isActive = (selectedCategory || data.topCategory?.id) === c.id;
                  const palette = CATEGORY_COLORS[c.id] || CATEGORY_COLORS.other;
                  return (
                    <TouchableOpacity
                      key={c.id}
                      onPress={() => setSelectedCategory(c.id)}
                      className="p-3.5 rounded-2xl flex-row items-center justify-between"
                      style={{
                        backgroundColor: isActive ? 'rgba(202, 234, 214, 0.2)' : 'rgba(255, 255, 255, 0.4)',
                        borderWidth: 1,
                        borderColor: isActive ? COLORS.primary : 'rgba(255, 255, 255, 0.2)',
                        marginBottom: 10,
                      }}
                    >
                      <View className="flex-row items-center space-x-3 flex-1">
                        <View className="w-10 h-10 rounded-xl items-center justify-center" style={{ backgroundColor: palette.bg }}>
                          <MaterialIcons name={c.icon as any} size={20} color={palette.color} />
                        </View>
                        <View className="flex-1 mr-2" style={{ marginLeft: 8 }}>
                          <Text className="font-semibold text-on-surface text-base">{c.name}</Text>
                          <View className="w-full h-1.5 bg-outline-variant/30 rounded-full mt-2 overflow-hidden">
                            <View className="h-full rounded-full" style={{ width: `${c.percentage}%`, backgroundColor: palette.color }} />
                          </View>
                        </View>
                      </View>
                      <View className="items-end pl-2">
                        <Text className="font-bold text-on-surface text-base">{money(c.amount)}</Text>
                        <Text className="text-xs text-on-surface-variant font-medium mt-0.5">{c.percentage}%</Text>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}

            {activeCategory && (
              <View className="bg-primary/5 p-4 rounded-2xl border border-primary/10 flex-row space-x-3 items-start mt-4">
                <MaterialIcons name="insights" size={20} color={COLORS.primary} />
                <Text className="flex-1 text-sm text-primary leading-relaxed font-medium" style={{ marginLeft: 8 }}>
                  {activeCategory.name} is {activeCategory.percentage}% of your spending this month, at {money(activeCategory.amount)}.
                </Text>
              </View>
            )}
          </View>

          {/* 4. You vs the people you split with */}
          {canCompare && (
            <View className="p-6 rounded-3xl" style={styles.liquidGlass}>
              <Text className="font-headline-md text-lg font-bold text-on-surface mb-4">How You Compare</Text>

              <View className="space-y-4 pt-2">
                <View className="space-y-1.5">
                  <View className="flex-row justify-between items-center">
                    <Text className="text-sm font-semibold text-on-surface-variant">Your Monthly Average</Text>
                    <Text className="text-sm font-bold text-primary">{money(data.myMonthlyAverage!)}</Text>
                  </View>
                  <View className="w-full h-8 bg-surface-container rounded-xl overflow-hidden justify-center pl-3">
                    <View
                      style={{ width: `${(data.myMonthlyAverage! / compareMax) * 100}%` }}
                      className="h-full bg-primary absolute left-0 top-0 rounded-l-xl"
                    />
                    <Text className="text-white text-xs font-bold z-10">You</Text>
                  </View>
                </View>

                <View className="space-y-1.5">
                  <View className="flex-row justify-between items-center">
                    <Text className="text-sm font-semibold text-on-surface-variant">Others You Split With</Text>
                    <Text className="text-sm font-bold text-on-surface">{money(data.groupMonthlyAverage!)}</Text>
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
          )}

        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  liquidGlass: {
    backgroundColor: 'rgba(255, 255, 255, 0.72)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
    shadowColor: '#1c1917',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 32,
    elevation: 2,
  },
});
