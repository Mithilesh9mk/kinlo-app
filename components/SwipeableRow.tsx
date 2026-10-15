import React from 'react';
import { Animated, View } from 'react-native';
import { Swipeable } from 'react-native-gesture-handler';
import { MaterialIcons } from '@expo/vector-icons';
import { useAlert } from './AppAlert';

// Same destructive colors as the existing tap-to-open Actions Sheet's
// "Delete Transaction" button, so a swipe and a tap land on the same visual
// language instead of inventing a second red.
const DELETE_BG = '#FEE2E2';
const DELETE_ICON = '#DC2626';

interface SwipeableRowProps {
  children: React.ReactNode;
  onDelete: () => void;
  /** Voided rows aren't swipeable at all — mirrors the existing tap guard. */
  disabled?: boolean;
  /** Overrides for the confirmation copy, when the caller knows what the row is. */
  confirmTitle?: string;
  confirmMessage?: string;
  confirmLabel?: string;
}

/**
 * Right-swipe-to-delete wrapper for a transaction row. Wraps outside
 * AnimatedPressable so tap-scale feedback is untouched, and inside
 * AnimatedListItem so list entrance/reorder animation is untouched.
 *
 * WHY THE SWIPE ALWAYS ASKS FIRST
 *
 * A swipe is far easier to trigger by accident than a tap — a stray
 * horizontal drag while scrolling a list is enough. This used to delete the
 * moment the row opened past the threshold, which meant one mis-swipe
 * silently destroyed a financial record with no undo anywhere in the app.
 * Confirmation is deliberately not opt-in: every caller here is deleting
 * money records, so the safe path is the default and there is no prop to
 * turn it off. Cancelling closes the row back up rather than leaving it
 * hanging open.
 */
export function SwipeableRow({
  children,
  onDelete,
  disabled,
  confirmTitle = 'Delete this expense?',
  confirmMessage = 'This removes it from your records. You can add it again, but it cannot be undone.',
  confirmLabel = 'Delete',
}: SwipeableRowProps) {
  const { showAlert } = useAlert();

  if (disabled) {
    return <>{children}</>;
  }

  const renderRightActions = (progress: Animated.AnimatedInterpolation<number>) => {
    const scale = progress.interpolate({
      inputRange: [0, 1],
      outputRange: [0.6, 1],
      extrapolate: 'clamp',
    });
    return (
      <View style={{ width: 76, alignItems: 'center', justifyContent: 'center', backgroundColor: DELETE_BG }}>
        <Animated.View style={{ transform: [{ scale }] }}>
          <MaterialIcons name="delete" size={22} color={DELETE_ICON} />
        </Animated.View>
      </View>
    );
  };

  return (
    <Swipeable
      renderRightActions={renderRightActions}
      overshootRight={false}
      rightThreshold={40}
      friction={2}
      onSwipeableOpen={(direction, swipeable) => {
        if (direction !== 'right') return;
        showAlert(
          confirmTitle,
          confirmMessage,
          [
            // Closing on cancel matters: leaving the row open after the user
            // declined reads as "it half-happened".
            { text: 'Cancel', style: 'cancel', onPress: () => swipeable.close() },
            { text: confirmLabel, style: 'destructive', onPress: () => onDelete() },
          ],
          // Backdrop tap / hardware back are also a decline, not a delete.
          { onDismiss: () => swipeable.close() },
        );
      }}
    >
      {children}
    </Swipeable>
  );
}
