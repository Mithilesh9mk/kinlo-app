-- Run each separately, paste each result.

-- 1. record_settlement exists with the right shape
SELECT proname, pronargs
FROM pg_proc
WHERE proname = 'record_settlement';
-- expect: one row, pronargs = 6

-- 2. ledger functions now include 'settled' rows (0006)
SELECT proname, prosrc ILIKE '%active'', ''settled%' AS includes_settled
FROM pg_proc
WHERE proname IN ('recalculate_group_settlements', 'recalculate_pair_settlements');
-- expect: two rows, both includes_settled = true
