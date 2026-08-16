-- Run each of these separately and report each result.

-- A. Any index at all with this name, in any schema?
SELECT schemaname, tablename, indexname
FROM pg_indexes
WHERE indexname = 'transaction_splits_tx_user_uniq';

-- B. All indexes currently on transaction_splits, any schema
SELECT schemaname, tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename = 'transaction_splits';

-- C. Does record_settlement's own body reference the table correctly —
--    confirms which schema this database actually uses for it
SELECT n.nspname AS schema, c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relname = 'transaction_splits';
