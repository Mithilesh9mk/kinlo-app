-- Kinlo · 0063 · store subscription events (RevenueCat → Gold)
--
-- Kinlo Gold will be sold through Google Play / the App Store via RevenueCat.
-- RevenueCat calls the revenuecat-webhook Edge Function on every purchase,
-- renewal, cancellation and refund; the function calls apply_store_event()
-- below, which writes the SAME user_plans.gold_until that coupons already use.
-- So nothing that reads the plan (get_my_plan, reserve_receipt_scan, the app)
-- changes: a store subscriber and a coupon holder are both just "gold_until
-- in the future".
--
-- DESIGN CHOICES
--   * Idempotent: RevenueCat retries and can deliver the same event twice.
--     billing_events.event_id is the primary key; a repeat is a no-op.
--   * Extends, never shortens, on a grant: gold_until = greatest(existing,
--     the store's expiry). A coupon's days are never clobbered by a renewal.
--   * Expiry needs no event: gold_until already equals the end of the paid
--     period, so Gold simply lapses. Only an explicit REFUND revokes
--     (gold_until = now()). A refund also drops any coupon days on the same
--     account — rare, accepted, and noted here so it is not a surprise.
--   * Sanity bounds: an expiry more than 400 days ahead is rejected (a
--     malformed event must not mint years of Gold).
--   * Only service_role may call it. The client roles get nothing, so there
--     is no way for an app user to grant themselves Gold.
--   * No raw payload is stored — only what is needed to audit a grant, which
--     keeps personal data out of this table. Not tied to a foreign key on
--     purpose: deleting an account must never be blocked by billing history.
--
-- ACCOUNT DELETION: billing_events rows hold only the user id (a UUID), the
-- product and dates. Account deletion already removes the auth login; the
-- rows stay as an audit trail and carry no name, phone or email.
--
-- VERIFICATION (run after applying; see bottom of file).

CREATE TABLE IF NOT EXISTS public.billing_events (
  event_id    TEXT PRIMARY KEY,
  user_id     UUID NOT NULL,
  event_type  TEXT NOT NULL,
  product_id  TEXT,
  store       TEXT,
  expires_at  TIMESTAMPTZ,
  revoked     BOOLEAN NOT NULL DEFAULT false,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS billing_events_user_idx ON public.billing_events (user_id, received_at DESC);

ALTER TABLE public.billing_events ENABLE ROW LEVEL SECURITY;
-- No policies: with RLS on and no policy, client roles can read nothing.
REVOKE ALL ON public.billing_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.apply_store_event(
  p_event_id   TEXT,
  p_user_id    UUID,
  p_event_type TEXT,
  p_product_id TEXT,
  p_store      TEXT,
  p_expires_at TIMESTAMPTZ,
  p_revoke     BOOLEAN
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted INT;
  v_until    TIMESTAMPTZ;
BEGIN
  IF p_event_id IS NULL OR length(p_event_id) = 0 OR p_user_id IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'bad_request');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    -- Not recorded, so RevenueCat's retry can succeed once the user exists.
    RETURN json_build_object('ok', false, 'error', 'unknown_user');
  END IF;

  IF NOT p_revoke THEN
    IF p_expires_at IS NULL THEN
      RETURN json_build_object('ok', false, 'error', 'missing_expiry');
    END IF;
    IF p_expires_at > now() + INTERVAL '400 days' THEN
      RETURN json_build_object('ok', false, 'error', 'expiry_out_of_range');
    END IF;
  END IF;

  INSERT INTO public.billing_events
    (event_id, user_id, event_type, product_id, store, expires_at, revoked)
  VALUES
    (p_event_id, p_user_id, p_event_type, p_product_id, p_store, p_expires_at, p_revoke)
  ON CONFLICT (event_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;

  IF v_inserted = 0 THEN
    RETURN json_build_object('ok', true, 'duplicate', true);
  END IF;

  IF p_revoke THEN
    INSERT INTO public.user_plans AS up (user_id, gold_until, updated_at)
    VALUES (p_user_id, now(), now())
    ON CONFLICT (user_id) DO UPDATE
      SET gold_until = least(coalesce(up.gold_until, now()), now()),
          updated_at = now()
    RETURNING up.gold_until INTO v_until;
  ELSE
    INSERT INTO public.user_plans AS up (user_id, gold_until, updated_at)
    VALUES (p_user_id, p_expires_at, now())
    ON CONFLICT (user_id) DO UPDATE
      SET gold_until = greatest(coalesce(up.gold_until, p_expires_at), p_expires_at),
          updated_at = now()
    RETURNING up.gold_until INTO v_until;
  END IF;

  RETURN json_build_object('ok', true, 'duplicate', false, 'gold_until', v_until);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_store_event(TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_store_event(TEXT, UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN)
  TO service_role;

-- ---------------------------------------------------------------------------
-- VERIFICATION — run each after applying and review the output.
-- ---------------------------------------------------------------------------
-- 1) Table exists, RLS on, no client grants (expect: rowsecurity = true; zero
--    rows for anon/authenticated):
--      SELECT relrowsecurity FROM pg_class WHERE oid = 'public.billing_events'::regclass;
--      SELECT grantee, privilege_type FROM information_schema.role_table_grants
--       WHERE table_name = 'billing_events' AND grantee IN ('anon','authenticated');
-- 2) Function is callable ONLY by service_role (expect: only service_role
--    and postgres/owner; NOT anon, authenticated, PUBLIC):
--      SELECT grantee FROM information_schema.routine_privileges
--       WHERE routine_name = 'apply_store_event';
-- 3) Behaviour, as a SQL-editor test with a REAL user id (replace <uid>); run
--    inside BEGIN … ROLLBACK so nothing persists:
--      BEGIN;
--      SELECT public.apply_store_event('t1','<uid>','INITIAL_PURCHASE','kinlo_gold_monthly','PLAY_STORE', now()+interval '30 days', false);
--      SELECT public.apply_store_event('t1','<uid>','INITIAL_PURCHASE','kinlo_gold_monthly','PLAY_STORE', now()+interval '30 days', false); -- expect duplicate:true
--      SELECT gold_until FROM public.user_plans WHERE user_id='<uid>';  -- ~30 days out
--      SELECT public.apply_store_event('t2','<uid>','CANCELLATION','kinlo_gold_monthly','PLAY_STORE', null, true);
--      SELECT gold_until FROM public.user_plans WHERE user_id='<uid>';  -- ≈ now
--      SELECT public.apply_store_event('t3','<uid>','RENEWAL','x','PLAY_STORE', now()+interval '900 days', false); -- expect expiry_out_of_range
--      ROLLBACK;
