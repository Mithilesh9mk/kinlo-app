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

  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE _bal ON COMMIT DROP AS
  SELECT x.uid AS user_id, SUM(x.cents)::BIGINT AS cents
  FROM (
    SELECT t.paid_by AS uid, ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE t.group_id = p_group_id
      AND t.status IN ('active', 'settled')
      AND s.user_id <> t.paid_by
    UNION ALL
    SELECT s.user_id AS uid, -ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE t.group_id = p_group_id
      AND t.status IN ('active', 'settled')
      AND s.user_id <> t.paid_by
  ) x
  GROUP BY x.uid;

  SELECT array_agg(user_id ORDER BY cents ASC), array_agg(-cents ORDER BY cents ASC)
    INTO debtor_ids, debtor_cents
  FROM _bal WHERE cents <= -1;

  SELECT array_agg(user_id ORDER BY cents DESC), array_agg(cents ORDER BY cents DESC)
    INTO cred_ids, cred_cents
  FROM _bal WHERE cents >= 1;

  DELETE FROM public.simplified_settlements WHERE group_id = p_group_id;

  WHILE i <= COALESCE(array_length(debtor_ids, 1), 0)
    AND j <= COALESCE(array_length(cred_ids, 1), 0)
  LOOP
    settled := LEAST(debtor_cents[i], cred_cents[j]);
    EXIT WHEN settled <= 0;

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
