-- Kinlo · 0008 · break the RLS recursion between transactions and splits
--
-- THE BUG
--
--   ERROR: 42P17: infinite recursion detected in policy for relation "transactions"
--
-- 0002 defined these two policies in terms of each other:
--
--   transactions_select      ... OR EXISTS (SELECT 1 FROM transaction_splits
--                                           WHERE transaction_id = transactions.id
--                                             AND user_id = auth.uid())
--
--   transaction_splits_select  user_id = auth.uid()
--                            OR EXISTS (SELECT 1 FROM transactions
--                                       WHERE id = transaction_splits.transaction_id
--                                         AND (paid_by = auth.uid() OR ...))
--
-- Reading either table makes Postgres evaluate the other table's policy, which
-- evaluates the first again. Any query touching both — every screen that
-- embeds transaction_splits, plus lib/friendFetcher's getRelatedUsers — fails
-- outright. That is why Insights showed "Could not load insights", Statement
-- showed "No transactions", friend lists came back empty, and Settle Up
-- reported "All settled up" for people who were genuinely owed money.
--
-- THE FIX
--
-- Both cross-table checks move into SECURITY DEFINER functions. Those run as
-- the function owner and do not re-trigger RLS on the table they read, so the
-- cycle is broken. This is the same technique 0002 already used for
-- is_group_member() to stop group_members recursing on itself.
--
-- The visibility rules are unchanged — only how they are evaluated.

-- ---------------------------------------------------------------------------
-- Helper: do I have a split on this transaction?
-- Reads transaction_splits without invoking its policy.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_has_split_in(check_transaction_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.transaction_splits s
    WHERE s.transaction_id = check_transaction_id
      AND s.user_id = auth.uid()
  );
$$;

REVOKE ALL ON FUNCTION public.user_has_split_in(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_has_split_in(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- transactions_select — the EXISTS on transaction_splits becomes a function
-- call, so reading transactions no longer evaluates the splits policy.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "transactions_select" ON public.transactions;

CREATE POLICY "transactions_select"
ON public.transactions FOR SELECT
USING (
  paid_by = auth.uid()
  OR (group_id IS NOT NULL AND public.is_group_member(group_id))
  OR public.user_has_split_in(id)
);

-- ---------------------------------------------------------------------------
-- transaction_splits_select — reuses can_write_transaction() from 0002, which
-- is already SECURITY DEFINER and encodes exactly this rule (payer, or member
-- of the transaction's group).
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "transaction_splits_select" ON public.transaction_splits;

CREATE POLICY "transaction_splits_select"
ON public.transaction_splits FOR SELECT
USING (
  user_id = auth.uid()
  OR public.can_write_transaction(transaction_id)
);
