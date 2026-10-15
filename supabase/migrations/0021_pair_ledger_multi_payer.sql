-- Kinlo · 0021 · the 1-on-1 ledger understands several payers
--
-- STEP 2 OF 2 for audit finding H1. 0020 added transaction_payers and backfilled
-- it; this teaches recalculate_pair_settlements to read it.
--
-- THE MODEL CHANGE
--
-- The old formula reads a debt straight off each row:
--
--   WHEN t.paid_by = me   AND s.user_id = other THEN +share
--   WHEN t.paid_by = other AND s.user_id = me    THEN -share
--
-- That works only because there is exactly one payer, so "the split user owes
-- the payer" is unambiguous. With two payers it is not: if A and B both put
-- money in and C owes ₹200, the row does not say how much of C's ₹200 belongs
-- to A and how much to B.
--
-- So the arithmetic moves to positions. For each transaction, every participant
-- has a contribution and an obligation:
--
--   net(user) = amount they paid  -  amount they owe
--
-- Positive is a creditor, negative a debtor, and the two sides always balance
-- because both derive from the same total.
--
-- HOW A DEBT IS ATTRIBUTED
--
-- Specification §8 states the rule by example:
--
--   A paid ₹600, B paid ₹400.  A owes ₹500, B owes ₹300, C owes ₹200.
--   Net: A +100, B +100, C -200
--   Therefore: C owes A ₹100 and C owes B ₹100.
--
-- C's ₹200 is divided between A and B in proportion to their *net credit*, not
-- their gross contribution — note A paid half as much again as B, yet they are
-- owed the same, because A also consumed more. So:
--
--   edge(debtor -> creditor) = |net(debtor)| * net(creditor) / total_credit
--
-- Chosen over greedy matching (what recalculate_group_settlements does) because
-- greedy depends on the order positions happen to be processed in, which makes
-- it a poor fit for a pairwise ledger that is recomputed constantly. Proportion
-- gives the same answer every time regardless of ordering.
--
-- WHY EXISTING BALANCES CANNOT MOVE
--
-- With a single payer the formula collapses to the old one exactly. The payer
-- is the only creditor, so total_credit = net(payer) and every debtor's
-- fraction is 1 — each owes the payer their whole share, which is precisely
-- what the previous version computed. This is worth verifying against live data
-- immediately after applying; the query is in the footer.
--
-- ROBUST AGAINST THE WRITE PATH LAGGING
--
-- record_expense() does not populate transaction_payers yet. The LEFT JOIN
-- below synthesises a single payer row from transactions.paid_by whenever no
-- explicit rows exist, so a transaction written by the current RPC — or by an
-- older client — is handled identically to a backfilled one. That removes any
-- window where new expenses would compute as though nobody had paid, and means
-- this migration is safe to apply before the write path catches up.
--
-- ROUNDING
--
-- Attribution is done in fractional paise and rounded once, at the end, on the
-- pair's net. Rounding each edge separately would let per-transaction remainders
-- accumulate. With a single payer every edge is a whole number of paise anyway,
-- so today this changes nothing; it matters only once genuine multi-payer
-- expenses exist.
--
-- UNCHANGED
--
-- Signature, security, the auth assertion, the delete-then-insert of the pair's
-- ledger rows, and the sign convention (positive means the other party owes me)
-- are all as they were in 0006.

CREATE OR REPLACE FUNCTION public.recalculate_pair_settlements(p_other_user UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me           UUID := auth.uid();
  -- Named distinctly from the CTE column below. A PL/pgSQL variable and a
  -- query column sharing a name makes every unqualified reference ambiguous,
  -- and Postgres rejects the whole function at runtime rather than at creation.
  v_net_cents  BIGINT;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_other_user IS NULL OR p_other_user = me THEN
    RAISE EXCEPTION 'a distinct counterparty is required';
  END IF;

  WITH tx AS (
    -- Non-group transactions that involve both of us, either as a payer or as
    -- someone who owes. Anything touching only one of us cannot create a debt
    -- between us.
    SELECT t.id, t.paid_by, t.amount
    FROM public.transactions t
    WHERE t.group_id IS NULL
      AND t.status IN ('active', 'settled')
      AND EXISTS (
        SELECT 1 FROM public.transaction_splits s
        WHERE s.transaction_id = t.id AND s.user_id IN (me, p_other_user)
      )
  ),
  paid AS (
    -- Explicit payer rows when they exist; otherwise the single payer the
    -- transaction row itself names.
    SELECT tx.id AS transaction_id,
           COALESCE(p.user_id, tx.paid_by) AS user_id,
           ROUND(COALESCE(p.amount_paid, tx.amount) * 100)::BIGINT AS cents
    FROM tx
    LEFT JOIN public.transaction_payers p ON p.transaction_id = tx.id
  ),
  owed AS (
    SELECT s.transaction_id,
           s.user_id,
           -ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transaction_splits s
    JOIN tx ON tx.id = s.transaction_id
  ),
  nets AS (
    SELECT transaction_id, user_id, SUM(cents)::BIGINT AS net_cents
    FROM (SELECT * FROM paid UNION ALL SELECT * FROM owed) x
    GROUP BY transaction_id, user_id
  ),
  credit AS (
    -- Column references qualified: the PL/pgSQL variable below is also called
    -- net_cents, and an unqualified reference here is ambiguous to Postgres.
    SELECT nets.transaction_id, SUM(nets.net_cents)::NUMERIC AS total_credit
    FROM nets
    WHERE nets.net_cents > 0
    GROUP BY nets.transaction_id
  ),
  edges AS (
    -- Each debtor owes each creditor in proportion to that creditor's share of
    -- the transaction's total credit.
    SELECT d.transaction_id,
           d.user_id AS debtor,
           c.user_id AS creditor,
           ((-d.net_cents)::NUMERIC * c.net_cents::NUMERIC) / cr.total_credit AS cents
    FROM nets d
    JOIN nets c   ON c.transaction_id = d.transaction_id AND c.net_cents > 0
    JOIN credit cr ON cr.transaction_id = d.transaction_id
    WHERE d.net_cents < 0
      AND cr.total_credit > 0
  )
  SELECT COALESCE(ROUND(SUM(
    CASE
      WHEN e.debtor = p_other_user AND e.creditor = me           THEN  e.cents
      WHEN e.debtor = me           AND e.creditor = p_other_user THEN -e.cents
      ELSE 0
    END)), 0)::BIGINT
  INTO v_net_cents
  FROM edges e;

  DELETE FROM public.simplified_settlements
  WHERE group_id IS NULL
    AND ((debtor_id = me AND creditor_id = p_other_user)
      OR (debtor_id = p_other_user AND creditor_id = me));

  IF v_net_cents >= 1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, p_other_user, me, v_net_cents / 100.0, NOW());
  ELSIF v_net_cents <= -1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, me, p_other_user, (-v_net_cents) / 100.0, NOW());
  END IF;
