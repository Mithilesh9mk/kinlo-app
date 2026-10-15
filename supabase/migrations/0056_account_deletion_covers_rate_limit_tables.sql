-- Kinlo · 0056 · account deletion must also clear rate-limit counters
--
-- Core Functionality Audit 2026-08-31, finding P2 §4.6 "Orphaned rate-limit
-- rows on failed account deletion". 0054 already extended
-- anonymize_my_account() to cover debt_nudges and personal_reminders, but
-- push_notify_attempts / receipt_parse_attempts / delete_account_attempts
-- (0045/0046/0047) were never added to either 0044 or 0054. Each is keyed on
-- user_id with no FK to public.users at all (by design — see those
-- migrations' headers, the RPC writes them directly), so nothing cascades
-- when a users row is anonymised. Low severity — no PII beyond a UUID and a
-- call count — but a deletion that leaves rows behind is not a deletion, per
-- 0044's own stated compliance position.
--
-- WHY A NEW MIGRATION, WHY THE WHOLE BODY IS REPRODUCED
--   Same reasoning as 0050/0054: anonymize_my_account() returns VOID and
--   takes no arguments, so CREATE OR REPLACE alone is enough. The live body
--   was captured via pg_get_functiondef and diffed against this file before
--   applying — the only change is the three new DELETE statements.

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

  -- Added by 0056. Rate-limit counters carry no PII beyond the UUID itself
  -- (a call count and a window timestamp) and have no FK to users at all, so
  -- nothing cascades. Clearing them removes the orphan risk outright rather
  -- than accepting it.
  DELETE FROM public.push_notify_attempts    WHERE user_id = v_me;
  DELETE FROM public.receipt_parse_attempts  WHERE user_id = v_me;
  DELETE FROM public.delete_account_attempts WHERE user_id = v_me;

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

REVOKE ALL ON FUNCTION public.anonymize_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.anonymize_my_account() TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT prosrc ILIKE '%push_notify_attempts%'
--      AND prosrc ILIKE '%receipt_parse_attempts%'
--      AND prosrc ILIKE '%delete_account_attempts%' AS covers_rate_limit_tables
--   FROM pg_proc WHERE proname = 'anonymize_my_account';
--   -> true
--
--   SELECT has_function_privilege('anon', oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', oid, 'EXECUTE') AS authed
--   FROM pg_proc WHERE proname = 'anonymize_my_account';
--   -> anon = false, authed = true
