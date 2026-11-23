/**
 * Sprout's speech bubble + "+N growth" moment, shared by the Home hero card and
 * the /sprout screen. Imports nothing from components/. Cosmetic: every failure
 * is swallowed, and nothing here touches expenses, settlements or friends.
 *
 * Growth moment: the last points total shown to the user is kept in
 * AsyncStorage (per user). When points are higher than that, `pop` fires once
 * and the bubble says how much Sprout grew. The very first run only stores a
 * baseline (no pop). While Show Sprout is off the baseline still advances
 * silently, so turning it back on never replays old growth.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { levelFor, type SproutMood } from './model';
import { pickLine, todayCountsFrom, type LineEvent, type QuietTier } from './lines';
import { getLastShownPoints, setLastShownPoints } from './prefs';
import type { SproutCounts } from './model';

export interface TalkLine {
  id: number;
  text: string;
}
export interface GrowthPop {
  id: number;
  n: number;
}

interface Args {
  userId: string | null;
  points: number;
  level: number;
  toNext: { remaining: number; nextName: string } | null;
  counts: SproutCounts | null;
  hidden: boolean;
  loading: boolean;
  /** Current mood: droopy / sad / grumpy switch the tap and greeting lines to that tier. Optional. */
  mood?: SproutMood;
  /** One-shot: a logged action just ended a quiet spell (says the revive line). Optional. */
  justRevived?: boolean;
}

const LINE_MS = 7000;
const GAIN_MS = 6000;

export function useSproutTalk(args: Args) {
  const { userId, points, loading, hidden } = args;
  const [line, setLine] = useState<TalkLine | null>(null);
  const [pop, setPop] = useState<GrowthPop | null>(null);

  const latest = useRef(args);
  latest.current = args;
  const mounted = useRef(true);
  const idRef = useRef(0);
  const tapCount = useRef(0);
  const greeted = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setLine(null);
  }, []);

  const say = useCallback((event: LineEvent, lastGain?: number) => {
    const a = latest.current;
    if (a.hidden || !mounted.current) return;
    const quiet: QuietTier | null =
      a.mood === 'droopy' || a.mood === 'sad' || a.mood === 'grumpy' ? a.mood : null;
    // A logged action that ends a quiet spell also gains points: say the revive line.
    const ev: LineEvent = event === 'gain' && a.justRevived ? 'revived' : event;
    const text = pickLine({
      quiet,
      level: a.level,
      toNext: a.toNext,
      todayCounts: todayCountsFrom(a.counts, new Date()),
      hour: new Date().getHours(),
      event: ev,
      tapCount: tapCount.current,
      lastGain,
    });
    idRef.current += 1;
    setLine({ id: idRef.current, text });
    if (timer.current) clearTimeout(timer.current);
    const ms = ev === 'gain' || ev === 'levelUp' || ev === 'revived' ? GAIN_MS : LINE_MS;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (mounted.current) setLine(null);
    }, ms);
  }, []);

  /** Call when the user taps Sprout. */
  const onTap = useCallback(() => {
    tapCount.current += 1;
    say('tap');
  }, [say]);

  const clearPop = useCallback(() => setPop(null), []);

  // Hide everything the moment Show Sprout is turned off.
  useEffect(() => {
    if (hidden) {
      dismiss();
      setPop(null);
    }
  }, [hidden, dismiss]);

  // Revive moment: Sprout perks up the instant a logged action ends a quiet spell.
  const justRevived = args.justRevived === true;
  useEffect(() => {
    if (justRevived && !hidden) say('revived');
  }, [justRevived, hidden, say]);

  // One friendly greeting per mount, once loaded.
  useEffect(() => {
    if (loading || hidden || !userId || greeted.current) return;
    greeted.current = true;
    say('open');
  }, [loading, hidden, userId, say]);

  // "+N growth" moment.
  useEffect(() => {
    if (loading || !userId) return;
    const uid = userId;
    const pts = points;
    chain.current = chain.current
      .then(async () => {
        const stored = await getLastShownPoints(uid);
        if (stored == null) {
          await setLastShownPoints(uid, pts); // first ever run: baseline only
          return;
        }
        if (pts <= stored) return; // never lower the baseline
        await setLastShownPoints(uid, pts);
        if (latest.current.hidden || !mounted.current) return;
        const gain = pts - stored;
        idRef.current += 1;
        setPop({ id: idRef.current, n: gain });
        say(levelFor(pts) > levelFor(stored) ? 'levelUp' : 'gain', gain);
      })
      .catch(() => {
        /* cosmetic; ignore */
      });
  }, [loading, userId, points, say]);

  return { line, pop, onTap, say, dismiss, clearPop };
}
