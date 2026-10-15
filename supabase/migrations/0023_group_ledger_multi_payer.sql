-- Kinlo · 0023 · the group ledger understands several payers
--
-- STEP 4, and the last server-side piece of H1. 0020 added transaction_payers,
-- 0021 rewrote the 1-on-1 ledger, 0022 taught record_expense to write payer
-- rows. The group engine still reads transactions.paid_by, so a group expense
-- that several people paid for would compute as though only one had.
--
-- THE CHANGE
--
-- 0006 builds each member's position like this:
--
--   payer gets  + every other participant's share
--   debtor gets - their own share
--
-- That is correct only with one payer, and it is a shortcut for the real
-- quantity: it happens to equal `paid - owed` because the payer paid the whole
-- amount and owes their own share, so total minus own share is exactly the sum
-- of everyone else's. With two payers the shortcut has no meaning.
--
-- So the position is computed directly instead:
--
--   net(member) = everything they paid  -  everything they owe
--
-- summed across every live transaction in the group. Same quantity, stated
-- honestly rather than inferred from a single-payer assumption.
--
-- WHAT DOES NOT CHANGE
--
-- The greedy debtor-to-creditor matching underneath is untouched. It already
-- copes with any number of creditors — that is what simplification is for — so
-- multiple payers need nothing from it. Only the input changes.
--
-- Which is why groups need no equivalent of the proportional attribution rule
-- 0021 had to introduce for pairs: a group ledger is *already* a matching
-- problem over net positions, and always has been.
--
-- WHY EXISTING GROUP BALANCES CANNOT MOVE
--
-- With a single payer, `paid - owed` is arithmetically identical to what 0006
-- computed, as shown above. There are no groups in this database today, so
-- there is nothing to disturb — but the property holds regardless, and the
-- verification below is worth running once groups exist.
--
-- THE TEMP TABLE IS GONE
--
-- 0006's recalculate_group_settlements built a `_bal` temp table with
-- ON COMMIT DROP. 0007 noted this made it unsafe to call more than once inside
-- one transaction and wrote its admin variant with CTEs instead. Since
-- record_expense() and void_transaction() can now rebuild several groups in a
-- single call, both versions use CTEs. Same result, no shared mutable state.
--
-- ROBUST AGAINST MISSING PAYER ROWS
--
-- Same LEFT JOIN fallback as 0021: a transaction with no explicit payer rows is
-- treated as having one payer for the full amount, taken from paid_by. Rows
-- written before 0022, or by anything that bypasses it, behave identically to
-- rows written after.

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
  v_settled BIGINT;
BEGIN
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'group id is required';
  END IF;

  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
  END IF;

  WITH tx AS (
    SELECT t.id, t.paid_by, t.amount
    FROM public.transactions t
    WHERE t.group_id = p_group_id
      AND t.status IN ('active', 'settled')
  ),
  paid AS (
    SELECT COALESCE(p.user_id, tx.paid_by) AS uid,
           ROUND(COALESCE(p.amount_paid, tx.amount) * 100)::BIGINT AS cents
    FROM tx
    LEFT JOIN public.transaction_payers p ON p.transaction_id = tx.id
  ),
  owed AS (
    SELECT s.user_id AS uid,
           -ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transaction_splits s
    JOIN tx ON tx.id = s.transaction_id
  ),
  bal AS (
    SELECT x.uid AS member, SUM(x.cents)::BIGINT AS position_cents
    FROM (SELECT * FROM paid UNION ALL SELECT * FROM owed) x
    GROUP BY x.uid
  )
  SELECT
    (SELECT array_agg(bal.member ORDER BY bal.position_cents ASC)
       FROM bal WHERE bal.position_cents <= -1),
    (SELECT array_agg(-bal.position_cents ORDER BY bal.position_cents ASC)
       FROM bal WHERE bal.position_cents <= -1),
    (SELECT array_agg(bal.member ORDER BY bal.position_cents DESC)
       FROM bal WHERE bal.position_cents >= 1),
    (SELECT array_agg(bal.position_cents ORDER BY bal.position_cents DESC)
       FROM bal WHERE bal.position_cents >= 1)
  INTO debtor_ids, debtor_cents, cred_ids, cred_cents;

  DELETE FROM public.simplified_settlements WHERE group_id = p_group_id;

  -- Greedy matching, unchanged from 0003/0006: settle the largest debt against
  -- the largest credit, take whichever is smaller, repeat.
  WHILE i <= COALESCE(array_length(debtor_ids, 1), 0)
    AND j <= COALESCE(array_length(cred_ids, 1), 0)
  LOOP
    v_settled := LEAST(debtor_cents[i], cred_cents[j]);
    EXIT WHEN v_settled <= 0;

    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES
      (p_group_id, debtor_ids[i], cred_ids[j], v_settled / 100.0, NOW());

    debtor_cents[i] := debtor_cents[i] - v_settled;
    cred_cents[j]   := cred_cents[j] - v_settled;

    IF debtor_cents[i] = 0 THEN i := i + 1; END IF;
    IF cred_cents[j] = 0 THEN j := j + 1; END IF;
  END LOOP;
