-- Kinlo · 0028 · detect two people editing the same expense
--
-- Audit finding M4. Nothing in this system notices a concurrent edit. Two
-- people can open the same expense, both change it, and the second write wins
-- silently — the first editor is never told their change was replaced, and the
-- balances quietly reflect only the later one.
--
-- §28 leaves the mechanism open (version columns, optimistic concurrency,
-- conflict detection all qualify) but requires that simultaneous operations
-- cannot silently produce an unintended state. Last-write-wins with no signal
-- does not meet that.
--
-- ---------------------------------------------------------------------------
-- 1 · actually maintain updated_at
-- ---------------------------------------------------------------------------
-- transactions.updated_at has existed since before the migration series, with
-- DEFAULT now() and NOT NULL — so it is set on insert and then never touched
-- again. Every row's updated_at is really a second copy of its created_at.
--
-- That is why the Phase 0.5 note that M4 "needs no new column" was only half
-- right: the column is there, but as a version token it has been inert. A
-- trigger is the reliable place to fix that — every write path gets it without
-- having to remember, including direct UPDATEs made under RLS.

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS transactions_touch_updated_at ON public.transactions;

CREATE TRIGGER transactions_touch_updated_at
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- 2 · record_expense refuses a stale edit
-- ---------------------------------------------------------------------------
-- New optional parameter: p_expected_updated_at.
--
-- The client reads a transaction's updated_at when it opens it for editing and
-- hands that value back on save. If the stored value has moved on, someone else
-- changed the row in between, and saving would erase their change without
-- either person ever knowing.
--
-- Optional on purpose. Creating a new expense passes nothing, and so does any
-- client that has not been updated yet — both keep working exactly as before.
-- Only an edit that supplies the token gets the check, so this cannot break a
-- write that previously succeeded.
--
-- WHY NOT A version INTEGER
--
-- A monotonic counter would be marginally more robust, but it means a new
-- column, a backfill, and remembering to increment it in four places.
-- updated_at already exists, is already NOT NULL, and — with the trigger above
-- — now changes on every write. Microsecond precision is far finer than the
-- interval between two human edits.
--
-- Everything else in this function is 0022 verbatim.

DROP FUNCTION IF EXISTS public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID, JSONB);

CREATE OR REPLACE FUNCTION public.record_expense(
  p_transaction_id      UUID,
  p_amount              NUMERIC,
  p_description         TEXT,
  p_category            TEXT,
  p_paid_by             UUID,
  p_split_type          TEXT,
  p_splits              JSONB,
  p_group_id            UUID DEFAULT NULL,
  p_payers              JSONB DEFAULT NULL,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
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

  SELECT t.group_id, t.updated_at
    INTO v_prev_group_id, v_stored_at
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
  END IF;

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

  DELETE FROM public.transaction_payers WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_payers (transaction_id, user_id, amount_paid)
  SELECT p_transaction_id, (e->>'user_id')::UUID, (e->>'amount_paid')::NUMERIC
  FROM jsonb_array_elements(v_payers) e;

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
  public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID, JSONB, TIMESTAMPTZ)
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID, JSONB, TIMESTAMPTZ)
  TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT p.oid::regprocedure::text AS signature,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'record_expense';
--   -> exactly one row, 10 arguments, anon false
--
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid = 'public.transactions'::regclass AND NOT tgisinternal;
--   -> transactions_touch_updated_at
--
-- Then confirm the trigger fires, which inspecting the body cannot show:
--
--   SELECT id, created_at = updated_at AS never_updated
--   FROM public.transactions ORDER BY created_at DESC LIMIT 3;
--
-- All true today, since nothing has ever maintained the column. Edit an expense
-- in the app and the row you touched should flip to false.
