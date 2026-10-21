-- Kinlo · 0067 · recurring_expenses: client roles need only row access
--
-- 0066 granted SELECT/INSERT/UPDATE/DELETE to authenticated, but Supabase's
-- default privileges had also given TRUNCATE, TRIGGER and REFERENCES (the same
-- gap 0062 closed for user_plans). RLS does not govern TRUNCATE, so any signed-in
-- user could have emptied EVERYONE's repeating expenses. Revoke the extras.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON public.recurring_expenses FROM PUBLIC, anon, authenticated;

-- VERIFY:
--   SELECT string_agg(privilege_type, ',' ORDER BY privilege_type) FROM information_schema.role_table_grants
--    WHERE table_name='recurring_expenses' AND grantee='authenticated';   -- DELETE,INSERT,SELECT,UPDATE
--   (and zero rows for anon)
