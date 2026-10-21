import React, { useCallback, useRef, useState } from 'react';
import { View, Text, ScrollView, TextInput, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { Skeleton } from '../components/Skeleton';
import { useToast } from '../components/Toast';
import { fetchMyPlan, redeemCoupon, redeemFailureMessage, FREE_SCANS_PER_MONTH, GOLD_SCANS_PER_MONTH, FREE_ACTIVE_REMINDERS, PlanInfo } from '../lib/plan';

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * Kinlo Gold: shows the current plan, what Gold includes, and a coupon field.
 * Subscriptions are not purchasable yet (BILLING_LIVE in lib/plan.ts is false):
 * Gold comes from a coupon or from the owner. The purchase UI is added with
 * the RevenueCat build; the coupon box stays either way.
 */
export default function GoldScreen() {
  const router = useRouter();
  const { showToast } = useToast();

  const [plan, setPlan] = useState<PlanInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const [code, setCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState<string | null>(null);
  const redeemingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await fetchMyPlan();
    if (result) {
      setPlan(result);
      setFailed(false);
    } else {
      setFailed(true);
    }
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  const handleRedeem = async () => {
    const trimmed = code.trim();
    if (!trimmed || redeemingRef.current) return;
    redeemingRef.current = true;
    setRedeeming(true);
    setRedeemError(null);
    const result = await redeemCoupon(trimmed);
    redeemingRef.current = false;
    setRedeeming(false);
    if (result.ok) {
      setCode('');
      showToast(`Gold unlocked until ${formatDate(result.goldUntil)}`);
      load();
    } else {
      setRedeemError(redeemFailureMessage(result.reason));
    }
  };

  const isGold = plan?.plan === 'gold';
  const used = plan?.scansUsed ?? 0;
  const limit = plan?.scansLimit ?? FREE_SCANS_PER_MONTH;
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const canRedeem = code.trim().length > 0 && !redeeming;

  return (
    <SafeAreaView className="flex-1 bg-background" edges={['top', 'bottom']}>
      <View className="flex-row items-center px-5 h-16 w-full border-b border-outline-variant/30">
        <AnimatedPressable
          onPress={() => router.back()}
          className="w-10 h-10 items-center justify-center rounded-full active:bg-surface-container"
        >
          <MaterialIcons name="arrow-back" size={24} color="#004c22" />
        </AnimatedPressable>
        <Text
          className="font-headline-md text-xl text-primary font-semibold"
          style={{ marginLeft: 6 }}
          numberOfLines={1}
        >
          Kinlo Gold
        </Text>
      </View>

      <KeyboardAvoidingView className="flex-1" behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          className="flex-1 px-5 pt-5"
          contentContainerStyle={{ paddingBottom: 48 }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Plan status */}
          {loading && !plan ? (
            <View className="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-5 mb-6">
              <Skeleton width="40%" height={20} style={{ marginBottom: 14 }} />
              <Skeleton width="70%" height={13} style={{ marginBottom: 14 }} />
              <Skeleton width="100%" height={8} />
            </View>
          ) : failed && !plan ? (
            <View className="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-5 mb-6 items-center">
              <MaterialIcons name="cloud-off" size={36} color="#bfc9bd" />
              <Text className="font-headline-md text-base font-bold text-on-surface mt-3 text-center">
                Plan details aren't available right now
              </Text>
              <Text className="text-sm text-on-surface-variant mt-1 text-center">
                Check your connection and try again.
              </Text>
              <AnimatedPressable onPress={load} className="mt-4 bg-primary px-6 py-3 rounded-xl">
                <Text className="text-on-primary font-bold text-sm">Retry</Text>
              </AnimatedPressable>
            </View>
          ) : plan ? (
            <View className="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-5 mb-6">
              <View className="flex-row items-center mb-2">
                <MaterialIcons
                  name={isGold ? 'workspace-premium' : 'person-outline'}
                  size={22}
                  color="#004c22"
                />
                <Text className="font-headline-md text-lg font-bold text-on-surface" style={{ marginLeft: 8 }}>
                  {isGold ? 'Gold member' : 'Free plan'}
                </Text>
              </View>
              {isGold ? (
                <>
                  {!!formatDate(plan.goldUntil) && (
                    <Text className="text-sm text-on-surface-variant">
                      Active until {formatDate(plan.goldUntil)}
                    </Text>
                  )}
                  <Text className="text-sm text-on-surface-variant mt-1 mb-3">
                    Receipt scans this month: {used} of {plan.scansLimit ?? GOLD_SCANS_PER_MONTH}
                  </Text>
                  <View className="h-2 rounded-full bg-surface-container overflow-hidden">
                    <View className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </View>
                </>
              ) : (
                <>
                  <Text className="text-sm text-on-surface-variant mb-3">
                    Receipt scans this month: {used} of {limit}
                  </Text>
                  <View className="h-2 rounded-full bg-surface-container overflow-hidden">
                    <View className="h-2 rounded-full bg-primary" style={{ width: `${pct}%` }} />
                  </View>
                </>
              )}
            </View>
          ) : null}

          {/* What Gold includes */}
          <Text className="font-headline-md text-base font-bold text-on-surface mb-3">What Gold includes</Text>
          {[
            {
              icon: 'document-scanner',
              title: `${GOLD_SCANS_PER_MONTH} receipt scans a month`,
              body: `AI reads your payment screenshots and receipts. Free includes ${FREE_SCANS_PER_MONTH} scans a month.`,
            },
            {
              icon: 'ios-share',
              title: 'Export your statement',
              body: 'Download your Statement as a CSV spreadsheet for your records or accountant.',
            },
            {
              icon: 'notifications-active',
              title: 'Unlimited reminders',
              body: `Add as many bill and payment reminders as you need. Free includes ${FREE_ACTIVE_REMINDERS} active reminders.`,
            },
          ].map((b) => (
            <View key={b.title} className="flex-row items-start mb-4">
              <View className="w-9 h-9 rounded-xl bg-secondary-container items-center justify-center">
                <MaterialIcons name={b.icon as any} size={20} color="#004c22" />
              </View>
              <View className="flex-1" style={{ marginLeft: 12 }}>
                <Text className="text-sm font-semibold text-on-surface">{b.title}</Text>
                <Text className="text-sm text-on-surface-variant mt-0.5">{b.body}</Text>
              </View>
            </View>
          ))}
          <Text className="text-xs text-on-surface-variant mb-6">
            Receipt scanning uses a paid AI service, which is why the free plan has a monthly allowance. Everything
            else in Kinlo — splitting, groups, balances, settling up — stays free.
          </Text>

          {/* Coupon */}
          <Text className="font-headline-md text-base font-bold text-on-surface mb-3">Have a coupon code?</Text>
          <View className="flex-row items-center">
            <TextInput
              value={code}
              onChangeText={(t) => {
                setCode(t.toUpperCase().slice(0, 24));
                if (redeemError) setRedeemError(null);
              }}
              placeholder="Enter code"
              placeholderTextColor="#9aa59a"
              autoCapitalize="characters"
              autoCorrect={false}
              maxLength={24}
              editable={!redeeming}
              returnKeyType="done"
              onSubmitEditing={handleRedeem}
              className="flex-1 h-12 px-4 rounded-xl border border-outline-variant bg-surface-container-lowest text-on-surface text-base"
            />
            <AnimatedPressable
              onPress={handleRedeem}
              disabled={!canRedeem}
              className={`h-12 px-5 rounded-xl items-center justify-center ${canRedeem ? 'bg-primary' : 'bg-surface-container-high'}`}
              style={{ marginLeft: 10, minWidth: 92 }}
            >
              {redeeming ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <Text className={`font-bold text-sm ${canRedeem ? 'text-on-primary' : 'text-on-surface-variant'}`}>
                  Redeem
                </Text>
              )}
            </AnimatedPressable>
          </View>
          {!!redeemError && <Text className="text-sm text-error mt-2">{redeemError}</Text>}

          {!isGold && (
            <Text className="text-xs text-on-surface-variant mt-5">
              Gold subscriptions are coming soon. Until then, Gold is available with a coupon code.
            </Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
