-- Kinlo · 0017 · a settlement can never exceed what is actually owed
--
-- WHY THIS EXISTS
--
-- The duplicate-settlement bug has now been "fixed" three times on the client
-- and reproduced three times in production:
--
--   0006  stopped the ledger honouring status='settled', so settling no longer
--         cancelled the debt twice.
--   0012  gave settlements a settles_transaction_id so the expense detail
--         screen could subtract what was already settled per participant.
--   (client, 18 Aug)  clamped each line to the real pair balance so a settled
--         friend offers no Settle button at all.
--
-- Every one of those is a client-side guard. Each depends on the device running
-- current code, on route params surviving navigation, and on an over-the-air
-- update actually reaching the phone. On 18 Aug a settlement was recorded twice
-- against the same expense — ₹418.67 against a ₹418.67 debt — because the
-- device was still running an older bundle. The database accepted both without
-- complaint, because nothing in the database had an opinion about it.
--
-- That is the actual defect. The invariant "you cannot pay back more than you
-- owe" is a property of the ledger, not of a screen. It belongs here.
--
-- WHAT THIS ADDS
--
-- Before writing a 1-on-1 settlement, compute what is genuinely outstanding
-- between the two parties and reject anything larger. The computation is the
-- same arithmetic recalculate_pair_settlements() uses, so it agrees with the
-- balance the app displays by construction.
--
-- Specification §4.5 and §19: a settlement reduces an existing obligation. If
-- there is no obligation, there is nothing to reduce, and the write is a
-- mistake regardless of which screen produced it.
--
-- DIRECTION MATTERS
--
--   p_payer_is_me = true   I hand them money, so I must owe them.
--   p_payer_is_me = false  they hand me money, so they must owe me.
--
-- A settlement in the wrong direction is not a partial payment, it is a new
-- debt wearing a settlement's clothes — which is exactly how 17 Aug's
-- "You settled ₹418.67 for 'You settled ₹418.67 with Sarvesh'" rows came to
-- exist. Both directions are checked.
--
-- IDEMPOTENCY IS PRESERVED
--
-- The balance is computed with this transaction id excluded. Without that, a
-- retry on the same idempotency key would see the effect of its own first
-- attempt, conclude the debt was already cleared, and reject a write that is
-- supposed to be a harmless replay.
--
-- GROUPS ARE EXEMPT
--
-- A group balance is a multi-party net that debt simplification may route
-- through people who never transacted directly, so a strict pairwise cap does
-- not apply cleanly. Group settlements are left as they were. There are
-- currently no groups in this database, so nothing is weakened today; when
-- groups are used, this needs its own rule.
--
-- TOLERANCE
--
-- One paisa, to absorb the remainder-cent distribution that splitCalculator
-- performs. A settlement of exactly the outstanding amount must always succeed.
--
-- THE ERROR IS USER-FACING
--
-- app/settle-up.tsx surfaces error.message directly in an Alert, so the message
-- is written to be read by a person rather than a developer.

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
  -- THE GUARD. Everything above this point is 0012 unchanged.
  --
  -- What is genuinely outstanding between us right now, by the same
  -- arithmetic recalculate_pair_settlements() uses. This transaction id is
  -- excluded so a retry does not see its own earlier attempt and reject a
  -- legitimate replay.
  -- =====================================================================
  IF p_group_id IS NULL THEN
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

    -- p_payer_is_me: I am handing over money, so I must be the one who owes.
    -- Otherwise they are paying me, so they must owe me.
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

-- Signature is unchanged, so CREATE OR REPLACE keeps the existing grants and
-- nothing needs re-granting. anon was already revoked on 17 Aug.
