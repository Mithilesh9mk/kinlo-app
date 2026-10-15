-- Kinlo · 0007 · admin-mode ledger rebuild for existing data
--
-- WHY THIS EXISTS
--
-- 0005 and 0006 fixed how settlements are written and counted, but they only
-- affect rows written *after* they landed. Every balance already sitting in
-- simplified_settlements was computed under the old, wrong logic and is
-- stale — which is what produced the reported symptom: the Home/Friends list
-- (which reads the ledger) showed "you owe ₹15" while the friend detail
-- screen (which recomputes from raw transactions) showed nothing owed.
--
-- The existing recalculate_group_settlements / recalculate_pair_settlements
-- cannot fix this from the SQL editor: both resolve the current user through
-- auth.uid(), which is NULL outside a request context, so they abort with
-- "authentication required" or a membership failure.
--
-- These admin variants take every identity explicitly and perform no
-- membership check, so they can be run once against the whole database to
-- bring the ledger back in line with the transactions.
--
-- SECURITY
--
-- Skipping the membership check is exactly why these must never be callable
-- by the app. They are granted to nobody: no PUBLIC, no authenticated, no
-- anon. Only a superuser / service_role connection (i.e. the SQL editor)
-- can execute them. Do not add a GRANT here.

BEGIN;

-- ---------------------------------------------------------------------------
-- Group rebuild — same math as recalculate_group_settlements (0006), minus
-- the auth.uid() membership assertion, and without the temp table so it is
-- safe to call repeatedly inside one transaction.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_rebuild_group_settlements(p_group_id UUID)
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

  WITH bal AS (
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
    GROUP BY x.uid
  )
  SELECT
    (SELECT array_agg(user_id ORDER BY cents ASC)  FROM bal WHERE cents <= -1),
    (SELECT array_agg(-cents   ORDER BY cents ASC)  FROM bal WHERE cents <= -1),
    (SELECT array_agg(user_id ORDER BY cents DESC) FROM bal WHERE cents >= 1),
    (SELECT array_agg(cents    ORDER BY cents DESC) FROM bal WHERE cents >= 1)
  INTO debtor_ids, debtor_cents, cred_ids, cred_cents;

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
END;
$$;

-- ---------------------------------------------------------------------------
-- 1-on-1 rebuild — both parties passed explicitly instead of auth.uid()
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_rebuild_pair_settlements(p_user_a UUID, p_user_b UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  net_cents BIGINT;
BEGIN
  IF p_user_a IS NULL OR p_user_b IS NULL OR p_user_a = p_user_b THEN
    RAISE EXCEPTION 'two distinct users are required';
  END IF;

  -- Positive => b owes a.
  SELECT COALESCE(SUM(
    CASE
      WHEN t.paid_by = p_user_a AND s.user_id = p_user_b THEN  ROUND(s.share_amount * 100)::BIGINT
      WHEN t.paid_by = p_user_b AND s.user_id = p_user_a THEN -ROUND(s.share_amount * 100)::BIGINT
      ELSE 0
    END), 0)
  INTO net_cents
  FROM public.transactions t
  JOIN public.transaction_splits s ON s.transaction_id = t.id
  WHERE t.group_id IS NULL
    AND t.status IN ('active', 'settled')
    AND t.paid_by IN (p_user_a, p_user_b)
    AND s.user_id IN (p_user_a, p_user_b)
    AND s.user_id <> t.paid_by;

  DELETE FROM public.simplified_settlements
  WHERE group_id IS NULL
    AND ((debtor_id = p_user_a AND creditor_id = p_user_b)
      OR (debtor_id = p_user_b AND creditor_id = p_user_a));

  IF net_cents >= 1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, p_user_b, p_user_a, net_cents / 100.0, NOW());
  ELSIF net_cents <= -1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, p_user_a, p_user_b, (-net_cents) / 100.0, NOW());
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Rebuild everything: every group, then every 1-on-1 pair that has history
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.admin_rebuild_all_settlements()
RETURNS TABLE (groups_rebuilt INT, pairs_rebuilt INT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  g RECORD;
  p RECORD;
  g_count INT := 0;
  p_count INT := 0;
BEGIN
  FOR g IN SELECT id FROM public.groups LOOP
    PERFORM public.admin_rebuild_group_settlements(g.id);
    g_count := g_count + 1;
  END LOOP;

  -- LEAST/GREATEST normalises (a,b) and (b,a) to one unordered pair so each
  -- relationship is rebuilt exactly once.
  FOR p IN
    SELECT DISTINCT
      LEAST(t.paid_by, s.user_id)    AS ua,
      GREATEST(t.paid_by, s.user_id) AS ub
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE t.group_id IS NULL
      AND t.status IN ('active', 'settled')
      AND s.user_id <> t.paid_by
  LOOP
    PERFORM public.admin_rebuild_pair_settlements(p.ua, p.ub);
    p_count := p_count + 1;
  END LOOP;

  groups_rebuilt := g_count;
  pairs_rebuilt  := p_count;
  RETURN NEXT;
END;
$$;

-- Admin-only. Deliberately no GRANT to authenticated/anon — these skip the
-- membership checks that protect every other ledger function.
REVOKE ALL ON FUNCTION public.admin_rebuild_group_settlements(UUID)      FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_rebuild_pair_settlements(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_rebuild_all_settlements()            FROM PUBLIC;

COMMIT;


