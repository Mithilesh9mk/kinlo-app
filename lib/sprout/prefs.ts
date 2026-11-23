/** Sprout local preferences (AsyncStorage). Every call fails soft. */
import AsyncStorage from '@react-native-async-storage/async-storage';

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

/** Valid level = integer 1..10, else null. */
function asLevel(v: string | null): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 10 ? n : null;
}

/** Default false = Sprout is shown. Device-wide, not per user. */
export async function getHidden(): Promise<boolean> {
  return (await getItem('@kinlo/sprout/hidden')) === '1';
}
export async function setHiddenPref(hidden: boolean): Promise<void> {
  await setItem('@kinlo/sprout/hidden', hidden ? '1' : '0');
}

export async function getLastSeenLevel(userId: string): Promise<number | null> {
  return asLevel(await getItem(k('lastSeenLevel', userId)));
}
export async function setLastSeenLevel(userId: string, level: number): Promise<void> {
  await setItem(k('lastSeenLevel', userId), String(level));
}

/** Highest level ever shown; feeds the no-regress rule. */
export async function getCachedLevel(userId: string): Promise<number | null> {
  return asLevel(await getItem(k('cachedLevel', userId)));
}
export async function setCachedLevel(userId: string, level: number): Promise<void> {
  await setItem(k('cachedLevel', userId), String(level));
}

export async function getLastOpenAt(userId: string): Promise<number | null> {
  const raw = await getItem(k('lastOpenAt', userId));
  const n = raw == null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}
export async function setLastOpenAt(userId: string, at: number): Promise<void> {
  await setItem(k('lastOpenAt', userId), String(at));
}
