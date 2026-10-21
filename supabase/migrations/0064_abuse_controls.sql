-- Kinlo · 0064 · abuse controls: Gold scan cap, per-device free pool, rate limits
--
-- WHAT THIS CHANGES
--   1. Gold is no longer unlimited: 125 receipt scans per calendar month (IST),
--      the same month boundary the free quota already uses. get_my_plan() now
--      reports scans_limit = 125 for Gold instead of NULL.
--   2. Free-plan scans are ALSO pooled per app install ("device"): a free
--      account can no longer get fresh scans by creating more accounts on the
--      same phone. Pool = DEVICE_FREE_LIMIT (6) free scans per month per
--      install id across all accounts.
--   3. A generic per-user rate limiter (hit_rate_limit) and its use on the
--      three abuse-prone entry points that had none:
--        redeem_coupon          10 attempts / hour   (code guessing)
--        resolve_user_by_phone  40 lookups / hour    (phone-number enumeration)
--        match_contacts_by_phone 20 calls / hour,    (bulk enumeration)
--                               input capped at 5000 numbers
--   4. Coupons are one redemption per code per install, so one phone cannot
--      stack a multi-use code across many accounts.
--
-- HONEST LIMITS — read before relying on this
--   * The "device" id is a random UUID the app generates and keeps. It is sent
--     by the client, so a determined attacker can fake it, and it resets on
--     reinstall / clear-data. It stops casual multi-account farming, not a
--     scripted attacker. A tamper-proof device check needs Play Integrity /
--     App Attest (native build + Google/Apple setup) — not done here.
--   * Sign-up, login and OTP throttling for Supabase Auth itself is configured
--     in the Supabase dashboard (Authentication → Rate Limits / Attack
--     Protection), not in SQL.
--   * A free scan costs about ₹0.07 of AI, so scan farming is a nuisance, not
--     a financial threat; these limits are mostly about keeping it that way.
--
-- COMPATIBILITY / DEPLOY ORDER
--   reserve_receipt_scan() and redeem_coupon() gain an OPTIONAL argument. A
--   zero-/one-argument call (the currently deployed parse-receipt v18 and the
--   current app) still resolves to the new function and behaves as before,
--   minus the device pool. The old overloads are dropped in the same
--   transaction so there is never an ambiguous pair.
--
-- ACCOUNT DELETION: rate_limit_events rows are removed by ON DELETE CASCADE
-- when the auth login is deleted (delete-account function). device_id on
-- receipt_scan_log / coupon_redemptions is a random install id with no
-- personal data.

-- ---------------------------------------------------------------------------
-- 1. Generic per-user rate limiter (internal)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rate_limit_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limit_events_lookup_idx
  ON public.rate_limit_events (user_id, action, created_at DESC);

ALTER TABLE public.rate_limit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_events FROM PUBLIC, anon, authenticated;

-- Returns TRUE and records the hit if the caller is under the limit; FALSE
-- (recording nothing) if they are at it. Callable ONLY from other SECURITY
-- DEFINER functions: clients choose neither the limit nor the window.
CREATE OR REPLACE FUNCTION public.hit_rate_limit(p_action TEXT, p_limit INT, p_window INTERVAL)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid   UUID := auth.uid();
  v_count INT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN FALSE;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text || ':' || p_action, 0));

  -- Keep the table small: anything older than 2 days can never matter (the
  -- longest window used is 1 hour).
  DELETE FROM public.rate_limit_events
   WHERE user_id = v_uid AND created_at < now() - INTERVAL '2 days';

  SELECT count(*)::int INTO v_count
    FROM public.rate_limit_events
   WHERE user_id = v_uid AND action = p_action AND created_at > now() - p_window;

  IF v_count >= p_limit THEN
    RETURN FALSE;
  END IF;

  INSERT INTO public.rate_limit_events (user_id, action) VALUES (v_uid, p_action);
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.hit_rate_limit(TEXT, INT, INTERVAL) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Scan quota: Gold cap + free per-install pool
-- ---------------------------------------------------------------------------
ALTER TABLE public.receipt_scan_log
  ADD COLUMN IF NOT EXISTS device_id TEXT,
  ADD COLUMN IF NOT EXISTS was_gold  BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS receipt_scan_log_device_idx
  ON public.receipt_scan_log (device_id, created_at)
  WHERE device_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.get_my_plan()
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Keep in sync with reserve_receipt_scan().
  v_free_limit  CONSTANT INT := 3;
  v_gold_limit  CONSTANT INT := 125;
  v_uid         UUID := auth.uid();
  v_gold_until  TIMESTAMPTZ;
  v_is_gold     BOOLEAN;
  v_month_start TIMESTAMPTZ :=
    date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  v_used        INT;
