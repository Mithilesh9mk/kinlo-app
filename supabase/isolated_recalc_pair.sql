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
    AND t.status IN ('active', 'settled')
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
END;
$$;



