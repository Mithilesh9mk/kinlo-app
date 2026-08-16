SELECT n.nspname AS schema, p.proname, p.pronargs
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname ILIKE '%recalculate%';
