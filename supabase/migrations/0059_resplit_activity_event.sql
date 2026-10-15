-- Kinlo · 0059 · a pure re-split now leaves a trail too
--
-- Core Functionality Audit 2026-08-31, finding P2 §4.6 / 0032's own
-- documented gap: emit_transaction_event() (0032) only ever sees the
-- transactions row. A re-split — same people, same total, same split mode,
-- only the per-person shares moved — never touches that row at all, so the
-- trigger's own diff finds nothing and stays silent. Someone's share of a
-- shared expense can change with zero record of it.
--
-- WHY THIS LIVES IN record_expense() AND NOT THE TRIGGER
--   The trigger fires on transactions, which has no view of
--   transaction_splits at all — there is nothing for it to diff. Detecting
--   a split-only change means comparing the OLD and NEW split sets, and
--   record_expense() is the only place that ever has both: it reads the
--   existing splits before deleting them and already holds the new ones in
--   p_splits. Moving this into a transaction_splits trigger instead would
--   mean re-deriving "was this part of a larger edit that already got an
--   event" from scratch, which record_expense already knows for free.
--
-- WHY "NOT v_row_changed" GATES IT
--   If amount/description/category/payer/group/split-mode also changed in
--   the same save, emit_transaction_event() already fires ONE expense_edited
--   event for that. Also emitting a split-change event here would be a
--   second, redundant event for one user action. The gate mirrors exactly
--   the columns the trigger itself diffs (see 0032), so "the trigger stayed
--   silent" and "record_expense saw no row-level change" are the same
--   condition by construction.
--
-- WHY A SIGNATURE STRING, NOT A SET-DIFFERENCE QUERY
--   `string_agg(user_id || ':' || round(share_amount,2), ',' ORDER BY
--   user_id)` turns "did the split change" into one equality check between
--   two scalars, computed once each. Correctly treats a same-set-different-
--   amounts re-split, an added participant, and a removed participant all
--   as "changed" — the exact shape of case this was missing.
--
-- Full function body reproduced from the live definition (captured via
-- pg_get_functiondef, diffed against this file before applying) except the
-- marked additions.

