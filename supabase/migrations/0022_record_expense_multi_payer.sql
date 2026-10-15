-- Kinlo · 0022 · recording an expense several people paid for
--
-- STEP 3 of H1. 0020 added transaction_payers, 0021 taught the 1-on-1 ledger to
-- read it. Nothing yet writes it, so multi-payer is understood but cannot be
-- recorded. This closes that.
--
-- THE NEW PARAMETER
--
--   p_payers  [{"user_id": uuid, "amount_paid": numeric}, ...]
--
-- Optional. When absent or empty, the function synthesises a single payer row
-- from p_paid_by carrying the whole amount — exactly what it does implicitly
-- today. That keeps every existing client working unchanged: the app currently
-- sends eight arguments and will keep doing so until its UI is rebuilt.
--
-- WHY THE FUNCTION HAD TO BE DROPPED
--
-- CREATE OR REPLACE cannot change an argument list. Adding a ninth parameter
-- creates a second overload rather than replacing the first, and PostgREST
-- resolves overloads by the named arguments in the request body — so which
-- implementation ran would depend on whether the client happened to send the
-- new key. Dropping first guarantees exactly one function exists.
--
-- The DROP takes the grants with it, so they are reissued at the foot of this
-- file, including the explicit REVOKE FROM anon. Supabase's default privileges
-- grant EXECUTE to anon at creation, and `REVOKE ... FROM PUBLIC` does not
-- remove it — the defect 0014 had to clean up across three functions.
--
-- INVARIANTS ENFORCED
--
--   §4.1  sum(payer contributions) = expense total
--   §4.2  sum(participant obligations) = expense total   (already enforced)
--
-- Both are exact. 0019 removed the per-split tolerance from the obligations
-- check for good reasons, and the same reasoning applies to contributions:
-- money that nobody is recorded as having paid is money the ledger invents.
--
-- WHAT paid_by MEANS NOW
--
-- The primary payer — the one screens show as "X paid". When several people
-- contribute, it is set to the largest contributor, with ties broken by the
-- order the client sent them so the result is deterministic. The RLS policies
-- that key on paid_by keep working, because the largest contributor is always
-- genuinely one of the payers.
--
-- REBUILD SCOPE
--
-- 0016 rebuilt every pair the expense touched, old shape and new, which fixed
-- C2. That set now has to include payers as well as debtors: changing who paid
-- alters the same balances that changing who owed does. The enumeration below
-- takes every unordered pair among the union of old payers, old debtors, new
-- payers and new debtors. Broader than strictly necessary for a single-payer
-- expense, and cheap — these are three or four people, not thousands.

DROP FUNCTION IF EXISTS public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID);

