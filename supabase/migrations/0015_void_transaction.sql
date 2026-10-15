-- Kinlo · 0015 · voiding becomes atomic and rebuilds every affected pair
--
-- THE TWO DEFECTS THIS CLOSES
--
-- C4 — voiding is not atomic, and its failure is swallowed.
--
--   app/friend/[id].tsx:338 and app/group/[id].tsx:360 both do this:
--
--     await supabase.from('transactions')
--       .update({ status: 'voided' }).eq('id', selectedTx.id);
--     ...
--     await recalculatePairSettlements(friendId);   // separate round trip
--
--   with the rebuild wrapped in a catch that logs "non-critical" and continues
--   to a success toast. If the second call fails — dropped connection, expired
--   token, RLS rejection — the expense is voided, the ledger is not rebuilt,
--   the user is told it worked, and nothing ever detects it. This is the exact
--   split-write pattern 0005 and 0009 were written to eliminate for creates.
--   Voiding was never given the same treatment.
--
-- C3 — voiding rebuilds only one counterparty.
--
--   The rebuild scope comes from the UI context — whichever friend's screen the
--   user happened to be on — rather than from the transaction's participants. A
--   three-person expense with no group has two counterparties; void it from one
--   friend's screen and the other's balance still contains their share of an
--   expense that no longer counts.
--
-- WHY A NEW RPC RATHER THAN FIXING THE CALL SITES
--
-- Atomicity cannot be achieved from the client. The status change and the
-- ledger rebuild have to be in one database transaction, which means one round
-- trip, which means a function. Once there is a function, the scope bug fixes
-- itself: the transaction's own splits say exactly which pairs are affected,
-- so nothing has to be inferred from the UI.
--
-- WHY IT CALLS THE admin_rebuild_* VARIANTS
--
-- recalculate_pair_settlements(other) resolves the *other* party through
-- auth.uid(), so it can only ever rebuild pairs that include the caller. That
-- is a real gap: a transaction with group_id IS NULL can have paid_by = A and
-- a split for B, with the caller being neither. The pair (A,B) then has a
-- ledger row that the caller's own rebuild can never reach.
--
-- admin_rebuild_pair_settlements(a, b) takes both identities explicitly, which
-- is precisely what is needed. It skips membership checks — but this function
-- has already established the caller's authority to void before it is reached,
-- and rebuilding only ever recomputes the truth from transactions. Because this
-- function is SECURITY DEFINER and owned by postgres, the nested call is
-- permitted even though 0014 revoked admin_rebuild_* from anon and
-- authenticated: privilege inside a SECURITY DEFINER body is checked against
-- the owner, not the caller. The revoke stays effective against direct calls.
--
-- AUTHORIZATION
--
-- Deliberately mirrors the existing transactions_update RLS policy —
--
--   (paid_by = auth.uid()) OR (group_id IS NOT NULL AND is_group_member(group_id))
--
-- — so this changes who can void nothing at all. It moves the same check into
-- a place where it can be enforced alongside the rebuild. SECURITY DEFINER
-- bypasses RLS, so this check is the only thing standing between a caller and
-- voiding someone else's expense; it is not optional.
--
-- IDEMPOTENT
--
-- Voiding an already-voided transaction returns without touching anything, so
-- a retry after a dropped response cannot double-apply. Nothing here depends on
-- being called exactly once.
--
-- SETTLEMENTS TOO
--
-- The function accepts any transaction, expense or settlement. Voiding a
-- mistaken settlement is the correction path §21 of the specification asks for,
-- and the mechanics are identical. The app does not offer it yet; the RPC does
-- not need to care.
--
-- WHAT THIS MIGRATION DOES NOT DO
--
-- It does not change the two call sites. app/friend/[id].tsx and
-- app/group/[id].tsx still perform the old two-step void until they are updated
-- to call this function — that is the next step, and it is a code change rather
-- than a migration. Until then this function is present and unused, which is
-- harmless.

CREATE OR REPLACE FUNCTION public.void_transaction(p_transaction_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me    UUID := auth.uid();
  v_tx  RECORD;
  r     RECORD;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_transaction_id IS NULL THEN
    RAISE EXCEPTION 'a transaction id is required';
  END IF;

  SELECT t.id, t.paid_by, t.group_id, t.status, t.type
    INTO v_tx
  FROM public.transactions t
  WHERE t.id = p_transaction_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transaction % does not exist', p_transaction_id;
  END IF;

  -- Same boundary as the transactions_update policy. SECURITY DEFINER bypasses
  -- RLS, so this is the only check protecting the row.
  IF NOT (
    v_tx.paid_by = me
    OR (v_tx.group_id IS NOT NULL AND public.is_group_member(v_tx.group_id))
  ) THEN
    RAISE EXCEPTION 'not permitted to void transaction %', p_transaction_id
      USING ERRCODE = '42501';
  END IF;

  -- Already done. Return rather than raise, so a retry is a no-op.
  IF v_tx.status = 'voided' THEN
    RETURN;
  END IF;

  UPDATE public.transactions
  SET status = 'voided'
  WHERE id = p_transaction_id;

  -- Rebuild every ledger relationship this transaction touched, in the same
  -- database transaction as the status change. Nothing here reads auth.uid(),
  -- so pairs the caller is not part of are rebuilt too.
  IF v_tx.group_id IS NOT NULL THEN
    PERFORM public.admin_rebuild_group_settlements(v_tx.group_id);
  ELSE
    -- The affected pairs are exactly payer-to-each-debtor. A split whose user
    -- is the payer moves no money and creates no ledger row.
    FOR r IN
      SELECT DISTINCT
        LEAST(v_tx.paid_by, s.user_id)    AS a,
        GREATEST(v_tx.paid_by, s.user_id) AS b
      FROM public.transaction_splits s
      WHERE s.transaction_id = p_transaction_id
        AND s.user_id <> v_tx.paid_by
    LOOP
      PERFORM public.admin_rebuild_pair_settlements(r.a, r.b);
    END LOOP;
  END IF;
END;
$$;

-- Note the grantee list: PUBLIC *and* anon. Every earlier migration in this
-- project wrote only `FROM PUBLIC`, which does not remove the separate explicit
-- grant Supabase's default privileges hand to anon at creation time — the
-- defect 0014 had to clean up. Naming anon here means this function is correct
-- from the moment it exists.
REVOKE ALL ON FUNCTION public.void_transaction(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.void_transaction(UUID) TO authenticated;
