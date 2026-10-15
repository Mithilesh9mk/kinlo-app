import { supabase } from './supabase';

/**
 * Deleting your account.
 *
 * See supabase/migrations/0044_account_deletion.sql for why this anonymises
 * rather than row-deletes: expenses you shared are also the other person's
 * record, and erasing them would silently change someone else's balance.
 *
 * The previous UI claimed deletion was "blocked under regulatory
 * guidelines" while a balance was outstanding, and offered to settle via
 * Plaid — a provider this app does not use. Both were invented. Erasure is
 * a right, not something conditional on settling a debt, so an outstanding
 * balance is now a warning rather than a block.
 */

export interface DeletionPreview {
  owedToYou: number;
  youOwe: number;
  openGroups: number;
  personalEntries: number;
  sharedExpenses: number;
}

export async function fetchDeletionPreview(): Promise<DeletionPreview> {
  const { data, error } = await supabase.rpc('account_deletion_preview').maybeSingle();
  if (error) throw new Error(error.message);

  const r = (data ?? {}) as any;
  return {
    owedToYou: Number(r.outstanding_owed_to_you) || 0,
    youOwe: Number(r.outstanding_you_owe) || 0,
    openGroups: Number(r.open_groups) || 0,
    personalEntries: Number(r.personal_entries) || 0,
    sharedExpenses: Number(r.shared_expenses) || 0,
  };
}

/**
 * Irreversible. Purges private data, strips identity from shared records,
 * removes receipt images, and deletes the login itself.
 *
 * Goes through the edge function rather than calling the RPC directly
 * because two of the three steps need service_role: removing Storage
 * objects, and deleting the auth user. Anonymising without deleting the
 * login would leave an account that still signs in — not "deleted" by
 * either store's definition.
 */
export async function deleteMyAccount(): Promise<void> {
  const { data, error } = await supabase.functions.invoke('delete-account');

  if (error) {
    // supabase-js collapses any non-2xx into an opaque FunctionsHttpError
    // and leaves data null, so the function's own message — which
    // distinguishes "your data is gone but the login remains" from "nothing
    // happened" — is only reachable through the stashed Response.
    const context = (error as { context?: unknown }).context;
    if (context instanceof Response) {
      try {
        const body = await context.json();
        if (body?.error) throw new Error(body.error);
      } catch {
        // fall through to the generic message below
      }
    }
    throw new Error('Could not delete your account. Please try again.');
  }

  if (data && (data as any).ok === false) {
    throw new Error((data as any).error || 'Could not delete your account.');
  }

  // The JWT is dead once the auth user is gone; clear local session state so
  // the app doesn't sit on credentials that no longer resolve.
  await supabase.auth.signOut().catch(() => {});
}
