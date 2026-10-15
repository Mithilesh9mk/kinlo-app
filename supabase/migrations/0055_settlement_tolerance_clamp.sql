-- Kinlo · 0055 · a settlement can never be recorded for more than the true debt
--
-- Core Functionality Audit 2026-08-31, finding P2 §4.6 / §3 "Settlement
-- tolerance margin". record_settlement (0018, relocked in 0048) accepts
-- p_amount up to v_max + 0.01 without clamping it back down — a settlement
-- for, say, v_max + 0.008 passes the guard and is written verbatim, leaving a
-- bounded sub-paisa residual sitting in the ledger. It never compounds (the
-- next settlement attempt recomputes v_max from the real remaining balance),
-- but "already square" should mean exactly ₹0.00 outstanding, not "within a
-- paisa of zero".
--
-- Fix: once the guard has already decided the amount is acceptable, clamp it
-- to the true remaining debt before it is ever written. The ±0.01 grace band
-- still exists — it is what lets a client-side rounding difference through
-- the guard at all — it just no longer leaves a residue once through.
--
-- v_max is intentionally NULL on a group-scoped retry (the ELSIF NOT
-- v_is_retry branch at line ~128 of the live function skips recomputing it,
-- because the first attempt already rebuilt the ledger the check would run
-- against). The clamp must not fire in that case — LEAST(p_amount, NULL) is
-- NULL, which would silently null out the retried transaction's amount.
--
-- Entire function body reproduced verbatim from the live definition
-- (captured via pg_get_functiondef and diffed line-by-line before writing
-- this file) except the one new IF block inserted between the guard and the
-- payer/debtor assignment.

CREATE OR REPLACE FUNCTION public.record_settlement(
  p_transaction_id UUID,
  p_other_user UUID,
  p_amount NUMERIC,
  p_payer_is_me BOOLEAN,
  p_description TEXT,
  p_group_id UUID DEFAULT NULL::UUID,
  p_settles UUID DEFAULT NULL::UUID
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
        'That is more than is outstanding. Only % remains to be settled.', ROUND(v_max, 2)
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
        'That is more than is outstanding. Only % remains to be settled in this group.', ROUND(v_max, 2)
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- =====================================================================

  -- 0055: clamp to the true remaining debt now that the guard has accepted
  -- it. v_max is NULL exactly when the group-retry branch above skipped
  -- recomputing it — do not clamp then, or a retried settlement's amount
  -- would be nulled out.
  IF v_max IS NOT NULL THEN
    p_amount := LEAST(p_amount, v_max);
  END IF;

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

REVOKE ALL ON FUNCTION public.record_settlement(UUID, UUID, NUMERIC, BOOLEAN, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_settlement(UUID, UUID, NUMERIC, BOOLEAN, TEXT, UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT p.oid::regprocedure::text,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'record_settlement';
--   -> anon = false, authed = true
--
-- Then exercise it on a real pair with a fractional-cent-adjacent debt (or
-- accept the byte-for-byte diff against the pre-migration live body as
-- sufficient, since the only behavioural change is the clamp — this
-- function's guard logic itself is untouched and was exercised in 0048's
-- own functional test).
