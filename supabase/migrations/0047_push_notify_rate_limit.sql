-- Kinlo · 0047 · per-user rate limit for push-notify
--
-- push-notify (supabase/functions/push-notify) had no throttle. Its own
-- authorization is sound (0002_user_isolation's users_select_related
-- decides who the caller may notify — see that function's header), but
-- nothing capped how many TIMES a caller can invoke it. A scripted loop
-- calling it repeatedly against even a single legitimate recipient (e.g. a
-- real group member) is unlimited spam today. 60-calls-per-rolling-1h per
-- caller: generous against real app activity (expense adds, settle-ups,
-- group changes all notify) while still bounding a spam loop.
--
-- Counts CALLS, not recipients-per-call. A single call can already notify
-- many userIds at once (e.g. a whole group) — that fan-out is intentional
-- product behaviour, not what this migration is guarding against.
--
-- Same shape as 0045/0046: separate table (different function, different
-- limit/window, same reasoning as 0045's header for not sharing one
-- counter table across unrelated limits), SECURITY DEFINER function keyed
-- on auth.uid() internally, atomic upsert, RLS enabled with zero policies.

CREATE TABLE public.push_notify_attempts (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count        INT NOT NULL DEFAULT 0
);

ALTER TABLE public.push_notify_attempts ENABLE ROW LEVEL SECURITY;
-- No policies added deliberately: blocks every direct access path for anon
-- and authenticated. The RPC function below is the only way in.

CREATE OR REPLACE FUNCTION public.check_and_increment_push_notify_rate_limit()
RETURNS TABLE (allowed BOOLEAN, remaining INT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit  CONSTANT INT := 60;
  v_window CONSTANT INTERVAL := INTERVAL '1 hour';
  v_count  INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'check_and_increment_push_notify_rate_limit requires an authenticated caller';
  END IF;

  INSERT INTO public.push_notify_attempts AS pna (user_id, window_start, count)
  VALUES (auth.uid(), now(), 1)
  ON CONFLICT (user_id) DO UPDATE SET
    window_start = CASE WHEN pna.window_start <= now() - v_window THEN now() ELSE pna.window_start END,
    count        = CASE WHEN pna.window_start <= now() - v_window THEN 1 ELSE pna.count + 1 END
  RETURNING pna.count INTO v_count;

  RETURN QUERY SELECT (v_count <= v_limit), GREATEST(v_limit - v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_push_notify_rate_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_push_notify_rate_limit() TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'push_notify_attempts';
--   -> true
--
--   SELECT count(*) FROM pg_policies WHERE tablename = 'push_notify_attempts';
--   -> 0
--
--   SELECT proname FROM pg_proc WHERE proname = 'check_and_increment_push_notify_rate_limit';
--   -> one row
--
--   SELECT
--     has_function_privilege('anon', 'public.check_and_increment_push_notify_rate_limit()', 'EXECUTE') AS anon_can_call,
--     has_function_privilege('authenticated', 'public.check_and_increment_push_notify_rate_limit()', 'EXECUTE') AS authenticated_can_call;
--   -> anon_can_call = false, authenticated_can_call = true
--
-- Functional check, as a real logged-in user via supabase-js (not the SQL
-- editor — auth.uid() is NULL there):
--   SELECT * FROM public.check_and_increment_push_notify_rate_limit();
--   -> calls 1-60: allowed = true, remaining counting down 59 -> 0
--   -> call 61: allowed = false, remaining = 0
