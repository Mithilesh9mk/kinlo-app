import React, { useEffect } from 'react';
import { Text } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';

export interface SproutPlusPopProps {
  n: number;
  /** Fires once the pop is finished, so the parent can clear it. */
  onDone: () => void;
  /** Absolute position inside a positioned parent. */
  style?: { top?: number; right?: number; left?: number };
}

const GREEN = '#1f6c3a';

/**
 * Floating "+N" shown when Sprout grows. Rises and fades (about 1.6 s). Under
 * reduced motion it just sits still for a moment, then goes. Never intercepts touches.
 */
export function SproutPlusPop({ n, onDone, style }: SproutPlusPopProps) {
  const reduced = useReducedMotion();
  const p = useSharedValue(0);
  useEffect(() => {
    if (reduced) {
      const t = setTimeout(onDone, 1800);
      return () => clearTimeout(t);
    }
    p.value = withTiming(1, { duration: 1600, easing: Easing.out(Easing.cubic) }, (finished) => {
      if (finished) runOnJS(onDone)();
    });
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [n, reduced]);
  const anim = useAnimatedStyle(() => {
    const v = p.value;
    return {
      opacity: reduced ? 1 : v < 0.7 ? 1 : Math.max(0, 1 - (v - 0.7) / 0.3),
      transform: [{ translateY: reduced ? 0 : -v * 34 }, { scale: reduced ? 1 : 1 + 0.15 * Math.sin(Math.min(1, v * 3) * Math.PI) }],
    };
  });
  if (!Number.isFinite(n) || n <= 0) return null;
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ position: 'absolute', top: 0, right: 0 }, style, anim]}
    >
      <Text style={[{ fontSize: 20, fontWeight: '800', color: GREEN }]}>{`+${n}`}</Text>
    </Animated.View>
  );
}

export default SproutPlusPop;
