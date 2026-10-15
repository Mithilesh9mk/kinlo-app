-- Kinlo · 0013 · bring undeclared live objects into version control
--
-- WHAT THIS IS FOR
--
-- The Phase 0 baseline audit found that get_group_members() is called by the
-- application but defined in no migration. Capturing it turned up four more
-- functions and two triggers in the same state: alive in production, absent
-- from the repository. Until now a rebuild from migrations/ would have
-- produced a database that compiles but does not work — no signup path, no
-- Groups tab, no automatic RLS on new tables.
--
-- THIS MIGRATION CHANGES NOTHING IN PRODUCTION
--
-- Every definition below is transcribed verbatim from pg_get_functiondef()
-- against the live database on 18 Aug 2026. Applying this file to the current
-- production database is a no-op: CREATE OR REPLACE with an identical body
-- leaves behaviour, signature and existing grants untouched, and both triggers
-- are guarded so an existing one is left alone.
--
-- Its purpose is the other direction — a database built from migrations/ alone
-- now matches production instead of silently lacking these objects.
--
-- NOT INCLUDED, DELIBERATELY
--
--   * Supabase platform event triggers (pgrst_ddl_watch, pgrst_drop_watch,
--     issue_graphql_placeholder, issue_pg_cron_access, issue_pg_net_access,
--     issue_pg_graphql_access). Every Supabase project gets these from the
--     platform; recreating them here would conflict with it.
--   * public._settlement_repair_log. It exists in live as an ad-hoc artifact
--     of the reversed-settlement repair, with no primary key, no foreign keys
--     and no policies. Whether to keep or drop it is a product decision, and
--     writing it into a forward migration would cement it. It is documented in
--     supabase/schema_snapshot.sql instead.
--   * GRANT statements. Supabase's default privileges already grant EXECUTE on
--     every public function to anon, authenticated and service_role, so the
--     live grant state reproduces itself without help. See the warning at the
--     foot of this file — the current grants are NOT what the migrations
--     intend, and correcting that is Phase 1 work, not capture work.
--
-- ---------------------------------------------------------------------------
-- 1 of 5 · get_group_members()
-- ---------------------------------------------------------------------------
-- Called by app/(tabs)/groups.tsx:51 and app/expense/details.tsx:94.
--
-- Enforces its own membership check and raises rather than returning an empty
-- set, so callers can distinguish "not your group" from "empty group". That
-- behaviour is depended upon and is preserved exactly.
--
-- Note it returns full_name as `character varying` because public.users
-- declares it varchar(100). The return type must keep matching the column, or
-- the function fails at runtime with a structure mismatch.

