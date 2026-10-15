import AsyncStorage from '@react-native-async-storage/async-storage';
import { SEEN_INTRO_KEY } from '../../lib/onboardingState';
import React, { useRef, useState } from 'react';
import { View, Text, ScrollView, NativeSyntheticEvent, NativeScrollEvent, Dimensions, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { MaterialIcons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AnimatedPressable } from '../../components/AnimatedPressable';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

const SLIDES = [
  {
    icon: 'call-split' as const,
    title: 'Split bills instantly',
    body: 'Add an expense once, and Kinlo works out who owes what — no spreadsheets, no chasing.',
  },
  {
    icon: 'document-scanner' as const,
    title: 'Scan spends, no typing',
    body: 'Snap or share a payment screenshot and Kinlo reads the amount, merchant, and date for you.',
  },
  {
    icon: 'account-balance-wallet' as const,
    title: 'One balance, one view',
    body: 'Personal spending and shared expenses, side by side — always know exactly where you stand.',
  },
];

export default function ValuePropScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const scrollRef = useRef<ScrollView>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const goToLogin = () => {
    AsyncStorage.setItem(SEEN_INTRO_KEY, 'true').catch(() => {});
    router.replace('/onboarding/login');
  };

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    if (index !== activeIndex) setActiveIndex(index);
  };

  const handleNext = () => {
    if (activeIndex === SLIDES.length - 1) {
      goToLogin();
      return;
    }
    scrollRef.current?.scrollTo({ x: SCREEN_WIDTH * (activeIndex + 1), animated: true });
  };

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {/* Skip */}
      <View className="flex-row justify-end px-6 pt-2">
        <AnimatedPressable onPress={goToLogin} accessibilityRole="button" accessibilityLabel="Skip" className="px-3 py-2">
          <Text className="text-xs font-bold text-on-surface-variant uppercase tracking-wider">Skip</Text>
        </AnimatedPressable>
      </View>

      <ScrollView
        ref={scrollRef}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        style={{ flex: 1 }}
      >
        {SLIDES.map((slide, index) => (
          <View key={index} style={{ width: SCREEN_WIDTH }} className="px-8 items-center justify-center">
            <View className="w-28 h-28 rounded-full bg-secondary-container items-center justify-center border border-white/50 mb-8" style={styles.iconGlow}>
              <MaterialIcons name={slide.icon} size={52} color="#004c22" />
            </View>
            <Text className="font-display-lg text-2xl font-bold text-primary text-center mb-3">
              {slide.title}
            </Text>
            <Text className="text-sm text-on-surface-variant/80 font-medium text-center leading-relaxed max-w-[280px]">
              {slide.body}
            </Text>
          </View>
        ))}
      </ScrollView>

      <View className="px-8 pb-8" style={{ paddingBottom: insets.bottom + 24 }}>
        {/* Progress dots */}
        <View className="flex-row items-center justify-center mb-6" style={{ gap: 6 }} accessibilityElementsHidden={true} importantForAccessibility="no-hide-descendants">
          {SLIDES.map((_, index) => (
            <View
              key={index}
              className="h-1.5 rounded-full bg-primary"
              style={{ width: index === activeIndex ? 20 : 6, opacity: index === activeIndex ? 1 : 0.35 }}
            />
          ))}
        </View>

        <AnimatedPressable
          onPress={handleNext}
          accessibilityRole="button"
          accessibilityLabel={activeIndex === SLIDES.length - 1 ? 'Get started' : 'Next'}
          scaleTo={0.9}
          className="w-full h-13 bg-primary rounded-2xl flex-row items-center justify-center shadow-sm"
          style={{ height: 52 }}
        >
          <Text className="text-white font-bold text-sm">
            {activeIndex === SLIDES.length - 1 ? 'Get Started' : 'Next'}
          </Text>
          <MaterialIcons name="arrow-forward" size={16} color="white" style={{ marginLeft: 6 }} />
        </AnimatedPressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  iconGlow: {
    shadowColor: '#166534',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.06,
    shadowRadius: 24,
  },
});
