-- Kinlo · 0042 · previewing and performing a placeholder claim
--
-- Second half of the connection handshake started in 0041. That migration
-- records who is asking whom; this one shows the claimant what they are
-- taking on, and — once both sides have accepted — performs the merge.
--
-- THIS IS THE HIGHEST BLAST-RADIUS FUNCTION IN THE PROJECT.
--
-- A placeholder's id appears in twelve columns across ten tables. A merge
-- that half-applies leaves the ledger internally inconsistent in a way no
-- screen would show and no user could correct. Everything below runs in the
-- single implicit transaction of the function body, so any failure rolls
-- the whole thing back rather than leaving a partial rewrite.
--
-- COLLISIONS ARE REFUSED, NOT RESOLVED
--
-- If the claimant's real account and the placeholder both already appear on
-- the same expense, in the same group, or in overlapping friendships, then
-- re-pointing produces duplicate rows and double-counted balances. Rather
-- than guess at a correct de-duplication, v1 detects those cases and
-- refuses with a message naming the overlap. The clean case — a genuinely
-- new account with no prior relationship to the placeholder's history —
-- covers essentially all real usage, and refusing loudly is far safer than
-- silently producing a wrong balance. This is the same principle the ledger
-- work settled on: invariants belong in the database, and a guard that
-- cannot be sure should stop rather than approximate.
--
-- WHY simplified_settlements IS DELETED RATHER THAN RE-POINTED
--
-- It is derived data with a unique key on (group_id, debtor_id,
-- creditor_id). Re-pointing debtor_id from placeholder to claimant collides
-- whenever the claimant already holds a row against the same counterparty.
-- Deleting the placeholder's rows and rebuilding regenerates them correctly
-- and is the only approach consistent with 0002's rule that this table is
-- never written except by a rebuild.
--
-- ORDERING CONSTRAINTS THAT ARE NOT OPTIONAL
--
--   * transactions.paid_by and transaction_payers.user_id are both
--     ON DELETE RESTRICT. They MUST be re-pointed before the placeholder
--     row is deleted or the delete fails outright.
--   * The request rows must be marked merged/cancelled BEFORE the delete.
--     0041's placeholder_id is ON DELETE SET NULL, so after the delete they
--     can no longer be located by placeholder_id.
--   * The ledger rebuild must run AFTER the re-point, since it reads the
--     rewritten rows.

