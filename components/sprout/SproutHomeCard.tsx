import React, { useCallback } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import { SproutHero } from './SproutHero';
import { useSprout } from '../../lib/sprout/useSprout';
import { useSproutTalk } from '../../lib/sprout/useSproutTalk';
import { refreshMySprout } from '../../lib/sprout/friends';

type Props = {
  /** Extra classes for the outer card (e.g. spacing); only applied when visible. */
  className?: string;
};

/**
 * Home hero for the user's Sprout. Self-contained: renders nothing while
 * first loading or when Show Sprout is off (bubble and +N hide with it).
 * Tapping Sprout makes it react; tapping the card opens the Sprout screen.
 * Copy never mentions money owed.
 */
export function SproutHomeCard({ className = '' }: Props) {
  const router = useRouter();
  const {
    stage, level, levelName, mood, points, blossoms, growth, fraction, toNext, tickKey,
    hidden, markSeen, refresh, loading, userId, counts, wilt, streakDays, justRevived,
  } = useSprout();

  const talk = useSproutTalk({
    userId,
    points,
    level,
    toNext: toNext ? { remaining: toNext.remaining, nextName: toNext.nextName } : null,
    counts,
    hidden,
    loading,
    mood,
    justRevived,
  });

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

  const animating = mood === 'celebrate' || mood === 'growing';

  return (
    <SproutHero
      className={className}
      stage={stage}
      mood={mood}
      blossoms={blossoms}
      growth={growth}
      tickKey={tickKey}
      levelName={levelName}
      points={points}
      toNext={toNext ? { remaining: toNext.remaining, nextName: toNext.nextName } : null}
      fraction={toNext ? fraction : 1}
      line={talk.line}
      pop={talk.pop}
      onTap={talk.onTap}
      onDismissLine={talk.dismiss}
      onPopDone={talk.clearPop}
      onOpen={() => router.push('/sprout')}
      onAnimationEnd={animating ? markSeen : undefined}
      wilt={wilt}
      streakDays={streakDays}
    />
  );
}

export default SproutHomeCard;
