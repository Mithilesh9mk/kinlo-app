import React, { useCallback, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { Sprout } from './Sprout';
import { useSprout } from '../../lib/sprout/useSprout';
import { refreshMySprout } from '../../lib/sprout/friends';
import type { SproutStage } from '../../lib/sprout/model';

type Props = {
  /** Extra classes for the outer card (e.g. spacing); only applied when visible. */
  className?: string;
};

const STAGE_NAME: Record<SproutStage, string> = {
  seed: 'Seed',
  sprout: 'Sprout',
  sapling: 'Sapling',
  tree: 'Tree',
};

const GROWTH_LINES = [
  'Logging expenses',
  'Settling up with friends',
  'Adding friends and joining circles',
  'Scanning receipts',
  'Squaring up a circle',
];

/**
 * Home card showing the user's Sprout. Self-contained: renders nothing while
 * first loading or when Show Sprout is off. Copy never mentions money owed.
 */
export function SproutHomeCard({ className = '' }: Props) {
  const { stage, mood, points, blossoms, toNext, hidden, markSeen, refresh, loading } = useSprout();
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

  const name = STAGE_NAME[stage];
  const subtitle = toNext
    ? `${toNext.remaining} ${toNext.remaining === 1 ? 'point' : 'points'} to ${STAGE_NAME[toNext.next]}`
    : 'Fully grown, still blossoming';
  const a11yLabel = `Your Sprout is a ${name}. ${subtitle}. Opens how Sprout grows.`;
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
            size={72}
            onAnimationEnd={animating ? markSeen : undefined}
          />
          <View className="flex-1">
            <Text className="font-bold text-base text-on-surface">{name}</Text>
            <Text className="text-xs text-on-surface-variant mt-0.5">{subtitle}</Text>
            <Text className="text-xs text-on-surface-variant mt-0.5">{points} points so far</Text>
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
                Sprout grows a little each time you use Kinlo:
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
                Sprout never shrinks. Once it grows, it stays grown.
              </Text>
              <Text className="text-xs text-on-surface-variant mt-3">
                Friends can see your Sprout's stage and points. You can turn this off in Profile, Show Sprout.
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
