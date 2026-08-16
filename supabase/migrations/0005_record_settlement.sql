-- Kinlo · 0005 · settlements record the correct payer direction
--
-- THE BUG THIS FIXES
--
-- app/settle-up.tsx wrote every settlement as `paid_by = auth.uid()`,
-- regardless of who actually handed over the money. It computed the direction
-- (`const isFriendPaying = currentStatus === 'owed'`) and then never used it.
--
-- In this schema "paid_by = X, split.user_id = Y, amount = A" means *Y owes X
-- A*. So with the payer hardcoded to the caller:
--
--   I owe Rahul ₹100, I pay him      →  -100 +100 =    0   correct
--   Rahul owes me ₹100, he pays me   →  +100 +100 = +200   WRONG
--
-- Recording that someone paid you back doubled their debt instead of clearing
-- it. The UI knew the direction ("Rahul is paying You") and group/[id].tsx
-- passed it as a route param; only the write ignored it.
--
-- WHY AN RPC RATHER THAN JUST FIXING THE CLIENT
--
-- The client cannot write the correct row. 0002's transactions_insert policy
-- requires `auth.uid() = paid_by` for 1-on-1 rows (group_id IS NULL) — which
-- is the constraint that made the original author hardcode the payer and
-- leave the comment "ALWAYS use the authenticated user as the payer to
-- satisfy RLS". That policy is correct and should stay: it is what stops one
-- user fabricating private debt between two others.
--
-- So the settlement is written by a SECURITY DEFINER function that re-checks
-- the caller is genuinely a party to the debt, exactly as 0003 does for the
-- ledger. Widening the RLS policy instead would re-open the phantom-debt hole
-- that 0002 closed.

BEGIN;

CREATE OR REPLACE FUNCTION public.record_settlement(
  p_transaction_id UUID,      -- idempotency key minted by the client
  p_other_user     UUID,
  p_amount         NUMERIC,
  p_payer_is_me    BOOLEAN,   -- true: I paid them. false: they paid me.
  p_description    TEXT,
  p_group_id       UUID DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me        UUID := auth.uid();
  v_payer   UUID;
  v_debtor  UUID;
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

  -- The whole point of this migration. "Y owes X" is encoded as
  -- paid_by = X, split.user_id = Y, so settling a debt means recording the
  -- *reverse* flow of the debt being cleared.
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
    (id, amount, description, category, paid_by, group_id, split_type, type, status)
  VALUES
    (p_transaction_id, p_amount, p_description, 'other', v_payer, p_group_id,
     'exact', 'settlement', 'active')
  ON CONFLICT (id) DO UPDATE SET
    amount      = EXCLUDED.amount,
    description = EXCLUDED.description,
    paid_by     = EXCLUDED.paid_by,
    group_id    = EXCLUDED.group_id,
    status      = EXCLUDED.status;

  -- Replace rather than append, so a retry cannot double-count the split.
  -- 0004's unique index makes this belt-and-braces.
  DELETE FROM public.transaction_splits WHERE transaction_id = p_transaction_id;

  INSERT INTO public.transaction_splits (transaction_id, user_id, share_amount)
  VALUES (p_transaction_id, v_debtor, p_amount);

  -- Rebuild the ledger in the same transaction as the write that invalidated
  -- it, so no reader can observe the inconsistent intermediate state.
  IF p_group_id IS NOT NULL THEN
    PERFORM public.recalculate_group_settlements(p_group_id);
  ELSE
    PERFORM public.recalculate_pair_settlements(p_other_user);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_settlement(UUID, UUID, NUMERIC, BOOLEAN, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_settlement(UUID, UUID, NUMERIC, BOOLEAN, TEXT, UUID) TO authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- Existing data
-- ---------------------------------------------------------------------------
-- Settlements written before this fix, where the friend was the one paying,
-- are stored with the payer reversed and have been inflating balances. Find
-- them with the query below — they are 'settlement' rows whose description
-- says the *friend* settled, but whose paid_by is the other party:
--
--   SELECT t.id, t.created_at, t.amount, t.paid_by, s.user_id AS split_user,
--          t.description
--   FROM public.transactions t
--   JOIN public.transaction_splits s ON s.transaction_id = t.id
--   WHERE t.type = 'settlement'
--     AND t.status = 'active'
--     AND t.description NOT LIKE 'You settled%'
--   ORDER BY t.created_at DESC;
--
-- Each row that reads "<Name> settled ₹X with You." but has paid_by = you is
-- reversed. Correcting one is a paired update — swap the payer and the split
-- user — followed by a recalculation for that pair or group:
--
--   UPDATE public.transactions      SET paid_by = '<friend-uuid>' WHERE id = '<tx>';
--   UPDATE public.transaction_splits SET user_id = '<your-uuid>'  WHERE transaction_id = '<tx>';
--   SELECT public.recalculate_pair_settlements('<friend-uuid>');
--
-- Review these by hand. Do not bulk-rewrite financial history on the strength
-- of a description string match.
