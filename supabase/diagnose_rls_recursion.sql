-- Kinlo · does RLS recurse between transactions and transaction_splits?
--
-- The SQL editor normally runs as an admin role with RLS bypassed, so app
-- failures do not reproduce there. This impersonates a real signed-in user so
-- the same policies the app hits are actually evaluated.
--
-- Replace <YOUR-USER-UUID> below with your own auth user id. Get it with:
--     SELECT id, email FROM auth.users ORDER BY created_at LIMIT 5;

BEGIN;

SET LOCAL role authenticated;
SET LOCAL request.jwt.claims = '{"sub":"<YOUR-USER-UUID>","role":"authenticated"}';

-- This mirrors what the Insights screen and the Statement screen run:
-- transactions with transaction_splits embedded.
SELECT
  t.id,
  t.category,
  t.status,
  t.type,
  s.user_id,
  s.share_amount
FROM public.transactions t
LEFT JOIN public.transaction_splits s ON s.transaction_id = t.id
LIMIT 5;

ROLLBACK;

-- EXPECTED OUTCOMES
--
-- a) "infinite recursion detected in policy for relation ..."
--    -> confirms the diagnosis. transactions_select selects from
--       transaction_splits, and transaction_splits_select selects back from
--       transactions, so Postgres loops. Every screen embedding splits fails:
--       Insights, Statement, the friend timeline. Fix is migration 0008
--       (below) which routes both checks through SECURITY DEFINER helpers,
--       which do not re-trigger RLS.
--
-- b) Rows come back fine
--    -> not recursion. Send me the exact error text shown under "Could not
--       load insights" in the app instead; that message is the real error
--       from PostgREST and will name the actual cause.
--
-- c) "permission denied" / zero rows
--    -> the policies are too strict rather than recursive, which is a
--       different fix.
