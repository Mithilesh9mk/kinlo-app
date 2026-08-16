-- Kinlo · preflight inspection
--
-- Run this FIRST, against the live project, before applying any migration in
-- supabase/migrations/. The committed supabase_schema.sql is known to be stale
-- (it rejects writes the app makes every day), so the migrations are written to
-- be idempotent and defensive. This script tells you which assumptions hold.
--
--   supabase link --project-ref eassxzvjtttgdmxfgwia
--   supabase db execute --file supabase/preflight.sql
--
-- Or paste into the SQL editor in the dashboard.

\echo '=== 1. Tables present in public ==='
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

\echo '=== 2. Is RLS actually enabled on each table? ==='
SELECT relname AS table_name, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
ORDER BY relname;

\echo '=== 3. Every live policy (THE source of truth, not schema.sql) ==='
SELECT tablename, policyname, cmd, roles, qual AS using_expr, with_check AS check_expr
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd, policyname;

\echo '=== 4. Columns on the tables the migrations touch ==='
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('users','transactions','transaction_splits','friendships',
                     'groups','group_members','simplified_settlements')
ORDER BY table_name, ordinal_position;

\echo '=== 5. CHECK constraints (app writes status=active/voided, type=expense) ==='
SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relnamespace = 'public'::regnamespace AND con.contype = 'c'
ORDER BY rel.relname, con.conname;

\echo '=== 6. Foreign keys — does users.id still require an auth.users row? ==='
\echo '     (AddFriendModal creates placeholder friends with no auth account,'
\echo '      so a hard FK here means those inserts are failing in production.)'
SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relnamespace = 'public'::regnamespace AND con.contype = 'f'
ORDER BY rel.relname, con.conname;

\echo '=== 7. Triggers (0001 expects on_transaction_splits_change to be gone) ==='
SELECT event_object_table AS table_name, trigger_name, action_timing, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;

\echo '=== 8. Data that would violate the tightened policies ==='
-- Rows whose payer is not a member of the group the expense belongs to.
-- These become unmaintainable once 0002 lands: fix or delete them first.
SELECT COUNT(*) AS orphan_payer_rows
FROM public.transactions t
WHERE t.group_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = t.group_id AND gm.user_id = t.paid_by
  );

-- Placeholder users (no matching auth account). Expected to be > 0 if the
-- add-a-friend-by-phone flow has ever been used.
SELECT COUNT(*) AS users_without_auth_account
FROM public.users u
WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id);

\echo '=== 9. Existing status values — 0001 adds a CHECK constraint ==='
\echo '     0001 allows (active, voided, pending, settled, disputed).'
\echo '     ANY other value here makes the ADD CONSTRAINT fail; migrate those'
\echo '     rows first or widen the CHECK in 0001 to match.'
SELECT status, COUNT(*) AS row_count
FROM public.transactions
GROUP BY status
ORDER BY row_count DESC;

-- Same question for type, if the column already exists.
SELECT type, COUNT(*) AS row_count
FROM public.transactions
GROUP BY type
ORDER BY row_count DESC;
