-- Kinlo · 0018 · group settlements cannot exceed the debt either
--
-- THE GAP THIS CLOSES
--
-- 0017 stopped a 1-on-1 settlement from exceeding what is actually owed, which
-- is what finally ended the duplicate-settlement bug. It exempted groups:
--
--   IF p_group_id IS NULL THEN
--     ... guard ...
--   END IF;
--
-- The reasoning was that a group balance is a multi-party net, routed by debt
-- simplification through people who may never have transacted directly, so the
-- pairwise arithmetic 0017 uses does not apply. That reasoning was right. The
-- conclusion — leave it unguarded — was not. It left group settlements in
-- exactly the state 1-on-1 settlements were in before 0017: nothing in the
-- database has an opinion about whether the payment makes sense, so a stale
-- client, a double tap or a reopened screen can record the same settlement
-- twice and drive a member's position past zero.
--
-- There are no groups in this database yet, so nothing is currently broken.
-- This lands before the first one is created rather than after.
--
-- WHAT THE RIGHT CAP IS FOR A GROUP
--
-- Not the raw pairwise net between two members — inside a group that number is
-- meaningless on its own, because the ledger deliberately re-routes who pays
-- whom to minimise transfers. What the app actually offers the user is a
-- simplified transfer: "B pays A ₹600", read straight out of
-- simplified_settlements. That row is the obligation, so that row is the cap.
--
-- Settling more than a simplified row says is owed is exactly as wrong as
-- overpaying a 1-on-1 debt, and it is the same user action that produces it:
-- pressing a button that should no longer be there.
--
-- DIRECTION
--
--   p_payer_is_me = true    I hand them money, clearing what I owe.
--                           The ledger must show me as debtor, them creditor.
--   p_payer_is_me = false   They hand me money, clearing what they owe.
--                           The ledger must show them as debtor, me creditor.
--
-- A settlement in the other direction is not a partial payment; it invents a
-- debt. Both directions are checked, as in 0017.
--
-- IDEMPOTENCY
--
-- The 1-on-1 branch recomputes from raw transactions and excludes its own
-- p_transaction_id, so a retry validates cleanly. That trick is not available
-- here: simplified_settlements is derived state that the first attempt already
-- rebuilt, so by the time a retry arrives the row it should be checking against
-- has already been reduced or removed.
--
-- So the group branch detects a retry directly — the transaction id already
-- exists — and skips the guard for it. An upsert replaying the same key is not
-- a second payment and must not be treated as one.
--
-- WHAT THIS DOES NOT CHANGE
--
-- Everything else in record_settlement is 0017 unchanged: validation, the
-- relationship and membership checks, the p_settles link handling, the write,
-- the split replacement, the expense status maintenance and the ledger rebuild.
-- Only the group branch of the guard is new.

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
