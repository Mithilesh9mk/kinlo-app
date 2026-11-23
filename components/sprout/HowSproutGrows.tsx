import React from 'react';
import { Text, View } from 'react-native';

export const GROWTH_LINES = [
  'Logging expenses',
  'Settling up with friends',
  'Adding friends and joining circles',
  'Scanning receipts',
  'Squaring up a circle',
];

const INK = '#1c1c19';
const MUTED = '#404940';

/** "How Sprout grows" copy (moved from the old Home card sheet; same facts and caps). */
export function HowSproutGrows() {
  return (
    <View>
      <Text style={[{ fontSize: 14, color: MUTED }]}>
        Sprout never stops growing. The first levels come quickly, from Seed to Ancient tree, and then it keeps going, with a new era every few levels and a little something new to wear. Sprout grows a little each time you use Kinlo:
      </Text>
      <View style={[{ marginTop: 12, gap: 6 }]}>
        {GROWTH_LINES.map((line) => (
          <Text key={line} style={[{ fontSize: 14, color: INK }]}>
            {'•  '}
            {line}
          </Text>
        ))}
      </View>
      <Text style={[{ fontSize: 14, color: MUTED, marginTop: 12 }]}>
        A few of the same kind of action per day count; real activity over time grows Sprout fastest.
      </Text>
      <Text style={[{ fontSize: 14, color: MUTED, marginTop: 12 }]}>
        Sprout never shrinks. Once it grows, it stays grown, and there are no streaks to keep up.
      </Text>
      <Text style={[{ fontSize: 12, color: MUTED, marginTop: 12 }]}>
        Friends can see your Sprout's level and points. You can turn this off in Profile, Show Sprout.
      </Text>
    </View>
  );
}

export default HowSproutGrows;