END;
$$;


-- The admin variant, same maths, both identities passed explicitly. Kept in
-- step with the above deliberately: 0015's void_transaction() and 0016's
-- record_expense() both call this one rather than the auth.uid() version, so
-- if the two drift, voiding and editing would compute balances differently
-- from everything else.

CREATE OR REPLACE FUNCTION public.admin_rebuild_pair_settlements(p_user_a UUID, p_user_b UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- See the note in recalculate_pair_settlements: distinct from the CTE column.
  v_net_cents BIGINT;
BEGIN
  IF p_user_a IS NULL OR p_user_b IS NULL OR p_user_a = p_user_b THEN
    RAISE EXCEPTION 'two distinct users are required';
  END IF;

  WITH tx AS (
    SELECT t.id, t.paid_by, t.amount
    FROM public.transactions t
    WHERE t.group_id IS NULL
      AND t.status IN ('active', 'settled')
      AND EXISTS (
        SELECT 1 FROM public.transaction_splits s
        WHERE s.transaction_id = t.id AND s.user_id IN (p_user_a, p_user_b)
      )
  ),
  paid AS (
    SELECT tx.id AS transaction_id,
           COALESCE(p.user_id, tx.paid_by) AS user_id,
           ROUND(COALESCE(p.amount_paid, tx.amount) * 100)::BIGINT AS cents
    FROM tx
    LEFT JOIN public.transaction_payers p ON p.transaction_id = tx.id
  ),
  owed AS (
    SELECT s.transaction_id, s.user_id, -ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transaction_splits s
    JOIN tx ON tx.id = s.transaction_id
  ),
  nets AS (
    SELECT transaction_id, user_id, SUM(cents)::BIGINT AS net_cents
    FROM (SELECT * FROM paid UNION ALL SELECT * FROM owed) x
    GROUP BY transaction_id, user_id
  ),
  credit AS (
    -- Qualified for the same reason as in recalculate_pair_settlements: the
    -- PL/pgSQL variable net_cents shadows this column name.
    SELECT nets.transaction_id, SUM(nets.net_cents)::NUMERIC AS total_credit
    FROM nets WHERE nets.net_cents > 0 GROUP BY nets.transaction_id
  ),
  edges AS (
    SELECT d.transaction_id,
           d.user_id AS debtor,
           c.user_id AS creditor,
           ((-d.net_cents)::NUMERIC * c.net_cents::NUMERIC) / cr.total_credit AS cents
    FROM nets d
    JOIN nets c   ON c.transaction_id = d.transaction_id AND c.net_cents > 0
    JOIN credit cr ON cr.transaction_id = d.transaction_id
    WHERE d.net_cents < 0
      AND cr.total_credit > 0
  )
  -- Positive means b owes a, matching the previous implementation.
  SELECT COALESCE(ROUND(SUM(
    CASE
      WHEN e.debtor = p_user_b AND e.creditor = p_user_a THEN  e.cents
      WHEN e.debtor = p_user_a AND e.creditor = p_user_b THEN -e.cents
      ELSE 0
    END)), 0)::BIGINT
  INTO v_net_cents
  FROM edges e;

  DELETE FROM public.simplified_settlements
  WHERE group_id IS NULL
    AND ((debtor_id = p_user_a AND creditor_id = p_user_b)
      OR (debtor_id = p_user_b AND creditor_id = p_user_a));

  IF v_net_cents >= 1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, p_user_b, p_user_a, v_net_cents / 100.0, NOW());
  ELSIF v_net_cents <= -1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, p_user_a, p_user_b, (-v_net_cents) / 100.0, NOW());
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- VERIFY IMMEDIATELY AFTER APPLYING
-- ---------------------------------------------------------------------------
-- Rebuild everything, then confirm no balance moved. Every expense in this
-- database has one payer, so the new maths must reproduce the old numbers
-- exactly. Any non-zero drift means the rewrite is wrong, and
-- admin_rebuild_all_settlements() can restore the previous state once this
-- migration is rolled back to 0006's body.
--
--   SELECT * FROM public.admin_rebuild_all_settlements();
--
-- then the standard reconciliation sweep — every drift must be 0.00.
