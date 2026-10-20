import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  PersonalReminder,
  ReminderRecurrence,
  listPersonalReminders,
  savePersonalReminder,
  completePersonalReminder,
  deletePersonalReminder,
  newTransactionId,
} from './reminders';
import { occurrencesAhead } from './recurrence';

/**
 * UI-facing facade over lib/reminders.ts (data access, throws) and
 * lib/recurrence.ts (date arithmetic). Two jobs:
 *
 *  1. Never throw to the UI — every call resolves to { ok, ... }.
 *  2. Mirror the table onto the device as local notifications. The table is
 *     the source of truth (see migration 0053); a failed or denied
 *     notification never fails a save.
 *
 * Notification identifiers are deterministic (`reminder:<id>:<n>`), so
 * cancelling needs no stored map and re-scheduling replaces in place.
 * Up to SLOTS upcoming occurrences are scheduled per reminder so a recurring
 * reminder keeps firing even if the app is not opened for a while.
 */

export type { PersonalReminder, ReminderRecurrence };

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const SLOTS = 3;
const CHANNEL_ID = 'reminders';

const idFor = (reminderId: string, n: number) => `reminder:${reminderId}:${n}`;

function msg(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Notifications (all best-effort)
// ---------------------------------------------------------------------------

/** Asks for permission only if it is still undetermined. Returns whether
 *  notifications can be delivered. Never throws. */
export async function ensureReminderPermission(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
        name: 'Reminders',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) {
      return true;
    }
    if (current.canAskAgain === false) return false;
    const asked = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    return asked.granted || asked.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
  } catch (e) {
    console.warn('Reminder permission check failed:', e);
    return false;
  }
}

export async function cancelReminderNotifications(reminderId: string): Promise<void> {
  for (let n = 0; n < SLOTS; n++) {
    try {
      await Notifications.cancelScheduledNotificationAsync(idFor(reminderId, n));
    } catch (e) {
      console.warn('Cancel reminder notification failed:', e);
    }
  }
}

/** Cancel then schedule the upcoming occurrences. Only active reminders get
 *  notifications. Does NOT prompt for permission — if not granted it is a no-op. */
export async function scheduleReminderNotifications(r: PersonalReminder): Promise<void> {
  await cancelReminderNotifications(r.id);
  if (r.status !== 'active') return;
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.ios?.status !== Notifications.IosAuthorizationStatus.PROVISIONAL) return;

    const dates = occurrencesAhead(r.nextDueAt, r.recurrence, SLOTS);
    for (let n = 0; n < dates.length; n++) {
      await Notifications.scheduleNotificationAsync({
        identifier: idFor(r.id, n),
        content: {
          title: r.title,
          body: r.amount !== null ? `Due: ₹${r.amount.toLocaleString('en-IN')}` : 'Reminder',
          data: { reminderId: r.id },
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.DATE,
          date: dates[n],
          ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
        },
      });
    }
  } catch (e) {
    console.warn('Scheduling reminder notification failed:', e);
  }
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export interface ReminderDraft {
  title: string;
  amount: number | null;
  recurrence: ReminderRecurrence;
  nextDueAt: Date;
}

export async function listReminders(): Promise<Result<PersonalReminder[]>> {
  try {
    const rows = await listPersonalReminders();
    return { ok: true, data: rows.filter((r) => r.status !== 'done') };
  } catch (e) {
    console.error('listReminders failed:', e);
    return { ok: false, error: msg(e) };
  }
}

export async function createReminder(draft: ReminderDraft): Promise<Result<PersonalReminder>> {
  try {
    // First save is the moment we ask for notification permission. Denial
    // must not block the save.
    await ensureReminderPermission();
    const saved = await savePersonalReminder({
      id: newTransactionId(),
      title: draft.title,
      amount: draft.amount,
      recurrence: draft.recurrence,
      nextDueAt: draft.nextDueAt.toISOString(),
    });
    await scheduleReminderNotifications(saved);
    return { ok: true, data: saved };
  } catch (e) {
    console.error('createReminder failed:', e);
    return { ok: false, error: msg(e) };
  }
}

/** Upsert on the existing id. Preserves category/notes/status by passing
 *  them through from `existing`, since the upsert writes the whole row. */
export async function updateReminder(
  existing: PersonalReminder,
  draft: ReminderDraft,
): Promise<Result<PersonalReminder>> {
  try {
    await ensureReminderPermission();
    const saved = await savePersonalReminder({
      id: existing.id,
      title: draft.title,
      amount: draft.amount,
      category: existing.category,
      notes: existing.notes,
      recurrence: draft.recurrence,
      nextDueAt: draft.nextDueAt.toISOString(),
      currency: existing.currency,
      dueTimeZone: existing.dueTimeZone,
      status: existing.status === 'done' ? 'active' : existing.status,
    });
    await scheduleReminderNotifications(saved);
    return { ok: true, data: saved };
  } catch (e) {
    console.error('updateReminder failed:', e);
    return { ok: false, error: msg(e) };
  }
}

/** One-off retires; repeating rolls forward and is re-scheduled. */
export async function markReminderDone(id: string): Promise<Result<PersonalReminder | null>> {
  try {
    const updated = await completePersonalReminder(id);
    if (updated) await scheduleReminderNotifications(updated);
    else await cancelReminderNotifications(id);
    return { ok: true, data: updated };
  } catch (e) {
    console.error('markReminderDone failed:', e);
    return { ok: false, error: msg(e) };
  }
}

export async function removeReminder(id: string): Promise<Result<true>> {
  try {
    await deletePersonalReminder(id);
    await cancelReminderNotifications(id);
    return { ok: true, data: true };
  } catch (e) {
    console.error('removeReminder failed:', e);
    return { ok: false, error: msg(e) };
  }
}

/** Re-derive the device schedule from the table (call on launch). Never throws. */
export async function resyncReminderNotifications(): Promise<void> {
  const res = await listReminders();
  if (!res.ok) return;
  for (const r of res.data) await scheduleReminderNotifications(r);
}
