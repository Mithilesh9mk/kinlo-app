/**
 * Sprout hook. Does not refresh on focus by itself: the caller wires
 * `refresh()` to useFocusEffect. Imports nothing from components/.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase';
import {
  artFor,
  displayLevel,
  eraFor,
  eraName,
  eraUnlocked,
  growthIn,
  levelFor,
  levelName,
  pointsFrom,
  resolveMood,
  streakInfo,
  toNextLevel,
  wiltFor,
  type SproutEvent,
  type SproutMood,
  type SproutStage,
} from './model';
import { fetchSproutCounts, getCachedCounts } from './stats';
import type { SproutCounts } from './model';
import {
  getCachedLevel,
  getHidden,
  getLastOpenAt,
  getLastSeenLevel,
  getQuietDays,
  setCachedLevel,
  setHiddenPref,
  setLastOpenAt,
  setLastSeenLevel,
  setQuietDays,
} from './prefs';

export interface SproutOverrides {
  event?: SproutEvent | null;
  scanning?: boolean;
  hasOpenBalances?: boolean;
}

export interface UseSproutResult {
  stage: SproutStage;
  level: number;
  levelName: string;
  blossoms: number;
  points: number;
  /** Era number of the shown level: 0 up to level 10, then 1, 2, ... (drives the figure's cosmetics). */
  era: number;
  /** Era name without "era" (null before the first era). */
  eraName: string | null;
  /** True while a 'growing' moment is an era unlock (a bigger celebration). */
  bigMoment: boolean;
  /** 0..1 progress through the current level. */
  growth: number;
  /** Progress to the next level (levels are endless, so there is always a next). */
  fraction: number;
  toNext: {
    nextLevel: number;
    nextName: string;
    remaining: number;
    fraction: number;
  };
  mood: SproutMood;
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  /** Record the shown level as celebrated so `growing` fires only once. */
  markSeen: () => void;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Increments when, after the first load, a refresh yields more points. */
  tickKey: number;
  /** Signed-in user id (null until loaded / signed out). */
  userId: string | null;
  /** Latest per-day counts (cached, then fresh). Counts only, no amounts. */
  counts: SproutCounts | null;
  /** Active days in a row (one grace day allowed). LOCAL only, never synced. */
  streakDays: number;
  /** Whole IST days since the last logged action; 0 for a brand-new user. */
  daysQuiet: number;
  /** 0..1 wilt for the figure, from daysQuiet only. */
  wilt: number;
  /** One-shot: a logged action just ended a quiet spell. */
  justRevived: boolean;
}

const REVIVE_MS = 3000;
const NOW_TICK_MS = 5 * 60 * 1000;

export function useSprout(overrides: SproutOverrides = {}): UseSproutResult {
  const { event, scanning, hasOpenBalances } = overrides;
  const [userId, setUserId] = useState<string | null>(null);
  const [points, setPoints] = useState(0);
  const [cachedLevel, setCachedLevelState] = useState<number | null>(null);
  const [lastSeenLevel, setLastSeen] = useState<number | null>(null);
  const [lastOpenAt, setLastOpen] = useState<number | null>(null);
  const [hidden, setHiddenState] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tickKey, setTickKey] = useState(0);
  const [counts, setCounts] = useState<SproutCounts | null>(null);
  const [justRevived, setJustRevived] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const reviveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const openStamped = useRef(false);
  /** Latest points known in this instance; null until the first load lands. */
  const lastPoints = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (reviveTimer.current) clearTimeout(reviveTimer.current);
    };
  }, []);

  // Re-evaluate quiet days across IST midnight while the app stays open.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), NOW_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id ?? null;
      const isHidden = await getHidden();
      if (!uid) {
        if (mounted.current) {
          setHiddenState(isHidden);
          setLoading(false);
        }
        return;
      }
      const [cachedCounts, cLevel, seen, openAt] = await Promise.all([
        getCachedCounts(uid),
        getCachedLevel(uid),
        getLastSeenLevel(uid),
        getLastOpenAt(uid),
      ]);
      const cachedPoints = pointsFrom(cachedCounts);
      if (mounted.current) {
        setUserId(uid);
        setHiddenState(isHidden);
        setPoints(cachedPoints);
        setCounts(cachedCounts);
        setCachedLevelState(cLevel);
        setLastSeen(seen);
        // Only the first read per hook instance is the "previous open".
        if (!openStamped.current) setLastOpen(openAt);
        setLoading(false);
      }
      if (!openStamped.current) {
        openStamped.current = true;
        await setLastOpenAt(uid, Date.now());
      }
      // First load only sets the baseline: no tick for it.
      const before = lastPoints.current;
      const fresh = await fetchSproutCounts(uid);
      const freshPoints = pointsFrom(fresh);
      const shown = displayLevel(levelFor(freshPoints), cLevel);
      await setCachedLevel(uid, shown);
      // Revive: quiet time was >= 2 days last time we looked, and a logged action ended it.
      const quietNow = streakInfo(fresh, new Date()).daysQuiet;
      const quietBefore = await getQuietDays(uid);
      await setQuietDays(uid, quietNow);
      if (mounted.current && quietBefore != null && quietBefore >= 2 && quietNow === 0) {
        setJustRevived(true);
        if (reviveTimer.current) clearTimeout(reviveTimer.current);
        reviveTimer.current = setTimeout(() => {
          reviveTimer.current = null;
          if (mounted.current) setJustRevived(false);
        }, REVIVE_MS);
      }
      if (seen == null) await setLastSeenLevel(uid, shown); // first run: nothing to celebrate
      if (mounted.current) {
        lastPoints.current = freshPoints;
        setPoints(freshPoints);
        setCounts(fresh);
        setCachedLevelState(shown);
        if (seen == null) setLastSeen(shown);
        if (before !== null && freshPoints > before) setTickKey((n) => n + 1);
      }
    } catch {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const level = displayLevel(levelFor(points), cachedLevel);
  const art = artFor(level);
  const toNext = toNextLevel(points);

  void nowMs; // the 5-minute tick only forces a re-render so `now` stays fresh
  const now = new Date();
  const { streakDays, daysQuiet } = streakInfo(counts, now);
  // Quiet moods come from daysQuiet only. hasOpenBalances is only ever used for 'proud'.
  const mood = resolveMood({
    level,
    lastSeenLevel,
    event,
    scanning,
    lastOpenAt,
    hasOpenBalances,
    daysQuiet,
    justRevived,
    now,
  });

  const setHidden = useCallback((value: boolean) => {
    setHiddenState(value);
    void setHiddenPref(value);
  }, []);

  const markSeen = useCallback(() => {
    if (!userId) return;
    setLastSeen(level);
    void setLastSeenLevel(userId, level);
    void setCachedLevel(userId, level);
  }, [userId, level]);

  const era = eraFor(level);

  return {
    stage: art.stage,
    level,
    levelName: levelName(level),
    blossoms: art.blossoms,
    era,
    eraName: eraName(era),
    bigMoment: mood === 'growing' && eraUnlocked(level, lastSeenLevel),
    points,
    growth: growthIn(points),
    fraction: toNext.fraction,
    toNext,
    mood,
    hidden,
    setHidden,
    markSeen,
    loading,
    refresh,
    tickKey,
    userId,
    counts,
    streakDays,
    daysQuiet,
    wilt: wiltFor(daysQuiet),
    justRevived,
  };
}
