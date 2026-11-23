import React from 'react';
import { Text, View } from 'react-native';
import { SproutFigure } from './SproutFigure';
import type { SproutStage } from '../../lib/sprout/model';

export interface SproutCompareSide {
  stage: SproutStage;
  blossoms: number;
  points: number;
  level?: number;
  levelName?: string;
}

export interface SproutCompareProps {
  me: SproutCompareSide;
  friend: SproutCompareSide | null;
  friendName: string;
}

const STAGE_LABEL: Record<SproutStage, string> = {
  seed: 'Seed',
  sprout: 'Sprout',
  sapling: 'Sapling',
  tree: 'Tree',
};

function nameOf(side: SproutCompareSide): string {
  return side.levelName || STAGE_LABEL[side.stage];
}

function Side({ title, side }: { title: string; side: SproutCompareSide }) {
  const label = `${title}: ${nameOf(side)}, ${side.points} points`;
  return (
    <View className="flex-1 items-center" accessible accessibilityLabel={label}>
      <SproutFigure stage={side.stage} mood="idle" blossoms={side.blossoms} size={64} />
      <Text
        className="font-body text-xs text-on-surface-variant mt-2 text-center"
        numberOfLines={1}
      >
        {title}
      </Text>
      <Text className="font-body text-sm text-on-surface mt-0.5">{nameOf(side)}</Text>
      <Text className="font-body text-xs text-on-surface-variant mt-0.5">
        {side.points} points
      </Text>
    </View>
  );
}

export function SproutCompare({ me, friend, friendName }: SproutCompareProps) {
  if (!friend) return null;
  const name = friendName.trim() || 'Friend';
  return (
    <View
      className="bg-surface-container-low border border-outline-variant/60 rounded-xl p-4"
      accessibilityLabel="Growing together"
    >
      <Text className="font-body text-sm text-on-surface text-center mb-3">Growing together</Text>
      <View className="flex-row">
        <Side title="Your Sprout" side={me} />
        <Side title={`${name}'s Sprout`} side={friend} />
      </View>
    </View>
  );
}

export default SproutCompare;
