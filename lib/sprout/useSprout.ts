/**
 * Sprout hook. Does not refresh on focus by itself: the caller wires
 * `refresh()` to useFocusEffect. Imports nothing from components/.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../supabase';
import {
  blossomsFor,
  displayStage,
  pointsFrom,
  resolveMood,
  stageFor,
  toNextStage,
  type SproutEvent,
  type SproutMood,
  type SproutStage,
} from './model';
import { fetchSproutCounts, getCachedCounts } from './stats';
import {
  getCachedStage,
  getHidden,
  getLastOpenAt,
  getLastSeenStage,
  setCachedStage,
  setHiddenPref,
  setLastOpenAt,
  setLastSeenStage,
} from './prefs';

export interface SproutOverrides {
  event?: SproutEvent | null;
  scanning?: boolean;
  hasOpenBalances?: boolean;
}

export interface UseSproutResult {
  stage: SproutStage;
  mood: SproutMood;
  points: number;
  blossoms: number;
  toNext: { next: SproutStage; remaining: number } | null;
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
  /** Record the shown stage as celebrated so `growing` fires only once. */
  markSeen: () => void;
  refresh: () => Promise<void>;
  loading: boolean;
}

export function useSprout(overrides: SproutOverrides = {}): UseSproutResult {
  const { event, scanning, hasOpenBalances } = overrides;
  const [userId, setUserId] = useState<string | null>(null);
  const [points, setPoints] = useState(0);
  const [cachedStage, setCachedStageState] = useState<SproutStage | null>(null);
  const [lastSeenStage, setLastSeen] = useState<SproutStage | null>(null);
  const [lastOpenAt, setLastOpen] = useState<number | null>(null);
  const [hidden, setHiddenState] = useState(false);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);
  const openStamped = useRef(false);

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
      const [cachedCounts, cStage, seen, openAt] = await Promise.all([
        getCachedCounts(uid),
        getCachedStage(uid),
        getLastSeenStage(uid),
        getLastOpenAt(uid),
      ]);
      if (mounted.current) {
        setUserId(uid);
        setHiddenState(isHidden);
        setPoints(pointsFrom(cachedCounts));
        setCachedStageState(cStage);
        setLastSeen(seen);
        // Only the first read per hook instance is the "previous open".
        if (!openStamped.current) setLastOpen(openAt);
        setLoading(false);
      }
      if (!openStamped.current) {
        openStamped.current = true;
        await setLastOpenAt(uid, Date.now());
      }
      const fresh = await fetchSproutCounts(uid);
      const freshPoints = pointsFrom(fresh);
      const shown = displayStage(stageFor(freshPoints), cStage);
      await setCachedStage(uid, shown);
      if (!seen) await setLastSeenStage(uid, shown); // first run: nothing to celebrate
      if (mounted.current) {
        setPoints(freshPoints);
        setCachedStageState(shown);
        if (!seen) setLastSeen(shown);
      }
    } catch {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const stage = displayStage(stageFor(points), cachedStage);

  const mood = resolveMood({
    stage,
    lastSeenStage,
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
    setLastSeen(stage);
    void setLastSeenStage(userId, stage);
    void setCachedStage(userId, stage);
  }, [userId, stage]);

  return {
    stage,
    mood,
    points,
    blossoms: blossomsFor(points),
    toNext: toNextStage(points),
    hidden,
    setHidden,
    markSeen,
    refresh,
    loading,
  };
}
