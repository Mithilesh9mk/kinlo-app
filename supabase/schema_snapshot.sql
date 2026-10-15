-- ===========================================================================
-- Kinlo · schema_snapshot.sql
-- Captured 18 Aug 2026 · project eassxzvjtttgdmxfgwia · Postgres 17
-- ===========================================================================
--
-- WHAT THIS IS
--
-- A reconstruction of the live `public` schema, assembled from system-catalog
-- introspection run through the Supabase SQL editor on 18 Aug 2026.
--
-- WHAT THIS IS NOT
--
-- It is NOT the output of `pg_dump` / `supabase db dump`. Neither the Supabase
-- CLI nor pg_dump was available in the capture environment, and the Supabase
-- MCP connection was permission-gated, so the schema was recovered by querying
-- pg_class, pg_attribute, pg_constraint, pg_indexes, pg_policies, pg_proc,
-- pg_trigger and pg_event_trigger and reassembling the DDL by hand.
--
-- Every object below is transcribed from those results. Function bodies are
-- verbatim `pg_get_functiondef` output and have not been reformatted. Table
-- definitions are reassembled from catalog columns, so their *text* differs
-- from whatever DDL originally created them even though the resulting
-- structure is the same.
--
-- Treat this as an accurate structural record and a starting point for
-- provisioning — not as a byte-exact replica of production. Replace it with a
-- real `supabase db dump --schema public` as soon as CLI access is available.
--
-- HOW THIS RELATES TO migrations/
--
-- Migrations 0001–0012 do not create the core tables; they only ALTER them.
-- The tables below pre-date the migration series and existed only in the live
-- database until this file. Where 0001 used CREATE TABLE IF NOT EXISTS against
-- a table that already existed, its declared definition never took effect —
-- this file records what is actually there, which in places differs from what
-- 0001 says. Those differences are listed in docs/Kinlo-Phase05-Baseline-Capture.docx.
--
-- NOT INCLUDED
--
--   * The `auth`, `storage`, `graphql`, `extensions` and other Supabase-managed
--     schemas. Only `public` plus the one project trigger that lives on
--     auth.users is captured.
--   * Supabase platform event triggers (pgrst_ddl_watch, pgrst_drop_watch,
--     issue_graphql_placeholder, issue_pg_cron_access, issue_pg_net_access,
--     issue_pg_graphql_access). These ship with every project and are recreated
--     by the platform; reproducing them here would conflict.
--   * Row data. This is structure only.
--
-- ===========================================================================


-- ===========================================================================
-- SECTION 1 · TABLES
-- ===========================================================================
-- Column types, NOT NULL and DEFAULT are transcribed exactly as reported by
-- pg_attribute / pg_attrdef.

CREATE TABLE IF NOT EXISTS public.users (
  id                              uuid NOT NULL,
  full_name                       character varying(100) NOT NULL,
  avatar_url                      text,
  phone_number                    character varying(15),
  is_verified                     boolean DEFAULT false,
  base_currency                   character varying(3) DEFAULT 'INR'::character varying,
  push_token                      character varying(255),
  upi_address                     character varying(100),
  created_at                      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at                      timestamp with time zone NOT NULL DEFAULT now(),
  require_expense_approval        boolean DEFAULT false,
  require_settlement_confirmation boolean DEFAULT false,
  is_placeholder                  boolean NOT NULL DEFAULT false,
  created_by                      uuid
);
-- NOTE: users.id has NO foreign key to auth.users. Migration 0001 deliberately
-- dropped it so placeholder friends can exist before they ever sign up.
-- NOTE: base_currency exists but is hardcoded to 'INR' at every write site;
-- no multi-currency behaviour is implemented (audit finding M5).
-- NOTE: require_expense_approval / require_settlement_confirmation back the
-- pending-approval flow in app/statement.tsx, which is currently unreachable
-- because record_expense() always writes status='active' (audit finding M6).

