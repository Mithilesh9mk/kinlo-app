-- Kinlo · 0031 · a group chooses whether its debts are simplified
--
-- Audit finding H6, specification §17.2. Simplification has always been
-- mandatory: recalculate_group_settlements runs greedy debtor-to-creditor
-- matching and simplified_settlements only ever stores that result, so the raw
-- "who actually owes whom" view is unreachable from anywhere in the product.
--
-- Simplification is not free. It minimises the number of transfers, but it
-- invents obligations between people who never transacted — B can be told to
-- pay A for a bill C paid for. Some groups want that; some would rather settle
-- with the person they actually ate dinner with. §17 is explicit that
-- simplification is a derived optimisation and the underlying expenses are
-- untouched either way, so offering the choice costs nothing in correctness.
--
-- ---------------------------------------------------------------------------
-- WHY THE FLAG CHANGES WHAT IS STORED, NOT HOW SCREENS READ IT
-- ---------------------------------------------------------------------------
-- The obvious implementation is to leave simplified_settlements simplified and
-- have the group screen fetch a separate "direct" view when the toggle is off.
-- That is wrong here for two reasons.
--
-- It would create a second balance calculation. Nearly every defect found in
-- this codebase traced back to a screen working out a balance its own way, and
-- lib/balances.ts exists specifically to stop that.
--
-- And it would break settling. 0018's group guard caps a settlement at the
-- matching simplified_settlements row. A direct debt B→C may have no simplified
-- row at all, so settling anything shown in a direct view would be refused with
-- "there is no outstanding balance between you in this group".
--
-- So the engines emit whichever shape the group has chosen, and everything
-- downstream — Friends, Home, lib/balances.ts, the settle guard, the group
-- settle sheet — follows with no change whatsoever.
--
-- This stays inside §17.2. transactions and transaction_splits are never
-- touched by either mode; simplified_settlements is derived state that is
-- already rebuilt from scratch on every write. Per-member net positions are
-- identical under both modes — only the routing between people differs, which
-- is precisely what §17.1 says simplification may change and §17.2 says the
-- toggle may switch.
--
-- One consequence worth stating plainly: with the toggle off, per-friend
-- balances on Home and Friends change for members of that group. Same totals,
-- different counterparties. That is the intended effect of the setting.

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS simplify_debts BOOLEAN NOT NULL DEFAULT TRUE;

-- TRUE preserves today's behaviour for every group that already exists.

COMMENT ON COLUMN public.groups.simplify_debts IS
  'TRUE: the ledger stores the minimal set of transfers (greedy matching). '
  'FALSE: it stores direct pairwise debts, each sitting with the person it '
  'arose from. Net positions are identical either way; only the routing differs.';


-- ===========================================================================
-- recalculate_group_settlements
-- ===========================================================================
-- The position calculation is 0023 unchanged — the tx / paid / owed / bal CTEs
-- that read transaction_payers with the paid_by fallback. Only what happens
-- afterwards is new.

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
  v_settled   BIGINT;
  v_simplify  BOOLEAN;
BEGIN
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'group id is required';
  END IF;

  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
  END IF;

  SELECT g.simplify_debts INTO v_simplify
  FROM public.groups g WHERE g.id = p_group_id;

  v_simplify := COALESCE(v_simplify, TRUE);

  DELETE FROM public.simplified_settlements WHERE group_id = p_group_id;

  IF v_simplify THEN
    -- -------------------------------------------------------------------
    -- Simplified: fewest transfers that settle everyone. 0023 unchanged.
    -- -------------------------------------------------------------------
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

  ELSE
    -- -------------------------------------------------------------------
    -- Direct: each debt stays with the person it arose from.
    --
    -- Per transaction, every debtor owes every creditor in proportion to that
    -- creditor's share of the transaction's total credit — the same attribution
    -- rule recalculate_pair_settlements uses (0021, the `edges` CTE). Reusing
    -- it is not a stylistic choice: a group in direct mode and a 1-on-1 debt
    -- between the same two people must be computed identically, or the two
    -- ledgers disagree about the same relationship.
    --
    -- Summed per unordered pair across the whole group, rounded once at the
    -- end. One row per pair, direction carried by which column each id lands
    -- in, so UNIQUE (group_id, debtor_id, creditor_id) and the amount > 0
    -- check are satisfied by construction.
    -- -------------------------------------------------------------------
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    SELECT p_group_id,
           CASE WHEN pair.net_cents < 0 THEN pair.a ELSE pair.b END,
           CASE WHEN pair.net_cents < 0 THEN pair.b ELSE pair.a END,
           ABS(pair.net_cents) / 100.0,
           NOW()
    FROM (
      WITH tx AS (
        SELECT t.id, t.paid_by, t.amount
        FROM public.transactions t
        WHERE t.group_id = p_group_id
          AND t.status IN ('active', 'settled')
      ),
      paid AS (
        SELECT tx.id AS transaction_id,
               COALESCE(p.user_id, tx.paid_by) AS user_id,
               ROUND(COALESCE(p.amount_paid, tx.amount) * 100)::BIGINT AS cents
        FROM tx
        LEFT JOIN public.transaction_payers p ON p.transaction_id = tx.id
      ),
      owed AS (
        SELECT s.transaction_id, s.user_id,
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
        SELECT nets.transaction_id, SUM(nets.net_cents)::NUMERIC AS total_credit
        FROM nets WHERE nets.net_cents > 0 GROUP BY nets.transaction_id
      ),
      edges AS (
        SELECT d.user_id AS debtor,
               c.user_id AS creditor,
               ((-d.net_cents)::NUMERIC * c.net_cents::NUMERIC) / cr.total_credit AS cents
        FROM nets d
        JOIN nets c    ON c.transaction_id = d.transaction_id AND c.net_cents > 0
        JOIN credit cr ON cr.transaction_id = d.transaction_id
        WHERE d.net_cents < 0
          AND cr.total_credit > 0
      )
      -- Collapse to unordered pairs. Positive means b owes a.
      SELECT LEAST(e.debtor, e.creditor)    AS a,
             GREATEST(e.debtor, e.creditor) AS b,
             ROUND(SUM(
               CASE WHEN e.debtor = GREATEST(e.debtor, e.creditor) THEN  e.cents
                    ELSE -e.cents
               END))::BIGINT AS net_cents
      FROM edges e
      GROUP BY LEAST(e.debtor, e.creditor), GREATEST(e.debtor, e.creditor)
    ) pair
    WHERE ABS(pair.net_cents) >= 1;
  END IF;
