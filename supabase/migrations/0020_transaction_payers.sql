-- Kinlo · 0020 · record who paid, when more than one person did
--
-- STEP 1 OF 2. This migration is deliberately inert.
--
-- It adds the table, its policies and a backfill, and changes no read path
-- whatsoever. Every balance in the app is still computed exactly as it was
-- ten minutes ago, from transactions.paid_by. Nothing observable changes.
--
-- The engine rewrite that actually consumes this table is a separate migration,
-- because it touches recalculate_pair_settlements and
-- recalculate_group_settlements — the two functions every balance in the
-- product derives from. Landing the schema and the maths together would mean a
-- single change with no verifiable midpoint. This way the backfill can be
-- proven correct against live data before anything starts reading it.
--
-- WHY THIS IS NEEDED (audit finding H1)
--
-- transactions.paid_by holds one UUID. There is no way to record "A paid ₹600
-- and B paid ₹400" — specification §8 and acceptance test D, both currently
-- unsatisfiable. The balance engine's paid-minus-owed formula is correct in
-- principle but has only ever seen a single payer, so the general case is
-- unreachable.
--
-- WHAT CHANGES CONCEPTUALLY
--
-- Today a debt is directly readable from a row: the split user owes the payer.
-- With several payers that stops being true. Each participant has a
-- contribution and an obligation, and their position is the difference:
--
--     net(user) = amount they paid  -  amount they owe
--
-- For two people that still yields an unambiguous pairwise debt, because one
-- net is the negation of the other. For three or more it does not — who settles
-- with whom becomes a matching problem, the same one
-- recalculate_group_settlements already solves for groups. That is the real
-- work of step 2, and it is why this is the last structural item rather than
-- another column.
--
-- WHY paid_by STAYS
--
-- It is not redundant and it is not being dropped:
--
--   * Four RLS policies key on it — transactions_select, _insert, _update and
--     _delete all test `paid_by = auth.uid()`. Rewriting those while also
--     rewriting the ledger would put two high-blast-radius changes in one
--     migration.
--   * Every screen displays "X paid" from it.
--   * For the overwhelmingly common single-payer expense it is a correct,
--     cheap denormalisation.
--
-- After step 2 it means "the primary payer" — the one shown in the UI — while
-- transaction_payers is authoritative for the arithmetic. Single-payer rows
-- will have exactly one payer row whose amount equals the transaction total, so
-- the two agree by construction.
--
-- RLS MUST BE DECLARED HERE, NOT LATER
--
-- This project has an event trigger, ensure_rls, which force-enables row level
-- security on every table created in public (see 0013). A CREATE TABLE without
-- policies in the same migration produces a table that silently returns nothing
-- to anon and authenticated — it appears empty rather than erroring, which is
-- the worst way for this to fail. Policies are therefore created below, not in
-- a follow-up.

-- ---------------------------------------------------------------------------
-- 1 · the table
-- ---------------------------------------------------------------------------
-- Mirrors transaction_splits deliberately: same shape, same cascade behaviour,
-- same uniqueness. One row per person who put money in.

CREATE TABLE IF NOT EXISTS public.transaction_payers (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  amount_paid    NUMERIC(15,2) NOT NULL CHECK (amount_paid > 0),
  CONSTRAINT transaction_payers_tx_user_uniq UNIQUE (transaction_id, user_id)
);

-- ON DELETE RESTRICT on user_id matches transactions.paid_by, which is also
-- RESTRICT: a person who has ever paid for something cannot be deleted out from
-- under the ledger. CASCADE on transaction_id matches transaction_splits — if
-- the expense goes, its payer rows go with it.

CREATE INDEX IF NOT EXISTS transaction_payers_transaction_idx
  ON public.transaction_payers (transaction_id);

CREATE INDEX IF NOT EXISTS transaction_payers_user_idx
  ON public.transaction_payers (user_id);

-- ---------------------------------------------------------------------------
-- 2 · row level security
-- ---------------------------------------------------------------------------
-- Explicit even though ensure_rls would enable it anyway, so the intent is in
-- the file rather than implied by a trigger.

ALTER TABLE public.transaction_payers ENABLE ROW LEVEL SECURITY;

-- Mirrors transaction_splits' policies exactly. can_write_transaction() is the
-- same predicate those use, so a caller who may write an expense's splits may
-- write its payers, and no wider.

CREATE POLICY transaction_payers_select ON public.transaction_payers FOR SELECT
  USING ((user_id = auth.uid()) OR public.can_write_transaction(transaction_id));

CREATE POLICY transaction_payers_insert ON public.transaction_payers FOR INSERT
  WITH CHECK (public.can_write_transaction(transaction_id));

CREATE POLICY transaction_payers_update ON public.transaction_payers FOR UPDATE
  USING (public.can_write_transaction(transaction_id))
  WITH CHECK (public.can_write_transaction(transaction_id));

CREATE POLICY transaction_payers_delete ON public.transaction_payers FOR DELETE
  USING (public.can_write_transaction(transaction_id));

-- ---------------------------------------------------------------------------
-- 3 · backfill
-- ---------------------------------------------------------------------------
-- One payer row per existing transaction, carrying the full amount. This is
-- exactly what the current model already asserts, so the backfill states
-- existing truth rather than inventing anything.
--
-- Voided rows are included. They are excluded from balances by status, not by
-- absence, and leaving them without payer rows would make the two
-- representations disagree the moment anything un-voided one.
--
-- ON CONFLICT DO NOTHING makes this safe to re-run, which matters given this
-- project's history of migrations reporting success without persisting.

INSERT INTO public.transaction_payers (transaction_id, user_id, amount_paid)
SELECT t.id, t.paid_by, t.amount
FROM public.transactions t
WHERE t.amount > 0
ON CONFLICT (transaction_id, user_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4 · verification
-- ---------------------------------------------------------------------------
-- Run after applying. Both must return zero rows.
--
-- Any transaction whose payer rows do not sum to its amount:
--
--   SELECT t.id, t.amount, COALESCE(SUM(p.amount_paid), 0) AS paid
--   FROM public.transactions t
--   LEFT JOIN public.transaction_payers p ON p.transaction_id = t.id
--   WHERE t.amount > 0
--   GROUP BY t.id, t.amount
--   HAVING ABS(COALESCE(SUM(p.amount_paid), 0) - t.amount) > 0.005;
--
-- Any transaction whose payer rows disagree with paid_by:
--
--   SELECT t.id
--   FROM public.transactions t
--   JOIN public.transaction_payers p ON p.transaction_id = t.id
--   GROUP BY t.id, t.paid_by
--   HAVING COUNT(*) <> 1 OR MIN(p.user_id) <> t.paid_by;
--
-- The second will start returning rows legitimately once multi-payer expenses
-- exist. Today it must be empty, because every expense has exactly one payer.
