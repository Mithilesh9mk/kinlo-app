-- Kinlo · 0062 · tighten client grants on user_plans
--
-- 0061 created user_plans and revoked INSERT/UPDATE/DELETE from the client
-- roles, but Supabase's default privileges had also handed anon and
-- authenticated TRUNCATE, TRIGGER and REFERENCES (and anon SELECT). RLS
-- protects rows, but TRUNCATE is not subject to RLS, so those grants were
-- wider than the design intends: the table is read-only for its owner and
-- written only by redeem_coupon() (SECURITY DEFINER).
--
-- Fix: strip everything from both client roles, then grant back exactly
-- SELECT to authenticated (the user_plans_select_own policy limits that to
-- the caller's own row). anon gets nothing.
--
-- 0061 itself is left as shipped; this is the follow-up.

REVOKE ALL ON public.user_plans FROM anon, authenticated;
GRANT SELECT ON public.user_plans TO authenticated;
