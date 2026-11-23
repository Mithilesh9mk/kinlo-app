import React, { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';

export interface SproutBubbleProps {
  text: string;
  /** Tapping the bubble dismisses it. */
  onDismiss: () => void;
  /** Which side the tail points to (toward Sprout). Default 'left'. */
  tail?: 'left' | 'bottom';
}

const BG = '#FFFFFF';
const BORDER = 'rgba(0,0,0,0.08)';
const INK = '#1c1c19';

/**
 * Sprout's own speech bubble: rounded, with a small tail. Pops in (instant under
 * reduced motion). Tap to dismiss. Plain styles only (no className) so nothing
 * depends on NativeWind merging. Re-key it per line to replay the pop-in.
 */
export function SproutBubble({ text, onDismiss, tail = 'left' }: SproutBubbleProps) {
  const reduced = useReducedMotion();
  const p = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    p.value = reduced ? 1 : withTiming(1, { duration: 220, easing: Easing.out(Easing.back(1.6)) });
  }, [reduced, p]);
  const anim = useAnimatedStyle(() => ({
    opacity: Math.min(1, p.value * 1.4),
    transform: [{ scale: 0.88 + 0.12 * p.value }],
  }));

  const tailStyle =
    tail === 'left'
      ? { left: -5, top: '50%' as const, marginTop: -5 }
      : { bottom: -5, left: 28 };

  return (
    <Animated.View style={[{ alignSelf: 'stretch' }, anim]}>
      <Pressable
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel={`Sprout says: ${text}`}
        accessibilityHint="Tap to dismiss"
        accessibilityLiveRegion="polite"
        style={[
          {
            backgroundColor: BG,
            borderRadius: 18,
            borderWidth: 1,
            borderColor: BORDER,
            paddingHorizontal: 14,
            paddingVertical: 10,
          },
        ]}
      >
        <Text style={[{ fontSize: 14, lineHeight: 19, fontWeight: '600', color: INK }]}>{text}</Text>
      </Pressable>
      <View
        pointerEvents="none"
        style={[
          {
            position: 'absolute',
            width: 10,
            height: 10,
            backgroundColor: BG,
            borderColor: BORDER,
            borderLeftWidth: tail === 'left' ? 1 : 0,
            borderBottomWidth: 1,
            borderRightWidth: tail === 'left' ? 0 : 1,
            transform: [{ rotate: '45deg' }],
          },
          tailStyle,
        ]}
      />
    </Animated.View>
  );
}

export default SproutBubble;
