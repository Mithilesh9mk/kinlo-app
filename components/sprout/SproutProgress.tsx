import React, { useEffect, useRef } from 'react';
import { View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

/**
 * Plain-View progress bar; the fill animates with withTiming (instant under
 * reduced motion). When the fraction drops because a level was just reached,
 * the bar first fills to the end, then starts the next level from empty.
 */
export function SproutProgress({ fraction }: { fraction: number }) {
  const reduced = useReducedMotion();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const progress = useSharedValue(clamped);
  const prev = useRef(clamped);
  useEffect(() => {
    const before = prev.current;
    prev.current = clamped;
    if (reduced) {
      progress.value = clamped;
    } else if (clamped < before - 0.02) {
      progress.value = withSequence(
        withTiming(1, { duration: 350 }),
        withTiming(0, { duration: 0 }),
        withTiming(clamped, { duration: 450 }),
      );
    } else {
      progress.value = withTiming(clamped, { duration: 600 });
    }
  }, [clamped, reduced, progress]);
  const fillStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 8, backgroundColor: 'rgba(0,0,0,0.08)' }]}
    >
      <Animated.View style={[{ height: 8, borderRadius: 4, backgroundColor: '#8bd79b' }, fillStyle]} />
    </View>
  );
}

export default SproutProgress;
