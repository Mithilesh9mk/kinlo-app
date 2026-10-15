-- Kinlo · 0016 · an edit rebuilds every relationship it touched, old and new
--
-- THE DEFECT (audit finding C2)
--
-- 0009's record_expense() rebuilds the ledger for every counterparty named in
-- the *incoming* payload:
--
--   FOR r IN
--     SELECT DISTINCT other FROM (
--       SELECT (e->>'user_id')::UUID AS other FROM jsonb_array_elements(p_splits) e
--       UNION SELECT p_paid_by
--     ) x WHERE other <> me
--   LOOP
--     PERFORM public.recalculate_pair_settlements(r.other);
--   END LOOP;
--
-- On a create that is complete. On an edit it is not. The function upserts the
-- transaction, deletes all its splits and reinserts them, so anyone *removed*
-- from the expense no longer appears in p_splits and their pair is never
-- rebuilt. Their ledger row keeps an obligation the expense no longer creates,
-- permanently, until some unrelated transaction with them happens to trigger a
-- rebuild.
--
--   Three-person 1-on-1 expense, you paid.
--   Edit it to remove one person.
--   Their balance with you still carries their old share.
--
-- The same gap applies to a changed payer, and to a changed group_id — only the
-- new group was rebuilt, the old one left stale.
--
-- THE FIX
--
-- Capture what the transaction looked like *before* the write, then rebuild the
-- union of the old shape and the new one.
--
-- WHY admin_rebuild_pair_settlements RATHER THAN recalculate_pair_settlements
--
-- Same reasoning as 0015. recalculate_pair_settlements(other) resolves the
-- second party through auth.uid(), so it can only rebuild pairs that include
-- the caller. A group_id IS NULL transaction can have paid_by = A and a split
-- for B with the caller being neither — an edit that changes such a row leaves
-- the (A,B) pair unreachable by the caller's own rebuild. Taking both
-- identities explicitly removes that blind spot.
--
-- The nested call is permitted despite 0014 revoking admin_rebuild_* from
-- authenticated: privilege inside a SECURITY DEFINER body is checked against
-- the owner. The revoke remains effective against direct client calls.
--
-- UNCHANGED
--
-- Signature, validation, participation checks, group-membership checks, the
-- upsert and the split replacement are all byte-for-byte what 0009 established.
-- The only edit is the rebuild block at the end, plus the two variables and one
-- SELECT needed to remember the previous shape. In particular the participation
-- checks are the phantom-debt guard from 0002 and are reproduced exactly.
--
-- Because the signature is identical, CREATE OR REPLACE preserves existing
-- grants; nothing needs re-granting.
--
-- ALSO IN THIS FILE
--
-- A one-line REVOKE of anon's stray EXECUTE on record_expense. It is the same
-- Supabase default-privilege grant 0014 had to clean off the admin functions.
-- record_expense rejects anon on its first line already, so this is tidiness
-- rather than a hole — but this migration is already touching the function and
-- leaving a known-wrong grant in place while doing so would be perverse.