END;
$$;


-- ===========================================================================
-- admin_rebuild_group_settlements
-- ===========================================================================
-- Same logic, no membership assertion. record_expense() and void_transaction()
-- call this one rather than the auth.uid() version, so the two must not drift —
-- if they did, editing or voiding would rebuild a group differently from
-- everything else that touches it.

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
  v_settled   BIGINT;
  v_simplify  BOOLEAN;
BEGIN
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'group id is required';
  END IF;

  SELECT g.simplify_debts INTO v_simplify
  FROM public.groups g WHERE g.id = p_group_id;

  v_simplify := COALESCE(v_simplify, TRUE);

  DELETE FROM public.simplified_settlements WHERE group_id = p_group_id;

  IF v_simplify THEN
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

  ELSE
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    SELECT p_group_id,
           CASE WHEN pair.net_cents < 0 THEN pair.a ELSE pair.b END,
           CASE WHEN pair.net_cents < 0 THEN pair.b ELSE pair.a END,
           ABS(pair.net_cents) / 100.0,
           NOW()
    FROM (
      WITH tx AS (
        SELECT t.id, t.paid_by, t.amount
        FROM public.transactions t
        WHERE t.group_id = p_group_id
          AND t.status IN ('active', 'settled')
      ),
      paid AS (
        SELECT tx.id AS transaction_id,
               COALESCE(p.user_id, tx.paid_by) AS user_id,
               ROUND(COALESCE(p.amount_paid, tx.amount) * 100)::BIGINT AS cents
        FROM tx
        LEFT JOIN public.transaction_payers p ON p.transaction_id = tx.id
      ),
      owed AS (
        SELECT s.transaction_id, s.user_id,
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
        SELECT nets.transaction_id, SUM(nets.net_cents)::NUMERIC AS total_credit
        FROM nets WHERE nets.net_cents > 0 GROUP BY nets.transaction_id
      ),
      edges AS (
        SELECT d.user_id AS debtor,
               c.user_id AS creditor,
               ((-d.net_cents)::NUMERIC * c.net_cents::NUMERIC) / cr.total_credit AS cents
        FROM nets d
        JOIN nets c    ON c.transaction_id = d.transaction_id AND c.net_cents > 0
        JOIN credit cr ON cr.transaction_id = d.transaction_id
        WHERE d.net_cents < 0
          AND cr.total_credit > 0
      )
      SELECT LEAST(e.debtor, e.creditor)    AS a,
             GREATEST(e.debtor, e.creditor) AS b,
             ROUND(SUM(
               CASE WHEN e.debtor = GREATEST(e.debtor, e.creditor) THEN  e.cents
                    ELSE -e.cents
               END))::BIGINT AS net_cents
      FROM edges e
      GROUP BY LEAST(e.debtor, e.creditor), GREATEST(e.debtor, e.creditor)
    ) pair
    WHERE ABS(pair.net_cents) >= 1;
  END IF;
END;
$$;


-- ===========================================================================
-- Changing the setting
-- ===========================================================================
-- Flag and rebuild in one call, deliberately. Updating the column without
-- rebuilding would leave the stored ledger contradicting the group's stated
-- convention until something else happened to trigger a rebuild — and in the
-- meantime the settle sheet would offer transfers from the mode the group just
-- turned off.

CREATE OR REPLACE FUNCTION public.set_group_simplification(
  p_group_id UUID,
  p_simplify BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'group id is required';
  END IF;
  IF p_simplify IS NULL THEN
    RAISE EXCEPTION 'a setting is required';
  END IF;

  -- SECURITY DEFINER bypasses RLS, so this is the only thing stopping a caller
  -- changing how a group they are not in settles up.
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
  END IF;

  UPDATE public.groups SET simplify_debts = p_simplify WHERE id = p_group_id;

  PERFORM public.recalculate_group_settlements(p_group_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_group_simplification(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_group_simplification(UUID, BOOLEAN) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT column_name, column_default, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='groups' AND column_name='simplify_debts';
--   -> boolean, default true, NOT NULL
--
--   SELECT p.oid::regprocedure::text,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname='public' AND p.proname='set_group_simplification';
--   -> one row, anon false
--
-- Then exercise the engines, since a stored body is not a working body:
--
--   SELECT * FROM public.admin_rebuild_all_settlements();
--
-- followed by the reconciliation sweep. Every group defaults to TRUE, so
-- nothing may move.
--
-- The invariant that matters once a real group exists (§17.1, §4.4): each
-- member's net position must be identical in both modes, and must sum to zero.
--
--   SELECT u.full_name,
--          ROUND(SUM(CASE WHEN s.creditor_id = u.id THEN s.amount
--                         WHEN s.debtor_id   = u.id THEN -s.amount END), 2) AS net
--   FROM public.simplified_settlements s
--   JOIN public.users u ON u.id IN (s.debtor_id, s.creditor_id)
--   WHERE s.group_id = '<group id>'
--   GROUP BY u.full_name ORDER BY 2 DESC;