CREATE TABLE IF NOT EXISTS public.groups (
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  title          character varying(100) NOT NULL,
  category       character varying(20) NOT NULL,
  total_spending numeric(15,2) NOT NULL DEFAULT 0,
  created_by     uuid,
  created_at     timestamp with time zone NOT NULL DEFAULT now()
);
-- NOTE: total_spending is a stored aggregate with no writer — no trigger
-- maintains it and no application code sets it. It sits at 0. Flagged in the
-- Phase 0.5 report as an independent-balance violation waiting to be read.

CREATE TABLE IF NOT EXISTS public.group_members (
  group_id  uuid NOT NULL,
  user_id   uuid NOT NULL,
  joined_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.friendships (
  user_id    uuid NOT NULL,
  friend_id  uuid NOT NULL,
  created_at timestamp with time zone DEFAULT now()
);
-- NOTE: migration 0001 declares created_at as NOT NULL DEFAULT now() and adds
-- CONSTRAINT friendships_no_self CHECK (user_id <> friend_id). Neither is
-- present in live, because 0001 used CREATE TABLE IF NOT EXISTS against a
-- table that already existed and the whole block was skipped. This file
-- records live, not 0001.

CREATE TABLE IF NOT EXISTS public.transactions (
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  amount                 numeric(15,2) NOT NULL,
  description            character varying(255) NOT NULL,
  category               character varying(20) NOT NULL,
  paid_by                uuid NOT NULL,
  group_id               uuid,
  split_type             character varying(10) DEFAULT 'equal'::character varying,
  status                 character varying(20) DEFAULT 'active'::character varying,
  created_at             timestamp with time zone NOT NULL DEFAULT now(),
  updated_at             timestamp with time zone NOT NULL DEFAULT now(),
  type                   text NOT NULL DEFAULT 'expense'::text,
  settles_transaction_id uuid
);
-- NOTE: `type` is text in live; migration 0001 declares VARCHAR(20). Divergence.
-- NOTE: `category` is varchar(20), but migration 0010's check permits 1–40
-- characters. The column type wins, so 0010 delivered 20 characters, not 40.
-- NOTE: `updated_at` is NOT maintained — no trigger sets it on UPDATE.
-- NOTE: `description` is varchar(255); settle-up.tsx composes descriptions
-- that embed a prior description plus balance and timestamp, and can overflow.

CREATE TABLE IF NOT EXISTS public.transaction_splits (
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  transaction_id   uuid NOT NULL,
  user_id          uuid NOT NULL,
  share_amount     numeric(15,2) NOT NULL,
  percentage_share numeric(5,2) DEFAULT NULL::numeric
);

CREATE TABLE IF NOT EXISTS public.simplified_settlements (
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  group_id    uuid,
  debtor_id   uuid NOT NULL,
  creditor_id uuid NOT NULL,
  amount      numeric(15,2) NOT NULL,
  updated_at  timestamp with time zone NOT NULL DEFAULT now()
);
-- The materialised ledger. Fully derived: reconstructable at any time from
-- transactions via admin_rebuild_all_settlements().

CREATE TABLE IF NOT EXISTS public._settlement_repair_log (
  transaction_id uuid,
  old_paid_by    uuid,
  old_split_user uuid,
  amount         numeric,
  description    text,
  repaired_at    timestamp with time zone
);
-- UNDECLARED ARTIFACT. Created ad hoc by supabase/repair_reversed_settlements.sql
-- during the reversed-settlement incident. It has no primary key, no foreign
-- keys and no indexes. RLS is enabled on it (by the ensure_rls event trigger)
-- but it has NO policies, so only service_role can read it. It holds a record
-- of past financial repairs. Keep-or-drop is a Phase 1 decision; it is captured
-- here because it exists, not because it is endorsed.


-- ===========================================================================
-- SECTION 2 · CONSTRAINTS
-- ===========================================================================

-- users -------------------------------------------------------------------
ALTER TABLE public.users
  ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE public.users
  ADD CONSTRAINT users_phone_number_key UNIQUE (phone_number);
ALTER TABLE public.users
  ADD CONSTRAINT users_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES public.users(id) ON DELETE SET NULL;

-- groups ------------------------------------------------------------------
ALTER TABLE public.groups
  ADD CONSTRAINT groups_pkey PRIMARY KEY (id);
ALTER TABLE public.groups
  ADD CONSTRAINT groups_category_check
  CHECK (((category)::text = ANY ((ARRAY['trip'::character varying,
                                         'home'::character varying,
                                         'food'::character varying,
                                         'other'::character varying])::text[])));
ALTER TABLE public.groups
  ADD CONSTRAINT groups_created_by_fkey FOREIGN KEY (created_by)
  REFERENCES public.users(id) ON DELETE SET NULL;
-- NOTE: groups_category_check is still a hardcoded whitelist — the same
-- pattern migration 0010 removed from transactions, left in place for groups.

-- group_members -----------------------------------------------------------
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_pkey PRIMARY KEY (group_id, user_id);
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_group_id_fkey FOREIGN KEY (group_id)
  REFERENCES public.groups(id) ON DELETE CASCADE;
ALTER TABLE public.group_members
  ADD CONSTRAINT group_members_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES public.users(id) ON DELETE CASCADE;

-- friendships -------------------------------------------------------------
ALTER TABLE public.friendships
  ADD CONSTRAINT friendships_pkey PRIMARY KEY (user_id, friend_id);
ALTER TABLE public.friendships
  ADD CONSTRAINT friendships_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.friendships
  ADD CONSTRAINT friendships_friend_id_fkey FOREIGN KEY (friend_id)
  REFERENCES public.users(id) ON DELETE CASCADE;

-- transactions ------------------------------------------------------------
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_category_check
  CHECK (((category IS NULL)
       OR ((char_length(btrim((category)::text)) >= 1)
       AND (char_length(btrim((category)::text)) <= 40))));
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (((status)::text = ANY ((ARRAY['active'::character varying,
                                       'voided'::character varying,
                                       'pending'::character varying,
                                       'settled'::character varying,
                                       'disputed'::character varying])::text[])));
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check
  CHECK ((type = ANY (ARRAY['expense'::text, 'settlement'::text])));
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_paid_by_fkey FOREIGN KEY (paid_by)
  REFERENCES public.users(id) ON DELETE RESTRICT;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_group_id_fkey FOREIGN KEY (group_id)
  REFERENCES public.groups(id) ON DELETE CASCADE;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_settles_transaction_id_fkey
  FOREIGN KEY (settles_transaction_id)
  REFERENCES public.transactions(id) ON DELETE SET NULL;
-- NOTE: paid_by is ON DELETE RESTRICT — a user who has ever paid cannot be
-- deleted. Relevant to member removal (audit finding M7).

-- transaction_splits ------------------------------------------------------
ALTER TABLE public.transaction_splits
  ADD CONSTRAINT transaction_splits_pkey PRIMARY KEY (id);
ALTER TABLE public.transaction_splits
  ADD CONSTRAINT transaction_splits_share_amount_check
  CHECK ((share_amount >= (0)::numeric));
ALTER TABLE public.transaction_splits
  ADD CONSTRAINT transaction_splits_transaction_id_user_id_key
  UNIQUE (transaction_id, user_id);
ALTER TABLE public.transaction_splits
  ADD CONSTRAINT transaction_splits_transaction_id_fkey FOREIGN KEY (transaction_id)
  REFERENCES public.transactions(id) ON DELETE CASCADE;
ALTER TABLE public.transaction_splits
  ADD CONSTRAINT transaction_splits_user_id_fkey FOREIGN KEY (user_id)
  REFERENCES public.users(id) ON DELETE CASCADE;

-- simplified_settlements --------------------------------------------------
ALTER TABLE public.simplified_settlements
  ADD CONSTRAINT simplified_settlements_pkey PRIMARY KEY (id);
ALTER TABLE public.simplified_settlements
  ADD CONSTRAINT simplified_settlements_amount_check CHECK ((amount > (0)::numeric));
ALTER TABLE public.simplified_settlements
  ADD CONSTRAINT simplified_settlements_group_id_debtor_id_creditor_id_key
  UNIQUE (group_id, debtor_id, creditor_id);
ALTER TABLE public.simplified_settlements
  ADD CONSTRAINT simplified_settlements_debtor_id_fkey FOREIGN KEY (debtor_id)
  REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.simplified_settlements
  ADD CONSTRAINT simplified_settlements_creditor_id_fkey FOREIGN KEY (creditor_id)
  REFERENCES public.users(id) ON DELETE CASCADE;
ALTER TABLE public.simplified_settlements
  ADD CONSTRAINT simplified_settlements_group_id_fkey FOREIGN KEY (group_id)
  REFERENCES public.groups(id) ON DELETE CASCADE;

-- _settlement_repair_log has no constraints of any kind.


-- ===========================================================================
-- SECTION 3 · INDEXES
-- ===========================================================================
-- Constraint-backed indexes (…_pkey, …_key) are created by SECTION 2 and are
-- not repeated here. Only standalone indexes appear below.

CREATE INDEX IF NOT EXISTS friendships_friend_id_idx
  ON public.friendships USING btree (friend_id);

CREATE INDEX IF NOT EXISTS transactions_group_status_idx
  ON public.transactions USING btree (group_id, status);

CREATE INDEX IF NOT EXISTS transactions_paid_by_idx
  ON public.transactions USING btree (paid_by);

CREATE INDEX IF NOT EXISTS transactions_settles_idx
  ON public.transactions USING btree (settles_transaction_id)
  WHERE (settles_transaction_id IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS transaction_splits_tx_user_uniq
  ON public.transaction_splits USING btree (transaction_id, user_id);
-- NOTE: duplicates transaction_splits_transaction_id_user_id_key exactly.
-- Both exist in live. Harmless, but doubles index maintenance on split writes.

CREATE INDEX IF NOT EXISTS simplified_settlements_debtor_idx
  ON public.simplified_settlements USING btree (debtor_id);

CREATE INDEX IF NOT EXISTS simplified_settlements_creditor_idx
  ON public.simplified_settlements USING btree (creditor_id);

-- ABSENT IN LIVE, DECLARED IN migrations/0003_settlements_rpc.sql:26 ---------
--
--   CREATE UNIQUE INDEX IF NOT EXISTS simplified_settlements_pair_uniq
--     ON public.simplified_settlements (debtor_id, creditor_id)
--     WHERE group_id IS NULL;
--
-- This index does not exist in the live database. 0003 claims to create it;
-- it never persisted — the same silent-failure pattern that hit 0004's index
-- and 0006's functions. Deliberately left commented out here: reinstating it
-- is a corrective change, and Phase 0.5 captures only. Without it nothing
-- structurally prevents duplicate 1-on-1 ledger rows, because the table's
-- UNIQUE (group_id, debtor_id, creditor_id) does not constrain NULL group_ids.
-- The invariant currently holds only because recalculate_pair_settlements()
-- deletes before it inserts.


-- ===========================================================================
-- SECTION 4 · FUNCTIONS
-- ===========================================================================
-- Bodies below are verbatim pg_get_functiondef() output.
--
-- Functions already defined by migrations 0002–0012 are NOT repeated here —
-- those files are their source of truth. This section carries only the five
-- functions that exist in live and in no migration. They are also captured in
-- migrations/0013_capture_undeclared_objects.sql so a fresh provision from the
-- migration series alone is complete.
--
--   get_group_members            actively used by the app
--   handle_new_user              signup path, fired by a trigger on auth.users
--   rls_auto_enable              event trigger, force-enables RLS on new tables
--   get_my_paid_transaction_ids  ORPHANED — no policy or code references it
--   get_my_split_transaction_ids ORPHANED — no policy or code references it

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


-- ===========================================================================
-- SECTION 5 · TRIGGERS
-- ===========================================================================

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

CREATE EVENT TRIGGER ensure_rls
  ON ddl_command_end
  EXECUTE FUNCTION public.rls_auto_enable();
-- WARNING FOR FUTURE MIGRATIONS: this fires on every CREATE TABLE in public
-- and force-enables RLS on the new table. A migration that creates a table
-- without also creating policies produces a table nothing can read. This will
-- bite the H1 multi-payer work.

-- No triggers exist on any public table. In particular nothing maintains
-- transactions.updated_at, users.updated_at or groups.total_spending.


-- ===========================================================================
-- SECTION 6 · ROW LEVEL SECURITY
-- ===========================================================================

ALTER TABLE public.users                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.groups                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.group_members           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.friendships             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_splits      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.simplified_settlements  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public._settlement_repair_log  ENABLE ROW LEVEL SECURITY;

-- users -------------------------------------------------------------------
CREATE POLICY users_select_related ON public.users FOR SELECT
  USING ((id = auth.uid()) OR (created_by = auth.uid())
         OR shares_group_with(id) OR is_friend_of(id) OR shares_transaction_with(id));

CREATE POLICY users_insert_self_or_placeholder ON public.users FOR INSERT
  WITH CHECK ((id = auth.uid())
              OR ((auth.uid() IS NOT NULL) AND (is_placeholder = true)
                  AND (created_by = auth.uid())));

CREATE POLICY users_update_self_or_placeholder ON public.users FOR UPDATE
  USING ((id = auth.uid()) OR ((is_placeholder = true) AND (created_by = auth.uid())))
  WITH CHECK ((id = auth.uid()) OR ((is_placeholder = true) AND (created_by = auth.uid())));

-- groups ------------------------------------------------------------------
CREATE POLICY groups_select_members ON public.groups FOR SELECT
  USING (is_group_member(id) OR (created_by = auth.uid()));

CREATE POLICY groups_insert_own ON public.groups FOR INSERT
  WITH CHECK (created_by = auth.uid());

CREATE POLICY groups_update_members ON public.groups FOR UPDATE
  USING (is_group_member(id))
  WITH CHECK (is_group_member(id));

CREATE POLICY groups_delete_creator ON public.groups FOR DELETE
  USING (created_by = auth.uid());

-- group_members -----------------------------------------------------------
CREATE POLICY group_members_select ON public.group_members FOR SELECT
  USING (is_group_member(group_id));

CREATE POLICY group_members_insert ON public.group_members FOR INSERT
  WITH CHECK (is_group_member(group_id)
              OR (EXISTS (SELECT 1 FROM public.groups g
                          WHERE g.id = group_members.group_id
                            AND g.created_by = auth.uid())));

CREATE POLICY group_members_delete ON public.group_members FOR DELETE
  USING ((user_id = auth.uid())
         OR (EXISTS (SELECT 1 FROM public.groups g
                     WHERE g.id = group_members.group_id
                       AND g.created_by = auth.uid())));

-- friendships -------------------------------------------------------------
CREATE POLICY friendships_select ON public.friendships FOR SELECT
  USING ((user_id = auth.uid()) OR (friend_id = auth.uid()));

CREATE POLICY friendships_insert ON public.friendships FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY friendships_delete ON public.friendships FOR DELETE
  USING ((user_id = auth.uid()) OR (friend_id = auth.uid()));

-- transactions ------------------------------------------------------------
CREATE POLICY transactions_select ON public.transactions FOR SELECT
  USING ((paid_by = auth.uid())
         OR ((group_id IS NOT NULL) AND is_group_member(group_id))
         OR user_has_split_in(id));

CREATE POLICY transactions_insert ON public.transactions FOR INSERT
  WITH CHECK ((auth.uid() = paid_by)
              OR ((group_id IS NOT NULL) AND is_group_member(group_id)
                  AND (EXISTS (SELECT 1 FROM public.group_members gm
                               WHERE gm.group_id = transactions.group_id
                                 AND gm.user_id = transactions.paid_by))));

CREATE POLICY transactions_update ON public.transactions FOR UPDATE
  USING ((paid_by = auth.uid())
         OR ((group_id IS NOT NULL) AND is_group_member(group_id)))
  WITH CHECK ((auth.uid() = paid_by)
              OR ((group_id IS NOT NULL) AND is_group_member(group_id)
                  AND (EXISTS (SELECT 1 FROM public.group_members gm
                               WHERE gm.group_id = transactions.group_id
                                 AND gm.user_id = transactions.paid_by))));

CREATE POLICY transactions_delete ON public.transactions FOR DELETE
  USING (paid_by = auth.uid());
-- NOTE: hard DELETE is permitted for the payer. The app voids instead, but
-- the policy leaves the audit trail deletable.

-- transaction_splits ------------------------------------------------------
CREATE POLICY transaction_splits_select ON public.transaction_splits FOR SELECT
  USING ((user_id = auth.uid()) OR can_write_transaction(transaction_id));

CREATE POLICY transaction_splits_insert ON public.transaction_splits FOR INSERT
  WITH CHECK (can_write_transaction(transaction_id));

CREATE POLICY transaction_splits_update ON public.transaction_splits FOR UPDATE
  USING (can_write_transaction(transaction_id))
  WITH CHECK (can_write_transaction(transaction_id));

CREATE POLICY transaction_splits_delete ON public.transaction_splits FOR DELETE
  USING (can_write_transaction(transaction_id));

-- simplified_settlements --------------------------------------------------
CREATE POLICY simplified_settlements_select ON public.simplified_settlements FOR SELECT
  USING ((debtor_id = auth.uid()) OR (creditor_id = auth.uid())
         OR ((group_id IS NOT NULL) AND is_group_member(group_id)));
-- Read-only to clients by design. There are no INSERT/UPDATE/DELETE policies:
-- the ledger is written exclusively by SECURITY DEFINER functions.

-- _settlement_repair_log --------------------------------------------------
-- RLS is enabled (by the ensure_rls event trigger) and there are NO policies,
-- so the table is unreachable by anon and authenticated. Only service_role and
-- superuser connections can read it. Recorded as-is.

-- All policies above are defined for role `public` (i.e. no TO clause), which
-- is how they exist in live.


-- ===========================================================================
-- SECTION 7 · GRANTS
-- ===========================================================================
--
-- No GRANT statements are emitted by this file, deliberately.
--
-- On a Supabase project, `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT
-- EXECUTE ON FUNCTIONS TO anon, authenticated, service_role` is in force. Every
-- function created in public therefore receives EXECUTE for all three roles
-- automatically, with no GRANT written anywhere. Re-running this file on a
-- fresh project reproduces the live grant state without any help from us.
--
-- LIVE GRANT STATE AS CAPTURED 18 Aug 2026 — every public function is
-- executable by anon, authenticated and service_role, with exactly one
-- exception: record_settlement(), from which anon was explicitly revoked on
-- 17 Aug 2026.
--
-- THIS IS NOT WHAT THE MIGRATIONS INTEND. 0007's header states its three
-- admin_rebuild_* functions are "granted to nobody: no PUBLIC, no
-- authenticated, no anon". They are in fact executable by anon. Those
-- functions deliberately omit the `auth.uid() IS NULL` guard that protects
-- every other RPC, because they take all identities as explicit arguments.
-- An unauthenticated caller can therefore invoke
-- admin_rebuild_all_settlements(), which iterates every group and every pair
-- in the database.
--
-- The cause is that `REVOKE ALL ON FUNCTION ... FROM PUBLIC` — the idiom used
-- by every migration in this project — does not remove the separate, explicit
-- grant that default privileges hand to anon. Only `REVOKE ... FROM anon`
-- does.
--
-- Corrective REVOKEs are NOT included here. Phase 0.5 captures the baseline;
-- it does not change it. This is recorded as the first item of Phase 1.
-- ===========================================================================


-- ===========================================================================
-- END OF SNAPSHOT
--
-- Objects captured:   8 tables · 34 constraints · 7 standalone indexes
--                     5 undeclared functions · 2 project triggers
--                     19 RLS policies across 7 tables
-- Objects referenced
-- but not repeated:   14 functions defined by migrations 0002–0012
-- Known incomplete:   see docs/Kinlo-Phase05-Baseline-Capture.docx, Section D
-- ===========================================================================
