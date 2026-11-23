import React from 'react';
import { Text, View } from 'react-native';
import { LEVELS } from '../../lib/sprout/model';

const INK = '#1c1c19';
const MUTED = '#404940';
const GREEN = '#2F9E55';
const DEEP = '#166534';
const TRACK = '#cfd8cd';

/**
 * The 10-level path: reached levels filled, the current one highlighted,
 * the next one says "N to go". Names come straight from LEVELS.
 */
export function SproutJourney({ level, points }: { level: number; points: number }) {
  return (
    <View
      className="liquid-glass rounded-2xl"
      style={[{ paddingVertical: 12, paddingHorizontal: 16 }]}
      accessibilityLabel={`Sprout journey, ${LEVELS.length} levels. You are level ${level}.`}
    >
      {LEVELS.map((l, i) => {
        const reached = l.level <= level;
        const current = l.level === level;
        const isNext = l.level === level + 1;
        const last = i === LEVELS.length - 1;
        const remaining = Math.max(0, l.threshold - points);
        return (
          <View
            key={l.level}
            accessible
            accessibilityLabel={`Level ${l.level}, ${l.name}${current ? ', you are here' : reached ? ', reached' : isNext ? `, ${remaining} to go` : ''}`}
            style={[{ flexDirection: 'row', alignItems: 'stretch', minHeight: 44 }]}
          >
            <View style={[{ width: 28, alignItems: 'center' }]}>
              <View
                style={[
                  {
                    width: current ? 22 : 16,
                    height: current ? 22 : 16,
                    borderRadius: 11,
                    marginTop: current ? 0 : 3,
                    backgroundColor: reached ? GREEN : 'transparent',
                    borderWidth: current ? 4 : 2,
                    borderColor: current ? DEEP : reached ? GREEN : TRACK,
                  },
                ]}
              />
              {!last ? (
                <View style={[{ flex: 1, width: 3, backgroundColor: l.level < level ? GREEN : TRACK, marginVertical: 2, borderRadius: 2 }]} />
              ) : null}
            </View>
            <View style={[{ flex: 1, paddingLeft: 10, paddingBottom: 12, flexDirection: 'row', justifyContent: 'space-between' }]}>
              <Text style={[{ fontSize: current ? 16 : 14, fontWeight: current ? '800' : reached ? '600' : '400', color: reached ? INK : MUTED }]}>
                {l.name}
              </Text>
              {current ? (
                <Text style={[{ fontSize: 12, fontWeight: '700', color: DEEP }]}>You are here</Text>
              ) : isNext ? (
                <Text style={[{ fontSize: 12, color: MUTED }]}>{`${remaining} to go`}</Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export default SproutJourney;
