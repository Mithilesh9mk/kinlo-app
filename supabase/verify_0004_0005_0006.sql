-- Kinlo · verify migrations 0004-0006 landed correctly
-- Paste into the SQL Editor and run.

-- 1. record_settlement() exists
SELECT proname, pronargs
FROM pg_proc
WHERE proname = 'record_settlement';
-- expect: one row, pronargs = 6

-- 2. the unique index from 0004 exists
SELECT indexname
FROM pg_indexes
WHERE tablename = 'transaction_splits'
  AND indexname = 'transaction_splits_tx_user_uniq';
-- expect: one row

-- 3. the ledger functions now count 'settled' too (0006)
SELECT proname, prosrc ILIKE '%active'', ''settled%' AS includes_settled
FROM pg_proc
WHERE proname IN ('recalculate_group_settlements', 'recalculate_pair_settlements');
-- expect: two rows, both includes_settled = true
