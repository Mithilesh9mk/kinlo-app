-- Kinlo · 0061 · plans, coupons and the monthly receipt-scan quota
--
-- WHY
--   Receipt scanning (parse-receipt, Gemini) costs real money per call. Free
--   users now get 3 scans per calendar month; Gold users are unlimited. There
--   is no payment gateway, so Gold is granted by redeeming a coupon code.
--   The server is the ONLY authority: the client cannot read coupon codes,
--   cannot write a plan, and cannot write or erase scan history. Every path
--   in is a SECURITY DEFINER function keyed on auth.uid() internally (never a
--   user-id parameter), same reasoning as 0045/0057.
--
--   This is separate from the abuse limiter in 0045/0057
--   (check_and_increment_receipt_rate_limit, 20 / rolling day). That one
--   stays as the anti-abuse floor; this one is the product quota.
--
-- TABLES (all RLS enabled)
--   user_plans         one row per user; gold_until > now() means Gold. The
--                      owner may SELECT their own row; nothing else.
--   coupon_codes       codes stored UPPERCASE. RLS on, NO policies, all
--                      privileges revoked: codes must never be listable.
--   coupon_redemptions one row per (code, user). RLS on, no policies.
--   receipt_scan_log   one row per reserved scan; counted per calendar month.
--                      RLS on, no policies.
--
-- FUNCTIONS (SECURITY DEFINER, search_path = public)
--   get_my_plan()                -> plan, gold_until, scans_used, scans_limit
--   redeem_coupon(p_code)        -> ok / error code; row-locks the coupon so
--                                   concurrent redemptions cannot exceed
--                                   max_redemptions; EXTENDS existing Gold.
--   reserve_receipt_scan()       -> atomic check-and-insert, serialised per
--                                   user with an advisory xact lock.
--   release_receipt_scan(id)     -> refunds a failed scan; only own rows
--                                   younger than 15 minutes, so it cannot be
--                                   used to erase history.
--
-- CALENDAR MONTH is computed in Asia/Kolkata (the app's home timezone):
--   date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'
--   The inner AT TIME ZONE yields a local timestamp, date_trunc cuts it to the
--   1st 00:00 local, the outer AT TIME ZONE converts it back to timestamptz.
--
-- ACCOUNT DELETION: no change needed. user_plans, coupon_redemptions and
--   receipt_scan_log all reference auth.users(id) ON DELETE CASCADE, and
--   supabase/functions/delete-account/index.ts ends with
--   admin.auth.admin.deleteUser(userId), which fires the cascades.
--   coupon_codes holds no user data (redeemed_count is just an integer).
--
-- SEED: one owner coupon, idempotent (ON CONFLICT DO NOTHING).

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.user_plans (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  gold_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_plans_select_own ON public.user_plans
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());
REVOKE INSERT, UPDATE, DELETE ON public.user_plans FROM anon, authenticated;

CREATE TABLE public.coupon_codes (
  code            TEXT PRIMARY KEY,
  gold_days       INT NOT NULL CHECK (gold_days > 0),
  max_redemptions INT NOT NULL DEFAULT 1 CHECK (max_redemptions > 0),
  redeemed_count  INT NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  active          BOOLEAN NOT NULL DEFAULT true,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.coupon_codes ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: no direct client access of any kind.
REVOKE ALL ON public.coupon_codes FROM anon, authenticated;

CREATE TABLE public.coupon_redemptions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL REFERENCES public.coupon_codes(code),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, user_id)
);

ALTER TABLE public.coupon_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.coupon_redemptions FROM anon, authenticated;

CREATE TABLE public.receipt_scan_log (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX receipt_scan_log_user_created_idx
  ON public.receipt_scan_log (user_id, created_at);

ALTER TABLE public.receipt_scan_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.receipt_scan_log FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_my_plan
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_plan()
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Free-tier monthly scan allowance. Keep in sync with reserve_receipt_scan().
  v_free_limit  CONSTANT INT := 3;
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
    'scans_limit', CASE WHEN v_is_gold THEN NULL ELSE v_free_limit END
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- redeem_coupon
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.redeem_coupon(p_code TEXT)
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid        UUID := auth.uid();
  v_code       TEXT := upper(btrim(coalesce(p_code, '')));
  v_coupon     public.coupon_codes%ROWTYPE;
  v_gold_until TIMESTAMPTZ;
BEGIN
  IF v_uid IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'not_signed_in');
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

  INSERT INTO public.coupon_redemptions (code, user_id) VALUES (v_code, v_uid);
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

-- ---------------------------------------------------------------------------
-- reserve_receipt_scan
-- ---------------------------------------------------------------------------
-- `used` in the result is the month's count AFTER this call (so it includes
-- the scan just reserved when allowed = true).
CREATE OR REPLACE FUNCTION public.reserve_receipt_scan()
RETURNS json
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Free-tier monthly scan allowance. Keep in sync with get_my_plan().
  v_free_limit  CONSTANT INT := 3;
  v_uid         UUID := auth.uid();
  v_gold_until  TIMESTAMPTZ;
  v_is_gold     BOOLEAN;
  v_month_start TIMESTAMPTZ :=
    date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata';
  v_used        INT;
  v_scan_id     UUID;
BEGIN
  IF v_uid IS NULL THEN
    RETURN json_build_object('allowed', false, 'scan_id', NULL, 'plan', 'free',
                             'used', 0, 'limit', v_free_limit);
  END IF;

  -- Serialise this user's reservations so two parallel calls cannot both
  -- read "2 used" and both proceed.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));

  SELECT gold_until INTO v_gold_until FROM public.user_plans WHERE user_id = v_uid;
  v_is_gold := v_gold_until IS NOT NULL AND v_gold_until > now();

  SELECT count(*)::int INTO v_used
  FROM public.receipt_scan_log
  WHERE user_id = v_uid AND created_at >= v_month_start;

  IF v_is_gold OR v_used < v_free_limit THEN
    INSERT INTO public.receipt_scan_log (user_id) VALUES (v_uid) RETURNING id INTO v_scan_id;
    RETURN json_build_object(
      'allowed', true,
      'scan_id', v_scan_id,
      'plan',    CASE WHEN v_is_gold THEN 'gold' ELSE 'free' END,
      'used',    v_used + 1,
      'limit',   CASE WHEN v_is_gold THEN NULL ELSE v_free_limit END
    );
  END IF;

  RETURN json_build_object(
    'allowed', false,
    'scan_id', NULL,
    'plan',    'free',
    'used',    v_used,
    'limit',   v_free_limit
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- release_receipt_scan
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.release_receipt_scan(p_scan_id UUID)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN;
  END IF;

  DELETE FROM public.receipt_scan_log
  WHERE id = p_scan_id
    AND user_id = auth.uid()
    AND created_at > now() - INTERVAL '15 minutes';
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_my_plan() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_plan() TO authenticated;
REVOKE ALL ON FUNCTION public.redeem_coupon(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.redeem_coupon(TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.reserve_receipt_scan() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reserve_receipt_scan() TO authenticated;
REVOKE ALL ON FUNCTION public.release_receipt_scan(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_receipt_scan(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- Seed
-- ---------------------------------------------------------------------------
INSERT INTO public.coupon_codes (code, gold_days, max_redemptions, expires_at, active, note)
VALUES ('KINLO-KZZS-RNWX-YTU3', 365, 1, NULL, true, 'owner coupon')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------------
-- VERIFY: see docs/sql/0061_paste_and_verify.sql
-- ---------------------------------------------------------------------------
