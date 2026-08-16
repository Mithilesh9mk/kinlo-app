-- =============================================================================
-- Kinlo · drop legacy/loose RLS policies left over from before the migration
--
-- apply_all_migrations.sql created the correct policies (transactions_insert,
-- transaction_splits_insert, etc.) but Postgres OR-combines every policy on
-- the same table+command, so the OLD loose ones that were already live under
-- different names are still granting access the new ones were meant to deny.
-- This drops exactly those old ones. Nothing here changes app behavior for
-- legitimate use — every dropped policy has a stricter or identical
-- replacement already in place from the previous script.
-- =============================================================================

BEGIN;

-- friendships — old ones are functionally identical to the new ones, just
-- redundant. Dropping to leave one definition per command.
DROP POLICY IF EXISTS "Users can delete their own friendships" ON public.friendships;
DROP POLICY IF EXISTS "Users can insert their own friendships" ON public.friendships;
DROP POLICY IF EXISTS "Users can select their own friendships" ON public.friendships;

-- group_members — gm_insert's WITH CHECK (true) let anyone add anyone to any
-- group. group_members_insert (scoped to existing members or the creator)
-- stays.
DROP POLICY IF EXISTS "gm_delete" ON public.group_members;
DROP POLICY IF EXISTS "gm_insert" ON public.group_members;
DROP POLICY IF EXISTS "gm_select" ON public.group_members;

-- groups — redundant duplicates of groups_insert_own / groups_select_members
-- / groups_update_members.
DROP POLICY IF EXISTS "groups_insert" ON public.groups;
DROP POLICY IF EXISTS "groups_select" ON public.groups;
DROP POLICY IF EXISTS "groups_update" ON public.groups;

-- simplified_settlements — this is the one that matters most: the ledger is
-- meant to be written ONLY by the SECURITY DEFINER RPCs in 0003
-- (recalculate_group_settlements / recalculate_pair_settlements). These three
-- policies let any authenticated user insert/update/delete rows directly —
-- e.g. a debtor deleting the row that says they owe money.
DROP POLICY IF EXISTS "Users can delete simplified_settlements" ON public.simplified_settlements;
DROP POLICY IF EXISTS "Users can insert simplified_settlements" ON public.simplified_settlements;
DROP POLICY IF EXISTS "Users can update simplified_settlements" ON public.simplified_settlements;

-- transaction_splits — ts_insert's WITH CHECK (auth.uid() IS NOT NULL) let
-- any authenticated user attach a split naming any user as a debtor on any
-- transaction. transaction_splits_insert (can_write_transaction) stays.
DROP POLICY IF EXISTS "ts_delete" ON public.transaction_splits;
DROP POLICY IF EXISTS "ts_insert" ON public.transaction_splits;
DROP POLICY IF EXISTS "ts_select" ON public.transaction_splits;

-- transactions — tx_insert's WITH CHECK (auth.uid() IS NOT NULL) is the
-- original phantom-debt hole from the audit, still live under this name.
-- transactions_insert (group-scoped payer rule) stays.
DROP POLICY IF EXISTS "tx_delete" ON public.transactions;
DROP POLICY IF EXISTS "tx_insert" ON public.transactions;
DROP POLICY IF EXISTS "tx_select" ON public.transactions;
DROP POLICY IF EXISTS "tx_update" ON public.transactions;

-- users — redundant duplicates of users_insert_self_or_placeholder / etc.
DROP POLICY IF EXISTS "users_insert" ON public.users;
DROP POLICY IF EXISTS "users_select" ON public.users;
DROP POLICY IF EXISTS "users_update" ON public.users;

COMMIT;

-- =============================================================================
-- Verify: every table+command should now show exactly ONE policy. If any row
-- below has count > 1, something old is still lurking — send me that output.
-- =============================================================================
SELECT tablename, cmd, COUNT(*) AS policy_count, array_agg(policyname) AS policy_names
FROM pg_policies
WHERE schemaname = 'public'
GROUP BY tablename, cmd
ORDER BY tablename, cmd;
