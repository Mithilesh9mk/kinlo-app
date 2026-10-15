import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { hasAnyPersonalTransaction } from './personalTransactions';

export type HintKind = 'split' | 'personal';

export const HINT_KEYS: Record<HintKind, string> = {
  split: 'kinlo.hint.firstSplit',
  personal: 'kinlo.hint.firstPersonal',
};

/**
 * Home's first-run guidance. Dismissal is per device (AsyncStorage), cleared
 * on logout. Both flags stay false until everything they depend on has
 * resolved, so nothing flashes on a cold start.
 *
 * `activityReady` must be true only when Home's recent-activity load has
 * finished AND came from the live fetch (not the offline cache).
 */
export function useFirstRunHints(opts: { activityReady: boolean; activityCount: number }) {
  // null = not read yet.
  const [dismissed, setDismissed] = useState<Record<HintKind, boolean> | null>(null);
  const [hasPersonal, setHasPersonal] = useState<boolean | null>(null);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      (async () => {
        try {
          const [s, p] = await Promise.all([
            AsyncStorage.getItem(HINT_KEYS.split),
            AsyncStorage.getItem(HINT_KEYS.personal),
          ]);
          if (active) setDismissed({ split: s === 'dismissed', personal: p === 'dismissed' });
        } catch {
          if (active) setDismissed({ split: false, personal: false });
        }
        try {
          const any = await hasAnyPersonalTransaction();
          if (active) setHasPersonal(any);
        } catch {
          // Unknown (offline/error) → keep the card hidden rather than guess.
          if (active) setHasPersonal(null);
        }
      })();
      return () => {
        active = false;
      };
    }, [])
  );

  const dismiss = useCallback((kind: HintKind) => {
    setDismissed((prev) => ({ split: false, personal: false, ...prev, [kind]: true }));
    AsyncStorage.setItem(HINT_KEYS[kind], 'dismissed').catch(() => {});
  }, []);

  const showSplit =
    dismissed !== null && !dismissed.split && opts.activityReady && opts.activityCount === 0;
  const showPersonal = dismissed !== null && !dismissed.personal && hasPersonal === false;

  return { showSplit, showPersonal, dismiss };
}
