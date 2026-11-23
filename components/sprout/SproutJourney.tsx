import React from 'react';
import { Text, View } from 'react-native';
import { eraFor, eraName, eraStartLevel, eraUnlock, levelInfo, thresholdFor } from '../../lib/sprout/model';

const INK = '#1c1c19';
const MUTED = '#404940';
const GREEN = '#2F9E55';
const DEEP = '#166534';
const TRACK = '#cfd8cd';

/** How many upcoming levels are listed after the current one. */
const AHEAD = 3;

type Kind = 'done' | 'current' | 'ahead' | 'era';

function Row({
  kind,
  title,
  note,
  detail,
  last,
  a11y,
}: {
  kind: Kind;
  title: string;
  note?: string;
  detail?: string;
  last?: boolean;
  a11y: string;
}) {
  const current = kind === 'current';
  const reached = kind === 'done' || current;
  return (
    <View accessible accessibilityLabel={a11y} style={[{ flexDirection: 'row', alignItems: 'stretch', minHeight: 44 }]}>
      <View style={[{ width: 28, alignItems: 'center' }]}>
        <View
          style={[
            {
              width: current ? 22 : 16,
              height: current ? 22 : 16,
              borderRadius: kind === 'era' ? 4 : 11,
              marginTop: current ? 0 : 3,
              backgroundColor: reached ? GREEN : 'transparent',
              borderWidth: current ? 4 : 2,
              borderColor: current ? DEEP : reached ? GREEN : TRACK,
            },
          ]}
        />
        {!last ? (
          <View style={[{ flex: 1, width: 3, backgroundColor: kind === 'done' ? GREEN : TRACK, marginVertical: 2, borderRadius: 2 }]} />
        ) : null}
      </View>
      <View style={[{ flex: 1, paddingLeft: 10, paddingBottom: 12 }]}>
        <View style={[{ flexDirection: 'row', justifyContent: 'space-between' }]}>
          <Text
            style={[{ flexShrink: 1, fontSize: current ? 16 : 14, fontWeight: current ? '800' : reached || kind === 'era' ? '600' : '400', color: reached || kind === 'era' ? INK : MUTED }]}
          >
            {title}
          </Text>
          {note ? <Text style={[{ fontSize: 12, fontWeight: current ? '700' : '400', color: current ? DEEP : MUTED, marginLeft: 8 }]}>{note}</Text> : null}
        </View>
        {detail ? <Text style={[{ fontSize: 12, color: MUTED, marginTop: 2 }]}>{detail}</Text> : null}
      </View>
    </View>
  );
}

/**
 * The endless path as a WINDOW, never the whole list: the levels already grown
 * collapse into one row, the current level is highlighted, the next three
 * levels follow (the first says "N to go"), and the next era shows what it
 * unlocks. Works at any level.
 */
export function SproutJourney({ level, points }: { level: number; points: number }) {
  const grown = Math.max(0, level - 1);
  const ahead = Array.from({ length: AHEAD }, (_, i) => levelInfo(level + 1 + i));
  const nextEra = eraFor(level) + 1;
  const eraLevel = eraStartLevel(nextEra);
  const eraRemaining = Math.max(0, thresholdFor(eraLevel) - points);
  const cur = levelInfo(level);

  const rows: React.ReactNode[] = [];
  if (grown > 0) {
    rows.push(
      <Row
        key="done"
        kind="done"
        title={`${grown} ${grown === 1 ? 'level' : 'levels'} grown`}
        a11y={`${grown} ${grown === 1 ? 'level' : 'levels'} already grown`}
      />,
    );
  }
  rows.push(
    <Row
      key="cur"
      kind="current"
      title={cur.name}
      note="You are here"
      detail={cur.eraName ? `${cur.eraName} era` : undefined}
      a11y={`Level ${cur.level}, ${cur.name}, you are here`}
    />,
  );
  ahead.forEach((l, i) => {
    const remaining = Math.max(0, l.threshold - points);
    const startsEra = l.era > cur.era;
    rows.push(
      <Row
        key={`a${l.level}`}
        kind="ahead"
        title={l.name}
        note={i === 0 ? `${remaining} to go` : undefined}
        detail={startsEra && l.eraName ? `Starts the ${l.eraName} era` : undefined}
        a11y={`Level ${l.level}, ${l.name}${i === 0 ? `, ${remaining} to go` : ''}${startsEra ? `, starts the ${l.eraName} era` : ''}`}
      />,
    );
  });
  rows.push(
    <Row
      key="era"
      kind="era"
      last
      title={`Next era: ${eraName(nextEra)}`}
      note={`${eraRemaining} to go`}
      detail={`Unlocks: ${eraUnlock(nextEra)}`}
      a11y={`Next era, ${eraName(nextEra)}. ${eraRemaining} to go. Unlocks ${eraUnlock(nextEra)}.`}
    />,
  );

  return (
    <View
      className="liquid-glass rounded-2xl"
      style={[{ paddingVertical: 12, paddingHorizontal: 16 }]}
      accessibilityLabel={`Sprout journey. You are level ${level}, ${cur.name}. The path never ends.`}
    >
      {rows}
    </View>
  );
}

export default SproutJourney;
