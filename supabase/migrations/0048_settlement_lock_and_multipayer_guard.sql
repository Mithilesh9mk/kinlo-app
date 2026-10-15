-- Kinlo · 0048 · settlement race lock + direct-mode multi-payer guard
--
-- Two independent P1 fixes from the 31 Aug Core Functionality Audit
-- (docs/Kinlo-Core-Functionality-Audit-2026-08-31.docx), shipped together.
--
-- ===========================================================================
-- FIX A — record_settlement had no lock between reading the outstanding
-- balance and writing the settlement
-- ===========================================================================
--
-- The same-screen double-tap case was already solved (client mints one
-- idempotency key per screen session, guarded by a synchronous in-flight
-- ref). But record_settlement itself reads v_max, checks it, then inserts,
-- with no lock in between. Under READ COMMITTED, two different sessions —
-- two devices, or both people in a pair settling within moments of each
-- other — can each read the same pre-write balance, each pass the cap
-- check, and both commit. The ledger ends up over-settled, unbounded by the
-- ±0.01 tolerance that bounds the single-request case.
--
-- Fix: pg_advisory_xact_lock, keyed to the specific pair (or group+pair)
-- being settled, acquired before the first balance read. This is the first
-- use of advisory locking in this codebase (grepped all 47 prior
-- migrations — the only locking precedent is plain `SELECT ... FOR UPDATE`
-- on a single fetched row by primary key, which has no equivalent row to
-- lock here since the pairwise balance is derived, not stored). The _xact_
-- variant auto-releases when the calling transaction ends, matching how
-- this function already runs — no explicit BEGIN/COMMIT inside it, it
-- relies entirely on PostgREST wrapping one RPC call in one transaction.
--
-- This does not change v_is_retry semantics: locking happens before that
-- read, not instead of it, so a retry still recomputes correctly and the
-- group branch still skips its guard on retry exactly as before. It only
-- serializes concurrent callers so the second one observes the first one's
-- committed write instead of racing against a stale read.
--
-- ===========================================================================
-- FIX B — a group in "direct" (non-simplified) mode combined with a
-- multi-payer expense can drift the ledger by whole paise
-- ===========================================================================
--
-- recalculate_pair_settlements / admin_rebuild_pair_settlements (0021) are
-- NOT affected — each call produces exactly one output row for one fixed
-- pair, so ROUND() is applied once on a single aggregate. There is no
-- multi-counterparty rounding drift possible there.
--
-- The real exposure is narrower: recalculate_group_settlements /
-- admin_rebuild_group_settlements's DIRECT branch (0031, used only when
-- simplify_debts = FALSE) reuses the same fractional-cents `edges` CTE, but
-- then rounds independently PER UNORDERED PAIR across the whole group. A
-- member with debt/credit relationships to more than one other member at
-- once can have their true net position split across several independently-
-- rounded pair totals that do not add back up to a whole paisa. This
-- fractional split only exists in the first place when a single expense has
-- more than one payer — a single-payer expense always produces whole-cent
-- net positions with nothing to round (see 0021's own design comment).
--
-- simplify_debts defaults to TRUE for every group (0031), so this requires a
-- user to have deliberately switched a group to direct mode, on top of a
-- multi-payer expense existing inside it — confirmed via the preflight query
-- below that this combination has never occurred in production.
--
-- Fix (a guard, not the full 2-D rounding-correction algorithm — decided
-- with the user 31 Aug: no existing matrix-rounding pattern exists anywhere
-- in this codebase to build the real fix on, and this combination has never
-- been exercised against real data, so closing the exploitable path now and
-- deferring the full algorithm to its own properly-tested change is the
-- lower-risk move): block the combination at both entry points —
--   (A) record_expense refuses a 2+-payer expense inside a group that is
--       currently in direct mode.
--   (B) set_group_simplification refuses to switch a group to direct mode
--       while it already contains a multi-payer expense (otherwise someone
--       could add the expense while simplified, still safe, then flip the
--       toggle afterward with no warning).
-- Single-payer expenses, and multi-payer expenses in simplified-mode groups
-- (the default, and the only mode ever exercised in production), are
-- completely unaffected.

-- ===========================================================================
-- FIX A: record_settlement
-- ===========================================================================
-- Identical to 0018_group_settlement_guard.sql except for one new PERFORM
-- inserted after input validation, before the balance-check guard.

CREATE OR REPLACE FUNCTION public.record_settlement(
  p_transaction_id UUID,      -- idempotency key minted by the client
  p_other_user     UUID,
  p_amount         NUMERIC,
  p_payer_is_me    BOOLEAN,   -- true: I paid them. false: they paid me.
  p_description    TEXT,
  p_group_id       UUID DEFAULT NULL,
  p_settles        UUID DEFAULT NULL   -- the expense being paid down, if any
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me           UUID := auth.uid();
  v_payer      UUID;
  v_debtor     UUID;
  v_target     RECORD;
  v_owed       NUMERIC;
  v_settled    NUMERIC;
  v_net_cents  BIGINT;        -- positive: the other party owes me
  v_max        NUMERIC;       -- most that may legitimately be settled now
  v_is_retry   BOOLEAN;       -- this idempotency key has already been written
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_other_user IS NULL OR p_other_user = me THEN
    RAISE EXCEPTION 'a distinct counterparty is required';
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'settlement amount must be positive';
  END IF;
  IF p_transaction_id IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required';
  END IF;

  -- 0048: serialize concurrent settle attempts for this exact pair (or
  -- group+pair) before either reads the outstanding balance. Without this,
  -- two sessions can both read the same pre-write balance and both pass the
  -- over-cap check below. xact-scoped: releases automatically when this
  -- call's implicit transaction ends, no manual unlock needed.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    CASE WHEN p_group_id IS NULL
      THEN 'pair:'  || LEAST(me, p_other_user)::text || ':' || GREATEST(me, p_other_user)::text
      ELSE 'group:' || p_group_id::text || ':' || LEAST(me, p_other_user)::text || ':' || GREATEST(me, p_other_user)::text
    END, 0
  ));

  SELECT EXISTS (
    SELECT 1 FROM public.transactions t WHERE t.id = p_transaction_id
  ) INTO v_is_retry;

  IF p_group_id IS NOT NULL THEN
    IF NOT public.is_group_member(p_group_id) THEN
      RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = p_group_id AND gm.user_id = p_other_user
    ) THEN
      RAISE EXCEPTION 'counterparty is not a member of group %', p_group_id
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF NOT (
      public.is_friend_of(p_other_user)
      OR public.shares_transaction_with(p_other_user)
      OR public.shares_group_with(p_other_user)
    ) THEN
      RAISE EXCEPTION 'no existing relationship with user %', p_other_user
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF p_settles IS NOT NULL THEN
    SELECT t.id, t.type, t.paid_by, t.status INTO v_target
    FROM public.transactions t WHERE t.id = p_settles;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'expense % does not exist', p_settles;
    END IF;
    IF v_target.type <> 'expense' THEN
      RAISE EXCEPTION 'only an expense can be settled, not a %', v_target.type;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.transaction_splits s
      WHERE s.transaction_id = p_settles AND s.user_id = me
    ) AND v_target.paid_by <> me THEN
      RAISE EXCEPTION 'you are not a party to expense %', p_settles
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- =====================================================================
  -- THE GUARD — a settlement may never exceed the debt it clears.
  -- =====================================================================
  IF p_group_id IS NULL THEN
    -- 1-on-1 (0017). Recomputed from raw transactions, excluding this
    -- transaction id so a retry does not see its own earlier attempt.
    SELECT COALESCE(SUM(
      CASE
        WHEN t.paid_by = me           AND s.user_id = p_other_user THEN  ROUND(s.share_amount * 100)::BIGINT
        WHEN t.paid_by = p_other_user AND s.user_id = me           THEN -ROUND(s.share_amount * 100)::BIGINT
        ELSE 0
      END), 0)
    INTO v_net_cents
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE t.group_id IS NULL
      AND t.status IN ('active', 'settled')
      AND t.id <> p_transaction_id
      AND t.paid_by IN (me, p_other_user)
      AND s.user_id IN (me, p_other_user)
      AND s.user_id <> t.paid_by;

    IF p_payer_is_me THEN
      v_max := GREATEST(0, -v_net_cents) / 100.0;
    ELSE
      v_max := GREATEST(0,  v_net_cents) / 100.0;
    END IF;

    IF v_max < 0.005 THEN
      RAISE EXCEPTION
        'Nothing to settle — you are already square with this person.'
        USING ERRCODE = '23514';
    END IF;

    IF p_amount > v_max + 0.01 THEN
      RAISE EXCEPTION
        'That is more than is outstanding. Only %.2f remains to be settled.', v_max
        USING ERRCODE = '23514';
    END IF;

  ELSIF NOT v_is_retry THEN
    -- Group. The cap is the simplified transfer the app actually offered,
    -- read from the group ledger. Skipped on a retry, because the first
    -- attempt has already rebuilt that ledger and the row it would check
    -- against no longer reflects the pre-settlement state.
    SELECT COALESCE(ss.amount, 0)
      INTO v_max
    FROM public.simplified_settlements ss
    WHERE ss.group_id = p_group_id
      AND ss.debtor_id   = CASE WHEN p_payer_is_me THEN me           ELSE p_other_user END
      AND ss.creditor_id = CASE WHEN p_payer_is_me THEN p_other_user ELSE me           END;

    v_max := COALESCE(v_max, 0);

    IF v_max < 0.005 THEN
      RAISE EXCEPTION
        'Nothing to settle — there is no outstanding balance between you in this group.'
        USING ERRCODE = '23514';
    END IF;

    IF p_amount > v_max + 0.01 THEN
      RAISE EXCEPTION
        'That is more than is outstanding. Only %.2f remains to be settled in this group.', v_max
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- =====================================================================

  IF p_payer_is_me THEN
    v_payer  := me;
    v_debtor := p_other_user;
  ELSE
    v_payer  := p_other_user;
    v_debtor := me;
  END IF;

  INSERT INTO public.transactions
    (id, amount, description, category, paid_by, group_id, split_type, type,
     status, settles_transaction_id)
  VALUES
    (p_transaction_id, p_amount, p_description, 'other', v_payer, p_group_id,
     'exact', 'settlement', 'active', p_settles)
  ON CONFLICT (id) DO UPDATE SET
    amount                 = EXCLUDED.amount,
    description            = EXCLUDED.description,
    paid_by                = EXCLUDED.paid_by,
    group_id               = EXCLUDED.group_id,
    status                 = EXCLUDED.status,
    settles_transaction_id = EXCLUDED.settles_transaction_id;

  DELETE FROM public.transaction_splits WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_splits (transaction_id, user_id, share_amount)
  VALUES (p_transaction_id, v_debtor, p_amount);

  IF p_settles IS NOT NULL THEN
    SELECT COALESCE(SUM(s.share_amount), 0) INTO v_owed
    FROM public.transaction_splits s
    JOIN public.transactions t ON t.id = s.transaction_id
    WHERE s.transaction_id = p_settles AND s.user_id <> t.paid_by;

    SELECT COALESCE(SUM(t.amount), 0) INTO v_settled
    FROM public.transactions t
    WHERE t.settles_transaction_id = p_settles
      AND t.type = 'settlement'
      AND t.status IN ('active', 'settled');

    UPDATE public.transactions
    SET status = CASE WHEN v_settled >= v_owed - 0.005 THEN 'settled' ELSE 'active' END
    WHERE id = p_settles AND status <> 'voided';
  END IF;

  IF p_group_id IS NOT NULL THEN
    PERFORM public.recalculate_group_settlements(p_group_id);
  ELSE
    PERFORM public.recalculate_pair_settlements(p_other_user);
  END IF;
