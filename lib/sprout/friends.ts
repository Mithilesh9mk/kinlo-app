/**
 * Friend Sprout reads and own-Sprout sync. Every call fails soft and quietly:
 * the sprout_stats table and RPCs may not exist on the server yet.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';
import { friendLevelFrom, levelName, type SproutStage } from './model';
import { getHidden } from './prefs';

export interface FriendSprout {
  stage: SproutStage;
  blossoms: number;
  points: number;
  level: number;
  levelName: string;
}

const STAGES: string[] = ['seed', 'sprout', 'sapling', 'tree'];
const REFRESH_KEY = '@kinlo/sprout/lastRefreshMine';
const REFRESH_EVERY_MS = 10 * 60 * 1000;

export async function fetchFriendSprout(friendId: string): Promise<FriendSprout | null> {
  try {
    if (!friendId) return null;
    const { data, error } = await supabase
      .from('sprout_stats')
      .select('stage, blossoms, points, level')
      .eq('user_id', friendId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as { stage: unknown; blossoms: unknown; points: unknown; level: unknown };
    if (typeof row.stage !== 'string' || !STAGES.includes(row.stage)) return null;
    // Server level is capped at 10 by design; derive the endless level from points.
    const level = friendLevelFrom(row.level, row.points);
    return {
      stage: row.stage as SproutStage,
      blossoms: typeof row.blossoms === 'number' ? row.blossoms : 0,
      points: typeof row.points === 'number' ? row.points : 0,
      level,
      levelName: levelName(level),
    };
  } catch {
    return null;
  }
}

/** Throttled to once per 10 minutes. */
export async function refreshMySprout(): Promise<void> {
  try {
    const last = Number(await AsyncStorage.getItem(REFRESH_KEY));
    if (Number.isFinite(last) && last > 0 && Date.now() - last < REFRESH_EVERY_MS) return;
    // Stamp first so a missing RPC is not retried on every screen focus.
    await AsyncStorage.setItem(REFRESH_KEY, String(Date.now()));
    // Converge the server flag on the local Show Sprout choice every time, so a
    // toggle made offline (or another account on this phone) can never leave a
    // Sprout visible to friends that the owner believes is hidden.
    // Order matters: hide FIRST, then refresh.
    const hidden = await getHidden();
    await supabase.rpc('set_my_sprout_shown', { p_shown: !hidden });
    await supabase.rpc('refresh_my_sprout');
  } catch {
    /* cosmetic feature; ignore */
  }
}

export async function setMySproutShown(shown: boolean): Promise<boolean> {
  try {
    const { error } = await supabase.rpc('set_my_sprout_shown', { p_shown: shown });
    return !error;
  } catch {
    return false;
  }
}
