-- Kinlo · repair settlements stored with the payer reversed
--
-- WHY THE HOME TOTAL IS TOO BIG
--
-- Before migration 0005, settle-up.tsx wrote EVERY settlement with
-- paid_by = the caller, regardless of who actually handed over the money.
-- "paid_by = X, split.user_id = Y" means "Y owes X", so a settlement where
-- the friend paid you back got stored as though YOU paid THEM — adding to the
-- debt instead of clearing it.
--
-- The status breakdown showed the arithmetic:
--     active  expense     15 rows   ₹5134.00
--     active  settlement  10 rows   ₹1340.50
--     settled expense      1 row    ₹  26.50
--     settled settlement   2 rows   ₹ 100.00
--   5134.00 + 26.50 + 1340.50 = ₹6501, within rounding of the ₹6,400 on Home.
--
-- HOW A REVERSED ROW IS IDENTIFIED
--
-- settle-up.tsx writes the description before the payer, and the description
-- always names whoever actually paid:
--     friend paid you  ->  "<Friend Name> settled ₹X ... with You."
--     you paid friend  ->  "You settled ₹X ... with <Friend Name>."
--
-- So a row is reversed when the description names someone OTHER than the
-- recorded payer. Matching on that — rather than on "the friend paid" alone —
-- matters: settlements written since 0005 already store the correct payer,
-- and a blanket flip would break those. This predicate leaves them alone.

-- ---------------------------------------------------------------------------
-- 1. INSPECT — run this alone and read every row before going further.
-- ---------------------------------------------------------------------------
SELECT
  t.id,
  t.created_at::date  AS date,
  t.amount,
  payer.full_name     AS recorded_payer,
  ower.full_name      AS recorded_ower,
  t.description,
  CASE
    WHEN t.description LIKE 'You settled%'                 THEN 'you paid — payer must be you'
    WHEN t.description LIKE payer.full_name || '%'         THEN 'OK — description matches payer'
    ELSE                                                        'REVERSED — description names someone else'
  END AS verdict
FROM public.transactions t
JOIN public.transaction_splits s ON s.transaction_id = t.id
LEFT JOIN public.users payer ON payer.id = t.paid_by
LEFT JOIN public.users ower  ON ower.id  = s.user_id
WHERE t.type = 'settlement'
  AND t.status IN ('active', 'settled')
ORDER BY t.created_at DESC;

-- Expect a mix. Only rows marked 'REVERSED' will be touched by block 2.
-- If NOTHING is marked REVERSED, stop — the inflation is coming from
-- somewhere else and block 2 would do nothing (or harm).


-- ---------------------------------------------------------------------------
-- 2. COUNT — how many rows would change, and by how much
-- ---------------------------------------------------------------------------
SELECT COUNT(*) AS rows_to_repair, SUM(t.amount) AS total_amount
FROM public.transactions t
JOIN public.transaction_splits s ON s.transaction_id = t.id
LEFT JOIN public.users payer ON payer.id = t.paid_by
WHERE t.type = 'settlement'
  AND t.status IN ('active', 'settled')
  AND t.description NOT LIKE 'You settled%'
  AND t.description NOT LIKE payer.full_name || '%';


-- ---------------------------------------------------------------------------
-- 3. THE REPAIR — only after blocks 1 and 2 look right.
--
--    This rewrites financial history. Take a backup first:
--    Dashboard -> Database -> Backups. The _settlement_repair_log table it
--    creates records the previous values so a mistake can be undone by hand.
--
--    Uncomment the block below to run it.
-- ---------------------------------------------------------------------------
/*

BEGIN;

CREATE TABLE IF NOT EXISTS public._settlement_repair_log (
  transaction_id  UUID,
  old_paid_by     UUID,
  old_split_user  UUID,
  amount          NUMERIC,
  description     TEXT,
  repaired_at     TIMESTAMPTZ
);

-- The rows to flip, resolved once so the log and the updates cannot disagree.
CREATE TEMP TABLE _swap ON COMMIT DROP AS
SELECT t.id AS tx_id, t.paid_by AS old_payer, s.user_id AS old_ower,
       t.amount, t.description
FROM public.transactions t
JOIN public.transaction_splits s ON s.transaction_id = t.id
LEFT JOIN public.users payer ON payer.id = t.paid_by
WHERE t.type = 'settlement'
  AND t.status IN ('active', 'settled')
  AND t.description NOT LIKE 'You settled%'
  AND t.description NOT LIKE payer.full_name || '%';

INSERT INTO public._settlement_repair_log
SELECT tx_id, old_payer, old_ower, amount, description, NOW() FROM _swap;

-- Swap payer and debtor.
UPDATE public.transaction_splits s
SET user_id = w.old_payer
FROM _swap w
WHERE s.transaction_id = w.tx_id;

UPDATE public.transactions t
SET paid_by = w.old_ower
FROM _swap w
WHERE t.id = w.tx_id;

COMMIT;

-- Rebuild every balance from the corrected rows.
SELECT * FROM public.admin_rebuild_all_settlements();

-- Confirm the repair.
SELECT COUNT(*) AS rows_repaired FROM public._settlement_repair_log;

*/


-- ---------------------------------------------------------------------------
-- 4. SEPARATE ISSUE — 3 'pending' expenses worth ₹4172.50 count toward nothing
-- ---------------------------------------------------------------------------
-- Migration 0006 counts only status IN ('active','settled'). I assumed
-- 'pending' was an unused legacy value from the pre-0001 schema; the data says
-- otherwise. None of that ₹4172.50 appears in anyone's balance right now.
SELECT
  t.created_at::date AS date,
  t.amount,
  payer.full_name    AS paid_by,
  t.description
FROM public.transactions t
LEFT JOIN public.users payer ON payer.id = t.paid_by
WHERE t.status = 'pending'
ORDER BY t.created_at DESC;
--
-- Ordinary expenses that predate the 'active' convention should count:
--     UPDATE public.transactions SET status = 'active' WHERE status = 'pending';
--     SELECT * FROM public.admin_rebuild_all_settlements();
-- Drafts or abandoned entries should stay excluded.
