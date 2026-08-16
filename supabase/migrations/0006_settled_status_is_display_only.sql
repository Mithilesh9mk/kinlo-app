-- Kinlo · 0006 · stop double-applying settlements
--
-- THE BUG THIS FIXES
--
-- Settling a specific expense did two things that each cancel the debt:
--   1. inserted a settlement transaction that nets against it (correct), and
--   2. set the original expense's status to 'settled' (settle-up.tsx).
--
-- 0003's ledger functions count only `status = 'active'`, so (2) drops the
-- original expense out of the balance entirely. Applied together the debt is
-- cancelled twice and the balance lands on the wrong side of zero:
--
--   Rahul owes me ₹100        →  +100
--   settlement recorded       →  +100 - 100 =   0   correct, stop here
--   original marked 'settled' →         0 - 100 = -100   now I owe Rahul ₹100
--
-- WHY THIS FIX
--
-- Everywhere in the app 'settled' is already treated as a *display* flag, not
-- an accounting one — friend/[id].tsx:522 and group/[id].tsx:629 render a
-- "Settled" badge from it, and it gates the settle button so you cannot settle
-- the same expense twice. Nothing client-side excludes it from a balance.
-- Only these two SQL functions did, which is what made the two mechanisms
-- collide.
--
-- Splitwise semantics are the same: settling does not retract the original
-- expense, it records a payment that offsets it. Both records stand, and the
-- history stays intact. So the flag stays and the ledger stops honouring it.
--
-- 'voided' remains excluded — that one genuinely means "this expense never
-- counted". 'pending'/'disputed' are legacy values from the pre-0001 schema
-- that the app never writes; they are left excluded rather than silently
-- pulled into balances.

BEGIN;

-- ---------------------------------------------------------------------------
-- Group settlements — body identical to 0003 except the status filter
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

-- ---------------------------------------------------------------------------
-- 1-on-1 settlements — body identical to 0003 except the status filter
-- ---------------------------------------------------------------------------
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

COMMIT;

-- ---------------------------------------------------------------------------
-- After applying: existing balances were computed under the old filter and are
-- stale. Recalculate every group and every 1-on-1 pair once. Run as a user who
-- is a member of the groups concerned, or temporarily bypass the membership
-- check — the functions are SECURITY DEFINER but still assert on auth.uid().
-- ---------------------------------------------------------------------------