END;
$$;

-- Signature unchanged, so CREATE OR REPLACE preserves existing grants.

-- ===========================================================================
-- FIX B.1: record_expense — refuse a 2+-payer expense in a direct-mode group
-- ===========================================================================
-- Identical to 0028_optimistic_concurrency.sql except for one new IF block
-- inserted inside the existing p_group_id IS NOT NULL branch, after the
-- "every participant must be a member of that group" check.

-- This body is 0028 verbatim except for the single guard IF block marked
-- "0048:" below (inside the p_group_id IS NOT NULL branch). Copied from a
-- direct read of 0028_optimistic_concurrency.sql, not reconstructed from
-- memory — an earlier draft of this migration guessed at parts of this
-- function from an unrelated earlier conversation and got several things
-- wrong (error wording, admin_rebuild_* vs recalculate_* function names,
-- the whole non-group rebuild-scope query). That draft was discarded before
-- ever being applied.

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

    -- 0048: a group in direct ("Pay who you owe") mode nets each pair's
    -- fractional-cent attribution independently, which does not reliably
    -- sum back to a whole paisa when one expense has more than one payer.
    -- See this migration's header for the full explanation. Single-payer
    -- expenses are exact and unaffected; simplified-mode groups (default)
    -- are unaffected.
    IF jsonb_array_length(v_payers) > 1 THEN
      IF EXISTS (
        SELECT 1 FROM public.groups g
        WHERE g.id = p_group_id AND g.simplify_debts = FALSE
      ) THEN
        RAISE EXCEPTION
          'Multiple payers are not yet supported in a group set to "Pay who you owe." Turn on "Fewest payments" for this group, or record this expense with a single payer.'
          USING ERRCODE = '23514';
      END IF;
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