CREATE OR REPLACE FUNCTION public.record_expense(
  p_transaction_id UUID,
  p_amount         NUMERIC,
  p_description    TEXT,
  p_category       TEXT,
  p_paid_by        UUID,
  p_split_type     TEXT,
  p_splits         JSONB,               -- [{"user_id": uuid, "share_amount": numeric}, ...]
  p_group_id       UUID DEFAULT NULL,
  p_payers         JSONB DEFAULT NULL   -- [{"user_id": uuid, "amount_paid": numeric}, ...]
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me              UUID := auth.uid();
  v_split_count   INT;
  v_sum           NUMERIC;
  v_payer_sum     NUMERIC;
  v_payer_count   INT;
  v_me_involved   BOOLEAN;
  v_primary       UUID;
  r               RECORD;
  v_existed       BOOLEAN := FALSE;
  v_prev_group_id UUID;
  v_prev_people   UUID[] := '{}';
  -- Normalised payer list: the caller's, or one synthesised from p_paid_by.
  v_payers        JSONB;
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

  -- ---------------------------------------------------------------------
  -- Normalise the payer list. No payers given means the classic single-payer
  -- expense, which is what every current client sends.
  -- ---------------------------------------------------------------------
  IF p_payers IS NULL OR jsonb_array_length(p_payers) = 0 THEN
    v_payers := jsonb_build_array(
      jsonb_build_object('user_id', p_paid_by::TEXT, 'amount_paid', p_amount)
    );
  ELSE
    v_payers := p_payers;
  END IF;

  SELECT COUNT(*) INTO v_payer_count FROM jsonb_array_elements(v_payers);

  SELECT COALESCE(SUM((e->>'amount_paid')::NUMERIC), 0)
    INTO v_payer_sum
  FROM jsonb_array_elements(v_payers) e;

  -- §4.1 — the contributions are the expense. Exact, for the same reason
  -- 0019 made the obligations check exact.
  IF ABS(v_payer_sum - p_amount) > 0.005 THEN
    RAISE EXCEPTION
      'The payers contributed %, but the expense is %. They must match exactly.',
      v_payer_sum, p_amount
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_payers) e
    WHERE (e->>'amount_paid')::NUMERIC <= 0
  ) THEN
    RAISE EXCEPTION 'every payer must have contributed a positive amount'
      USING ERRCODE = '23514';
  END IF;

  -- ---------------------------------------------------------------------
  -- Obligations (unchanged from 0019)
  -- ---------------------------------------------------------------------
  SELECT COUNT(*) INTO v_split_count FROM jsonb_array_elements(p_splits);
  IF v_split_count = 0 THEN
    RAISE EXCEPTION 'at least one split is required';
  END IF;

  SELECT COALESCE(SUM((e->>'share_amount')::NUMERIC), 0)
    INTO v_sum
  FROM jsonb_array_elements(p_splits) e;

  IF ABS(v_sum - p_amount) > 0.005 THEN
    RAISE EXCEPTION
      'The shares add up to %, but the expense is %. They must match exactly.',
      v_sum, p_amount
      USING ERRCODE = '23514';
  END IF;

  -- ---------------------------------------------------------------------
  -- Participation. You must be genuinely party to this expense — as someone
  -- who owes, or as someone who paid.
  -- ---------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_splits) e
    WHERE (e->>'user_id')::UUID = me
  ) INTO v_me_involved;

  IF NOT (
    v_me_involved
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_payers) e
      WHERE (e->>'user_id')::UUID = me
    )
  ) THEN
    RAISE EXCEPTION 'you are not a participant in this expense'
      USING ERRCODE = '42501';
  END IF;

  IF p_group_id IS NOT NULL THEN
    IF NOT public.is_group_member(p_group_id) THEN
      RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_payers) e
      WHERE NOT EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.group_id = p_group_id AND gm.user_id = (e->>'user_id')::UUID
      )
    ) THEN
      RAISE EXCEPTION 'every payer must be a member of that group' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_splits) e
      WHERE NOT EXISTS (
        SELECT 1 FROM public.group_members gm
        WHERE gm.group_id = p_group_id AND gm.user_id = (e->>'user_id')::UUID
      )
    ) THEN
      RAISE EXCEPTION 'every participant must be a member of that group'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    -- Everyone named must already be connected to you — payers included. This
    -- is 0002's phantom-debt guard, widened to cover the new list.
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_payers) e
      WHERE (e->>'user_id')::UUID <> me
        AND NOT (
          public.is_friend_of((e->>'user_id')::UUID)
          OR public.shares_transaction_with((e->>'user_id')::UUID)
          OR public.shares_group_with((e->>'user_id')::UUID)
        )
    ) THEN
      RAISE EXCEPTION 'no existing relationship with one of the payers'
        USING ERRCODE = '42501';
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
  -- Remember everyone this expense used to touch, before anything is written.
  -- ---------------------------------------------------------------------
  SELECT t.group_id INTO v_prev_group_id
  FROM public.transactions t WHERE t.id = p_transaction_id;

  v_existed := FOUND;

  IF v_existed THEN
    SELECT COALESCE(array_agg(DISTINCT u), '{}')
      INTO v_prev_people
    FROM (
      SELECT s.user_id AS u FROM public.transaction_splits s
      WHERE s.transaction_id = p_transaction_id
      UNION
      SELECT pp.user_id FROM public.transaction_payers pp
      WHERE pp.transaction_id = p_transaction_id
      UNION
      SELECT t.paid_by FROM public.transactions t WHERE t.id = p_transaction_id
    ) x;
  END IF;

  -- The primary payer: largest contributor, ties broken by the order the
  -- client sent them, so the same payload always yields the same row.
  SELECT (e->>'user_id')::UUID
    INTO v_primary
  FROM jsonb_array_elements(v_payers) WITH ORDINALITY AS t(e, ord)
  ORDER BY (e->>'amount_paid')::NUMERIC DESC, t.ord ASC
  LIMIT 1;

  INSERT INTO public.transactions
    (id, amount, description, category, paid_by, group_id, split_type, type, status)
  VALUES
    (p_transaction_id, p_amount, p_description, COALESCE(p_category, 'other'),
     v_primary, p_group_id, COALESCE(p_split_type, 'equal'), 'expense', 'active')
  ON CONFLICT (id) DO UPDATE SET
    amount      = EXCLUDED.amount,
    description = EXCLUDED.description,
    category    = EXCLUDED.category,
    paid_by     = EXCLUDED.paid_by,
    group_id    = EXCLUDED.group_id,
    split_type  = EXCLUDED.split_type,
    status      = EXCLUDED.status;

  -- Replace both lists rather than merging: on an edit this clears whatever
  -- was there, and on a retry it clears a partial write.
  DELETE FROM public.transaction_payers WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_payers (transaction_id, user_id, amount_paid)
  SELECT p_transaction_id, (e->>'user_id')::UUID, (e->>'amount_paid')::NUMERIC
  FROM jsonb_array_elements(v_payers) e;

  DELETE FROM public.transaction_splits WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_splits (transaction_id, user_id, share_amount)
  SELECT p_transaction_id, (e->>'user_id')::UUID, (e->>'share_amount')::NUMERIC
  FROM jsonb_array_elements(p_splits) e
  WHERE (e->>'share_amount')::NUMERIC > 0;

  -- ---------------------------------------------------------------------
  -- Rebuild every relationship touched, old shape and new.
  -- ---------------------------------------------------------------------
  IF v_existed
     AND v_prev_group_id IS NOT NULL
     AND v_prev_group_id IS DISTINCT FROM p_group_id THEN
    PERFORM public.admin_rebuild_group_settlements(v_prev_group_id);
  END IF;

  IF p_group_id IS NOT NULL THEN
    PERFORM public.admin_rebuild_group_settlements(p_group_id);
  END IF;

  -- Every unordered pair among everyone involved, before or after. With
  -- several payers a debt can exist between any two of them, so enumerating
  -- payer-to-debtor pairs is no longer sufficient.
  FOR r IN
    WITH people AS (
      SELECT u FROM unnest(v_prev_people) AS u
      WHERE v_existed AND v_prev_group_id IS NULL
      UNION
      SELECT (e->>'user_id')::UUID FROM jsonb_array_elements(p_splits) e
      WHERE p_group_id IS NULL
      UNION
      SELECT (e->>'user_id')::UUID FROM jsonb_array_elements(v_payers) e
      WHERE p_group_id IS NULL
    )
    SELECT DISTINCT LEAST(x.u, y.u) AS a, GREATEST(x.u, y.u) AS b
    FROM people x CROSS JOIN people y
    WHERE x.u IS NOT NULL AND y.u IS NOT NULL AND x.u <> y.u
  LOOP
    PERFORM public.admin_rebuild_pair_settlements(r.a, r.b);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION
  public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID, JSONB)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID, JSONB)
  TO authenticated;