BEGIN
  IF v_uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT gold_until INTO v_gold_until FROM public.user_plans WHERE user_id = v_uid;
  v_is_gold := v_gold_until IS NOT NULL AND v_gold_until > now();

  SELECT count(*)::int INTO v_used
  FROM public.receipt_scan_log
  WHERE user_id = v_uid AND created_at >= v_month_start;

  RETURN json_build_object(
    'plan',        CASE WHEN v_is_gold THEN 'gold' ELSE 'free' END,
    'gold_until',  v_gold_until,
    'scans_used',  v_used,
    'scans_limit', CASE WHEN v_is_gold THEN v_gold_limit ELSE v_free_limit END
  );
END;
$$;

DROP FUNCTION IF EXISTS public.reserve_receipt_scan();

-- `used` in the result is the month's count AFTER this call when allowed.
-- `reason` (only when not allowed): 'free_cap' | 'gold_cap' | 'device_limit'.
CREATE OR REPLACE FUNCTION public.reserve_receipt_scan(p_device_id TEXT DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_free_limit         CONSTANT INT := 3;    -- per account per month
  v_gold_limit         CONSTANT INT := 125;  -- per account per month
  v_device_free_limit  CONSTANT INT := 6;    -- free scans per install per month, all accounts
  v_uid         UUID := auth.uid();
  v_device      TEXT := CASE
                          WHEN p_device_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                          THEN lower(p_device_id) ELSE NULL END;
  v_gold_until  TIMESTAMPTZ;
  v_is_gold     BOOLEAN;
  v_month_start TIMESTAMPTZ :=
    date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  v_used        INT;
  v_device_used INT;
  v_scan_id     UUID;
BEGIN
  IF v_uid IS NULL THEN
    RETURN json_build_object('allowed', false, 'scan_id', NULL, 'plan', 'free',
                             'used', 0, 'limit', v_free_limit, 'reason', 'free_cap');
  END IF;

  -- Serialise this user's reservations so two parallel calls cannot both
  -- read "2 used" and both proceed. Lock order is always user, then device.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  IF v_device IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('dev:' || v_device, 0));
  END IF;

  SELECT gold_until INTO v_gold_until FROM public.user_plans WHERE user_id = v_uid;
  v_is_gold := v_gold_until IS NOT NULL AND v_gold_until > now();

  SELECT count(*)::int INTO v_used
  FROM public.receipt_scan_log
  WHERE user_id = v_uid AND created_at >= v_month_start;

  IF v_is_gold THEN
    IF v_used >= v_gold_limit THEN
      RETURN json_build_object('allowed', false, 'scan_id', NULL, 'plan', 'gold',
                               'used', v_used, 'limit', v_gold_limit, 'reason', 'gold_cap');
    END IF;
  ELSE
    IF v_used >= v_free_limit THEN
      RETURN json_build_object('allowed', false, 'scan_id', NULL, 'plan', 'free',
                               'used', v_used, 'limit', v_free_limit, 'reason', 'free_cap');
    END IF;
    IF v_device IS NOT NULL THEN
      SELECT count(*)::int INTO v_device_used
      FROM public.receipt_scan_log
      WHERE device_id = v_device AND NOT was_gold AND created_at >= v_month_start;
      IF v_device_used >= v_device_free_limit THEN
        RETURN json_build_object('allowed', false, 'scan_id', NULL, 'plan', 'free',
                                 'used', v_used, 'limit', v_free_limit, 'reason', 'device_limit');
      END IF;
    END IF;
  END IF;

  INSERT INTO public.receipt_scan_log (user_id, device_id, was_gold)
  VALUES (v_uid, v_device, v_is_gold)
  RETURNING id INTO v_scan_id;

  RETURN json_build_object(
    'allowed', true,
    'scan_id', v_scan_id,
    'plan',    CASE WHEN v_is_gold THEN 'gold' ELSE 'free' END,
    'used',    v_used + 1,
    'limit',   CASE WHEN v_is_gold THEN v_gold_limit ELSE v_free_limit END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_receipt_scan(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_receipt_scan(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Coupons: attempt limit + one redemption per code per install
-- ---------------------------------------------------------------------------
ALTER TABLE public.coupon_redemptions ADD COLUMN IF NOT EXISTS device_id TEXT;
CREATE INDEX IF NOT EXISTS coupon_redemptions_device_idx
  ON public.coupon_redemptions (code, device_id) WHERE device_id IS NOT NULL;

DROP FUNCTION IF EXISTS public.redeem_coupon(TEXT);

CREATE OR REPLACE FUNCTION public.redeem_coupon(p_code TEXT, p_device_id TEXT DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_code       TEXT := upper(btrim(coalesce(p_code, '')));
  v_device     TEXT := CASE
                         WHEN p_device_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                         THEN lower(p_device_id) ELSE NULL END;
  v_coupon     public.coupon_codes%ROWTYPE;
  v_gold_until TIMESTAMPTZ;
BEGIN
  IF v_uid IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'not_signed_in');
  END IF;

  IF NOT public.hit_rate_limit('coupon', 10, INTERVAL '1 hour') THEN
    RETURN json_build_object('ok', false, 'error', 'rate_limited');
  END IF;

  -- Row lock: concurrent redemptions of the same code queue up here, so
  -- redeemed_count cannot be raced past max_redemptions.
  SELECT * INTO v_coupon FROM public.coupon_codes WHERE code = v_code FOR UPDATE;

  IF NOT FOUND OR NOT v_coupon.active THEN
    RETURN json_build_object('ok', false, 'error', 'invalid');
  END IF;
  IF v_coupon.expires_at IS NOT NULL AND v_coupon.expires_at <= now() THEN
    RETURN json_build_object('ok', false, 'error', 'expired');
  END IF;
  IF v_coupon.redeemed_count >= v_coupon.max_redemptions THEN
    RETURN json_build_object('ok', false, 'error', 'used_up');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.coupon_redemptions WHERE code = v_code AND user_id = v_uid
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'already_redeemed');
  END IF;
  IF v_device IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.coupon_redemptions WHERE code = v_code AND device_id = v_device
  ) THEN
    RETURN json_build_object('ok', false, 'error', 'already_redeemed');
  END IF;

  INSERT INTO public.coupon_redemptions (code, user_id, device_id) VALUES (v_code, v_uid, v_device);
  UPDATE public.coupon_codes SET redeemed_count = redeemed_count + 1 WHERE code = v_code;

  -- Extend: stack onto remaining Gold if still active, otherwise start now.
  INSERT INTO public.user_plans AS up (user_id, gold_until, updated_at)
  VALUES (v_uid, now() + v_coupon.gold_days * INTERVAL '1 day', now())
  ON CONFLICT (user_id) DO UPDATE SET
    gold_until = greatest(coalesce(up.gold_until, now()), now())
                 + v_coupon.gold_days * INTERVAL '1 day',
    updated_at = now()
  RETURNING up.gold_until INTO v_gold_until;

  RETURN json_build_object('ok', true, 'gold_until', v_gold_until);
END;
$$;

REVOKE ALL ON FUNCTION public.redeem_coupon(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_coupon(TEXT, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 4. Phone-number lookups: stop enumeration
-- ---------------------------------------------------------------------------
-- Same result shape and same matching rule as 0039 / 0043. They become
-- plpgsql (and match_contacts_by_phone VOLATILE) only because they now write
-- a rate-limit row. A refused call raises 'rate_limited'.
CREATE OR REPLACE FUNCTION public.resolve_user_by_phone(phone_suffix TEXT)
RETURNS TABLE (id UUID, full_name TEXT, phone_number TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.hit_rate_limit('phone_lookup', 40, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT u.id, u.full_name, u.phone_number
  FROM public.users u
  WHERE u.is_placeholder = FALSE
    AND u.id <> auth.uid()
    AND u.phone_number IS NOT NULL
    AND right(regexp_replace(u.phone_number, '\D', '', 'g'), 10) = phone_suffix
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_user_by_phone(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_user_by_phone(TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.match_contacts_by_phone(phone_suffixes TEXT[])
RETURNS TABLE (id UUID, full_name TEXT, avatar_url TEXT, phone_number TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffixes TEXT[] := phone_suffixes[1:5000];
BEGIN
  IF NOT public.hit_rate_limit('contact_match', 20, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT u.id, u.full_name, u.avatar_url, u.phone_number
  FROM public.users u
  WHERE u.is_placeholder = FALSE
    AND u.id <> auth.uid()
    AND u.phone_number IS NOT NULL
    AND right(regexp_replace(u.phone_number, '\D', '', 'g'), 10) = ANY(v_suffixes)
    AND NOT public.is_friend_of(u.id)
    -- Adding them directly right now would create the second friendship
    -- edge that makes the pending merge un-runnable (see 0043).
    AND NOT EXISTS (
      SELECT 1 FROM public.connection_requests cr
      WHERE cr.status = 'pending'
        AND cr.claimant_id = u.id
        AND cr.owner_id = auth.uid()
    )
  LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.match_contacts_by_phone(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_contacts_by_phone(TEXT[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICATION — run after applying and review the output.
-- ---------------------------------------------------------------------------
-- 1) Old overloads gone, new ones present (expect exactly one row each):
--      SELECT proname, pg_get_function_identity_arguments(oid) FROM pg_proc
--       WHERE pronamespace='public'::regnamespace
--         AND proname IN ('reserve_receipt_scan','redeem_coupon','hit_rate_limit');
-- 2) hit_rate_limit NOT executable by clients (expect no anon/authenticated):
--      SELECT grantee FROM information_schema.routine_privileges
--       WHERE routine_name='hit_rate_limit';
-- 3) rate_limit_events: RLS on, no client grants:
--      SELECT relrowsecurity FROM pg_class WHERE oid='public.rate_limit_events'::regclass;
-- 4) Gold limit now numeric (expect 125 for a Gold user, 3 for free): call
--    get_my_plan() as a user (SQL editor: SET LOCAL request.jwt.claims …) or
--    check in the app: Gold screen shows "x of 125".
