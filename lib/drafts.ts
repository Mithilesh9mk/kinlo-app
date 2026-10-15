import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';

/**
 * Saving and restoring a half-composed expense.
 *
 * Two stores, on purpose:
 *
 *   AsyncStorage   written on every change, instantly, offline. Covers the
 *                  common case — the app is killed or backgrounded away.
 *   expense_drafts written debounced, on step transitions. Covers what local
 *                  storage cannot: a lost, wiped or replaced device.
 *
 * Local is the fast path; the server is the safety net. Losing a draft now
 * requires both to fail.
 *
 * A draft is NOT a financial event. It never touches transactions,
 * transaction_splits or the ledger, and nothing here can affect a balance —
 * §11 is explicit that a draft must not, and keeping it in its own table with
 * an opaque payload is what makes that true by construction rather than by
 * discipline.
 *
 * See supabase/migrations/0027_expense_drafts.sql.
 */

const LOCAL_KEY = 'kinlo.expenseDraft.v1';

/** How long after the last change before the server copy is written. */
const SYNC_DEBOUNCE_MS = 2500;

/**
 * How long an untouched draft is allowed to sit before it's treated as
 * abandoned. Past this, loadDraft() clears it instead of returning it — it
 * holds a plaintext amount/description in local AsyncStorage with no
 * expiry otherwise, and a two-day-old half-typed expense isn't worth
 * resuming anyway.
 */
const MAX_DRAFT_AGE_MS = 1000 * 60 * 60 * 48;

export interface ExpenseDraft {
  amount: string;
  description: string;
  category: string;
  splitMode: string;
  groupId?: string | null;
  payers: unknown[];
  participants: unknown[];
  /** When this draft was last touched, so a stale one can be aged out. */
  savedAt: string;
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Whether a draft holds enough to be worth restoring.
 *
 * A draft created by simply opening the amount screen and backing out is noise,
 * and offering to resume it would be worse than dropping it. Anything with a
 * real amount, a description, or chosen participants is worth keeping.
 */
export function isDraftMeaningful(draft: ExpenseDraft | null): boolean {
  if (!draft) return false;
  const amount = parseFloat(draft.amount || '0');
  return (
    (Number.isFinite(amount) && amount > 0) ||
    (draft.description || '').trim().length > 0 ||
    (draft.participants?.length ?? 0) > 0
  );
}

/** Writes locally at once, and schedules the server copy. */
export async function saveDraft(draft: ExpenseDraft): Promise<void> {
  const stamped: ExpenseDraft = { ...draft, savedAt: new Date().toISOString() };

  try {
    await AsyncStorage.setItem(LOCAL_KEY, JSON.stringify(stamped));
  } catch (e) {
    console.warn('Could not save draft locally:', e);
  }

  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { void pushDraftToServer(stamped); }, SYNC_DEBOUNCE_MS);
}

/**
 * Writes the server copy now, skipping the debounce.
 *
 * Called when the user leaves the expense flow, since the timer would otherwise
 * be cancelled by the screen unmounting before it ever fired.
 */
export async function flushDraft(draft: ExpenseDraft): Promise<void> {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
  await pushDraftToServer({ ...draft, savedAt: new Date().toISOString() });
}

async function pushDraftToServer(draft: ExpenseDraft): Promise<void> {
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (!userId) return;

    const { error } = await supabase
      .from('expense_drafts')
      .upsert({ user_id: userId, payload: draft, updated_at: new Date().toISOString() });

    // Never surfaced to the user. A draft failing to sync is not something they
    // can act on, and the local copy has already succeeded.
    if (error) console.warn('Draft sync failed:', error.message);
  } catch (e) {
    console.warn('Draft sync threw:', e);
  }
}

/**
 * The most recent draft, local first.
 *
 * Local wins on a tie because it is written on every change while the server
 * copy lags by the debounce — so when both exist for the same session, local is
 * the fresher one. The server copy matters when local is absent, which is
 * exactly the reinstalled-or-replaced-device case it exists for.
 */
export async function loadDraft(): Promise<ExpenseDraft | null> {
  let local: ExpenseDraft | null = null;
  try {
    const raw = await AsyncStorage.getItem(LOCAL_KEY);
    if (raw) local = JSON.parse(raw) as ExpenseDraft;
  } catch (e) {
    console.warn('Could not read local draft:', e);
  }

  let remote: ExpenseDraft | null = null;
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (userId) {
      const { data } = await supabase
        .from('expense_drafts')
        .select('payload')
        .eq('user_id', userId)
        .maybeSingle();
      if (data?.payload) remote = data.payload as ExpenseDraft;
    }
  } catch (e) {
    console.warn('Could not read remote draft:', e);
  }

  const localAt = Date.parse(local?.savedAt || '') || 0;
  const remoteAt = Date.parse(remote?.savedAt || '') || 0;
  const winner = !local ? remote : !remote ? local : (remoteAt > localAt ? remote : local);
  if (!winner) return null;

  const age = Date.now() - Math.max(localAt, remoteAt);
  if (age > MAX_DRAFT_AGE_MS) {
    await clearDraft();
    return null;
  }

  return winner;
}

/**
 * Clears both copies. Called once an expense is actually posted — at that point
 * it is a transaction, and a draft of it would only invite posting it twice.
 */
export async function clearDraft(): Promise<void> {
  if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }

  try {
    await AsyncStorage.removeItem(LOCAL_KEY);
  } catch (e) {
    console.warn('Could not clear local draft:', e);
  }

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const userId = sessionData?.session?.user?.id;
    if (userId) {
      await supabase.from('expense_drafts').delete().eq('user_id', userId);
    }
  } catch (e) {
    console.warn('Could not clear remote draft:', e);
  }
}
