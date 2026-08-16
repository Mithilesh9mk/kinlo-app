-- Read-only, safe to run as one paste.

SELECT 'record_settlement exists' AS check, EXISTS (
  SELECT 1 FROM pg_proc WHERE proname = 'record_settlement'
) AS result
UNION ALL
SELECT 'recalculate_group_settlements exists', EXISTS (
  SELECT 1 FROM pg_proc WHERE proname = 'recalculate_group_settlements'
)
UNION ALL
SELECT 'recalculate_pair_settlements exists', EXISTS (
  SELECT 1 FROM pg_proc WHERE proname = 'recalculate_pair_settlements'
)
UNION ALL
SELECT 'transaction_splits_tx_user_uniq index exists', EXISTS (
  SELECT 1 FROM pg_indexes WHERE indexname = 'transaction_splits_tx_user_uniq'
)
UNION ALL
SELECT 'recalculate_group_settlements includes settled status', EXISTS (
  SELECT 1 FROM pg_proc
  WHERE proname = 'recalculate_group_settlements'
    AND prosrc ILIKE '%active'', ''settled%'
)
UNION ALL
SELECT 'recalculate_pair_settlements includes settled status', EXISTS (
  SELECT 1 FROM pg_proc
  WHERE proname = 'recalculate_pair_settlements'
    AND prosrc ILIKE '%active'', ''settled%'
);