CREATE OR REPLACE FUNCTION public.get_group_members(target_group_id uuid)
 RETURNS TABLE(user_id uuid, full_name character varying, avatar_url text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = target_group_id AND gm.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this group';
  END IF;
  
  RETURN QUERY
    SELECT gm.user_id, u.full_name, u.avatar_url
    FROM public.group_members gm
    JOIN public.users u ON u.id = gm.user_id
    WHERE gm.group_id = target_group_id;
END;
$function$;


-- ---------------------------------------------------------------------------
-- 2 of 5 · handle_new_user()
-- ---------------------------------------------------------------------------
-- The signup path. Fired by on_auth_user_created (section 5 below) whenever
-- Supabase Auth inserts into auth.users, it creates the matching
-- public.users profile row.
--
-- Without this, a new account gets an auth record and no profile, and every
-- screen that joins to public.users fails for that user. It is the single most
-- important object that was missing from the repository.
--
-- ON CONFLICT (id) DO NOTHING makes it safe against a placeholder row that was
-- already created for this person by a friend before they signed up.

CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.users (id, full_name, base_currency, is_verified)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', 'User'),
    'INR',
    false
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$function$;


-- ---------------------------------------------------------------------------
-- 3 of 5 · rls_auto_enable()
-- ---------------------------------------------------------------------------
-- An event-trigger function that force-enables row level security on every
-- table created in the public schema.
--
-- WARNING FOR EVERY FUTURE MIGRATION IN THIS PROJECT: because of this, a
-- migration that runs CREATE TABLE without also creating policies produces a
-- table with RLS on and no policies — which denies all access to anon and
-- authenticated, silently. The table will appear empty rather than error.
-- Any migration that adds a table must add its policies in the same file.
--
-- The exception handler means a failure to enable RLS is logged and swallowed
-- rather than aborting the DDL, so a CREATE TABLE cannot be blocked by it.

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;


-- ---------------------------------------------------------------------------
-- 4 of 5 · get_my_paid_transaction_ids() and get_my_split_transaction_ids()
-- ---------------------------------------------------------------------------
-- ORPHANED. Both exist in live and neither is referenced by any RLS policy or
-- by any line of application code — verified against pg_policies on
-- 18 Aug 2026 and by searching app/, lib/ and context/.
--
-- They are the shape of an RLS-recursion workaround and were almost certainly
-- written during the incident that produced 0008_fix_rls_recursion.sql, then
-- abandoned when user_has_split_in() and can_write_transaction() were adopted
-- instead.
--
-- Captured because they exist, not because they are wanted. Dropping them is a
-- change, and Phase 0.5 does not make changes. Recommended for removal in a
-- later phase once someone has confirmed no external consumer (an edge
-- function, a saved query, a dashboard) calls them.

CREATE OR REPLACE FUNCTION public.get_my_paid_transaction_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT id FROM public.transactions WHERE paid_by = auth.uid();
$function$;

CREATE OR REPLACE FUNCTION public.get_my_split_transaction_ids()
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT transaction_id FROM public.transaction_splits WHERE user_id = auth.uid();
$function$;


-- ---------------------------------------------------------------------------
-- 5 of 5 · the two project triggers
-- ---------------------------------------------------------------------------
-- Both are guarded so that applying this migration to the existing production
-- database leaves the current triggers exactly as they are. On a fresh
-- database they are created.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t
    JOIN pg_class c     ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'auth'
      AND c.relname = 'users'
      AND t.tgname  = 'on_auth_user_created'
      AND NOT t.tgisinternal
  ) THEN
    CREATE TRIGGER on_auth_user_created
      AFTER INSERT ON auth.users
      FOR EACH ROW
      EXECUTE FUNCTION public.handle_new_user();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_event_trigger WHERE evtname = 'ensure_rls'
  ) THEN
    CREATE EVENT TRIGGER ensure_rls
      ON ddl_command_end
      EXECUTE FUNCTION public.rls_auto_enable();
  END IF;
END $$;


-- ===========================================================================
-- KNOWN DEFECT RECORDED HERE, NOT FIXED HERE
-- ===========================================================================
--
-- Captured 18 Aug 2026: every function in the public schema is executable by
-- `anon`, with the single exception of record_settlement(), from which anon
-- was explicitly revoked on 17 Aug 2026.
--
-- That includes admin_rebuild_all_settlements(),
-- admin_rebuild_group_settlements(uuid) and admin_rebuild_pair_settlements(
-- uuid, uuid) — whose own migration, 0007, states in its header that they are
-- "granted to nobody: no PUBLIC, no authenticated, no anon".
--
-- The consequence is materially worse for those three than for the rest.
-- Every other RPC opens with `IF me IS NULL THEN RAISE EXCEPTION
-- 'authentication required'`, so an anon caller is rejected immediately. 0007
-- deliberately omits that guard, because the admin functions receive every
-- identity as an explicit argument and perform no membership check at all. An
-- unauthenticated caller can therefore run admin_rebuild_all_settlements(),
-- which loops every group and every 1-on-1 pair in the database, as often as
-- it likes.
--
-- Data integrity is not at risk: these functions recompute the ledger from
-- transactions and produce the correct result. The exposure is availability,
-- plus a security boundary the repository claims and does not have.
--
-- ROOT CAUSE: `REVOKE ALL ON FUNCTION ... FROM PUBLIC`, the idiom used by
-- every migration in this project, does not remove the separate explicit grant
-- that Supabase's default privileges give to `anon` at function-creation time.
-- Only `REVOKE ... FROM anon` removes it.
--
-- The fix belongs in a forward migration of its own, alongside the same sweep
-- for record_expense(), get_related_users() and the RLS predicate helpers.
-- It is deliberately not performed here: Phase 0.5 captures the baseline
-- without altering it, so that the corrective change is reviewable on its own.
-- ===========================================================================
