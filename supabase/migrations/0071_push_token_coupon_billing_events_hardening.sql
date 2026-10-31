-- Kinlo · 0071 · push tokens private, seeded coupon neutralised, billing_events tied to the account
--
-- Three independent gaps found in the public-repo review. Each section is
-- guarded and idempotent, and sections 2 and 3 are harmless no-ops when the
-- thing they act on is absent. Written as a new file because 0061 and 0063
-- are shipped / pending and must not be edited.
--
-- ORDER THE OWNER MUST APPLY (see docs/sql/0071_paste_and_verify.sql):
--   0063 first (if it has not been applied yet), then 0071.
--   0071 on its own, before 0063, is safe: section 3 notices that
--   billing_events does not exist and skips. In that case run section 3 of
--   the paste script again after 0063 lands.
--
-- 1. users.push_token WAS READABLE BY OTHER PEOPLE
--
--   users_select_related (0002) lets a signed-in user read the whole users
--   row of anyone they share a group, friendship or expense with, and 0068
--   notes that a single one-way friendship insert used to be enough. The
--   table-level SELECT grant to `authenticated` covers every column, so
--   push_token (an Expo push token, which anyone holding it can use to send
--   push notifications to that device through Expo's API) came along with
--   name, phone and UPI id. The lookup RPCs (get_related_users 0011,
--   match_contacts_by_phone 0038, resolve_user_by_phone 0039/0065) do NOT
--   return it: they name their output columns, and no view or rowtype
--   function in the migrations exposes it. The leak was the direct table
--   read.
--
--   Fix: column-level privileges. Table-level SELECT is revoked from the
--   client roles and re-granted on every column EXCEPT push_token. Nothing
--   else changes: RLS is untouched, INSERT/UPDATE grants are untouched (so
--   hooks/usePushNotifications.ts can still write its own token with
--   `update({ push_token })`; it never reads it back).
--
--   Who can still read push_token: the postgres owner and service_role
--   (push-notify uses the service role and is unaffected), and every
--   SECURITY DEFINER function, which runs as postgres (anonymize_my_account
--   clears it). Clients, including the token's own owner, cannot SELECT it;
--   nothing in the app does.
--
--   Why this and not a separate owner-only token table: moving the token
--   would mean changing push-notify, the registration hook, the three
--   account-deletion functions and send_debt_nudge, plus a data copy and a
--   deploy ordering between the app, the edge function and the database. A
--   column grant is one statement, needs no deploy, and is checked by one
--   query: has_column_privilege('authenticated','public.users','push_token',
--   'SELECT') must be false.
--
--   Consequences to know about:
--     * `select('*')` / `select=*` on public.users from a client now fails
--       with "permission denied for table users". No client code does that
--       (checked: every users select names its columns).
--     * A column added to public.users LATER is not readable by clients until
--       a migration GRANTs SELECT on it. Fail-closed, and deliberate.
--     * The grant list is built from pg_attribute at apply time, so columns
--       that exist in production but not in the committed schema (this
--       project has drifted before) are still covered.
--
-- 2. THE OWNER COUPON IS IN PLAINTEXT IN 0061 (PUBLIC REPO)
--
--   0061 seeds one 'owner coupon'. The code cannot be un-published from git
--   history, so it is made useless instead: every coupon with that note that
--   has not been fully redeemed is switched to active = false (redeem_coupon
--   rejects inactive codes). It is matched by its columns (note and
--   redeemed_count), never by retyping the code, so no code appears in this
--   file. Rows are not deleted: coupon_redemptions references coupon_codes
--   (code), and an already-redeemed coupon keeps its history. Gold already
--   granted by redemption is not touched (user_plans is separate).
--
--   To mint a replacement, use the commented owner-run snippet at the bottom
--   of docs/sql/0071_paste_and_verify.sql. It is deliberately NOT in this
--   migration: a migration is committed to a public repo.
--
-- 3. billing_events HAD NO FOREIGN KEY (0063)
--
--   0063 left billing_events.user_id unconstrained "so deleting an account is
--   never blocked", which also meant the rows outlived the account forever.
--   delete-account ends with auth.admin.deleteUser, so a foreign key to
--   auth.users(id) ON DELETE CASCADE does both: deletion is never blocked,
--   and the rows go with the login. Orphan rows (users that no longer exist)
--   are removed first or the constraint could not be added. Trade-off: the
--   store-event audit trail for a deleted account is gone; the store itself
--   (Google Play / RevenueCat) keeps the authoritative purchase record.
--   apply_store_event already refuses unknown users, so valid webhooks are
--   unaffected.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. users.push_token: column-level read lockdown
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_cols text;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'ABORT 0071: public.users does not exist';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.users'::regclass
      AND attname = 'push_token' AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'ABORT 0071: public.users has no push_token column; schema differs from what this migration was written against';
  END IF;

  SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
    INTO v_cols
  FROM pg_attribute
  WHERE attrelid = 'public.users'::regclass
    AND attnum > 0
    AND NOT attisdropped
    AND attname <> 'push_token';

  -- Table-level grant first (a table-level SELECT covers every column, so it
  -- must go before a column list means anything), then any stray
  -- column-level grant on the token itself, then the explicit list.
  REVOKE SELECT ON public.users FROM PUBLIC, anon, authenticated;
  REVOKE SELECT (push_token) ON public.users FROM PUBLIC, anon, authenticated;
  EXECUTE format('GRANT SELECT (%s) ON public.users TO authenticated', v_cols);
END $$;

-- ---------------------------------------------------------------------------
-- 2. Neutralise the coupon seeded by 0061 (matched by columns, not by code)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_n int;
BEGIN
  IF to_regclass('public.coupon_codes') IS NULL THEN
    RAISE NOTICE '0071: public.coupon_codes does not exist; skipping coupon step';
    RETURN;
  END IF;

  UPDATE public.coupon_codes
     SET active = false
   WHERE note = 'owner coupon'
     AND active
     AND redeemed_count < max_redemptions;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE '0071: deactivated % unredeemed owner coupon(s)', v_n;
END $$;

-- ---------------------------------------------------------------------------
-- 3. billing_events -> auth.users foreign key (only if 0063 has been applied)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_orphans int;
BEGIN
  IF to_regclass('public.billing_events') IS NULL THEN
    RAISE NOTICE '0071: public.billing_events does not exist (0063 not applied); skipping foreign key. Re-run section 3 of the paste script after applying 0063.';
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.billing_events'::regclass
      AND conname = 'billing_events_user_id_fkey'
  ) THEN
    RAISE NOTICE '0071: billing_events_user_id_fkey already present; nothing to do';
    RETURN;
  END IF;

  DELETE FROM public.billing_events b
   WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = b.user_id);
  GET DIAGNOSTICS v_orphans = ROW_COUNT;
  RAISE NOTICE '0071: removed % orphaned billing_events row(s)', v_orphans;

  ALTER TABLE public.billing_events
    ADD CONSTRAINT billing_events_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
END $$;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY: see docs/sql/0071_paste_and_verify.sql (section 3)
-- ---------------------------------------------------------------------------