-- Signature unchanged, so CREATE OR REPLACE preserves existing grants.

-- ===========================================================================
-- FIX B.2: set_group_simplification — refuse switching to direct mode while
-- a multi-payer expense already exists in the group
-- ===========================================================================

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

  -- 0048: mirrors record_expense's guard from the other direction — without
  -- this, a multi-payer expense recorded while simplified (safe) could have
  -- the group switched to direct mode afterward with no warning, hitting
  -- the same rounding drift record_expense's guard exists to prevent.
  IF NOT p_simplify THEN
    IF EXISTS (
      SELECT tp.transaction_id
      FROM public.transaction_payers tp
      JOIN public.transactions t ON t.id = tp.transaction_id
      WHERE t.group_id = p_group_id AND t.status <> 'voided'
      GROUP BY tp.transaction_id
      HAVING COUNT(*) > 1
    ) THEN
      RAISE EXCEPTION
        'This group already has an expense with multiple payers, which "Pay who you owe" does not support yet. Void or edit that expense to a single payer first.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  UPDATE public.groups SET simplify_debts = p_simplify WHERE id = p_group_id;

  PERFORM public.recalculate_group_settlements(p_group_id);
END;
$$;

-- Signature unchanged, so CREATE OR REPLACE preserves existing grants.

-- ===========================================================================
-- VERIFICATION — run each block separately, review output before proceeding
-- ===========================================================================

