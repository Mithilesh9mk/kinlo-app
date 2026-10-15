-- Kinlo · 0012 · a settlement records which expense it settles
--
-- THE BUG THIS FIXES
--
-- app/transaction/[id].tsx offers a Settle button per participant, and decides
-- whether to show it from the original expense's splits alone:
--
--   const canSettle = !isVoided && Math.abs(l.betweenUs) > 0.005;
--
-- Nothing subtracts settlements already recorded. So after settling with one
-- participant, reopening the same expense — from anyone's history — shows the
-- same button again, and pressing it writes a second offsetting settlement:
--
--   Vaishnavi owes me ₹189.33   →  +189.33
--   settlement recorded         →         0   correct, stop here
--   button reappears, pressed   →   -189.33   now I owe her
--   pressed again               →   -378.66
--
-- That is exactly what the live data contained: expense "Heh" (₹189.33) had
-- three identical settlements at 13:38, 13:39 and 13:40. The two duplicates
-- were voided by hand before this migration; this stops it recurring.
--
-- WHY NOT JUST GATE ON transactions.status
--
-- friend/[id].tsx and group/[id].tsx already gate with `status !== 'settled'`,
-- and copying that here would stop the double-settle. But `status` is one
-- column on the whole transaction, answering a per-participant question. On a
-- three-way dinner, settling with Vaishnavi would mark the expense settled and
-- hide Sarvesh's genuinely outstanding share. All-or-nothing is the wrong
-- shape.
--
-- WHAT THIS DOES INSTEAD
--
-- A settlement row now carries settles_transaction_id: the expense it pays
-- down, or NULL for a "settle up our whole balance" payment that belongs to no
-- single expense. The detail screen subtracts, per participant, what has
-- already been settled against that expense, so Vaishnavi's button disappears
-- while Sarvesh's stays. Partial payments fall out for free.
--
-- The expense's own `status` is now maintained server-side, flipping to
-- 'settled' only once every participant's share is covered — so the badge and
-- the older screens' gate stay meaningful instead of firing on the first
-- participant. settle-up.tsx's client-side status write is removed alongside
-- this; doing it here keeps it in the same database transaction as the
-- settlement, which the client-side version never was.
--
-- Ledger math is untouched. 0006 established that `status` is display-only and
-- both 'active' and 'settled' count toward balances; that stays true. The
-- offsetting settlement row is still what actually clears the debt.

