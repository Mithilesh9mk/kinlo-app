import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Client-side brake on sign-in / sign-up / password-reset attempts.
 *
 * This is NOT the security boundary - anyone can bypass an app by calling the
 * API directly. The real limits are Supabase Auth's own rate limits and
 * CAPTCHA (dashboard: Authentication → Rate Limits / Attack Protection). This
 * exists to stop an honest user hammering a wrong password into a server-side
 * lockout, and to make scripted use of the app's own screens slow.
 *
 * Persisted so closing and reopening the app does not reset it. Never throws:
 * if storage fails the attempt is allowed.
 */

const KEY = 'kinlo.authAttempts.v1';
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const RESET_MIN_GAP_MS = 60 * 1000;

async function read(): Promise<number[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    const now = Date.now();
    return Array.isArray(arr)
      ? arr.filter((t): t is number => typeof t === 'number' && now - t < WINDOW_MS && t <= now)
      : [];
  } catch {
    return [];
  }
}

export type ThrottleResult = { allowed: true } | { allowed: false; retryInSeconds: number };

/** Records one sign-in / sign-up attempt, or says how long to wait. */
export async function takeAuthAttempt(): Promise<ThrottleResult> {
  const attempts = await read();
  if (attempts.length >= MAX_ATTEMPTS) {
    const retryMs = attempts[0] + WINDOW_MS - Date.now();
    return { allowed: false, retryInSeconds: Math.max(1, Math.ceil(retryMs / 1000)) };
  }
  try {
    await AsyncStorage.setItem(KEY, JSON.stringify([...attempts, Date.now()]));
  } catch {
    // allow
  }
  return { allowed: true };
}

export async function clearAuthAttempts(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // ignore
  }
}

const RESET_KEY = 'kinlo.resetSentAt.v1';

/** Password-reset emails: at most one per minute from this device. */
export async function takeResetEmail(): Promise<ThrottleResult> {
  try {
    const last = Number(await AsyncStorage.getItem(RESET_KEY));
    const now = Date.now();
    if (Number.isFinite(last) && last > 0 && now - last < RESET_MIN_GAP_MS && last <= now) {
      return { allowed: false, retryInSeconds: Math.ceil((RESET_MIN_GAP_MS - (now - last)) / 1000) };
    }
    await AsyncStorage.setItem(RESET_KEY, String(now));
  } catch {
    // allow
  }
  return { allowed: true };
}

export function throttleMessage(seconds: number): string {
  const mins = Math.ceil(seconds / 60);
  return seconds <= 90
    ? `Too many attempts. Please wait ${seconds} seconds and try again.`
    : `Too many attempts. Please wait about ${mins} minutes and try again.`;
}
