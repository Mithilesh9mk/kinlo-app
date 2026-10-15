-- Kinlo · 0046 · per-user rate limit for delete-account
--
-- delete-account (supabase/functions/delete-account) had no throttle. Unlike
-- parse-receipt (0045), the risk here isn't shared quota burn — it's a
-- destructive, hard-to-fully-undo action (anonymize_my_account + Storage
-- sweep + auth.admin.deleteUser) with no legitimate reason to be called more
-- than once. A tight 3-calls-per-rolling-1h cap per user: generous enough
-- that a genuine retry after a transient failure (e.g. step 3's
-- auth_delete_failed path, still logged in) isn't blocked, tight enough to
-- stop a scripted loop hammering the flow.
--
-- Separate table from 0045's receipt_parse_attempts, deliberately — that
-- migration's own header already flags this as a different risk shape
-- (cost-per-call vs. destructive-and-idempotent-ish); sharing one counter
-- table across two unrelated limits would couple their windows/limits for
-- no benefit.
--
-- Same shape as 0045 otherwise: SECURITY DEFINER function keyed on
-- auth.uid() internally (never a parameter), atomic upsert, RLS enabled with
-- zero policies so the function is the only way in.

CREATE TABLE public.delete_account_attempts (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count        INT NOT NULL DEFAULT 0
);

ALTER TABLE public.delete_account_attempts ENABLE ROW LEVEL SECURITY;
-- No policies added deliberately: blocks every direct access path for anon
-- and authenticated. The RPC function below is the only way in.

CREATE OR REPLACE FUNCTION public.check_and_increment_delete_account_rate_limit()
RETURNS TABLE (allowed BOOLEAN, remaining INT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit  CONSTANT INT := 3;
  v_window CONSTANT INTERVAL := INTERVAL '1 hour';
  v_count  INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'check_and_increment_delete_account_rate_limit requires an authenticated caller';
  END IF;

  INSERT INTO public.delete_account_attempts AS daa (user_id, window_start, count)
  VALUES (auth.uid(), now(), 1)
  ON CONFLICT (user_id) DO UPDATE SET
    window_start = CASE WHEN daa.window_start <= now() - v_window THEN now() ELSE daa.window_start END,
    count        = CASE WHEN daa.window_start <= now() - v_window THEN 1 ELSE daa.count + 1 END
  RETURNING daa.count INTO v_count;

  RETURN QUERY SELECT (v_count <= v_limit), GREATEST(v_limit - v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_delete_account_rate_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_delete_account_rate_limit() TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'delete_account_attempts';
--   -> true
--
--   SELECT count(*) FROM pg_policies WHERE tablename = 'delete_account_attempts';
--   -> 0
--
--   SELECT proname FROM pg_proc WHERE proname = 'check_and_increment_delete_account_rate_limit';
--   -> one row
--
--   SELECT
--     has_function_privilege('anon', 'public.check_and_increment_delete_account_rate_limit()', 'EXECUTE') AS anon_can_call,
--     has_function_privilege('authenticated', 'public.check_and_increment_delete_account_rate_limit()', 'EXECUTE') AS authenticated_can_call;
--   -> anon_can_call = false, authenticated_can_call = true
--
-- Functional check, as a real logged-in user via supabase-js (not the SQL
-- editor — auth.uid() is NULL there):
--   SELECT * FROM public.check_and_increment_delete_account_rate_limit();
--   -> calls 1-3: allowed = true, remaining 2 -> 1 -> 0
--   -> call 4: allowed = false, remaining = 0
