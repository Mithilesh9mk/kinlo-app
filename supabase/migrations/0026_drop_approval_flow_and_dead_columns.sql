-- Kinlo · 0026 · remove the abandoned approval flow and three dead columns
--
-- Everything here is unused. Nothing reads it, nothing writes it, and in two
-- cases the app could not reach it even if it tried. Confirmed against the
-- codebase and against live data before writing this.
--
-- ---------------------------------------------------------------------------
-- 1 · the approval flow
-- ---------------------------------------------------------------------------
-- users.require_expense_approval and users.require_settlement_confirmation
-- backed a flow where an expense would land as 'pending' and wait to be
-- approved by the other party.
--
-- It was never finished. record_expense() writes status='active' unconditionally
-- and always has, so no transaction could ever arrive in a state needing
-- approval. app/statement.tsx carried four handlers for it — approve, reject,
-- confirm, dispute — and not one of them was called from anywhere: no button,
-- no menu, no code path. Those are removed in the same change as this
-- migration.
--
-- They were also wrong, which is why removing rather than finishing them is the
-- right call:
--
--   * handleReject wrote status='rejected', a value transactions_status_check
--     has never permitted. It would have failed outright.
--   * handleApprove called recalculatePairSettlements without checking
--     group_id, so on a group expense it would have rebuilt the wrong ledger.
--
-- Neither column is referenced anywhere in app/, lib/, context/ or components/.

ALTER TABLE public.users DROP COLUMN IF EXISTS require_expense_approval;
ALTER TABLE public.users DROP COLUMN IF EXISTS require_settlement_confirmation;

-- ---------------------------------------------------------------------------
-- 2 · narrow transactions.status to what the app actually writes
-- ---------------------------------------------------------------------------
-- The constraint has permitted five values since 0001: active, voided, pending,
-- settled, disputed. Only three are ever written. 'pending' and 'disputed' were
-- the approval flow's states, and 0001's own header notes they were legacy from
-- the pre-migration schema that the app never used.
--
-- Verified on 20 Aug 2026 before writing this:
--
--   SELECT status, count(*) FROM public.transactions GROUP BY status;
--   -> active 65, settled 9, voided 5.  Nothing else exists.
--
-- Narrowing matters because a permitted-but-unused status is a trap: the ledger
-- functions count only 'active' and 'settled', so anything that managed to
-- write 'pending' would silently vanish from every balance while still
-- appearing in history.

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_status_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('active', 'voided', 'settled'));

-- ---------------------------------------------------------------------------
-- 3 · groups.total_spending
-- ---------------------------------------------------------------------------
-- A stored aggregate with no writer. No trigger maintains it, no application
-- code sets it, and it has sat at its DEFAULT 0 since the table was created.
--
-- It is dropped rather than fixed because it should not exist: §3.1 is explicit
-- that a balance or total is derived state, reconstructable from the financial
-- events, and never an independent stored truth. app/group/[id].tsx already
-- computes group spend from transactions. A column that looks authoritative,
-- reads as zero, and is wrong the moment anyone trusts it is worse than no
-- column at all.

ALTER TABLE public.groups DROP COLUMN IF EXISTS total_spending;

-- ---------------------------------------------------------------------------
-- 4 · transaction_splits.percentage_share
-- ---------------------------------------------------------------------------
-- Read in one place — app/expense/amount.tsx, when reconstructing an expense
-- for editing — and written nowhere. It has been NULL on every row ever
-- created, which means the edit path's `splitMode = ... ? 'percent' : 'exact'`
-- test has always taken the 'exact' branch.
--
-- Nothing is lost. A percentage split is stored as the amounts it produced, and
-- reopening it as exact amounts reproduces the same shares. The percentages
-- themselves were never persisted, so they cannot be restored by keeping a
-- column that never held them.
--
-- amount.tsx is updated in the same change to stop selecting it.

ALTER TABLE public.transaction_splits DROP COLUMN IF EXISTS percentage_share;

-- ---------------------------------------------------------------------------
-- DELIBERATELY KEPT
-- ---------------------------------------------------------------------------
--   _settlement_repair_log  — the audit record of the June reversed-settlement
--     repair. service_role-only access is correct for an admin table, and
--     destroying the trail of a financial correction to reclaim a few kilobytes
--     is a poor trade.
--
--   users.is_verified — set false at signup and never updated, but plausible
--     for phone or email verification later. Dropping and re-adding is churn.
--
-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT table_name, column_name FROM information_schema.columns
--   WHERE table_schema='public'
--     AND column_name IN ('require_expense_approval','require_settlement_confirmation',
--                         'total_spending','percentage_share');
--   -> zero rows
--
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid='public.transactions'::regclass AND conname='transactions_status_check';
--   -> CHECK (status::text = ANY (ARRAY['active','voided','settled']))