CREATE OR REPLACE FUNCTION public.record_expense(
  p_transaction_id UUID,
  p_amount NUMERIC,
  p_description TEXT,
  p_category TEXT,
  p_paid_by UUID,
  p_split_type TEXT,
  p_splits JSONB,
  p_group_id UUID DEFAULT NULL::UUID,
  p_payers JSONB DEFAULT NULL::JSONB,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL::TIMESTAMPTZ
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
  v_me_involved   BOOLEAN;
  v_primary       UUID;
  r               RECORD;
  v_existed       BOOLEAN := FALSE;
  v_prev_group_id UUID;
  v_prev_people   UUID[] := '{}';
  v_stored_at     TIMESTAMPTZ;
  v_payers        JSONB;
  -- 0059
  v_old_amount      NUMERIC;
  v_old_description TEXT;
  v_old_category    TEXT;
  v_old_paid_by     UUID;
  v_old_split_type  TEXT;
  v_old_splits_sig  TEXT;
  v_new_splits_sig  TEXT;
  v_row_changed     BOOLEAN;
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

  IF p_payers IS NULL OR jsonb_array_length(p_payers) = 0 THEN
    v_payers := jsonb_build_array(
      jsonb_build_object('user_id', p_paid_by::TEXT, 'amount_paid', p_amount)
    );
  ELSE
    v_payers := p_payers;
  END IF;

  SELECT COALESCE(SUM((e->>'amount_paid')::NUMERIC), 0)
    INTO v_payer_sum
  FROM jsonb_array_elements(v_payers) e;

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

    -- 0048: a group in direct ("Pay who you owe") mode nets each pair's
    -- fractional-cent attribution independently, which does not reliably
    -- sum back to a whole paisa when one expense has more than one payer.
    -- See this migration's header for the full explanation. Single-payer
    -- expenses are exact and unaffected; simplified-mode groups (default)
    -- are unaffected.
    IF jsonb_array_length(v_payers) > 1 THEN
      IF EXISTS (
        SELECT 1 FROM public.groups g
        WHERE g.id = p_group_id AND g.simplify_debts = FALSE
      ) THEN
        RAISE EXCEPTION
          'Multiple payers are not yet supported in a group set to "Pay who you owe." Turn on "Fewest payments" for this group, or record this expense with a single payer.'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSE
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

  -- 0059: pulled alongside the columns record_expense already fetched here,
  -- purely to know afterwards whether the transactions row itself is about
  -- to change.
  SELECT t.group_id, t.updated_at, t.amount, t.description, t.category, t.paid_by, t.split_type
    INTO v_prev_group_id, v_stored_at, v_old_amount, v_old_description, v_old_category, v_old_paid_by, v_old_split_type
  FROM public.transactions t
  WHERE t.id = p_transaction_id;

  v_existed := FOUND;

  -- The conflict check. Only when the caller supplied a token and the row
  -- already exists — a create has nothing to conflict with.
  IF v_existed
     AND p_expected_updated_at IS NOT NULL
     AND v_stored_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION
      'Someone else changed this expense while you were editing it. Reopen it to see their version before saving yours.'
      USING ERRCODE = '40001';
  END IF;

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

    -- 0059: the OLD split composition, captured before it is deleted below.
    -- Canonicalised to one comparable string so "did the split change" is a
    -- single equality check rather than a set-difference query, and so an
    -- added/removed participant and a same-set amount shuffle are both
    -- correctly seen as a change.
    SELECT COALESCE(string_agg(s.user_id::text || ':' || ROUND(s.share_amount, 2)::text, ',' ORDER BY s.user_id), '')
      INTO v_old_splits_sig
    FROM public.transaction_splits s
    WHERE s.transaction_id = p_transaction_id;
  END IF;

  SELECT (e->>'user_id')::UUID
    INTO v_primary
  FROM jsonb_array_elements(v_payers) WITH ORDINALITY AS t(e, ord)
  ORDER BY (e->>'amount_paid')::NUMERIC DESC, t.ord ASC
  LIMIT 1;

  -- 0059: mirrors exactly the columns emit_transaction_event() (0032) diffs
  -- on the transactions row. If none of these actually change, that trigger
  -- will emit nothing for this write — which is exactly the case a
  -- split-only change needs to be caught here instead of assumed already
  -- covered.
  v_row_changed := v_existed AND (
    p_amount IS DISTINCT FROM v_old_amount
    OR p_description IS DISTINCT FROM v_old_description
    OR COALESCE(p_category, 'other') IS DISTINCT FROM v_old_category
    OR v_primary IS DISTINCT FROM v_old_paid_by
    OR p_group_id IS DISTINCT FROM v_prev_group_id
    OR COALESCE(p_split_type, 'equal') IS DISTINCT FROM v_old_split_type
  );

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

  DELETE FROM public.transaction_payers WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_payers (transaction_id, user_id, amount_paid)
  SELECT p_transaction_id, (e->>'user_id')::UUID, (e->>'amount_paid')::NUMERIC
  FROM jsonb_array_elements(v_payers) e;

  DELETE FROM public.transaction_splits WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_splits (transaction_id, user_id, share_amount)
  SELECT p_transaction_id, (e->>'user_id')::UUID, (e->>'share_amount')::NUMERIC
  FROM jsonb_array_elements(p_splits) e
  WHERE (e->>'share_amount')::NUMERIC > 0;

  -- 0059: the NEW split composition, canonicalised the same way as
  -- v_old_splits_sig — same filter (share_amount > 0) as the INSERT just
  -- above, so the signature matches what actually landed in the table.
  IF v_existed THEN
    SELECT COALESCE(string_agg((e->>'user_id') || ':' || ROUND((e->>'share_amount')::NUMERIC, 2)::text, ',' ORDER BY (e->>'user_id')::UUID), '')
      INTO v_new_splits_sig
    FROM jsonb_array_elements(p_splits) e
    WHERE (e->>'share_amount')::NUMERIC > 0;

    IF NOT v_row_changed AND v_old_splits_sig IS DISTINCT FROM v_new_splits_sig THEN
      INSERT INTO public.activity_events
        (actor_id, event_type, transaction_id, group_id, payload)
      VALUES (
        me,
        'expense_edited',
        p_transaction_id,
        p_group_id,
        jsonb_build_object('description', p_description, 'changes', jsonb_build_object('split', true))
      );
    END IF;
  END IF;

  IF v_existed
     AND v_prev_group_id IS NOT NULL
     AND v_prev_group_id IS DISTINCT FROM p_group_id THEN
    PERFORM public.admin_rebuild_group_settlements(v_prev_group_id);
  END IF;

  IF p_group_id IS NOT NULL THEN
    PERFORM public.admin_rebuild_group_settlements(p_group_id);
  END IF;

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

REVOKE ALL ON FUNCTION public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID, JSONB, TIMESTAMPTZ) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID, JSONB, TIMESTAMPTZ) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT has_function_privilege('anon', oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', oid, 'EXECUTE') AS authed
--   FROM pg_proc WHERE proname = 'record_expense';
--   -> anon=false, authed=true
--
-- Functional test (throwaway ZZTEST rows, fabricated auth via set_config,
-- same technique as 0058):
--   1. Create expense A/B 50-50 via record_expense.
--   2. Re-save via record_expense with the SAME amount/description/category/
--      payer/group/split_type but shares 30/70 -> expect exactly one new
--      expense_edited event, payload.changes = {"split": true}.
--   3. Re-save again with identical shares (idempotent no-op) -> expect NO
--      new event (v_old_splits_sig = v_new_splits_sig).
--   4. Change the amount too in the same save as a re-split -> expect the
--      TRIGGER's own expense_edited (with an "amount" change) and confirm
--      this migration's block does NOT also fire (v_row_changed = true) —
--      exactly one event, not two.
