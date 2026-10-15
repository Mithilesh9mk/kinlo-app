-- Kinlo · 0044 · account deletion
--
-- Profile's "Delete Account & Data" button has never done anything —
-- handleDeleteAccountAttempt() only opened a modal. Both stores require a
-- working deletion path (Play additionally requires one reachable from the
-- web without signing in), and DPDP/GDPR give a right to erasure. This is
-- the data half; supabase/functions/delete-account handles the parts SQL
-- cannot reach (Storage objects and the auth login itself).
--
-- WHY THIS ANONYMISES RATHER THAN ROW-DELETES
--
-- Not a shortcut — a hard DELETE is both blocked and wrong here:
--
--   * transactions.paid_by and transaction_payers.user_id are ON DELETE
--     RESTRICT. Anyone who has ever paid for anything cannot be deleted at
--     all; the delete simply fails.
--   * More importantly, those rows are ALSO the other person's record. If
--     you and I split a dinner and my row vanishes, your balance silently
--     changes and your history loses a counterparty. Erasing one person's
--     data must not rewrite someone else's financial record.
--
-- So: everything private to the user is destroyed, everything another user
-- depends on is stripped of identity and kept. What remains of a deleted
-- account is a nameless participant on expenses other people still own.
-- The privacy policy must describe exactly this — see lib/legal.ts.
--
-- WHAT IS DESTROYED
--   personal_transactions   private by definition, nobody else can see them
--   expense_drafts          unposted, private
--   friendships             a relationship, not a financial record
--   push_token              contactability
--   name / phone / avatar / upi_address   identity
--
-- WHAT IS KEPT, DE-IDENTIFIED
--   transactions, transaction_splits, transaction_payers, simplified_settlements,
--   group_members, activity_events — all load-bearing for other people.
--
-- OUTSTANDING BALANCES ARE NOT BLOCKED
--   Refusing to delete an account that still owes money would make erasure
--   conditional on settling a debt, which is not a defensible reading of a
--   statutory right. The client warns first (see account_deletion_preview)
--   so the choice is informed; the other party keeps their claim against a
--   now-nameless participant.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ---------------------------------------------------------------------------
-- account_deletion_preview — what the user is about to lose / leave behind
-- ---------------------------------------------------------------------------
-- Called before the confirmation prompt so the warning states real numbers
-- rather than a generic "this cannot be undone".
CREATE OR REPLACE FUNCTION public.account_deletion_preview()
RETURNS TABLE (
  outstanding_owed_to_you  NUMERIC,
  outstanding_you_owe      NUMERIC,
  open_groups              INTEGER,
  personal_entries         INTEGER,
  shared_expenses          INTEGER
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    COALESCE((SELECT SUM(s.amount) FROM public.simplified_settlements s
              WHERE s.creditor_id = auth.uid()), 0)::NUMERIC,
    COALESCE((SELECT SUM(s.amount) FROM public.simplified_settlements s
              WHERE s.debtor_id = auth.uid()), 0)::NUMERIC,
    (SELECT COUNT(*)::INTEGER FROM public.group_members gm WHERE gm.user_id = auth.uid()),
    (SELECT COUNT(*)::INTEGER FROM public.personal_transactions pt
      WHERE pt.user_id = auth.uid() AND pt.status <> 'voided'),
    (SELECT COUNT(DISTINCT ts.transaction_id)::INTEGER FROM public.transaction_splits ts
      WHERE ts.user_id = auth.uid());
$$;

-- ---------------------------------------------------------------------------
-- anonymize_my_account — the destructive step
-- ---------------------------------------------------------------------------
-- Callable only for the caller's own account: there is no user-id parameter
-- precisely so it cannot be aimed at anyone else.
CREATE OR REPLACE FUNCTION public.anonymize_my_account()
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me UUID := auth.uid();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  IF EXISTS (SELECT 1 FROM public.users WHERE id = v_me AND deleted_at IS NOT NULL) THEN
    RETURN;  -- idempotent: a retried delete must not error
  END IF;

  -- Private data: destroyed outright.
  DELETE FROM public.personal_transactions WHERE user_id = v_me;
  DELETE FROM public.expense_drafts        WHERE user_id = v_me;
  DELETE FROM public.friendships           WHERE user_id = v_me OR friend_id = v_me;

  -- Any connection request naming this account is moot now.
  UPDATE public.connection_requests
     SET status = 'cancelled'
   WHERE status = 'pending'
     AND (owner_id = v_me OR claimant_id = v_me);

  -- Identity: stripped. full_name is NOT NULL, so it gets a constant rather
  -- than NULL — every screen renders a name and a blank would surface as an
  -- empty row rather than an obviously-departed user.
  UPDATE public.users
     SET full_name    = 'Deleted user',
         phone_number = NULL,
         avatar_url   = NULL,
         upi_address  = NULL,
         push_token   = NULL,
         is_verified  = FALSE,
         deleted_at   = now()
   WHERE id = v_me;

  -- Placeholder contacts this user created for people who never joined are
  -- their data, not the placeholder's — and with the creator gone nobody can
  -- ever claim them. Remove the ones carrying no financial history.
  DELETE FROM public.users p
  WHERE p.is_placeholder = TRUE
    AND p.created_by = v_me
    AND NOT EXISTS (SELECT 1 FROM public.transaction_splits ts WHERE ts.user_id = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.transactions t        WHERE t.paid_by = p.id)
    AND NOT EXISTS (SELECT 1 FROM public.transaction_payers tp WHERE tp.user_id = p.id);
END;
$$;

REVOKE ALL ON FUNCTION public.account_deletion_preview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.anonymize_my_account()     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.account_deletion_preview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.anonymize_my_account()     TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name='users' AND column_name='deleted_at';
--   -> one row
--
--   SELECT
--     has_function_privilege('anon','public.anonymize_my_account()','EXECUTE')          AS anon_del,
--     has_function_privilege('authenticated','public.anonymize_my_account()','EXECUTE') AS auth_del;
--   -> false, true
--
-- FUNCTIONAL — use a throwaway account, this is irreversible:
--   1. Sign up, add an expense with someone, log a personal expense.
--   2. Run the deletion from Profile.
--   3. The other person's balance with you must be UNCHANGED:
--        SELECT * FROM public.simplified_settlements WHERE debtor_id = '<them>' OR creditor_id = '<them>';
--   4. Your row must be stripped:
--        SELECT full_name, phone_number, upi_address, deleted_at
--        FROM public.users WHERE id = '<you>';
--        -> 'Deleted user', NULL, NULL, a timestamp
--   5. Nothing private must remain:
--        SELECT COUNT(*) FROM public.personal_transactions WHERE user_id = '<you>';  -> 0
--        SELECT COUNT(*) FROM public.expense_drafts        WHERE user_id = '<you>';  -> 0
--        SELECT COUNT(*) FROM public.friendships WHERE user_id='<you>' OR friend_id='<you>'; -> 0
