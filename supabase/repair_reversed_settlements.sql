-- Kinlo · repair settlements stored with the payer reversed
--
-- WHY THE HOME TOTAL LOOKS TOO BIG
--
-- Before migration 0005, settle-up.tsx wrote EVERY settlement with
-- paid_by = the caller, regardless of who actually handed over the money.
-- "paid_by = X, split.user_id = Y" means "Y owes X", so a settlement where
-- the friend paid you back got stored as though YOU paid THEM — which adds
-- to the debt instead of clearing it.
--
-- The status breakdown shows the scale of it:
--     active  expense     15 rows   ₹5134.00
--     active  settlement  10 rows   ₹1340.50
--     settled expense      1 row    ₹  26.50
--     settled settlement   2 rows   ₹ 100.00
--
-- 5134.00 + 26.50 + 1340.50 = ₹6501 — within rounding of the ₹6,400 on Home.
-- The settlements are being ADDED to the debt rather than subtracted from it.
-- 0005 fixed how new settlements are written; these older rows still carry the
-- wrong payer and must be corrected in place.
--
-- Run block 1, READ THE ROWS, and only then decide on block 2.

-- ---------------------------------------------------------------------------
-- 1. Candidates: settlements whose description says the FRIEND paid, but
--    whose paid_by is someone else. Descriptions come from settle-up.tsx:
--      friend paid you  -> "<Name> settled ₹X with You."
--      you paid friend  -> "You settled ₹X ..."
-- ---------------------------------------------------------------------------
SELECT
  t.id,
  t.created_at::date          AS date,
  t.amount,
  payer.full_name             AS currently_recorded_payer,
  debtor.full_name            AS currently_recorded_ower,
  t.description
FROM public.transactions t
JOIN public.transaction_splits s ON s.transaction_id = t.id
LEFT JOIN public.users payer  ON payer.id  = t.paid_by
LEFT JOIN public.users debtor ON debtor.id = s.user_id
WHERE t.type = 'settlement'
  AND t.status IN ('active', 'settled')
  AND t.description NOT LIKE 'You settled%'
ORDER BY t.created_at DESC;

-- Read the output. For each row the description names who actually paid.
-- If `currently_recorded_payer` is NOT that person, the row is reversed.
-- If every row already looks right, STOP — the inflation is coming from
-- something else and block 2 would corrupt correct data.


-- ---------------------------------------------------------------------------
-- 2. THE REPAIR — only run after confirming block 1's rows are genuinely
--    reversed. Swaps payer and debtor on those settlements, then rebuilds
--    every affected balance.
--
--    This rewrites financial history. Take a backup first:
--    Supabase Dashboard -> Database -> Backups, or run block 1 and save the
--    output so the change can be reversed by hand.
-- ---------------------------------------------------------------------------
/*  -- uncomment to run

BEGIN;

-- Snapshot the rows being changed, so the repair can be audited afterwards.
CREATE TABLE IF NOT EXISTS public._settlement_repair_log AS
SELECT
  t.id            AS transaction_id,
  t.paid_by       AS old_paid_by,
  s.user_id       AS old_split_user,
  t.amount,
  t.description,
  NOW()           AS repaired_at
FROM public.transactions t
JOIN public.transaction_splits s ON s.transaction_id = t.id
WHERE t.type = 'settlement'
  AND t.status IN ('active', 'settled')
  AND t.description NOT LIKE 'You settled%'
WITH NO DATA;

INSERT INTO public._settlement_repair_log
SELECT t.id, t.paid_by, s.user_id, t.amount, t.description, NOW()
FROM public.transactions t
JOIN public.transaction_splits s ON s.transaction_id = t.id
WHERE t.type = 'settlement'
  AND t.status IN ('active', 'settled')
  AND t.description NOT LIKE 'You settled%';

-- Swap: the person currently recorded as owing becomes the payer, and vice
-- versa. Done via a temp mapping because both sides change at once.
CREATE TEMP TABLE _swap ON COMMIT DROP AS
SELECT t.id AS tx_id, t.paid_by AS old_payer, s.user_id AS old_ower
FROM public.transactions t
JOIN public.transaction_splits s ON s.transaction_id = t.id
WHERE t.type = 'settlement'
  AND t.status IN ('active', 'settled')
  AND t.description NOT LIKE 'You settled%';

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

*/


-- ---------------------------------------------------------------------------
-- 3. SEPARATE ISSUE — 3 'pending' expenses worth ₹4172.50 count toward
--    nothing right now.
-- ---------------------------------------------------------------------------
-- Migration 0006 counts only status IN ('active','settled'). I assumed
-- 'pending' was an unused legacy value from the pre-0001 schema; your data
-- shows otherwise — there are 3 real expense rows sitting in it, and none of
-- that ₹4172.50 appears in anyone's balance.
--
-- Inspect them before deciding:
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
-- If they are ordinary expenses that predate the 'active' convention, they
-- should count, and the fix is to promote them:
--     UPDATE public.transactions SET status = 'active' WHERE status = 'pending';
--     SELECT * FROM public.admin_rebuild_all_settlements();
-- If they are drafts or abandoned entries, leave them excluded.
