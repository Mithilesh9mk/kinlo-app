import React, { useState } from 'react';
import { View, Text } from 'react-native';

/**
 * A Pareto chart: category bars in descending order, with the running
 * cumulative share drawn over them and an 80% reference line.
 *
 * The point of the ordering is the "vital few" read — how many categories
 * you have to add up before you have accounted for most of the spending.
 * Where the cumulative curve crosses 80% is the answer, which is why that
 * gridline is drawn rather than left to the eye.
 *
 * WHY PLAIN VIEWS AND NOT SVG
 *
 * react-native-svg is not a dependency here, and adding it is a native
 * module — a new build and a broken OTA channel for everyone on the current
 * one. Every other chart in this app (Insights' 6-month bars, the
 * split/personal mix bar) is built from plain Views for the same reason, so
 * this stays consistent as well as cheap. The cumulative line is drawn as
 * rotated segments between consecutive points: each segment is positioned
 * at the midpoint of the pair and rotated about its own centre, which
 * avoids depending on `transformOrigin`.
 */

export interface ParetoSlice {
  id: string;
  label: string;
  amount: number;
  color: string;
}

const CHART_HEIGHT = 132;
const LINE_COLOR = '#d97706';
/**
 * Bars past this point are collapsed into one tail bucket. Categories are
 * free text in this app, so a user can accumulate a dozen of them — at that
 * width each bar is a sliver and its label is unreadable. Collapsing the
 * tail is also just how Pareto charts are conventionally drawn, and it keeps
 * the cumulative curve ending at exactly 100%.
 */
const MAX_BARS = 6;

export function ParetoChart({ data }: { data: ParetoSlice[] }) {
  const [width, setWidth] = useState(0);

  const ranked = [...data].filter((d) => d.amount > 0).sort((a, b) => b.amount - a.amount);
  const total = ranked.reduce((sum, d) => sum + d.amount, 0);

  if (ranked.length === 0 || total <= 0) return null;

  // Labelled "+N more" rather than "Other", because this app already has a
  // real category called Other and the two would be indistinguishable.
  const sorted: ParetoSlice[] =
    ranked.length > MAX_BARS
      ? [
          ...ranked.slice(0, MAX_BARS - 1),
          {
            id: '__tail__',
            label: `+${ranked.length - (MAX_BARS - 1)} more`,
            amount: ranked.slice(MAX_BARS - 1).reduce((sum, d) => sum + d.amount, 0),
            color: '#9aa39b',
          },
        ]
      : ranked;

  // Not `sorted[0].amount`: the collapsed tail is a SUM, so it can be larger
  // than the biggest single category (five categories of 20 plus a tail of
  // ten more at 15 each gives a 150 tail against a 20 leader). Scaling
  // against the leader would then compute a >100% bar height and overflow
  // the plot area.
  const max = Math.max(...sorted.map((d) => d.amount));

  // Cumulative share after each bar, as a 0-100 percentage.
  let running = 0;
  const cumulative = sorted.map((d) => {
    running += d.amount;
    return (running / total) * 100;
  });

  const slotWidth = width > 0 ? width / sorted.length : 0;
  const pointAt = (i: number) => ({
    x: slotWidth * (i + 0.5),
    // 100% sits at the top of the plot area, 0% at the bottom.
    y: CHART_HEIGHT - (cumulative[i] / 100) * CHART_HEIGHT,
  });

  return (
    <View>
      <View
        style={{ height: CHART_HEIGHT, width: '100%', position: 'relative' }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {/* 80% reference line — the Pareto threshold itself. */}
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: CHART_HEIGHT - CHART_HEIGHT * 0.8,
            height: 1,
            backgroundColor: 'rgba(217,119,6,0.35)',
          }}
        />
        <Text
          style={{
            position: 'absolute',
            right: 0,
            top: CHART_HEIGHT - CHART_HEIGHT * 0.8 - 12,
            fontSize: 9,
            fontWeight: '700',
            color: LINE_COLOR,
          }}
        >
          80%
        </Text>

        {/* Bars */}
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', height: '100%' }}>
          {sorted.map((d) => (
            <View key={d.id} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
              <View
                style={{
                  width: '58%',
                  height: `${Math.max((d.amount / max) * 100, 2)}%`,
                  backgroundColor: d.color,
                  borderRadius: 4,
                }}
              />
            </View>
          ))}
        </View>

        {/* Cumulative curve, drawn only once the container width is known. */}
        {width > 0 && sorted.slice(0, -1).map((d, i) => {
          const a = pointAt(i);
          const b = pointAt(i + 1);
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const length = Math.sqrt(dx * dx + dy * dy);
          const angle = Math.atan2(dy, dx);
          return (
            <View
              key={`seg-${d.id}`}
              style={{
                position: 'absolute',
                left: (a.x + b.x) / 2 - length / 2,
                top: (a.y + b.y) / 2 - 1,
                width: length,
                height: 2,
                backgroundColor: LINE_COLOR,
                borderRadius: 1,
                transform: [{ rotate: `${angle}rad` }],
              }}
            />
          );
        })}

        {width > 0 && sorted.map((d, i) => {
          const p = pointAt(i);
          return (
            <View
              key={`dot-${d.id}`}
              style={{
                position: 'absolute',
                left: p.x - 3.5,
                top: p.y - 3.5,
                width: 7,
                height: 7,
                borderRadius: 999,
                backgroundColor: LINE_COLOR,
              }}
            />
          );
        })}
      </View>

      {/* Category labels under each bar. Truncated hard — at five or more
          categories there is only a few dp per slot. */}
      <View style={{ flexDirection: 'row', marginTop: 6 }}>
        {sorted.map((d) => (
          <View key={`label-${d.id}`} style={{ flex: 1, alignItems: 'center' }}>
            <Text style={{ fontSize: 9, color: '#404940', fontWeight: '600' }} numberOfLines={1}>
              {d.label}
            </Text>
          </View>
        ))}
      </View>
    </View>
  );
}
