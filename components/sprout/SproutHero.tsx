import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Sprout } from './Sprout';
import { SproutBubble } from './SproutBubble';
import { SproutPlusPop } from './SproutPlusPop';
import { SproutProgress } from './SproutProgress';
import type { SproutMood, SproutStage } from './SproutFigure';

export const HERO_SPROUT_SIZE = 120;

export interface SproutHeroProps {
  stage: SproutStage;
  mood: SproutMood;
  blossoms: number;
  growth: number;
  tickKey?: number;
  levelName: string;
  points: number;
  /** Progress to the next level; null at the top level. */
  toNext: { remaining: number; nextName: string } | null;
  /** Bar fraction 0..1 (1 at the top). */
  fraction: number;
  /** Current speech-bubble line; null = none showing. */
  line: { id: number; text: string } | null;
  /** "+N growth" moment; null = none. */
  pop: { id: number; n: number } | null;
  onTap: () => void;
  onDismissLine: () => void;
  onPopDone: () => void;
  /** Tap on the card body (opens the Sprout screen). */
  onOpen: () => void;
  onAnimationEnd?: () => void;
  /** 0..1 wilt for the figure (quiet moods). Optional; default derives from the mood. */
  wilt?: number;
  /** Active days in a row; "N days in a row" shows from 2. Optional. */
  streakDays?: number;
  className?: string;
}

/**
 * Home hero: a big, tappable Sprout on the left, its speech bubble on the
 * right, and the level + progress underneath. Presentational only: data comes
 * from SproutHomeCard (and the docs mock). Copy never mentions money.
 */
export function SproutHero({
  stage, mood, blossoms, growth, tickKey, levelName, points, toNext, fraction,
  line, pop, onTap, onDismissLine, onPopDone, onOpen, onAnimationEnd, wilt, streakDays = 0, className = '',
}: SproutHeroProps) {
  const streakText = streakDays >= 2 ? `${Math.floor(streakDays)} days in a row` : null;
  const subtitle = toNext ? `${toNext.remaining} to go to ${toNext.nextName}` : null;
  const maxTitle = `${levelName} · ${points} growth points`;
  const a11yBase = toNext
    ? `Your Sprout is ${levelName}. ${subtitle}. ${points} points so far.`
    : `Your Sprout is ${levelName}. ${points} growth points.`;
  const a11yLabel = `${a11yBase}${streakText ? ` ${streakText}.` : ''} Opens the Sprout screen.`;

  return (
    <View className={`liquid-glass rounded-2xl ${className}`}>
      {/* Not itself a screen-reader stop: Sprout, the bubble and the footer are. */}
      <Pressable onPress={onOpen} accessible={false} style={[{ padding: 16 }]}>
        <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 12 }]}>
          <View style={[{ width: HERO_SPROUT_SIZE, height: HERO_SPROUT_SIZE }]}>
            <Sprout
              stage={stage}
              mood={mood}
              blossoms={blossoms}
              growth={growth}
              tickKey={tickKey}
              size={HERO_SPROUT_SIZE}
              onTap={onTap}
              accessibilityHint="Tap to play with Sprout"
              onAnimationEnd={onAnimationEnd}
              wilt={wilt}
            />
            {pop ? <SproutPlusPop key={pop.id} n={pop.n} onDone={onPopDone} style={{ top: 2, right: 2 }} /> : null}
          </View>
          <View style={[{ flex: 1, justifyContent: 'center', minHeight: 56 }]}>
            {line ? (
              <SproutBubble key={line.id} text={line.text} onDismiss={onDismissLine} />
            ) : (
              <Text style={[{ fontSize: 13, color: '#404940' }]}>Tap Sprout to say hi</Text>
            )}
          </View>
        </View>

        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={a11yLabel}
          style={[{ marginTop: 12 }]}
        >
          {toNext ? (
            <View style={[{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' }]}>
              <Text style={[{ fontSize: 17, fontWeight: '700', color: '#1c1c19' }]}>{levelName}</Text>
              <Text style={[{ fontSize: 12, color: '#404940' }]}>{subtitle}</Text>
            </View>
          ) : (
            <Text style={[{ fontSize: 17, fontWeight: '700', color: '#1c1c19' }]}>{maxTitle}</Text>
          )}
          <SproutProgress fraction={toNext ? fraction : 1} />
          {streakText ? (
            <Text style={[{ fontSize: 12, fontWeight: '600', color: '#9a3f1c', marginTop: 6 }]}>{streakText}</Text>
          ) : null}
        </Pressable>
      </Pressable>
    </View>
  );
}

export default SproutHero;