-- ---------------------------------------------------------------------------
-- STEP 1 of 5 — the column
--
-- ON DELETE SET NULL, not CASCADE: deleting an expense must never silently
-- delete the record that money changed hands. The settlement stands on its own
-- as a payment between two people; it just stops being attributed.
-- ---------------------------------------------------------------------------

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS settles_transaction_id UUID
    REFERENCES public.transactions(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- STEP 2 of 5 — the index
--
-- Every load of the expense detail screen asks "what settles this?", so the
-- lookup is on the hot path. Partial, because the overwhelming majority of
-- rows are expenses with a NULL here.
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS transactions_settles_idx
  ON public.transactions (settles_transaction_id)
  WHERE settles_transaction_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- STEP 3 of 5 — drop the 6-argument record_settlement
--
-- The new signature adds a seventh parameter. CREATE OR REPLACE cannot change
-- an argument list, and simply creating the 7-arg version would leave both
-- resident as overloads — which PostgREST resolves by the named arguments in
-- the request body, making the choice depend on whether the client happened to
-- send the new key. Drop first so exactly one function exists.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.record_settlement(UUID, UUID, NUMERIC, BOOLEAN, TEXT, UUID);

-- ---------------------------------------------------------------------------
-- STEP 4 of 5 — recreate it
--
-- Body identical to 0005 except: the new parameter, its validation, storing it
-- on the row, and the status maintenance at the end.
-- ---------------------------------------------------------------------------

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

  -- SECURITY DEFINER bypasses RLS, so these checks are the only thing between
  -- a caller and forging a settlement involving someone they have no
  -- relationship with.
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
    -- Same boundary users_select_related uses everywhere else.
    IF NOT (
      public.is_friend_of(p_other_user)
      OR public.shares_transaction_with(p_other_user)
      OR public.shares_group_with(p_other_user)
    ) THEN
      RAISE EXCEPTION 'no existing relationship with user %', p_other_user
        USING ERRCODE = '42501';
    END IF;
  END IF;

  -- Validate the link. Bypassing RLS means an unchecked p_settles would let a
  -- caller attach a payment to an expense they have nothing to do with, which
  -- would then alter that expense's status.
  IF p_settles IS NOT NULL THEN
    SELECT t.id, t.type, t.paid_by, t.status
      INTO v_target
    FROM public.transactions t
    WHERE t.id = p_settles;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'expense % does not exist', p_settles;
    END IF;

    -- Settling a settlement is what produced the "You settled ₹81.66 for
    -- 'Vaishnavi settled ₹81.66 with You'" rows in the live data. A payment
    -- is not a debt; it cannot be paid down.
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

  -- "Y owes X" is encoded as paid_by = X, split.user_id = Y, so settling a
  -- debt means recording the *reverse* flow of the debt being cleared.
  IF p_payer_is_me THEN
    v_payer  := me;              -- I handed over money, so they now owe me
    v_debtor := p_other_user;    -- which nets off what I owed them
  ELSE
    v_payer  := p_other_user;    -- they handed over money, so I now owe them
    v_debtor := me;              -- which nets off what they owed me
  END IF;

  -- upsert, not insert: a retry on the same idempotency key must overwrite
  -- the half-written row rather than fail on a duplicate primary key.
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

  -- Replace rather than append, so a retry cannot double-count the split.
  -- 0004's unique index makes this belt-and-braces.
  DELETE FROM public.transaction_splits WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_splits (transaction_id, user_id, share_amount)
  VALUES (p_transaction_id, v_debtor, p_amount);

  -- Maintain the target expense's display status. Everyone except the payer
  -- owes their share; once linked settlements cover that total, and not
  -- before, the expense reads as settled.
  IF p_settles IS NOT NULL THEN
    SELECT COALESCE(SUM(s.share_amount), 0)
      INTO v_owed
    FROM public.transaction_splits s
    JOIN public.transactions t ON t.id = s.transaction_id
    WHERE s.transaction_id = p_settles
      AND s.user_id <> t.paid_by;

    SELECT COALESCE(SUM(t.amount), 0)
      INTO v_settled
    FROM public.transactions t
    WHERE t.settles_transaction_id = p_settles
      AND t.type = 'settlement'
      AND t.status IN ('active', 'settled');

    UPDATE public.transactions
    SET status = CASE
                   WHEN v_settled >= v_owed - 0.005 THEN 'settled'
                   ELSE 'active'
                 END
    WHERE id = p_settles
      AND status <> 'voided';   -- a voided expense stays voided
  END IF;

  -- Rebuild the ledger in the same transaction as the write that invalidated
  -- it, so no reader can observe the inconsistent intermediate state.
  IF p_group_id IS NOT NULL THEN
    PERFORM public.recalculate_group_settlements(p_group_id);
  ELSE
    PERFORM public.recalculate_pair_settlements(p_other_user);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- STEP 5 of 5 — grants
--
-- The DROP in step 3 took the old grants with it.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.record_settlement(UUID, UUID, NUMERIC, BOOLEAN, TEXT, UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_settlement(UUID, UUID, NUMERIC, BOOLEAN, TEXT, UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- NOT BACKFILLED, deliberately
--
-- Settlements written before this migration have settles_transaction_id NULL
-- and stay that way. They cannot be attributed: nothing recorded which expense
-- they paid down, and guessing by amount would mis-link the many equal-share
-- rows this data is full of. NULL reads as "a general payment against the
-- overall balance", which is both true and harmless — the detail screen only
-- subtracts what is explicitly linked, so old expenses simply keep showing
-- their original position, exactly as they did before.
-- ---------------------------------------------------------------------------
