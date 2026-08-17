-- Kinlo · 0009 · let someone else be the payer on an expense you record
--
-- THE BUG
--
-- Adding an expense that a friend paid for fails with a database error.
-- expense/payer.tsx offers every participant as a possible payer (its
-- condition is `participants.length > 0`, not group membership), but 0002's
-- insert policy is:
--
--   transactions_insert WITH CHECK (
--     auth.uid() = paid_by
--     OR (group_id IS NOT NULL AND is_group_member(group_id) AND <payer in group>)
--   )
--
-- so a 1-on-1 expense naming anyone but yourself as payer is rejected. The UI
-- offers something the database forbids. "Vaishnavi paid for dinner, split
-- between us" is core behaviour, so the database has to allow it.
--
-- WHY NOT JUST WIDEN THE POLICY
--
-- That rule is what stops one account fabricating debt between two strangers —
-- the phantom-debt hole 0002 closed. And RLS cannot express the check we
-- actually want: WITH CHECK runs when the transaction row is inserted, but the
-- splits do not exist yet at that moment, so the database has no way to see
-- whether the caller is genuinely part of the expense.
--
-- So the whole write moves into one SECURITY DEFINER function that receives
-- the splits up front and can therefore verify participation before writing
-- anything. Same shape as record_settlement() in 0005.
--
-- This also removes a latent bug: split.tsx currently writes the transaction,
-- then the splits, then recalculates as three separate round trips, so a
-- failure part-way leaves a half-written expense behind.

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
  me            UUID := auth.uid();
  v_split_count INT;
  v_sum         NUMERIC;
  v_me_involved BOOLEAN;
  r             RECORD;
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

  -- Shares must account for the whole amount. A tolerance of 1 paisa per
  -- split absorbs the remainder-cent distribution splitCalculator does.
  SELECT COALESCE(SUM((e->>'share_amount')::NUMERIC), 0)
    INTO v_sum
  FROM jsonb_array_elements(p_splits) e;

  IF ABS(v_sum - p_amount) > (0.01 * v_split_count) THEN
    RAISE EXCEPTION 'splits total % but the expense is %', v_sum, p_amount;
  END IF;

  -- SECURITY DEFINER bypasses RLS, so these checks are the only thing between
  -- a caller and inventing an expense between people they have nothing to do
  -- with. You must be a genuine party: the payer, or one of the debtors.
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
    -- Every debtor must be in the group too, so a group expense cannot be used
    -- to attach a stranger to the ledger.
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
    -- No group: everyone named must already be connected to you. Same
    -- boundary users_select_related uses everywhere else.
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

  -- upsert, so retrying the same idempotency key overwrites a half-written
  -- attempt rather than failing on a duplicate primary key.
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

  -- Replace rather than append: on an edit this clears the old set, and on a
  -- retry it clears a partial one. 0004's unique index backs this up.
  DELETE FROM public.transaction_splits WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_splits (transaction_id, user_id, share_amount)
  SELECT p_transaction_id, (e->>'user_id')::UUID, (e->>'share_amount')::NUMERIC
  FROM jsonb_array_elements(p_splits) e
  WHERE (e->>'share_amount')::NUMERIC > 0;

  -- Rebuild the ledger in the same transaction as the write, so no reader can
  -- observe the inconsistent intermediate state.
  IF p_group_id IS NOT NULL THEN
    PERFORM public.recalculate_group_settlements(p_group_id);
  ELSE
    -- Every counterparty this expense involves, from my side of it.
    FOR r IN
      SELECT DISTINCT other FROM (
        SELECT (e->>'user_id')::UUID AS other FROM jsonb_array_elements(p_splits) e
        UNION
        SELECT p_paid_by
      ) x
      WHERE other <> me
    LOOP
      PERFORM public.recalculate_pair_settlements(r.other);
    END LOOP;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_expense(UUID, NUMERIC, TEXT, TEXT, UUID, TEXT, JSONB, UUID) TO authenticated;
