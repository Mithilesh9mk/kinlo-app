import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * A random id for THIS app install, used only to keep free-plan limits from
 * being reset by creating more accounts on the same phone (see migration 0064).
 *
 * It contains no personal data and is not the hardware id. It is generated
 * once and kept across sign-outs (deliberately NOT cleared on logout - that
 * is the point), and it resets if the app is reinstalled or its data cleared.
 * Because the client supplies it, it is a speed bump, not a lock: see the
 * HONEST LIMITS note in 0064. Never throws; null means "unavailable" and the
 * server then simply skips the per-install check.
 */

const KEY = 'kinlo.deviceId';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function randomUuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

let cached: string | null = null;

export async function getDeviceId(): Promise<string | null> {
  if (cached) return cached;
  try {
    const stored = await AsyncStorage.getItem(KEY);
    if (stored && UUID_RE.test(stored)) {
      cached = stored;
      return stored;
    }
    const fresh = randomUuid();
    await AsyncStorage.setItem(KEY, fresh);
    cached = fresh;
    return fresh;
  } catch {
    return null;
  }
}
