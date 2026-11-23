/**
 * Sprout hook. Does not refresh on focus by itself: the caller wires
 * `refresh()` to useFocusEffect. Imports nothing from components/.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase';
import {
  artFor,
  displayLevel,
  growthIn,
  levelFor,
  levelName,
  pointsFrom,
  resolveMood,
  toNextLevel,
  type SproutEvent,
  type SproutMood,
  type SproutStage,
} from './model';
import { fetchSproutCounts, getCachedCounts } from './stats';
import {
  getCachedLevel,
  getHidden,
  getLastOpenAt,
  getLastSeenLevel,
  setCachedLevel,
  setHiddenPref,
  setLastOpenAt,
  setLastSeenLevel,
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
  /** 0..1 progress through the current level (1 at the top). */
  growth: number;
  /** Progress to the next level, 1 at the top. */
  fraction: number;
  toNext: {
    nextLevel: number;
    nextName: string;
    remaining: number;
    fraction: number;
  } | null;
  mood: SproutMood;
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  /** Record the shown level as celebrated so `growing` fires only once. */
  markSeen: () => void;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Increments when, after the first load, a refresh yields more points. */
  tickKey: number;
}

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
  const mounted = useRef(true);
  const openStamped = useRef(false);
  /** Latest points known in this instance; null until the first load lands. */
  const lastPoints = useRef<number | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
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
      if (seen == null) await setLastSeenLevel(uid, shown); // first run: nothing to celebrate
      if (mounted.current) {
        lastPoints.current = freshPoints;
        setPoints(freshPoints);
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

  const mood = resolveMood({
    level,
    lastSeenLevel,
    event,
    scanning,
    lastOpenAt,
    hasOpenBalances,
    now: new Date(),
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

  return {
    stage: art.stage,
    level,
    levelName: levelName(level),
    blossoms: art.blossoms,
    points,
    growth: growthIn(points),
    fraction: toNext?.fraction ?? 1,
    toNext,
    mood,
    hidden,
    setHidden,
    markSeen,
    loading,
    refresh,
    tickKey,
  };
}
