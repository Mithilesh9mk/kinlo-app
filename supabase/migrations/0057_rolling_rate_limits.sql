-- Kinlo · 0057 · rate limits stop resetting hard at the window boundary
--
-- Core Functionality Audit 2026-08-31, finding P2 §4.6 "Push rate limiting
-- window shape" (flagged for 0047, with a note to spot-check 0045/0046 —
-- confirmed on inspection: all three share byte-for-byte identical shape).
--
-- THE BUG
--   check_and_increment_{push_notify,receipt,delete_account}_rate_limit all
--   use a TUMBLING window: window_start is set once, the counter climbs
--   until window_start is more than v_window old, then the whole thing
--   resets to 1. A caller who front-loads a window (60 calls at t=0 for
--   push, say) and then bursts again the instant window_start expires
--   (60 more at t=1h+ε) gets up to 2x the stated limit inside a span far
--   shorter than the window itself. The three limits guard different risks
--   (spam volume, Gemini cost, a destructive action) but all share this
--   exposure.
--
-- THE FIX — a sliding-window COUNTER, not a sliding-window LOG
--   An exact rolling window needs one row per request (a log), counted and
--   pruned on every call. That is a bigger, riskier change here: three new
--   tables, and it would immediately re-open the exact gap 0050/0054/0056
--   just closed — those migrations delete rows from the CURRENT
--   single-row-per-user tables on account deletion, and swapping to log
--   tables would need updating anonymize_my_account() a fourth time in as
--   many migrations for the same three tables.
--
--   The sliding-window-counter approximation (the same technique
--   Cloudflare's and Kong's rate limiters use) gets arbitrarily close to a
--   true rolling window with none of that: keep the current bucket's count
--   AND the immediately preceding bucket's count, and weight the previous
--   bucket by how much of it still overlaps the trailing window from now.
--   Worst case at a bucket boundary is smoothly interpolated rather than a
--   hard reset, closing exactly the 2x-burst gap the audit named, with one
--   new column per table and no schema churn to what 0056 just touched.
--
--   estimated_count = current_count + previous_count × (1 − elapsed_fraction)
--   where elapsed_fraction is how far now() sits into the current bucket.
--   A request right after a bucket rolls over (elapsed_fraction ≈ 0) still
--   counts nearly all of the previous bucket's traffic against the limit —
--   exactly the case that let the old tumbling window through.
--
-- Buckets are aligned to epoch-second boundaries of v_window's length
-- (e.g. every exact hour for the two 1-hour limiters), not to each caller's
-- first-ever call — required so "the previous bucket" is the same span for
-- every caller and comparable across rows.

ALTER TABLE public.push_notify_attempts
  ADD COLUMN IF NOT EXISTS prev_count INT NOT NULL DEFAULT 0;
ALTER TABLE public.receipt_parse_attempts
  ADD COLUMN IF NOT EXISTS prev_count INT NOT NULL DEFAULT 0;
ALTER TABLE public.delete_account_attempts
  ADD COLUMN IF NOT EXISTS prev_count INT NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.check_and_increment_push_notify_rate_limit()