END;
$$;


-- Admin variant: identical maths, no membership assertion, callable from the
-- SQL editor and from SECURITY DEFINER callers. record_expense() and
-- void_transaction() use this one, so it must not drift from the above.

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
  v_settled BIGINT;
BEGIN
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'group id is required';
  END IF;

  WITH tx AS (
    SELECT t.id, t.paid_by, t.amount
    FROM public.transactions t
    WHERE t.group_id = p_group_id
      AND t.status IN ('active', 'settled')
  ),
  paid AS (
    SELECT COALESCE(p.user_id, tx.paid_by) AS uid,
           ROUND(COALESCE(p.amount_paid, tx.amount) * 100)::BIGINT AS cents
    FROM tx
    LEFT JOIN public.transaction_payers p ON p.transaction_id = tx.id
  ),
  owed AS (
    SELECT s.user_id AS uid,
           -ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transaction_splits s
    JOIN tx ON tx.id = s.transaction_id
  ),
  bal AS (
    SELECT x.uid AS member, SUM(x.cents)::BIGINT AS position_cents
    FROM (SELECT * FROM paid UNION ALL SELECT * FROM owed) x
    GROUP BY x.uid
  )
  SELECT
    (SELECT array_agg(bal.member ORDER BY bal.position_cents ASC)
       FROM bal WHERE bal.position_cents <= -1),
    (SELECT array_agg(-bal.position_cents ORDER BY bal.position_cents ASC)
       FROM bal WHERE bal.position_cents <= -1),
    (SELECT array_agg(bal.member ORDER BY bal.position_cents DESC)
       FROM bal WHERE bal.position_cents >= 1),
    (SELECT array_agg(bal.position_cents ORDER BY bal.position_cents DESC)
       FROM bal WHERE bal.position_cents >= 1)
  INTO debtor_ids, debtor_cents, cred_ids, cred_cents;

  DELETE FROM public.simplified_settlements WHERE group_id = p_group_id;

  WHILE i <= COALESCE(array_length(debtor_ids, 1), 0)
    AND j <= COALESCE(array_length(cred_ids, 1), 0)
  LOOP
    v_settled := LEAST(debtor_cents[i], cred_cents[j]);
    EXIT WHEN v_settled <= 0;

    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES
      (p_group_id, debtor_ids[i], cred_ids[j], v_settled / 100.0, NOW());

    debtor_cents[i] := debtor_cents[i] - v_settled;
    cred_cents[j]   := cred_cents[j] - v_settled;

    IF debtor_cents[i] = 0 THEN i := i + 1; END IF;
    IF cred_cents[j] = 0 THEN j := j + 1; END IF;
  END LOOP;
END;
$$;

-- Signatures unchanged, so CREATE OR REPLACE preserves grants. Note the loop
-- variable is v_settled rather than 0006's `settled`: a PL/pgSQL variable and a
-- query column sharing a name makes unqualified references ambiguous, which
-- Postgres accepts at CREATE time and rejects only when the function runs.
-- That cost a round trip on 0021 and is avoided here by construction.
--
-- VERIFY AFTER APPLYING
--
--   SELECT * FROM public.admin_rebuild_all_settlements();
--
-- then the reconciliation sweep. There are no groups in this database, so
-- groups_rebuilt will be 0 and the pair drift must remain 0.00 — this migration
-- must not have disturbed the 1-on-1 ledger.