-- Preflight (run BEFORE the three CREATE OR REPLACE blocks above): expect
-- zero rows. Confirms the guard is purely prophylactic — no group is
-- currently in direct mode with a multi-payer expense already in it.
--
-- SELECT g.id, g.title, t.id AS transaction_id, COUNT(tp.*) AS payer_count
-- FROM public.groups g
-- JOIN public.transactions t ON t.group_id = g.id AND t.status <> 'voided'
-- JOIN public.transaction_payers tp ON tp.transaction_id = t.id
-- WHERE g.simplify_debts = FALSE
-- GROUP BY g.id, g.title, t.id
-- HAVING COUNT(tp.*) > 1;

-- Post-apply: confirm all three functions were actually replaced.
--
-- SELECT proname, prosrc ILIKE '%pg_advisory_xact_lock%' AS has_lock
-- FROM pg_proc WHERE proname = 'record_settlement';
--
-- SELECT proname, prosrc ILIKE '%Pay who you owe%' AS has_guard
-- FROM pg_proc WHERE proname = 'record_expense';
--
-- SELECT proname, prosrc ILIKE '%multiple payers%' AS has_guard
-- FROM pg_proc WHERE proname = 'set_group_simplification';

-- Post-apply: confirm grants are unchanged (anon = none, authenticated = yes).
--
-- SELECT routine_name, grantee, privilege_type
-- FROM information_schema.role_routine_grants
-- WHERE routine_name IN ('record_settlement','record_expense','set_group_simplification')
--   AND grantee IN ('anon','authenticated');
