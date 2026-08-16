-- Kinlo · 0003 · one atomic source of truth for the ledger
--
-- Replaces three separate implementations of the same algorithm:
--   * lib/DebtSimplification.ts   — float maths with 0.01 epsilon, used to draw
--                                   the group screen
--   * lib/debtCalculator.ts       — integer cents, used on every write path
--   * functions/simplify_debts/   — a third copy in an abandoned edge function
--
-- and the four client-side delete()-then-insert() pairs that rewrote
-- simplified_settlements with no transaction around them. A dropped connection
-- between those two calls left the ledger empty, which the UI renders as "all
-- settled up".
--
-- The port below is of the integer-cent version (lib/debtCalculator.ts), which
-- is the correct one: it accumulates in cents and never accrues float error.
-- Once this ships, delete the float implementation rather than leaving two.
--
-- Authorisation matters here because these run as SECURITY DEFINER (they must
-- rewrite rows that 0002 gives no client any write policy for). Each one
-- re-checks membership against auth.uid() before touching anything.

BEGIN;

-- UNIQUE(group_id, debtor_id, creditor_id) does not constrain 1-on-1 rows,
-- because NULL group_id values never compare equal. This covers that case.
CREATE UNIQUE INDEX IF NOT EXISTS simplified_settlements_pair_uniq
  ON public.simplified_settlements (debtor_id, creditor_id)
  WHERE group_id IS NULL;

-- ---------------------------------------------------------------------------
-- Group settlements
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.recalculate_group_settlements(p_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  debtor_ids   UUID[];
  debtor_cents BIGINT[];
  cred_ids     UUID[];
  cred_cents   BIGINT[];
  i INT := 1;
  j INT := 1;
  settled BIGINT;
BEGIN
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'group id is required';
  END IF;

  -- SECURITY DEFINER bypasses RLS, so the membership check is the only thing
  -- standing between a caller and another group's ledger.
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
  END IF;

  -- Net position per member, in cents. A payer is owed each other member's
  -- share; each other member owes theirs. Voided rows are excluded.
  CREATE TEMP TABLE _bal ON COMMIT DROP AS
  SELECT x.uid AS user_id, SUM(x.cents)::BIGINT AS cents
  FROM (
    SELECT t.paid_by AS uid, ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE t.group_id = p_group_id
      AND t.status = 'active'
      AND s.user_id <> t.paid_by
    UNION ALL
    SELECT s.user_id AS uid, -ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE t.group_id = p_group_id
      AND t.status = 'active'
      AND s.user_id <> t.paid_by
  ) x
  GROUP BY x.uid;

  -- Largest debt and largest credit first — the greedy pairing that keeps the
  -- number of transfers minimal.
  SELECT array_agg(user_id ORDER BY cents ASC), array_agg(-cents ORDER BY cents ASC)
    INTO debtor_ids, debtor_cents
  FROM _bal WHERE cents <= -1;

  SELECT array_agg(user_id ORDER BY cents DESC), array_agg(cents ORDER BY cents DESC)
    INTO cred_ids, cred_cents
  FROM _bal WHERE cents >= 1;

  -- Delete and rebuild inside this function's transaction, so no reader can
  -- observe the empty intermediate state.
  DELETE FROM public.simplified_settlements WHERE group_id = p_group_id;

  WHILE i <= COALESCE(array_length(debtor_ids, 1), 0)
    AND j <= COALESCE(array_length(cred_ids, 1), 0)
  LOOP
    settled := LEAST(debtor_cents[i], cred_cents[j]);
    EXIT WHEN settled <= 0;   -- guards against a non-advancing loop

    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES
      (p_group_id, debtor_ids[i], cred_ids[j], settled / 100.0, NOW());

    debtor_cents[i] := debtor_cents[i] - settled;
    cred_cents[j]   := cred_cents[j] - settled;

    IF debtor_cents[i] = 0 THEN i := i + 1; END IF;
    IF cred_cents[j] = 0 THEN j := j + 1; END IF;
  END LOOP;

  DROP TABLE IF EXISTS _bal;
END;
$$;

-- ---------------------------------------------------------------------------
-- 1-on-1 settlements
-- ---------------------------------------------------------------------------
-- Expenses with no group. Only two parties, so the greedy loop collapses to a
-- single net figure and at most one row.
CREATE OR REPLACE FUNCTION public.recalculate_pair_settlements(p_other_user UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me         UUID := auth.uid();
  net_cents  BIGINT;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_other_user IS NULL OR p_other_user = me THEN
    RAISE EXCEPTION 'a distinct counterparty is required';
  END IF;

  -- Positive => the other party owes me.
  SELECT COALESCE(SUM(
    CASE
      WHEN t.paid_by = me            AND s.user_id = p_other_user THEN  ROUND(s.share_amount * 100)::BIGINT
      WHEN t.paid_by = p_other_user  AND s.user_id = me           THEN -ROUND(s.share_amount * 100)::BIGINT
      ELSE 0
    END), 0)
  INTO net_cents
  FROM public.transactions t
  JOIN public.transaction_splits s ON s.transaction_id = t.id
  WHERE t.group_id IS NULL
    AND t.status = 'active'
    AND t.paid_by IN (me, p_other_user)
    AND s.user_id IN (me, p_other_user)
    AND s.user_id <> t.paid_by;

  DELETE FROM public.simplified_settlements
  WHERE group_id IS NULL
    AND ((debtor_id = me AND creditor_id = p_other_user)
      OR (debtor_id = p_other_user AND creditor_id = me));

  IF net_cents >= 1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, p_other_user, me, net_cents / 100.0, NOW());
  ELSIF net_cents <= -1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, me, p_other_user, (-net_cents) / 100.0, NOW());
  END IF;
  -- exactly zero: settled, leave no row
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_group_settlements(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_pair_settlements(UUID)  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalculate_group_settlements(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_pair_settlements(UUID)  TO authenticated;

COMMIT;