CREATE OR REPLACE FUNCTION public.record_expense(
  p_transaction_id UUID,
  p_amount         NUMERIC,
  p_description    TEXT,
  p_category       TEXT,
  p_paid_by        UUID,
  p_split_type     TEXT,
  p_splits         JSONB,               -- [{"user_id": uuid, "share_amount": numeric}, ...]
  p_group_id       UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me              UUID := auth.uid();
  v_split_count   INT;
  v_sum           NUMERIC;
  v_me_involved   BOOLEAN;
  r               RECORD;
  -- Previous shape of this transaction, captured before anything is written.
  v_existed       BOOLEAN := FALSE;
  v_prev_paid_by  UUID;
  v_prev_group_id UUID;
  v_prev_others   UUID[] := '{}';
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_transaction_id IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'amount must be positive';
  END IF;
  IF p_paid_by IS NULL THEN
    RAISE EXCEPTION 'a payer is required';
  END IF;

  SELECT COUNT(*) INTO v_split_count FROM jsonb_array_elements(p_splits);
  IF v_split_count = 0 THEN
    RAISE EXCEPTION 'at least one split is required';
  END IF;

  SELECT COALESCE(SUM((e->>'share_amount')::NUMERIC), 0)
    INTO v_sum
  FROM jsonb_array_elements(p_splits) e;

  IF ABS(v_sum - p_amount) > (0.01 * v_split_count) THEN
    RAISE EXCEPTION 'splits total % but the expense is %', v_sum, p_amount;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_splits) e
    WHERE (e->>'user_id')::UUID = me
  ) INTO v_me_involved;

  IF NOT (v_me_involved OR p_paid_by = me) THEN
    RAISE EXCEPTION 'you are not a participant in this expense'
      USING ERRCODE = '42501';
  END IF;

  IF p_group_id IS NOT NULL THEN
    IF NOT public.is_group_member(p_group_id) THEN
      RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = p_group_id AND gm.user_id = p_paid_by
    ) THEN
      RAISE EXCEPTION 'the payer is not a member of that group' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_splits) e
      WHERE NOT EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.group_id = p_group_id
          AND gm.user_id = (e->>'user_id')::UUID
      )
    ) THEN
      RAISE EXCEPTION 'every participant must be a member of that group'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF p_paid_by <> me AND NOT (
      public.is_friend_of(p_paid_by)
      OR public.shares_transaction_with(p_paid_by)
      OR public.shares_group_with(p_paid_by)
    ) THEN
      RAISE EXCEPTION 'no existing relationship with the payer' USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_splits) e
      WHERE (e->>'user_id')::UUID <> me
        AND NOT (
          public.is_friend_of((e->>'user_id')::UUID)
          OR public.shares_transaction_with((e->>'user_id')::UUID)
          OR public.shares_group_with((e->>'user_id')::UUID)
        )
    ) THEN
      RAISE EXCEPTION 'no existing relationship with one of the participants'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- ---------------------------------------------------------------------
  -- Remember the previous shape BEFORE the upsert and the split delete.
  -- On a create this finds nothing and every value stays at its default,
  -- which makes the rebuild block below reduce to exactly what 0009 did.
  -- ---------------------------------------------------------------------
  SELECT t.paid_by, t.group_id
    INTO v_prev_paid_by, v_prev_group_id
  FROM public.transactions t
  WHERE t.id = p_transaction_id;

  v_existed := FOUND;

  IF v_existed THEN
    SELECT COALESCE(array_agg(DISTINCT s.user_id), '{}')
      INTO v_prev_others
    FROM public.transaction_splits s
    WHERE s.transaction_id = p_transaction_id;
  END IF;

  INSERT INTO public.transactions
    (id, amount, description, category, paid_by, group_id, split_type, type, status)
  VALUES
    (p_transaction_id, p_amount, p_description, COALESCE(p_category, 'other'),
     p_paid_by, p_group_id, COALESCE(p_split_type, 'equal'), 'expense', 'active')
  ON CONFLICT (id) DO UPDATE SET
    amount      = EXCLUDED.amount,
    description = EXCLUDED.description,
    category    = EXCLUDED.category,
    paid_by     = EXCLUDED.paid_by,
    group_id    = EXCLUDED.group_id,
    split_type  = EXCLUDED.split_type,
    status      = EXCLUDED.status;

  DELETE FROM public.transaction_splits WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_splits (transaction_id, user_id, share_amount)
  SELECT p_transaction_id, (e->>'user_id')::UUID, (e->>'share_amount')::NUMERIC
  FROM jsonb_array_elements(p_splits) e
  WHERE (e->>'share_amount')::NUMERIC > 0;

  -- ---------------------------------------------------------------------
  -- Rebuild the union of the old shape and the new one.
  -- ---------------------------------------------------------------------

  -- The group this row used to belong to, if it has moved or left one.
  IF v_existed
     AND v_prev_group_id IS NOT NULL
     AND v_prev_group_id IS DISTINCT FROM p_group_id THEN
    PERFORM public.admin_rebuild_group_settlements(v_prev_group_id);
  END IF;

  -- The group it belongs to now.
  IF p_group_id IS NOT NULL THEN
    PERFORM public.admin_rebuild_group_settlements(p_group_id);
  END IF;

  -- Every 1-on-1 pair touched, before or after. A row that is a group expense
  -- in both shapes contributes nothing here, which is correct — group balances
  -- live entirely in the group ledger.
  FOR r IN
    SELECT DISTINCT x.a, x.b
    FROM (
      -- pairs as the transaction used to be
      SELECT LEAST(v_prev_paid_by, u)    AS a,
             GREATEST(v_prev_paid_by, u) AS b
      FROM unnest(v_prev_others) AS u
      WHERE v_existed
        AND v_prev_group_id IS NULL
        AND u <> v_prev_paid_by

      UNION

      -- pairs as it is now
      SELECT LEAST(p_paid_by, (e->>'user_id')::UUID),
             GREATEST(p_paid_by, (e->>'user_id')::UUID)
      FROM jsonb_array_elements(p_splits) e
      WHERE p_group_id IS NULL
        AND (e->>'user_id')::UUID <> p_paid_by
    ) x
    WHERE x.a IS NOT NULL AND x.b IS NOT NULL
  LOOP
    PERFORM public.admin_rebuild_pair_settlements(r.a, r.b);
  END LOOP;
END;
$$;

-- Strip the stray default-privilege grant. record_expense already rejects an
-- unauthenticated caller on its first line, so this is hygiene rather than a
-- fix — but see 0014 for why `REVOKE ... FROM PUBLIC` alone never removed it.
REVOKE EXECUTE ON FUNCTION
  public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID)
  FROM anon;
