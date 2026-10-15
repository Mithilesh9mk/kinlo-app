-- Kinlo · 0024 · finish the anon sweep, remove two dead functions
--
-- Cosmetic hardening plus a small cleanup. Nothing here closes a live hole —
-- 0014 dealt with the one function that was genuinely exposed. This tidies the
-- rest so the schema matches what the migrations have always claimed.
--
-- ---------------------------------------------------------------------------
-- 1 · revoke anon from four client RPCs
-- ---------------------------------------------------------------------------
-- Each already rejects an unauthenticated caller on its own terms:
--
--   recalculate_pair_settlements   raises 'authentication required' when
--                                  auth.uid() is NULL
--   recalculate_group_settlements  raises 'not a member of group %' — is_group_member
--                                  cannot be true for a NULL uid
--   get_related_users              returns no rows, since every branch of its
--                                  UNION compares against auth.uid()
--   get_group_members              raises 'Not a member of this group', same reason
--
-- So this is defence in depth rather than a fix. It matters because every
-- migration in this project has claimed `REVOKE ALL ... FROM PUBLIC` locked
-- these down, and it never did — PUBLIC and anon are separate grantees, and
-- Supabase's default privileges hand anon its own explicit EXECUTE at creation
-- time. See 0014 for the version of this that was actually dangerous.

REVOKE EXECUTE ON FUNCTION public.recalculate_pair_settlements(UUID)  FROM anon;
REVOKE EXECUTE ON FUNCTION public.recalculate_group_settlements(UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_related_users()                 FROM anon;
REVOKE EXECUTE ON FUNCTION public.get_group_members(UUID)             FROM anon;

-- ---------------------------------------------------------------------------
-- 2 · NOT revoked, deliberately
-- ---------------------------------------------------------------------------
-- These six stay callable by anon and that is correct:
--
--   can_write_transaction, is_friend_of, is_group_member,
--   shares_group_with, shares_transaction_with, user_has_split_in
--
-- All six are invoked from inside RLS policies. Postgres checks EXECUTE against
-- the *calling* role while evaluating a policy, so revoking anon would turn an
-- anonymous SELECT into a hard permission error instead of an empty result. The
-- policies themselves are what restrict access; these are just their machinery.
--
-- handle_new_user is fired by the on_auth_user_created trigger on auth.users,
-- not called by any client. rls_auto_enable is an event trigger and runs as
-- whoever issued the DDL, which anon can never be. Both left alone: revoking
-- from a trigger function risks breaking signup for no security gain.

-- ---------------------------------------------------------------------------
-- 3 · drop two orphaned functions
-- ---------------------------------------------------------------------------
--   get_my_paid_transaction_ids()
--   get_my_split_transaction_ids()
--
-- Captured in 0013 because they existed in production and in no migration.
-- Both are the shape of an RLS-recursion workaround and were almost certainly
-- written during the incident behind 0008_fix_rls_recursion.sql, then abandoned
-- when user_has_split_in() and can_write_transaction() were adopted instead.
--
-- Verified unreferenced on 18 Aug 2026:
--   * pg_policies — no policy on any table mentions either
--   * app/, lib/, context/, components/ — no call site
--   * supabase/functions/ — neither edge function calls them
--
-- Re-confirm before running this if any time has passed:
--
--   SELECT tablename, policyname FROM pg_policies
--   WHERE schemaname = 'public'
--     AND (qual || COALESCE(with_check, '')) LIKE '%get_my_%transaction_ids%';
--
-- Expected: zero rows. They are captured in 0013 and in schema_snapshot.sql, so
-- dropping them here is reversible from version control.

DROP FUNCTION IF EXISTS public.get_my_paid_transaction_ids();
DROP FUNCTION IF EXISTS public.get_my_split_transaction_ids();

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT p.oid::regprocedure::text AS signature,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' ORDER BY p.proname;
--
-- Expect 18 rows, not 20. anon should read false for everything except the six
-- RLS predicates, handle_new_user and rls_auto_enable.
