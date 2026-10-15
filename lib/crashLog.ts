import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Records a fatal JS error to disk so it survives the crash, and surfaces it
 * on the next launch.
 *
 * WHY THIS EXISTS
 *
 * "Add Expense" and "Settle Up" were going blank and then killing the app
 * ("Kinlo keeps stopping"). The ErrorBoundary added alongside this catches
 * render-time throws — it did NOT catch this one, which means the failure is
 * outside React's render path: an unhandled promise rejection, a callback,
 * or a native module call. Those bypass error boundaries entirely.
 *
 * In a release build there is no redbox and no dev console, so such an error
 * takes the whole process down with nothing written anywhere. This app has
 * no crash-reporting SDK either, and adding one (Sentry et al.) needs a
 * native rebuild. This does not: ErrorUtils is a plain JS global, so the
 * whole mechanism ships over the air.
 *
 * The write is deliberately fire-and-forget and wrapped in its own guard —
 * a crash reporter that throws while reporting a crash is worse than none.
 */

const KEY = 'kinlo.lastCrash.v1';

export interface CrashRecord {
  message: string;
  stack: string;
  isFatal: boolean;
  at: string;
}

export async function getLastCrash(): Promise<CrashRecord | null> {
  try {
    const raw = await AsyncStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as CrashRecord) : null;
  } catch {
    return null;
  }
}

export async function clearLastCrash(): Promise<void> {
  try {
    await AsyncStorage.removeItem(KEY);
  } catch {
    // nothing useful to do
  }
}

/**
 * Chains onto the existing global handler rather than replacing it, so
 * whatever RN would normally do (including actually crashing) still happens.
 * We only add the recording step.
 */
export function installCrashLogger(): void {
  // globalThis, not `global` — this project's tsconfig has no @types/node
  // (deliberately: a devDependency would feed the EAS fingerprint and could
  // orphan installed builds from OTA updates), so `global` is not declared.
  const g = globalThis as any;
  if (!g.ErrorUtils || g.__kinloCrashLoggerInstalled) return;
  g.__kinloCrashLoggerInstalled = true;

  const previous = g.ErrorUtils.getGlobalHandler?.();

  g.ErrorUtils.setGlobalHandler((error: any, isFatal?: boolean) => {
    try {
      const record: CrashRecord = {
        message: String(error?.message ?? error ?? 'Unknown error'),
        stack: String(error?.stack ?? '(no stack)'),
        isFatal: !!isFatal,
        at: new Date().toISOString(),
      };
      // Intentionally not awaited: the process may be about to die, and an
      // await here would just lose the record to the shutdown.
      AsyncStorage.setItem(KEY, JSON.stringify(record)).catch(() => {});
      console.error('Kinlo fatal error captured:', record.message, record.stack);
    } catch {
      // never let the reporter mask the original failure
    }

    if (typeof previous === 'function') previous(error, isFatal);
  });

  // Unhandled promise rejections do not reach ErrorUtils on their own. This
  // is the most likely shape of the current bug — an async mount effect
  // rejecting with nothing to catch it.
  try {
    const tracking = require('promise/setimmediate/rejection-tracking');
    tracking.enable({
      allRejections: true,
      onUnhandled: (id: number, error: any) => {
        try {
          const record: CrashRecord = {
            message: 'Unhandled promise rejection: ' + String(error?.message ?? error),
            stack: String(error?.stack ?? '(no stack)'),
            isFatal: false,
            at: new Date().toISOString(),
          };
          AsyncStorage.setItem(KEY, JSON.stringify(record)).catch(() => {});
          console.error('Kinlo unhandled rejection:', record.message, record.stack);
        } catch {
          // same reasoning as above
        }
      },
      onHandled: () => {},
    });
  } catch {
    // the rejection-tracking module is an RN internal; if its path ever
    // changes, the ErrorUtils handler above still covers fatal errors.
  }
}
