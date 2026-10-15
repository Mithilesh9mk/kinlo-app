import React from 'react';
import Animated, { FadeInDown, LinearTransition } from 'react-native-reanimated';
import { ViewStyle, StyleProp } from 'react-native';

/**
 * Wraps a list row (friend, group, activity, transaction) with a fast
 * staggered entrance and a layout animation for reorders/removals, so lists
 * never just "pop" into their final state.
 *
 * Plain timing, not a spring. A spring here — even a lightly-damped one —
 * visibly overshoots and settles more than once when many staggered rows
 * animate in together (a full list load, a scope switch), which reads as
 * the whole screen bouncing rather than one row bouncing once. A timing
 * curve settles in exactly `duration`, always, with no oscillation.
 */
export function AnimatedListItem({
  index = 0,
  style,
  children,
}: {
  index?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  return (
    <Animated.View
      entering={FadeInDown.delay(Math.min(index, 8) * 30).duration(200)}
      layout={LinearTransition.duration(180)}
      style={style}
    >
      {children}
    </Animated.View>
  );
}
