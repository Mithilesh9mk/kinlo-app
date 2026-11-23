import React, { useCallback, useEffect, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useFocusEffect } from 'expo-router';
import { Sprout } from './Sprout';
import { useSprout } from '../../lib/sprout/useSprout';
import { refreshMySprout } from '../../lib/sprout/friends';

type Props = {
  /** Extra classes for the outer card (e.g. spacing); only applied when visible. */
  className?: string;
};

const GROWTH_LINES = [
  'Logging expenses',
  'Settling up with friends',
  'Adding friends and joining circles',
  'Scanning receipts',
  'Squaring up a circle',
];

/** Plain-View progress bar; the fill animates with withTiming (instant under reduced motion). */
function ProgressBar({ fraction }: { fraction: number }) {
  const reduced = useReducedMotion();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const progress = useSharedValue(clamped);
  useEffect(() => {
    progress.value = reduced ? clamped : withTiming(clamped, { duration: 600 });
  }, [clamped, reduced, progress]);
  const fillStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));
  return (
    <View
      className="bg-surface-container-highest overflow-hidden mt-2"
      style={[{ height: 8, borderRadius: 4 }]}
    >
      <Animated.View style={[{ height: 8, borderRadius: 4, backgroundColor: '#8bd79b' }, fillStyle]} />
    </View>
  );
}

/**
 * Home card showing the user's Sprout. Self-contained: renders nothing while
 * first loading or when Show Sprout is off. Copy never mentions money owed.
 */
export function SproutHomeCard({ className = '' }: Props) {
  const {
    stage, levelName, mood, points, blossoms, growth, fraction, toNext, tickKey,
    hidden, markSeen, refresh, loading,
  } = useSprout();
  const [open, setOpen] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        try {
          await refresh();
          if (active) await refreshMySprout();
        } catch {
          /* cosmetic; ignore */
        }
      })();
      return () => {
        active = false;
      };
    }, [refresh]),
  );

  if (loading || hidden) return null;

  const name = levelName;
  const subtitle = toNext
    ? `${toNext.remaining} to go to ${toNext.nextName}`
    : 'Fully grown, still blossoming';
  const barFraction = toNext ? fraction : 1;
  const a11yLabel = `Your Sprout is ${name}. ${subtitle}. ${points} points so far. Opens how Sprout grows.`;
  const animating = mood === 'celebrate' || mood === 'growing';

  return (
    <>
      <View className={`liquid-glass rounded-2xl ${className}`}>
        <Pressable
          onPress={() => setOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={a11yLabel}
          className="p-4 flex-row items-center gap-4"
        >
          <Sprout
            stage={stage}
            mood={mood}
            blossoms={blossoms}
            growth={growth}
            tickKey={tickKey}
            size={72}
            onAnimationEnd={animating ? markSeen : undefined}
          />
          <View className="flex-1">
            <Text className="font-bold text-lg text-on-surface">{name}</Text>
            <Text className="text-xs text-on-surface-variant mt-0.5">{subtitle}</Text>
            <ProgressBar fraction={barFraction} />
            <Text className="text-xs text-on-surface-variant mt-1.5">{points} points so far</Text>
          </View>
        </Pressable>
      </View>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <Pressable
          style={[{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }]}
          onPress={() => setOpen(false)}
          accessibilityLabel="Close"
        >
          <Pressable onPress={() => {}} accessible={false}>
            <View className="bg-surface rounded-t-3xl p-6 pb-10">
              <Text className="font-bold text-lg text-on-surface">How Sprout grows</Text>
              <Text className="text-sm text-on-surface-variant mt-2">
                Sprout has 10 levels, from Seed to Ancient tree. The early levels come quickly; the later ones take a little longer. Sprout grows a little each time you use Kinlo:
              </Text>
              <View className="mt-3 gap-1.5">
                {GROWTH_LINES.map((line) => (
                  <Text key={line} className="text-sm text-on-surface">
                    {'•  '}
                    {line}
                  </Text>
                ))}
              </View>
              <Text className="text-sm text-on-surface-variant mt-3">
                A few of the same kind of action per day count; real activity over time grows Sprout fastest.
              </Text>
              <Text className="text-sm text-on-surface-variant mt-3">
                Sprout never shrinks. Once it grows, it stays grown, and there are no streaks to keep up.
              </Text>
              <Text className="text-xs text-on-surface-variant mt-3">
                Friends can see your Sprout's level and points. You can turn this off in Profile, Show Sprout.
              </Text>
              <Pressable
                onPress={() => setOpen(false)}
                accessibilityRole="button"
                accessibilityLabel="Close"
                className="mt-5 bg-primary rounded-xl py-3 items-center"
              >
                <Text className="text-white font-semibold">Got it</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}

export default SproutHomeCard;
