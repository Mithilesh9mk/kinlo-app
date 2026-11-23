import React from 'react';
import { Text, View } from 'react-native';
import type { TodayCounts } from '../../lib/sprout/lines';

const INK = '#1c1c19';
const MUTED = '#404940';

const ROWS: { key: keyof TodayCounts; label: string }[] = [
  { key: 'expenses', label: 'Expenses logged' },
  { key: 'settlements', label: 'Settlements' },
  { key: 'scans', label: 'Receipts scanned' },
  { key: 'friends', label: 'Friends added' },
];

/** Today's actions as COUNTS ONLY. Never an amount, never who owes whom. */
export function SproutToday({ counts }: { counts: TodayCounts }) {
  const total = counts.expenses + counts.settlements + counts.scans + counts.friends;
  return (
    <View className="liquid-glass rounded-2xl" style={[{ padding: 16 }]}>
      {total === 0 ? (
        <Text style={[{ fontSize: 14, color: MUTED }]}>A fresh day. Sprout is happy to grow whenever you are.</Text>
      ) : (
        ROWS.map((r) => (
          <View
            key={r.key}
            accessible
            accessibilityLabel={`${r.label} today: ${counts[r.key]}`}
            style={[{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 5 }]}
          >
            <Text style={[{ fontSize: 14, color: INK }]}>{r.label}</Text>
            <Text style={[{ fontSize: 14, fontWeight: '700', color: INK }]}>{counts[r.key]}</Text>
          </View>
        ))
      )}
    </View>
  );
}

export default SproutToday;
