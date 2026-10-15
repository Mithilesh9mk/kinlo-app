import React from 'react';
import { Pressable, PressableProps, ViewStyle, StyleProp } from 'react-native';

export interface AnimatedPressableProps extends PressableProps {
  style?: StyleProp<ViewStyle>;
  /** How far the element shrinks on press. 0.96 (default) is a subtle tap; use 0.9 for large touch targets like cards. */
  scaleTo?: number;
  disabled?: boolean;
  /** Accepted for drop-in compatibility with TouchableOpacity call sites; unused. */
  activeOpacity?: number;
}

/**
 * Press-scale feedback without Reanimated.
 *
 * WHY NOT REANIMATED
 *
 * This used to drive the scale with useSharedValue + useAnimatedStyle, which
 * crashed the app outright:
 *
 *   RangeError: Maximum call stack size exceeded
 *       at some (native)
 *       at isAnimated_utilsTs1        ← ~10,000 frames
 *       at styleUpdater_useAnimatedStyle
 *       at AnimationFrameQueue.executeQueue   (worklets thread)
 *
 * Reanimated's isAnimated() recurses through style structures with no depth
 * guard. It runs on the worklets thread — below React — so neither an
 * ErrorBoundary nor an ErrorUtils handler can see it; the process is just
 * killed. Add Expense and Settle Up were unusable. Diagnosed over adb.
 *
 * WHY style MUST STAY AN ARRAY, NOT A FUNCTION
 *
 * Pressable supports `style={({ pressed }) => ...}`, and the first version of
 * this rewrite used it. That silently destroyed the app's visual design:
 * NativeWind merges `className` INTO the style prop, and it cannot do that
 * when style is a function — so every className-driven background, border and
 * card surface disappeared. Cards on Home, Groups, the category chips and the
 * split-confirm panel all went flat, and the disabled Next button could not be
 * re-enabled because the panel it lived in was gone.
 *
 * So press state is tracked in React state and the style stays a plain array.
 * One extra render per press, which is nothing next to losing every card in
 * the app.
 *
 * The props are unchanged: ~416 call sites use this and none need editing.
 */
export function AnimatedPressable({
  style,
  scaleTo = 0.96,
  disabled,
  onPressIn,
  onPressOut,
  children,
  activeOpacity: _activeOpacity,
  ...rest
}: AnimatedPressableProps) {
  const [pressed, setPressed] = React.useState(false);

  return (
    <Pressable
      {...rest}
      disabled={disabled}
      onPressIn={(e) => {
        setPressed(true);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setPressed(false);
        onPressOut?.(e);
      }}
      style={[
        style,
        disabled ? { opacity: 0.5 } : null,
        pressed && !disabled ? { transform: [{ scale: scaleTo }] } : null,
      ]}
    >
      {children}
    </Pressable>
  );
}
