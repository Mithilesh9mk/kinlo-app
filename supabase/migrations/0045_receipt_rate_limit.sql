-- Kinlo · 0045 · per-user rate limit for parse-receipt
--
-- parse-receipt (supabase/functions/parse-receipt) had no throttle at all:
-- any authenticated user could call it in a tight loop, burning the
-- project's shared Gemini free-tier quota (see that file's header for why
-- Gemini/free-tier was chosen in the first place) and, past the free tier,
-- real money. This closes that gap with a 20-calls-per-rolling-24h cap per
-- user.
--
-- ATOMICITY: the check-and-increment happens in one INSERT ... ON CONFLICT
-- statement, not a SELECT-then-UPDATE from the edge function. Two concurrent
-- calls from the same user hitting this at once cannot both read "19" and
-- both proceed — Postgres serializes the two upserts.
--
-- SECURITY DEFINER, not the edge function's usual "no service role" pattern
-- (see parse-receipt/index.ts header): the function only ever touches the
-- caller's own row (keyed by auth.uid() internally, never a parameter), so
-- there is nothing for a caller to reach outside their own data. RLS on the
-- table itself has no policies at all — direct access from anon/authenticated
-- is fully blocked either way; the function (owned by the migration role,
-- same as the table) is the only path in, same reasoning already used for
-- resolve_user_by_phone (0039) and match_contacts_by_phone (0038).
--
-- Scope: parse-receipt only. delete-account gets its own limiter separately
-- — different risk shape (destructive + idempotent-ish vs. cost-per-call),
-- doesn't belong in the same table.

CREATE TABLE public.receipt_parse_attempts (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  count        INT NOT NULL DEFAULT 0
);

ALTER TABLE public.receipt_parse_attempts ENABLE ROW LEVEL SECURITY;
-- No policies added deliberately: this blocks every direct access path for
-- anon and authenticated. The RPC function below is the only way in.

CREATE OR REPLACE FUNCTION public.check_and_increment_receipt_rate_limit()
RETURNS TABLE (allowed BOOLEAN, remaining INT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit  CONSTANT INT := 20;
  v_window CONSTANT INTERVAL := INTERVAL '1 day';
  v_count  INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'check_and_increment_receipt_rate_limit requires an authenticated caller';
  END IF;

  INSERT INTO public.receipt_parse_attempts AS rpa (user_id, window_start, count)
  VALUES (auth.uid(), now(), 1)
  ON CONFLICT (user_id) DO UPDATE SET
    window_start = CASE WHEN rpa.window_start <= now() - v_window THEN now() ELSE rpa.window_start END,
    count        = CASE WHEN rpa.window_start <= now() - v_window THEN 1 ELSE rpa.count + 1 END
  RETURNING rpa.count INTO v_count;

  RETURN QUERY SELECT (v_count <= v_limit), GREATEST(v_limit - v_count, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_receipt_rate_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_receipt_rate_limit() TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'receipt_parse_attempts';
--   -> true
--
--   SELECT count(*) FROM pg_policies WHERE tablename = 'receipt_parse_attempts';
--   -> 0
--
--   SELECT proname FROM pg_proc WHERE proname = 'check_and_increment_receipt_rate_limit';
--   -> one row
--
--   SELECT
--     has_function_privilege('anon', 'public.check_and_increment_receipt_rate_limit()', 'EXECUTE') AS anon_can_call,
--     has_function_privilege('authenticated', 'public.check_and_increment_receipt_rate_limit()', 'EXECUTE') AS authenticated_can_call;
--   -> anon_can_call = false, authenticated_can_call = true
--
-- Functional check, from the app (auth.uid() is NULL in the SQL editor, same
-- caveat as every other SECURITY DEFINER function here — call it 21x in a
-- row as a real logged-in user via supabase-js, not in the SQL editor):
--   SELECT * FROM public.check_and_increment_receipt_rate_limit();
--   -> calls 1-20: allowed = true, remaining counting down 19 -> 0
--   -> call 21: allowed = false, remaining = 0
