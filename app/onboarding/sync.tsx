import React, { useEffect, useRef, useState } from 'react';
import { View, Text, ScrollView, Animated, StyleSheet, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Contacts/notification permission decisions now happen in
// onboarding/permissions.tsx, before this screen is ever reached — this is
// just the "preparing your ledger" beat, then a handoff to first-action.tsx.
export default function SyncScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  // Text can't read an Animated.Value directly, so the listener below keeps
  // this in sync with progressAnim for the "NN%" label while the bar itself
  // (a width style) animates off progressAnim directly.
  const [progressPercent, setProgressPercent] = useState(0);

  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(30)).current;
  const syncRotateAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fadeAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      Animated.timing(slideAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start();

    Animated.loop(
      Animated.timing(syncRotateAnim, {
        toValue: 1,
        duration: 2000,
        useNativeDriver: true,
      })
    ).start();

    // Was a raw setState(100) at 900ms — inside an Animated.View, but with
    // nothing animated about it, so the bar snapped from empty to full in a
    // single re-render instead of filling like the spinning ring beside it
    // implied it would. width can't use the native driver, hence false here
    // while everything else above stays on it.
    const progressListenerId = progressAnim.addListener(({ value }) => {
      setProgressPercent(Math.round(value));
    });
    Animated.timing(progressAnim, {
      toValue: 100,
      duration: 900,
      useNativeDriver: false,
    }).start();

    const navTimer = setTimeout(() => {
      router.replace('/onboarding/first-action');
    }, 1500);

    return () => {
      progressAnim.removeListener(progressListenerId);
      clearTimeout(navTimer);
    };
  }, []);

  const interpolatedRotate = syncRotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  const interpolatedWidth = progressAnim.interpolate({
    inputRange: [0, 100],
    outputRange: ['0%', '100%'],
    extrapolate: 'clamp',
  });

  return (
    <View className="flex-1 bg-background">
      <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 60 }}>
        <Animated.View
          style={{ opacity: fadeAnim, transform: [{ translateY: slideAnim }] }}
          className="px-6 pt-16 max-w-xl mx-auto w-full space-y-8"
        >
          {/* Step Indicators: ●●●● (4 of 4) */}
          <View className="flex-row items-center justify-end pb-2" style={{ gap: 6 }} accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants">
            <View className="w-1.5 h-1.5 rounded-full bg-primary" />
            <View className="w-1.5 h-1.5 rounded-full bg-primary" />
            <View className="w-1.5 h-1.5 rounded-full bg-primary" />
            <View className="w-5 h-1.5 rounded-full bg-primary" />
          </View>

          <View className="space-y-2 mt-4 items-center text-center">
            <Text className="font-display-lg text-3xl font-bold text-primary text-center">Preparing your ledger</Text>
            <Text className="text-sm text-on-surface-variant/80 font-medium text-center max-w-xs mt-1 leading-relaxed">
              Setting up your organic, frictionless shared balance space...
            </Text>
          </View>

          <View className="p-8 rounded-3xl items-center" style={styles.liquidGlass}>
            <View className="w-36 h-36 items-center justify-center relative mb-5">
              <Animated.View
                style={[
                  styles.circularBeam,
                  {
                    transform: [{ rotate: interpolatedRotate }],
                    borderColor: '#004c22',
                    borderTopColor: 'transparent',
                    borderRightColor: 'transparent',
                  },
                ]}
                className="w-full h-full rounded-full border-4 absolute"
              />
              <View className="items-center justify-center">
                <Text className="text-3xl font-display font-bold text-primary">{progressPercent}%</Text>
                <Text className="text-[10px] text-outline font-bold uppercase tracking-wider mt-1">
                  {progressPercent === 100 ? 'SUCCESS' : 'PREPARING'}
                </Text>
              </View>
            </View>

            <View className="w-full h-2 bg-outline-variant/30 rounded-full overflow-hidden">
              <Animated.View
                className="h-full bg-primary"
                style={{ width: interpolatedWidth, borderRadius: 99 }}
              />
            </View>
          </View>
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
    shadowOpacity: 0.04,
    shadowRadius: 24,
    elevation: 2,
  },
  circularBeam: {
    borderStyle: 'solid',
  },
});
