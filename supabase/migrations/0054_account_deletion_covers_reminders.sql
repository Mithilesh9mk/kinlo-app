-- Kinlo · 0054 · account deletion must destroy the tables 0052 and 0053 added
-- (renumbered 8 Sep 2026 — this file itself did not collide, renumbered only
-- to stay contiguous with 0052/0053 above.)
--
-- 0044_account_deletion's anonymize_my_account() does NOT delete the users
-- row — it anonymises it (full_name = 'Deleted user', identity fields
-- nulled, deleted_at stamped) and separately DELETEs the tables holding
-- private data: personal_transactions, expense_drafts, friendships. That
-- design is deliberate and 0044's header explains it: transactions.paid_by
-- and transaction_payers.user_id are ON DELETE RESTRICT, and those rows are
-- also the COUNTERPARTY's financial record, so erasing them would silently
-- move someone else's balance.
--
-- Two consequences that this migration fixes:
--
--   1. personal_reminders (0049) is private data of exactly the kind 0044
--      destroys — your rent, your medicines, your card due dates — and
--      would have survived account deletion untouched.
--
--   2. debt_nudges (0048) would have survived too, and the ON DELETE
--      CASCADE on its two foreign keys does NOT save it: the cascade fires
--      when a users row is DELETED, and this flow never deletes one.
--
-- Both are erasure gaps, not cosmetic ones, against the DPDP/store
-- compliance position 0044 was written to satisfy. A deletion that leaves
-- private rows behind is not a deletion.
--
-- WHY A NEW MIGRATION RATHER THAN AN EDIT TO 0044
--   Shipped migrations are never edited in this project. anonymize_my_account
--   returns VOID and takes no arguments, so CREATE OR REPLACE alone is
--   enough — no DROP, no signature change, nothing else in the app has to
--   know. The entire 0044 body below is reproduced verbatim; the only
--   change is the two DELETE statements marked "added by 0050".
--
--   Verified before writing this: the LIVE definition was captured from
--   pg_get_functiondef and its body compared against 0044's committed text.
--   They are identical, so nothing production had drifted to is being lost
--   here.
--
-- account_deletion_preview() is deliberately NOT touched. Adding a column
-- to its RETURNS TABLE would need a DROP + CREATE, and reminders are not
-- something the user "leaves behind" for another party to inherit — the
-- preview exists to warn about outstanding balances and shared expenses.

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

  -- Added by 0050. Reminders are private the same way personal_transactions
  -- are: nobody else is party to them, so there is nothing to preserve.
  DELETE FROM public.personal_reminders    WHERE user_id = v_me;

  -- Added by 0050. Both directions: a nudge this user sent, and one sent to
  -- them. Neither carries money, and the cooldown it encodes is meaningless
  -- once the account is gone. The FK CASCADE cannot do this because the
  -- users row is anonymised, not deleted.
  DELETE FROM public.debt_nudges
   WHERE sender_id = v_me OR recipient_id = v_me;

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

-- Re-stated because CREATE OR REPLACE does not change ownership or grants,
-- but leaving them implicit is how a later reader ends up assuming anon
-- still has EXECUTE. REVOKE FROM PUBLIC alone does not remove anon's grant.
REVOKE ALL ON FUNCTION public.anonymize_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anonymize_my_account() TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT
--     pg_get_functiondef('public.anonymize_my_account()'::regprocedure) ILIKE '%personal_reminders%' AS reminders_cleaned,
--     pg_get_functiondef('public.anonymize_my_account()'::regprocedure) ILIKE '%debt_nudges%'        AS nudges_cleaned;
--   -> true, true
--
-- The replace must not have DROPPED anything 0044 did. All five of these
-- must still be present:
--   SELECT
--     pg_get_functiondef('public.anonymize_my_account()'::regprocedure) ILIKE '%personal_transactions%'  AS keeps_personal_tx,
--     pg_get_functiondef('public.anonymize_my_account()'::regprocedure) ILIKE '%expense_drafts%'         AS keeps_drafts,
--     pg_get_functiondef('public.anonymize_my_account()'::regprocedure) ILIKE '%friendships%'            AS keeps_friendships,
--     pg_get_functiondef('public.anonymize_my_account()'::regprocedure) ILIKE '%connection_requests%'    AS keeps_conn_requests,
--     pg_get_functiondef('public.anonymize_my_account()'::regprocedure) ILIKE '%Deleted user%'           AS keeps_identity_strip;
--   -> all true
--
--   SELECT
--     has_function_privilege('anon', 'public.anonymize_my_account()', 'EXECUTE')          AS anon_can_call,
--     has_function_privilege('authenticated', 'public.anonymize_my_account()', 'EXECUTE') AS authenticated_can_call;
--   -> false, true
--
-- FUNCTIONAL — on a THROWAWAY account only; this is irreversible. Signed in
-- as that account through supabase-js (auth.uid() is NULL in the SQL
-- editor, so the function returns immediately there and proves nothing):
--   create one personal reminder and send one debt nudge, then
--   select public.anonymize_my_account();
--   -> select count(*) from personal_reminders where user_id = <them>;  -> 0
--   -> select count(*) from debt_nudges
--        where sender_id = <them> or recipient_id = <them>;             -> 0
--   -> select count(*) from personal_transactions where user_id = <them>; -> 0
--   -> select full_name, deleted_at from users where id = <them>;
--      -> 'Deleted user', a timestamp
