-- Kinlo · 0072 · friend invite links (QR code / shareable link)
--
-- Why: today the only ways to link two real accounts are phone lookups
-- (resolve_user_by_phone, match_contacts_by_phone), and can_connect_with()
-- (0068) deliberately allows nothing else for strangers. Someone with no phone
-- number on their profile, or whose friend's number is not saved, has no way to
-- connect. This adds a personal invite token: A shows it as a QR code or shares
-- it as a link, B (signed in) opens it, sees who it is from, confirms, and the
-- two become friends.
--
-- Consent model. The token IS the owner's consent (only A can mint it, A chose
-- to share it, and A can rotate it to kill every copy). The confirm tap in the
-- app is the accepter's consent. Nothing is created by merely opening a link:
-- preview_friend_invite is read-only.
--
-- What an accepted invite is. A normal friendships row (user_id = accepter,
-- friend_id = owner), exactly what AddFriendModal creates after a phone match.
-- is_friend_of() is mutual, so both sides see each other's profile via
-- users_select_related, appear in getRelatedUsers(), pass can_connect_with(),
-- and can record shared expenses with each other (record_expense accepts any
-- is_friend_of participant), exactly as phone-matched friends can today. Nothing
-- else needs to change for an invite-made friendship to behave like any other.
--
-- Why this does not reopen the 0068 gap. 0068 closed "one-way friendship with
-- anyone you can name by UUID". Here the friendships insert happens inside a
-- SECURITY DEFINER function (RLS does not apply), but only for a token the
-- owner minted, only between the caller and that token's owner, never for a
-- placeholder, and rate limited. The friendships_insert policy is untouched.
--
-- Properties:
--   * public.friend_invites has RLS on and NO client grants at all. Clients
--     only ever reach it through the three functions below.
--   * Token = 24 lowercase hex chars (96 bits) from gen_random_uuid(); not
--     guessable, and lookups are rate limited anyway. Multi-use: one QR can be
--     scanned by many friends. Expires after 30 days; get_my_friend_invite
--     hands out a fresh one once less than a day of life is left. Rotating
--     revokes every active token of the owner.
--   * Rate limits (hit_rate_limit, per caller): invite_create 30/h (create or
--     rotate only, never a plain read), invite_lookup 30/h, invite_accept 20/h.
--   * Errors reveal nothing: unknown, revoked, expired and malformed tokens are
--     indistinguishable ('invalid' / zero rows).
--
-- Assumption about the live schema: friendships has (user_id, friend_id,
-- created_at) per 0001/0030. Production has drifted from the committed schema
-- before (0030), so a primary key on (user_id, friend_id) is not assumed:
-- accept_friend_invite guards with NOT EXISTS under a per-pair advisory lock and
-- also adds ON CONFLICT DO NOTHING, which is harmless if no constraint exists.

BEGIN;

-- ---------------------------------------------------------------------------
-- Table: no client access
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.friend_invites (
  token       TEXT PRIMARY KEY,
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',
  revoked_at  TIMESTAMPTZ,
  -- A link forwarded further than intended stops working after max_uses new
  -- friendships; the owner's next read then gets a fresh token.
  uses        INT NOT NULL DEFAULT 0,
  max_uses    INT NOT NULL DEFAULT 25
);
CREATE INDEX IF NOT EXISTS friend_invites_owner_id_idx ON public.friend_invites (owner_id);

