/** Sprout local preferences (AsyncStorage). Every call fails soft. */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SproutStage } from './model';

const STAGES: string[] = ['seed', 'sprout', 'sapling', 'tree'];
const k = (name: string, userId: string) => `@kinlo/sprout/${name}/${userId}`;

async function getItem(key: string): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(key);
  } catch {
    return null;
  }
}
async function setItem(key: string, value: string): Promise<void> {
  try {
    await AsyncStorage.setItem(key, value);
  } catch {
    /* cosmetic feature; ignore */
  }
}

function asStage(v: string | null): SproutStage | null {
  return v && STAGES.includes(v) ? (v as SproutStage) : null;
}

/** Default false = Sprout is shown. Device-wide, not per user. */
export async function getHidden(): Promise<boolean> {
  return (await getItem('@kinlo/sprout/hidden')) === '1';
}
export async function setHiddenPref(hidden: boolean): Promise<void> {
  await setItem('@kinlo/sprout/hidden', hidden ? '1' : '0');
}

export async function getLastSeenStage(userId: string): Promise<SproutStage | null> {
  return asStage(await getItem(k('lastSeenStage', userId)));
}
export async function setLastSeenStage(userId: string, stage: SproutStage): Promise<void> {
  await setItem(k('lastSeenStage', userId), stage);
}

/** Highest stage ever shown; feeds the no-regress rule. */
export async function getCachedStage(userId: string): Promise<SproutStage | null> {
  return asStage(await getItem(k('cachedStage', userId)));
}
export async function setCachedStage(userId: string, stage: SproutStage): Promise<void> {
  await setItem(k('cachedStage', userId), stage);
}

export async function getLastOpenAt(userId: string): Promise<number | null> {
  const raw = await getItem(k('lastOpenAt', userId));
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}
export async function setLastOpenAt(userId: string, at: number): Promise<void> {
  await setItem(k('lastOpenAt', userId), String(at));
}
