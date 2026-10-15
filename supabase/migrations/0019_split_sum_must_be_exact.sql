-- Kinlo · 0019 · the shares must sum to the expense, exactly
--
-- THE DEFECT (audit finding H5)
--
-- 0009 introduced, and 0016 carried forward, this check:
--
--   IF ABS(v_sum - p_amount) > (0.01 * v_split_count) THEN
--
-- The tolerance scales with the number of participants. A two-way expense may
-- be 2 paise out; a five-way, 5 paise; a twenty-way, 20 paise. The expense
-- saves, the ledger is built from shares that do not add up to the total, and
-- the difference silently becomes a rounding error nobody can account for.
--
-- Specification §4.3 states the split invariant holds after rounding with no
-- exception. This is the last place that invariant can be enforced — RLS cannot
-- express it, and the client is not trustworthy for it, as the last two days
-- have demonstrated at some length.
--
-- WHY THE TOLERANCE EXISTED
--
-- 0009's comment says: "A tolerance of 1 paisa per split absorbs the
-- remainder-cent distribution splitCalculator does." That was a
-- misunderstanding. splitCalculator works in integer paise and its distribution
-- is exact by construction — calculateEqualSplit floors every share and hands
-- out the remainder one paisa at a time, so the shares have always summed to
-- the total precisely. There was nothing to absorb.
--
-- WHY THIS IS SAFE TO TIGHTEN NOW AND WAS NOT BEFORE
--
-- Until today two client paths could genuinely produce a sum that missed:
--
--   * calculatePercentSplit rounded each share and dumped the accumulated
--     remainder on the last participant. The total still came out right, but
--     only because of that dumping.
--   * validateExactSplit compared rupees as floats with a `< 0.01` tolerance,
--     so a real one-paisa shortfall passed — 1000 - 999.99 evaluates to
--     0.00999999999999091, which is under the threshold.
--
-- Both were fixed today: percentage splits now use largest-remainder allocation
-- and exact splits are compared in whole paise. Every client path now produces
-- shares that sum exactly, so a strict server check rejects nothing legitimate.
--
-- Tightening before those fixes would have started refusing valid expenses,
-- which is why H5 was sequenced after H4 rather than before it.
--
-- WHAT REMAINS AS TOLERANCE
--
-- 0.005 — half a paisa. Not a real allowance: share_amount and amount are both
-- NUMERIC(15,2), so any genuine difference is at least a full paisa and will be
-- caught. It exists only so the comparison cannot be defeated by a NUMERIC
-- representation edge, and documents the intent as "exact".
--
-- UNCHANGED
--
-- Everything else is 0016 verbatim: the participation checks that are 0002's
-- phantom-debt guard, the group-membership checks, the upsert, the split
-- replacement, and the old-plus-new rebuild scope that fixed C2. Only the
-- tolerance expression and its comment differ.

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

  -- Exact. See the header: the previous tolerance scaled with participant
  -- count and let a twenty-way expense be 20 paise out.
  IF ABS(v_sum - p_amount) > 0.005 THEN
    RAISE EXCEPTION
      'The shares add up to %, but the expense is %. They must match exactly.',
      v_sum, p_amount
      USING ERRCODE = '23514';
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

  IF v_existed
     AND v_prev_group_id IS NOT NULL
     AND v_prev_group_id IS DISTINCT FROM p_group_id THEN
    PERFORM public.admin_rebuild_group_settlements(v_prev_group_id);
  END IF;

  IF p_group_id IS NOT NULL THEN
    PERFORM public.admin_rebuild_group_settlements(p_group_id);
  END IF;

  FOR r IN
    SELECT DISTINCT x.a, x.b
    FROM (
      SELECT LEAST(v_prev_paid_by, u)    AS a,
             GREATEST(v_prev_paid_by, u) AS b
      FROM unnest(v_prev_others) AS u
      WHERE v_existed
        AND v_prev_group_id IS NULL
        AND u <> v_prev_paid_by

      UNION

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

-- Signature unchanged, so CREATE OR REPLACE preserves existing grants.
-- anon was revoked in 0016.