ALTER TABLE public.friend_invites ENABLE ROW LEVEL SECURITY;
-- Default privileges also hand TRUNCATE/TRIGGER/REFERENCES to authenticated on
-- new tables (see 0062, 0067); ALL covers them. No policies: deny by default.
REVOKE ALL ON public.friend_invites FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_my_friend_invite: the caller's current token, created if needed
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_my_friend_invite(p_rotate BOOLEAN DEFAULT FALSE)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me    UUID := auth.uid();
  v_token TEXT;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_me AND u.is_placeholder = FALSE AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  -- One token mint at a time per user, so two taps cannot create two tokens.
  PERFORM pg_advisory_xact_lock(hashtextextended('friend_invite:' || v_me::text, 0));

  IF NOT COALESCE(p_rotate, FALSE) THEN
    SELECT i.token INTO v_token
    FROM public.friend_invites i
    WHERE i.owner_id = v_me
      AND i.revoked_at IS NULL
      AND i.expires_at > now() + INTERVAL '1 day'
      AND i.uses < i.max_uses
    ORDER BY i.created_at DESC
    LIMIT 1;

    IF v_token IS NOT NULL THEN
      RETURN v_token;   -- plain read: no rate-limit hit
    END IF;
  END IF;

  IF NOT public.hit_rate_limit('invite_create', 30, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF COALESCE(p_rotate, FALSE) THEN
    UPDATE public.friend_invites
       SET revoked_at = now()
     WHERE owner_id = v_me
       AND revoked_at IS NULL
       AND expires_at > now();
  END IF;

  -- Dead tokens are of no use to anyone; keep the table from growing.
  DELETE FROM public.friend_invites
   WHERE owner_id = v_me
     AND (revoked_at < now() - INTERVAL '7 days' OR expires_at < now() - INTERVAL '7 days');

  -- First 12 hex chars of a v4 uuid are all random (the version and variant
  -- nibbles come later), so two of them give a full 96 bits.
  v_token := left(replace(gen_random_uuid()::text, '-', ''), 12)
          || left(replace(gen_random_uuid()::text, '-', ''), 12);
  INSERT INTO public.friend_invites (token, owner_id) VALUES (v_token, v_me);
  RETURN v_token;
END;
$$;

-- ---------------------------------------------------------------------------
-- preview_friend_invite: who is this link from? (read-only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_friend_invite(p_token TEXT)
RETURNS TABLE (
  owner_id        UUID,
  full_name       TEXT,
  avatar_url      TEXT,
  is_self         BOOLEAN,
  already_friends BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me UUID := auth.uid();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hit_rate_limit('invite_lookup', 30, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{24}$' THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_me AND u.is_placeholder = FALSE AND u.deleted_at IS NULL) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT u.id,
         u.full_name::text,
         u.avatar_url::text,
         (u.id = v_me),
         EXISTS (
           SELECT 1 FROM public.friendships f
           WHERE (f.user_id = v_me AND f.friend_id = u.id)
              OR (f.friend_id = v_me AND f.user_id = u.id)
         )
  FROM public.friend_invites i
  JOIN public.users u ON u.id = i.owner_id
  WHERE i.token = p_token
    AND i.revoked_at IS NULL
    AND i.expires_at > now()
    AND i.uses < i.max_uses
    AND u.is_placeholder = FALSE AND u.deleted_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- accept_friend_invite: become friends with the token's owner
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_friend_invite(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me      UUID := auth.uid();
  v_owner   UUID;
  v_name    TEXT;
  v_friends BOOLEAN;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hit_rate_limit('invite_accept', 20, INTERVAL '1 hour') THEN
    RETURN json_build_object('ok', false, 'error', 'rate_limited');
  END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{24}$' THEN
    RETURN json_build_object('ok', false, 'error', 'invalid');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_me AND u.is_placeholder = FALSE AND u.deleted_at IS NULL) THEN
    RETURN json_build_object('ok', false, 'error', 'not_allowed');
  END IF;

  SELECT i.owner_id, u.full_name::text
    INTO v_owner, v_name
  FROM public.friend_invites i
  JOIN public.users u ON u.id = i.owner_id
  WHERE i.token = p_token
    AND i.revoked_at IS NULL
    AND i.expires_at > now()
    AND i.uses < i.max_uses
    AND u.is_placeholder = FALSE AND u.deleted_at IS NULL
  -- Holds off a concurrent account deletion until this friendship is decided.
  FOR SHARE OF u;

  IF v_owner IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'invalid');
  END IF;
  IF v_owner = v_me THEN
    RETURN json_build_object('ok', false, 'error', 'self');
  END IF;

  -- Serialise per pair (order-independent) so concurrent accepts, or both
  -- people accepting each other's links at once, cannot insert two rows.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'friend_pair:' || (CASE WHEN v_me < v_owner THEN v_me ELSE v_owner END)::text
    || ':' || (CASE WHEN v_me < v_owner THEN v_owner ELSE v_me END)::text, 0));

  SELECT EXISTS (
    SELECT 1 FROM public.friendships f
    WHERE (f.user_id = v_me AND f.friend_id = v_owner)
       OR (f.friend_id = v_me AND f.user_id = v_owner)
  ) INTO v_friends;

  IF NOT v_friends THEN
    INSERT INTO public.friendships (user_id, friend_id)
    VALUES (v_me, v_owner)
    ON CONFLICT DO NOTHING;
    UPDATE public.friend_invites SET uses = uses + 1 WHERE token = p_token;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'friend_id', v_owner,
    'full_name', v_name,
    'already_friends', v_friends
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC alone does not remove anon's default EXECUTE.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_my_friend_invite(BOOLEAN)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.preview_friend_invite(TEXT)    FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_friend_invite(TEXT)     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_friend_invite(BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_friend_invite(TEXT)   TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_friend_invite(TEXT)    TO authenticated;

COMMIT;

-- VERIFY: see docs/sql/0072_paste_and_verify.sql (preflight, body, checks,
-- and role-simulated tests that roll back).