RETURNS TABLE(allowed BOOLEAN, remaining INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit            CONSTANT INT := 60;
  v_window           CONSTANT INTERVAL := INTERVAL '1 hour';
  v_window_seconds    NUMERIC := EXTRACT(EPOCH FROM v_window);
  v_epoch             NUMERIC := EXTRACT(EPOCH FROM now());
  v_bucket_start_epoch NUMERIC := FLOOR(v_epoch / v_window_seconds) * v_window_seconds;
  v_cur_bucket        TIMESTAMPTZ := to_timestamp(v_bucket_start_epoch);
  v_elapsed_fraction  NUMERIC := (v_epoch - v_bucket_start_epoch) / v_window_seconds;
  v_count             INT;
  v_prev              INT;
  v_estimate          NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'check_and_increment_push_notify_rate_limit requires an authenticated caller';
  END IF;

  INSERT INTO public.push_notify_attempts AS pna (user_id, window_start, count, prev_count)
  VALUES (auth.uid(), v_cur_bucket, 1, 0)
  ON CONFLICT (user_id) DO UPDATE SET
    window_start = v_cur_bucket,
    count        = CASE
                      WHEN pna.window_start = v_cur_bucket             THEN pna.count + 1
                      WHEN pna.window_start = v_cur_bucket - v_window  THEN 1
                      ELSE 1
                    END,
    prev_count   = CASE
                      WHEN pna.window_start = v_cur_bucket             THEN pna.prev_count
                      WHEN pna.window_start = v_cur_bucket - v_window  THEN pna.count
                      ELSE 0
                    END
  RETURNING pna.count, pna.prev_count INTO v_count, v_prev;

  v_estimate := v_count + v_prev * (1 - v_elapsed_fraction);

  RETURN QUERY SELECT (v_estimate <= v_limit), GREATEST(v_limit - CEIL(v_estimate)::int, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.check_and_increment_receipt_rate_limit()
RETURNS TABLE(allowed BOOLEAN, remaining INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit            CONSTANT INT := 20;
  v_window           CONSTANT INTERVAL := INTERVAL '1 day';
  v_window_seconds    NUMERIC := EXTRACT(EPOCH FROM v_window);
  v_epoch             NUMERIC := EXTRACT(EPOCH FROM now());
  v_bucket_start_epoch NUMERIC := FLOOR(v_epoch / v_window_seconds) * v_window_seconds;
  v_cur_bucket        TIMESTAMPTZ := to_timestamp(v_bucket_start_epoch);
  v_elapsed_fraction  NUMERIC := (v_epoch - v_bucket_start_epoch) / v_window_seconds;
  v_count             INT;
  v_prev              INT;
  v_estimate          NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'check_and_increment_receipt_rate_limit requires an authenticated caller';
  END IF;

  INSERT INTO public.receipt_parse_attempts AS rpa (user_id, window_start, count, prev_count)
  VALUES (auth.uid(), v_cur_bucket, 1, 0)
  ON CONFLICT (user_id) DO UPDATE SET
    window_start = v_cur_bucket,
    count        = CASE
                      WHEN rpa.window_start = v_cur_bucket             THEN rpa.count + 1
                      WHEN rpa.window_start = v_cur_bucket - v_window  THEN 1
                      ELSE 1
                    END,
    prev_count   = CASE
                      WHEN rpa.window_start = v_cur_bucket             THEN rpa.prev_count
                      WHEN rpa.window_start = v_cur_bucket - v_window  THEN rpa.count
                      ELSE 0
                    END
  RETURNING rpa.count, rpa.prev_count INTO v_count, v_prev;

  v_estimate := v_count + v_prev * (1 - v_elapsed_fraction);

  RETURN QUERY SELECT (v_estimate <= v_limit), GREATEST(v_limit - CEIL(v_estimate)::int, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.check_and_increment_delete_account_rate_limit()
RETURNS TABLE(allowed BOOLEAN, remaining INTEGER)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit            CONSTANT INT := 3;
  v_window           CONSTANT INTERVAL := INTERVAL '1 hour';
  v_window_seconds    NUMERIC := EXTRACT(EPOCH FROM v_window);
  v_epoch             NUMERIC := EXTRACT(EPOCH FROM now());
  v_bucket_start_epoch NUMERIC := FLOOR(v_epoch / v_window_seconds) * v_window_seconds;
  v_cur_bucket        TIMESTAMPTZ := to_timestamp(v_bucket_start_epoch);
  v_elapsed_fraction  NUMERIC := (v_epoch - v_bucket_start_epoch) / v_window_seconds;
  v_count             INT;
  v_prev              INT;
  v_estimate          NUMERIC;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'check_and_increment_delete_account_rate_limit requires an authenticated caller';
  END IF;

  INSERT INTO public.delete_account_attempts AS daa (user_id, window_start, count, prev_count)
  VALUES (auth.uid(), v_cur_bucket, 1, 0)
  ON CONFLICT (user_id) DO UPDATE SET
    window_start = v_cur_bucket,
    count        = CASE
                      WHEN daa.window_start = v_cur_bucket             THEN daa.count + 1
                      WHEN daa.window_start = v_cur_bucket - v_window  THEN 1
                      ELSE 1
                    END,
    prev_count   = CASE
                      WHEN daa.window_start = v_cur_bucket             THEN daa.prev_count
                      WHEN daa.window_start = v_cur_bucket - v_window  THEN daa.count
                      ELSE 0
                    END
  RETURNING daa.count, daa.prev_count INTO v_count, v_prev;

  v_estimate := v_count + v_prev * (1 - v_elapsed_fraction);

  RETURN QUERY SELECT (v_estimate <= v_limit), GREATEST(v_limit - CEIL(v_estimate)::int, 0);
END;
$$;

REVOKE ALL ON FUNCTION public.check_and_increment_push_notify_rate_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_push_notify_rate_limit() TO authenticated;
REVOKE ALL ON FUNCTION public.check_and_increment_receipt_rate_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_receipt_rate_limit() TO authenticated;
REVOKE ALL ON FUNCTION public.check_and_increment_delete_account_rate_limit() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_and_increment_delete_account_rate_limit() TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT column_name FROM information_schema.columns
--   WHERE table_schema='public' AND column_name='prev_count'
--     AND table_name IN ('push_notify_attempts','receipt_parse_attempts','delete_account_attempts');
--   -> 3 rows
--
--   SELECT proname, has_function_privilege('anon', oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', oid, 'EXECUTE') AS authed
--   FROM pg_proc WHERE proname IN (
--     'check_and_increment_push_notify_rate_limit',
--     'check_and_increment_receipt_rate_limit',
--     'check_and_increment_delete_account_rate_limit');
--   -> 3 rows, anon=false, authed=true
--
-- Then exercise it as a throwaway user (set_config('request.jwt.claim.sub',
-- ...) — these tables carry no financial data, so a fabricated UUID is
-- fine and does not need the real-group caution 0051 required):
--   call check_and_increment_delete_account_rate_limit() 3 times in a row ->
--   allowed=true,true,true then false on the 4th, matching the old
--   behaviour when called well inside one bucket (no regression for the
--   common case).
--   Manually backdate the row's window_start to simulate landing just after
--   a bucket boundary with a nonzero prev_count, and confirm a 4th call is
--   now refused where the OLD function would have allowed a fresh 3.
--   Clean up the throwaway row after.
