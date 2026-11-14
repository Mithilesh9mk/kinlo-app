import { Linking, Platform } from 'react-native';
import * as Updates from 'expo-updates';

/**
 * Manual "Check for updates" (Profile).
 *
 * Two different kinds of update exist and only one can be installed from
 * inside the app:
 *
 *  - Over-the-air (JS) updates: downloaded here with expo-updates and applied
 *    by restarting the app. Only updates published for this build's runtime
 *    version are ever offered, so this can never pull an incompatible bundle.
 *  - A new build in the Play Store / App Store: the app cannot install that
 *    itself, and it has no way to ask the store which version is newest
 *    without a native in-app-update module (not in this build). Until then
 *    the best it can do is open the store page. STORE_LISTING_URL stays null
 *    while Kinlo is not published, which hides that option entirely rather
 *    than showing a link that goes nowhere.
 */
export const STORE_LISTING_URL: string | null = Platform.select<string | null>({
  android: null, // e.g. 'https://play.google.com/store/apps/details?id=<package>' once published
  ios: null, // e.g. 'https://apps.apple.com/app/id<app id>' once published
  default: null,
});

export type UpdateCheckResult =
  | { status: 'ready' } // downloaded; restart to apply
  | { status: 'up_to_date' }
  | { status: 'unavailable' } // dev build, or updates disabled in this binary
  | { status: 'error' };

export async function checkAndDownloadUpdate(): Promise<UpdateCheckResult> {
  if (__DEV__ || !Updates.isEnabled) return { status: 'unavailable' };
  try {
    const check = await Updates.checkForUpdateAsync();
    if (!check.isAvailable) return { status: 'up_to_date' };
    const fetched = await Updates.fetchUpdateAsync();
    return fetched.isNew ? { status: 'ready' } : { status: 'up_to_date' };
  } catch (e) {
    console.warn('Update check failed:', e);
    return { status: 'error' };
  }
}

export async function restartToApplyUpdate(): Promise<void> {
  try {
    await Updates.reloadAsync();
  } catch (e) {
    console.warn('Could not restart to apply the update:', e);
  }
}

export function openStoreListing(): void {
  if (STORE_LISTING_URL) Linking.openURL(STORE_LISTING_URL).catch(() => {});
}