-- ---------------------------------------------------------------------------
-- preview_placeholder_claim — what the claimant would take on
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because the claimant has no RLS visibility into these
-- transactions yet — that is the entire point of the request. Scoped hard:
-- the caller must be a party to this specific request, and only rows the
-- placeholder actually appears on are returned.
--
-- The caller computes the net as SUM(you_paid) - SUM(your_share); positive
-- means the friend owes them, negative means they owe the friend.
CREATE OR REPLACE FUNCTION public.preview_placeholder_claim(p_request_id UUID)
-- Output columns are prefixed rather than named `description`/`total_amount`
-- etc. A RETURNS TABLE column is an in-scope variable inside a PL/pgSQL
-- body, and every one of those bare names also exists as a column on a
-- table this query touches. Postgres accepts the collision at CREATE time
-- and only fails on execution.
RETURNS TABLE (
  tx_id            UUID,
  tx_description   TEXT,
  tx_occurred_at   TIMESTAMPTZ,
  tx_total         NUMERIC,
  ph_share         NUMERIC,
  ph_paid          NUMERIC,
  tx_group_name    TEXT
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.connection_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT * INTO v_req FROM public.connection_requests WHERE id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That connection request no longer exists';
  END IF;

  IF auth.uid() NOT IN (v_req.owner_id, v_req.claimant_id) THEN
    RAISE EXCEPTION 'That connection request is not yours';
  END IF;

  IF v_req.placeholder_id IS NULL THEN
    RETURN;  -- already merged; nothing left to preview
  END IF;

  RETURN QUERY
  SELECT t.id,
         t.description::TEXT,
         t.created_at,
         t.amount,
         COALESCE(s.share_amount, 0)::NUMERIC,
         -- Explicit payer row when one exists; otherwise the transaction's
         -- own single payer. Mirrors 0021's paid CTE.
         COALESCE(
           p.amount_paid,
           CASE WHEN t.paid_by = v_req.placeholder_id THEN t.amount ELSE 0 END
         )::NUMERIC,
         g.name::TEXT
  FROM public.transactions t
  LEFT JOIN public.transaction_splits s
         ON s.transaction_id = t.id AND s.user_id = v_req.placeholder_id
  LEFT JOIN public.transaction_payers p
         ON p.transaction_id = t.id AND p.user_id = v_req.placeholder_id
  LEFT JOIN public.groups g ON g.id = t.group_id
  WHERE t.status IN ('active', 'settled')
    AND (s.user_id IS NOT NULL OR t.paid_by = v_req.placeholder_id)
  ORDER BY t.created_at DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- claim_placeholder — the merge
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_placeholder(p_request_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req         public.connection_requests%ROWTYPE;
  v_placeholder UUID;
  v_claimant    UUID;
  v_conflict    TEXT;
  r             RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT * INTO v_req FROM public.connection_requests
  WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That connection request no longer exists';
  END IF;

  IF auth.uid() NOT IN (v_req.owner_id, v_req.claimant_id) THEN
    RAISE EXCEPTION 'That connection request is not yours';
  END IF;

  -- Idempotent: a double-tap, or both sides calling this after the second
  -- acceptance, must not attempt a second merge.
  IF v_req.status = 'merged' THEN
    RETURN;
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'That connection request is no longer open';
  END IF;

  IF v_req.owner_response <> 'accepted' OR v_req.claimant_response <> 'accepted' THEN
    RAISE EXCEPTION 'Both people must accept before the accounts can be connected';
  END IF;

  v_placeholder := v_req.placeholder_id;
  v_claimant    := v_req.claimant_id;

  IF v_placeholder IS NULL THEN
    RAISE EXCEPTION 'That contact has already been connected to an account';
  END IF;

  -- Lock both rows in a deterministic order so two concurrent claims of the
  -- same placeholder serialise instead of deadlocking.
  PERFORM 1 FROM public.users
   WHERE id IN (v_placeholder, v_claimant)
   ORDER BY id
   FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = v_placeholder AND is_placeholder = TRUE
  ) THEN
    RAISE EXCEPTION 'That contact has already been connected to an account';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.users WHERE id = v_claimant AND is_placeholder = TRUE
  ) THEN
    RAISE EXCEPTION 'A placeholder contact cannot claim another placeholder';
  END IF;

  -- -------------------------------------------------------------------------
  -- Collision detection — refuse rather than guess
  -- -------------------------------------------------------------------------
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.transaction_splits a
      JOIN public.transaction_splits b ON b.transaction_id = a.transaction_id
      WHERE a.user_id = v_placeholder AND b.user_id = v_claimant
    ) THEN 'the same expense already lists both this contact and your own account'
    WHEN EXISTS (
      SELECT 1
      FROM public.transaction_payers a
      JOIN public.transaction_payers b ON b.transaction_id = a.transaction_id
      WHERE a.user_id = v_placeholder AND b.user_id = v_claimant
    ) THEN 'the same expense already records both this contact and your own account as payers'
    WHEN EXISTS (
      SELECT 1
      FROM public.group_members a
      JOIN public.group_members b ON b.group_id = a.group_id
      WHERE a.user_id = v_placeholder AND b.user_id = v_claimant
    ) THEN 'you are already a member of a group this contact belongs to'
    WHEN EXISTS (
      SELECT 1
      FROM public.friendships a
      JOIN public.friendships b ON b.user_id = a.user_id AND b.friend_id = v_claimant
      WHERE a.friend_id = v_placeholder
    ) THEN 'someone is already friends with both this contact and your account'
    WHEN EXISTS (
      SELECT 1
      FROM public.friendships a
      JOIN public.friendships b ON b.friend_id = a.friend_id AND b.user_id = v_claimant
      WHERE a.user_id = v_placeholder
    ) THEN 'this contact and your account already share a friend'
    ELSE NULL
  END INTO v_conflict;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'These accounts cannot be connected automatically because %. Please resolve that overlap first.',
      v_conflict;
  END IF;

  -- -------------------------------------------------------------------------
  -- Merge
  -- -------------------------------------------------------------------------
  -- Derived ledger rows for the placeholder: dropped, rebuilt at the end.
  DELETE FROM public.simplified_settlements
  WHERE debtor_id = v_placeholder OR creditor_id = v_placeholder;

  -- A direct friend link between the placeholder and the claimant would
  -- become a self-friendship once re-pointed, violating 0030's no-self
  -- check. Remove it rather than rewrite it.
  DELETE FROM public.friendships
  WHERE (user_id = v_placeholder AND friend_id = v_claimant)
     OR (user_id = v_claimant    AND friend_id = v_placeholder);

  -- ON DELETE RESTRICT columns first (see header).
  UPDATE public.transactions       SET paid_by    = v_claimant WHERE paid_by    = v_placeholder;
  UPDATE public.transaction_payers SET user_id    = v_claimant WHERE user_id    = v_placeholder;

  UPDATE public.transaction_splits SET user_id    = v_claimant WHERE user_id    = v_placeholder;
  UPDATE public.group_members      SET user_id    = v_claimant WHERE user_id    = v_placeholder;
  UPDATE public.friendships        SET user_id    = v_claimant WHERE user_id    = v_placeholder;
  UPDATE public.friendships        SET friend_id  = v_claimant WHERE friend_id  = v_placeholder;
  UPDATE public.activity_events    SET actor_id   = v_claimant WHERE actor_id   = v_placeholder;
  UPDATE public.activity_events    SET subject_id = v_claimant WHERE subject_id = v_placeholder;
  UPDATE public.groups             SET created_by = v_claimant WHERE created_by = v_placeholder;
  UPDATE public.users              SET created_by = v_claimant WHERE created_by = v_placeholder;

  -- Before the delete: 0041's placeholder_id is ON DELETE SET NULL, so
  -- these rows become unfindable by placeholder_id once it is gone.
  UPDATE public.connection_requests
     SET status = 'merged', merged_at = now()
   WHERE id = p_request_id;

  UPDATE public.connection_requests
     SET status = 'cancelled'
   WHERE placeholder_id = v_placeholder
     AND id <> p_request_id
     AND status = 'pending';

  DELETE FROM public.users WHERE id = v_placeholder;

  -- -------------------------------------------------------------------------
  -- Rebuild every ledger the claimant now belongs to
  -- -------------------------------------------------------------------------
  -- admin_rebuild_* rather than recalculate_* : the latter compute relative
  -- to auth.uid(), which here is whichever party happened to tap accept,
  -- not the account whose ledger actually moved.
  FOR r IN
    SELECT DISTINCT x.other_id
    FROM (
      SELECT s2.user_id AS other_id
      FROM public.transaction_splits s1
      JOIN public.transactions t      ON t.id = s1.transaction_id AND t.group_id IS NULL
      JOIN public.transaction_splits s2 ON s2.transaction_id = s1.transaction_id
      WHERE s1.user_id = v_claimant AND s2.user_id <> v_claimant
      UNION
      SELECT t.paid_by
      FROM public.transaction_splits s1
      JOIN public.transactions t ON t.id = s1.transaction_id AND t.group_id IS NULL
      WHERE s1.user_id = v_claimant AND t.paid_by <> v_claimant
      UNION
      SELECT s2.user_id
      FROM public.transactions t
      JOIN public.transaction_splits s2 ON s2.transaction_id = t.id
      WHERE t.group_id IS NULL AND t.paid_by = v_claimant AND s2.user_id <> v_claimant
    ) x
    WHERE x.other_id IS NOT NULL
  LOOP
    PERFORM public.admin_rebuild_pair_settlements(v_claimant, r.other_id);
  END LOOP;

  FOR r IN
    SELECT gm.group_id FROM public.group_members gm WHERE gm.user_id = v_claimant
  LOOP
    PERFORM public.admin_rebuild_group_settlements(r.group_id);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants — REVOKE FROM PUBLIC alone does NOT remove anon's default EXECUTE
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.preview_placeholder_claim(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_placeholder(UUID)         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_placeholder_claim(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_placeholder(UUID)         TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT proname FROM pg_proc
--   WHERE proname IN ('preview_placeholder_claim','claim_placeholder');
--   -> two rows
--
--   SELECT
--     has_function_privilege('anon','public.claim_placeholder(uuid)','EXECUTE')          AS anon_claim,
--     has_function_privilege('anon','public.preview_placeholder_claim(uuid)','EXECUTE')  AS anon_preview,
--     has_function_privilege('authenticated','public.claim_placeholder(uuid)','EXECUTE') AS auth_claim;
--   -> false, false, true
--
--   OWNERSHIP MATTERS HERE. claim_placeholder calls admin_rebuild_pair_settlements
--   and admin_rebuild_group_settlements, which 0014 revoked from both anon and
--   authenticated (service_role retained). A SECURITY DEFINER function runs as
--   its OWNER, so this only works if the owner still holds EXECUTE on those.
--   Confirm rather than assume:
--     SELECT p.proname, pg_get_userbyid(p.proowner) AS owner
--     FROM pg_proc p
--     WHERE p.proname IN ('claim_placeholder',
--                         'admin_rebuild_pair_settlements',
--                         'admin_rebuild_group_settlements');
--   -> claim_placeholder's owner must be able to execute the other two. If the
--      merge fails at runtime with "permission denied for function
--      admin_rebuild_pair_settlements", this is the cause, not the logic.
--
-- FUNCTIONAL — do this on real data before trusting the merge. A function
-- that persists is not a function that runs: a PL/pgSQL name collision is
-- accepted at CREATE time and only fails on execution.
--
--   1. As A, add an off-app friend by phone and record an expense against them.
--   2. Note A's balance with that friend.
--   3. Sign up a new account with the same number; both sides accept.
--   4. Confirm the placeholder is gone and its history moved:
--        SELECT count(*) FROM public.users WHERE id = '<placeholder_id>';
--        -> 0
--   5. RECONCILIATION SWEEP — every pair must read 0.00 drift. This is the
--      check that actually proves the merge did not corrupt the ledger; run
--      it exactly as the earlier ledger work did, and do not treat the
--      merge as working until it passes.
