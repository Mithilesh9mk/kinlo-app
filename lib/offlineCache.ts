import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Generic "show the last thing we fetched" cache for read-only screens.
 *
 * Not a general offline queue and never should be — it has no idea how to
 * merge, replay or reconcile a write, so it only ever wraps a read. Any
 * screen with a network-dependent write (add expense, settle up, void, scan
 * a receipt) must keep failing normally offline; wrapping those here would
 * make a stale local number look like it was ever actually saved.
 *
 * Key convention matches lib/drafts.ts: a fixed `kinlo.cache.` prefix, no
 * per-user namespacing (this app already assumes one account per device —
 * see drafts.ts's LOCAL_KEY and the onboarding_* keys).
 */

const PREFIX = 'kinlo.cache.';

export interface CacheEnvelope<T> {
  data: T;
  /** ISO timestamp, set when this entry was written. */
  cachedAt: string;
}

export async function writeCache<T>(key: string, data: T): Promise<void> {
  try {
    const envelope: CacheEnvelope<T> = { data, cachedAt: new Date().toISOString() };
    await AsyncStorage.setItem(PREFIX + key, JSON.stringify(envelope));
  } catch (e) {
    // A failed cache write should never block the live data that triggered
    // it from reaching the screen — log and move on.
    console.warn(`Could not write offline cache for "${key}":`, e);
  }
}

export async function readCache<T>(key: string): Promise<CacheEnvelope<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + key);
    if (!raw) return null;
    return JSON.parse(raw) as CacheEnvelope<T>;
  } catch (e) {
    console.warn(`Could not read offline cache for "${key}":`, e);
    return null;
  }
}

/**
 * Gate for whether a failed fetch may fall back to cache.
 *
 * Used to be a message/type sniff guessing "is this actually offline" vs a
 * real bug. Verified wrong on a real device: the heuristic never matched,
 * so every offline screen just showed blank instead of the cached data this
 * whole feature exists to serve. Now unconditional — any error falls back
 * to cache when one exists. Trade-off accepted: a genuine backend bug can
 * briefly show stale numbers instead of an error, until the next successful
 * fetch corrects it. That beats guaranteed blank screens on every real
 * outage, which is what the narrow version actually shipped.
 */
export function isLikelyNetworkError(_err: unknown): boolean {
  return true;
}

/**
 * Runs `fetcher`. On success, caches the result under `key` and returns it
 * live (`cachedAt: null`). On failure: if `isLikelyNetworkError(err)` and a
 * cache entry exists, returns the cached entry instead of throwing.
 * Otherwise rethrows — a non-network error, or a cold start with nothing
 * cached yet, must still surface as the caller's existing error handling,
 * not get silently swapped for stale data.
 */
export async function withOfflineFallback<T>(
  key: string,
  fetcher: () => Promise<T>,
): Promise<{ data: T; cachedAt: string | null }> {
  try {
    const data = await fetcher();
    await writeCache(key, data);
    return { data, cachedAt: null };
  } catch (err) {
    if (isLikelyNetworkError(err)) {
      const cached = await readCache<T>(key);
      if (cached) return { data: cached.data, cachedAt: cached.cachedAt };
    }
    throw err;
  }
}

/**
 * Removes every kinlo.cache.* entry. Call on sign-out so a shared device
 * never shows the previous account's stale numbers before the next
 * session's first live fetch completes.
 */
export async function clearOfflineCache(): Promise<void> {
  try {
    const keys = await AsyncStorage.getAllKeys();
    const cacheKeys = keys.filter((k) => k.startsWith(PREFIX));
    if (cacheKeys.length > 0) await AsyncStorage.multiRemove(cacheKeys);
  } catch (e) {
    console.warn('Could not clear offline cache:', e);
  }
}
