-- Kinlo · 0073 · circle (group) invite links (QR code / shareable link)
--
-- Why: 0072 let two people become friends without a phone number. Circles have
-- the same gap. Today the only way into a circle is for an existing member to
-- pick you from their own friends / connected people (create_group, or a direct
-- group_members insert gated by can_connect_with, 0068). Someone you have just
-- met, or who is not saved in your phone, cannot be added. This adds ONE shared
-- invite token per circle: any member shows it as a QR code or shares it as a
-- link, another signed-in user opens it, sees which circle it is, confirms, and
-- is added as a member by account id. No phone number is involved.
--
-- Who may add members today (read from 0002, 0033, 0035, 0068): ANY member of
-- a circle may add people (group_members_insert: is_group_member(group_id) or
-- groups.created_by, AND can_connect_with(user_id)). Only removal is narrower
-- in the table policy (self, or the creator), and 0035 then opened removal to
-- any member through remove_group_member. Renaming is open to any member too
-- (groups_update_members). Nothing in the schema makes the creator special for
-- ADDING, so letting any member mint and rotate the shared invite does not
-- contradict an existing rule; get_group_invite therefore requires membership
-- only, not creatorship.
--
-- The one existing rule an invite DOES bypass, deliberately: 0068's
-- can_connect_with() ("you may only add people you are already connected to").
-- That rule protects the person being added from being linked to by a
-- stranger who merely knows their UUID. An invite does not have that problem,
-- because the person being added is the one who opens the link and taps
-- confirm; they cannot be added by anyone else's action. The insert happens
-- inside a SECURITY DEFINER function (RLS does not apply) but only for the
-- caller themselves, only for a token a member of that circle minted, never for
-- a placeholder or deleted account, and rate limited. group_members_insert and
-- create_group are untouched.
--
-- Consent model, and what joining means. Joining makes the joiner visible to
-- EVERY member of the circle (shares_group_with() gives users_select_related
-- access to their profile: name, avatar, phone, UPI id) and lets every member
-- include them in circle expenses. So: the token is the consent of a member of
-- the circle (a member chose to share it, and any member can rotate it to kill
-- every copy), and the confirm tap in the app is the joiner's consent. Nothing
-- is created by merely opening a link: preview_group_invite is read-only.
-- Anyone holding a link can see the circle title, category, member count and
-- the inviter's name before joining; that is the intended "who is this from"
-- screen, and it is why the token is long, random and rate limited.
--
-- What a normal member-add does today. group_members has an AFTER INSERT OR
-- DELETE trigger, group_members_emit_event (0032, emit_membership_event), which
-- writes one activity_events row: event_type 'member_added', group_id, subject_id
-- = the added user, actor_id = auth.uid() (falling back to the added user).
-- accept_group_invite does a plain INSERT into group_members, so the same trigger
-- fires identically (actor = subject = the joiner, which is also what happens
-- when anyone adds themselves today); it writes no activity_events row itself,
-- so there is no double entry. The trigger also gives the correct feed entry
-- for free. Other side effects found: none (no balances or settlements are
-- derived from membership; the 0029 guard is BEFORE DELETE only).
--
-- Circles can be deleted (groups_delete_creator, 0002) and there is no archive
-- state. group_invites.group_id is ON DELETE CASCADE, and accept locks the
-- groups row FOR SHARE (same idea as 0072's FOR SHARE on the owner) so a
-- concurrent circle deletion cannot interleave with a join.
--
-- Properties (same hardening as 0072):
--   * public.group_invites has RLS on and NO client grants at all. Clients only
--     ever reach it through the three functions below.
--   * Token = 24 lowercase hex chars (96 bits) from gen_random_uuid(); not
--     guessable, lookups rate limited. Multi-use: one QR can be scanned by many
--     people. Expires after 30 days; get_group_invite hands out a fresh one
--     once less than a day of life is left. Capped at max_uses = 25 joins, so a
--     link forwarded further than intended stops working; the next read by any
--     member then mints a fresh one. Rotating revokes every active token of the
--     circle.
--   * Rate limits (hit_rate_limit, per caller): group_invite_create 30/h (create
--     or rotate only, never a plain read), group_invite_lookup 30/h,
--     group_invite_accept 20/h.
--   * Errors reveal nothing: unknown, revoked, expired, used-up and malformed
--     tokens, and tokens of a deleted circle, are indistinguishable ('invalid' /
--     zero rows).
--   * The creator of a token leaving the circle does not kill the token (it is
--     the circle's token, not the person's); the preview then shows no inviter
--     name. Any remaining member can rotate it.
--
-- Assumptions about the live schema that the repo cannot prove (production has
-- drifted from the committed schema before, see 0030): groups(id, title,
-- category, created_by) and group_members(group_id, user_id). A unique
-- (group_id, user_id) is NOT assumed by this file, even though create_group
-- (0033) relies on ON CONFLICT (group_id, user_id): accept guards with NOT
-- EXISTS under a per-(group, user) advisory lock and also adds ON CONFLICT DO
-- NOTHING (no conflict target), which is harmless if no constraint exists.

BEGIN;

-- ---------------------------------------------------------------------------
-- Table: no client access
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.group_invites (
  token       TEXT PRIMARY KEY,
  group_id    UUID NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  created_by  UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '30 days',
  revoked_at  TIMESTAMPTZ,
  -- A link forwarded further than intended stops working after max_uses new
  -- members; the next member read then gets a fresh token.
  uses        INT NOT NULL DEFAULT 0,
  max_uses    INT NOT NULL DEFAULT 25
);
CREATE INDEX IF NOT EXISTS group_invites_group_id_idx ON public.group_invites (group_id);

ALTER TABLE public.group_invites ENABLE ROW LEVEL SECURITY;
-- Default privileges also hand TRUNCATE/TRIGGER/REFERENCES to authenticated on
-- new tables (see 0062, 0067); ALL covers them. No policies: deny by default.
REVOKE ALL ON public.group_invites FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- get_group_invite: the circle's current token, created if needed (members only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_group_invite(p_group_id UUID, p_rotate BOOLEAN DEFAULT FALSE)
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
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_me AND u.is_placeholder = FALSE AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  -- One token mint at a time per circle, so two taps (or two members) cannot
  -- create two tokens.
  PERFORM pg_advisory_xact_lock(hashtextextended('group_invite:' || p_group_id::text, 0));

  -- Holds off a concurrent circle deletion until this token is decided. A
  -- missing circle is reported exactly like "not a member".
  PERFORM 1 FROM public.groups g WHERE g.id = p_group_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  -- Explicit ids: this is a definer function, so auth.uid() is passed in by
  -- value rather than relying on is_group_member() semantics.
  IF NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = p_group_id AND gm.user_id = v_me
  ) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  IF NOT COALESCE(p_rotate, FALSE) THEN
    SELECT i.token INTO v_token
    FROM public.group_invites i
    WHERE i.group_id = p_group_id
      AND i.revoked_at IS NULL
      AND i.expires_at > now() + INTERVAL '1 day'
      AND i.uses < i.max_uses
    ORDER BY i.created_at DESC
    LIMIT 1;

    IF v_token IS NOT NULL THEN
      RETURN v_token;   -- plain read: no rate-limit hit
    END IF;
  END IF;

  IF NOT public.hit_rate_limit('group_invite_create', 30, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  IF COALESCE(p_rotate, FALSE) THEN
    UPDATE public.group_invites
       SET revoked_at = now()
     WHERE group_id = p_group_id
       AND revoked_at IS NULL
       AND expires_at > now();
  END IF;

  -- Dead tokens are of no use to anyone; keep the table from growing.
  DELETE FROM public.group_invites
   WHERE group_id = p_group_id
     AND (revoked_at < now() - INTERVAL '7 days' OR expires_at < now() - INTERVAL '7 days');

  -- First 12 hex chars of a v4 uuid are all random (the version and variant
  -- nibbles come later), so two of them give a full 96 bits.
  v_token := left(replace(gen_random_uuid()::text, '-', ''), 12)
          || left(replace(gen_random_uuid()::text, '-', ''), 12);
  INSERT INTO public.group_invites (token, group_id, created_by) VALUES (v_token, p_group_id, v_me);
  RETURN v_token;
END;
$$;

-- ---------------------------------------------------------------------------
-- preview_group_invite: which circle is this link for? (read-only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.preview_group_invite(p_token TEXT)
RETURNS TABLE (
  group_id       UUID,
  title          TEXT,
  category       TEXT,
  member_count   INTEGER,
  inviter_name   TEXT,
  already_member BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_me UUID := auth.uid();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hit_rate_limit('group_invite_lookup', 30, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{24}$' THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_me AND u.is_placeholder = FALSE AND u.deleted_at IS NULL) THEN
    RETURN;
  END IF;

  -- Every column below is table-qualified: the OUT names (group_id, title,
  -- category) collide with real column names.
  RETURN QUERY
  SELECT g.id,
         g.title::text,
         g.category::text,
         (SELECT count(*)::int FROM public.group_members m WHERE m.group_id = g.id),
         (SELECT cu.full_name::text
            FROM public.users cu
           WHERE cu.id = i.created_by
             AND cu.deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM public.group_members m2
                         WHERE m2.group_id = i.group_id AND m2.user_id = cu.id)),
         EXISTS (SELECT 1 FROM public.group_members m3
                 WHERE m3.group_id = g.id AND m3.user_id = v_me)
  FROM public.group_invites i
  JOIN public.groups g ON g.id = i.group_id
  WHERE i.token = p_token
    AND i.revoked_at IS NULL
    AND i.expires_at > now()
    AND i.uses < i.max_uses;
END;
$$;

-- ---------------------------------------------------------------------------
-- accept_group_invite: join the token's circle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.accept_group_invite(p_token TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me     UUID := auth.uid();
  v_group  UUID;
  v_tok    TEXT;
  v_title  TEXT;
  v_member BOOLEAN;
  v_rows   INT;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hit_rate_limit('group_invite_accept', 20, INTERVAL '1 hour') THEN
    RETURN json_build_object('ok', false, 'error', 'rate_limited');
  END IF;
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{24}$' THEN
    RETURN json_build_object('ok', false, 'error', 'invalid');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u WHERE u.id = v_me AND u.is_placeholder = FALSE AND u.deleted_at IS NULL) THEN
    RETURN json_build_object('ok', false, 'error', 'not_allowed');
  END IF;

  -- Step 1, no locks: which circle is this token for?
  SELECT i.group_id INTO v_group
  FROM public.group_invites i
  JOIN public.groups g ON g.id = i.group_id
  WHERE i.token = p_token
    AND i.revoked_at IS NULL
    AND i.expires_at > now()
    AND i.uses < i.max_uses;

  IF v_group IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Step 2: lock the circle row first (holds off a concurrent circle deletion
  -- until this join is decided). Lock order is always groups row, then invite
  -- row, which is also the order a deletion cascade takes, so no deadlock.
  PERFORM 1 FROM public.groups g WHERE g.id = v_group FOR SHARE;
  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Step 3: re-read the token under a row lock, so concurrent accepts of one
  -- token cannot overshoot max_uses, and a rotate that just won is honoured.
  SELECT i.token, g.title::text
    INTO v_tok, v_title
  FROM public.group_invites i
  JOIN public.groups g ON g.id = i.group_id
  WHERE i.token = p_token
    AND i.group_id = v_group
    AND i.revoked_at IS NULL
    AND i.expires_at > now()
    AND i.uses < i.max_uses
  FOR UPDATE OF i;

  IF v_tok IS NULL THEN
    RETURN json_build_object('ok', false, 'error', 'invalid');
  END IF;

  -- Serialise per (circle, user) so concurrent accepts by the same person
  -- cannot insert two rows.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'group_member:' || v_group::text || ':' || v_me::text, 0));

  SELECT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = v_group AND gm.user_id = v_me
  ) INTO v_member;

  IF NOT v_member THEN
    -- Fires group_members_emit_event (0032): one 'member_added' activity row,
    -- exactly as for any other member-add.
    INSERT INTO public.group_members (group_id, user_id)
    VALUES (v_group, v_me)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows > 0 THEN
      UPDATE public.group_invites SET uses = uses + 1 WHERE token = p_token;
    END IF;
  END IF;

  RETURN json_build_object(
    'ok', true,
    'group_id', v_group,
    'title', v_title,
    'already_member', v_member
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC alone does not remove anon's default EXECUTE.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.get_group_invite(UUID, BOOLEAN)  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.preview_group_invite(TEXT)       FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.accept_group_invite(TEXT)        FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_group_invite(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.preview_group_invite(TEXT)      TO authenticated;
GRANT EXECUTE ON FUNCTION public.accept_group_invite(TEXT)       TO authenticated;

COMMIT;

-- VERIFY: see docs/sql/0073_paste_and_verify.sql (preflight, body, checks,
-- and role-simulated tests that roll back).
