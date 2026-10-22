-- Kinlo · 0068 · close three relationship gaps found in the 22 Oct public-repo audit
--
-- All three were confirmed against the live policies before writing this.
--
-- 1. Direct writes to the ledger tables. transactions_insert allowed any row
--    with paid_by = auth.uid() and never checked group_id, so a signed-in user
--    could REST-insert an expense into a group they are not in, then plant
--    splits for that group's members (can_write_transaction is true for the
--    payer). The app never writes these tables directly: every write goes
--    through SECURITY DEFINER RPCs owned by postgres (record_expense,
--    record_settlement, void_transaction, claim_placeholder,
--    anonymize_my_account), which validate membership and relationships and
--    are unaffected by client-role grants. So the client roles lose
--    INSERT/UPDATE/DELETE/TRUNCATE outright; SELECT and RLS are unchanged.
--
-- 2. One-way friendships with anyone. friendships_insert only checked
--    user_id = auth.uid(); friend_id could be any UUID. is_friend_of() is
--    mutual, so one inserted row made the target's whole users row readable
--    (phone, UPI id, push token) and let record_expense name them on a 1-on-1
--    expense (it accepts any is_friend_of participant), creating debts they
--    never agreed to.
--
-- 3. Adding anyone to a group. group_members_insert let any member add any
--    UUID, and create_group (SECURITY DEFINER, so RLS does not apply inside
--    it) added whatever p_member_ids it was given. A group membership grants
--    shares_group_with(), i.e. the same profile visibility as gap 2.
--
-- The fix for 2 and 3 is one rule, can_connect_with(target): you may link to
-- someone only if they are you, a placeholder you created, someone you are
-- already connected with (friend / shared group / shared expense), or a
-- registered user you found by phone number. That last case is what the app's
-- two add-friend flows do (AddFriendModal -> resolve_user_by_phone, Friends
-- screen -> match_contacts_by_phone), so both lookups now record what they
-- returned in phone_lookup_hits. Every member picker in the app is built from
-- getRelatedUsers(), which is exactly the "already connected" set, so no
-- client change is needed.
--
-- Existing friendships and memberships are left as they are.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Ledger tables: client roles read only
-- ---------------------------------------------------------------------------
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.transactions       FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.transaction_splits FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.transaction_payers FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Phone lookups: who has found whom
-- ---------------------------------------------------------------------------
-- Written only by the two lookup RPCs below (SECURITY DEFINER). No client
-- grants at all: nobody reads or writes it directly.
CREATE TABLE IF NOT EXISTS public.phone_lookup_hits (
  caller_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  found_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (caller_id, target_id)
);
ALTER TABLE public.phone_lookup_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.phone_lookup_hits FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- can_connect_with: the one rule behind gaps 2 and 3
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_connect_with(p_target UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT auth.uid() IS NOT NULL
     AND p_target IS NOT NULL
     AND (
          p_target = auth.uid()
       OR EXISTS (SELECT 1 FROM public.users u
                  WHERE u.id = p_target AND u.is_placeholder AND u.created_by = auth.uid())
       OR public.is_friend_of(p_target)
       OR public.shares_group_with(p_target)
       OR public.shares_transaction_with(p_target)
       OR EXISTS (SELECT 1 FROM public.phone_lookup_hits h
                  WHERE h.caller_id = auth.uid() AND h.target_id = p_target)
     );
$$;
REVOKE ALL ON FUNCTION public.can_connect_with(UUID) FROM PUBLIC, anon;
-- RLS policies evaluate as the caller, so authenticated needs EXECUTE.
GRANT EXECUTE ON FUNCTION public.can_connect_with(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Friendships
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS friendships_insert ON public.friendships;
CREATE POLICY friendships_insert ON public.friendships
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.can_connect_with(friend_id));

-- ---------------------------------------------------------------------------
-- 3. Group members (table path and create_group)
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS group_members_insert ON public.group_members;
CREATE POLICY group_members_insert ON public.group_members
  FOR INSERT TO authenticated
  WITH CHECK (
    (
      public.is_group_member(group_id)
      OR EXISTS (SELECT 1 FROM public.groups g
                 WHERE g.id = group_members.group_id AND g.created_by = auth.uid())
    )
    AND public.can_connect_with(user_id)
  );

-- Body identical to the live version except for the member check.
CREATE OR REPLACE FUNCTION public.create_group(p_group_id uuid, p_title text, p_category text, p_member_ids uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  me UUID := auth.uid();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'an idempotency key is required';
  END IF;
  IF p_title IS NULL OR btrim(p_title) = '' THEN
    RAISE EXCEPTION 'a group name is required';
  END IF;

  -- 0068: only people you are connected with. RLS does not apply inside a
  -- SECURITY DEFINER function, so the group_members_insert policy alone
  -- would not cover this path.
  IF EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_member_ids, '{}')) AS u
    WHERE NOT public.can_connect_with(u)
  ) THEN
    RAISE EXCEPTION 'you can only add people you are connected with' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.groups (id, title, category, created_by)
  VALUES (p_group_id, btrim(p_title), COALESCE(p_category, 'other'), me)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.group_members (group_id, user_id)
  SELECT p_group_id, u
  FROM unnest(array_append(p_member_ids, me)) AS u
  ON CONFLICT (group_id, user_id) DO NOTHING;
END;
$function$;

-- ---------------------------------------------------------------------------
-- Phone lookups now record what they returned
-- ---------------------------------------------------------------------------
-- Same signatures, return types, rate limits and filters as live (0064/0065);
-- the only addition is the phone_lookup_hits upsert.
CREATE OR REPLACE FUNCTION public.resolve_user_by_phone(phone_suffix text)
 RETURNS TABLE(id uuid, full_name text, phone_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_id    UUID;
  v_name  TEXT;
  v_phone TEXT;
BEGIN
  IF NOT public.hit_rate_limit('phone_lookup', 40, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  SELECT u.id, u.full_name::text, u.phone_number::text
    INTO v_id, v_name, v_phone
  FROM public.users u
  WHERE u.is_placeholder = FALSE
    AND u.id <> auth.uid()
    AND u.phone_number IS NOT NULL
    AND right(regexp_replace(u.phone_number, '\D', '', 'g'), 10) = phone_suffix
  LIMIT 1;

  IF v_id IS NOT NULL THEN
    INSERT INTO public.phone_lookup_hits (caller_id, target_id)
    VALUES (auth.uid(), v_id)
    ON CONFLICT ON CONSTRAINT phone_lookup_hits_pkey DO UPDATE SET found_at = now();

    RETURN QUERY SELECT v_id, v_name, v_phone;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.match_contacts_by_phone(phone_suffixes text[])
 RETURNS TABLE(id uuid, full_name text, avatar_url text, phone_number text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_suffixes TEXT[] := phone_suffixes[1:5000];
  r RECORD;
BEGIN
  IF NOT public.hit_rate_limit('contact_match', 20, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  FOR r IN
    SELECT u.id AS uid, u.full_name::text AS uname, u.avatar_url::text AS uavatar, u.phone_number::text AS uphone
    FROM public.users u
    WHERE u.is_placeholder = FALSE
      AND u.id <> auth.uid()
      AND u.phone_number IS NOT NULL
      AND right(regexp_replace(u.phone_number, '\D', '', 'g'), 10) = ANY(v_suffixes)
      AND NOT public.is_friend_of(u.id)
      AND NOT EXISTS (
        SELECT 1 FROM public.connection_requests cr
        WHERE cr.status = 'pending'
          AND cr.claimant_id = u.id
          AND cr.owner_id = auth.uid()
      )
    LIMIT 200
  LOOP
    INSERT INTO public.phone_lookup_hits (caller_id, target_id)
    VALUES (auth.uid(), r.uid)
    ON CONFLICT ON CONSTRAINT phone_lookup_hits_pkey DO UPDATE SET found_at = now();

    id := r.uid;
    full_name := r.uname;
    avatar_url := r.uavatar;
    phone_number := r.uphone;
    RETURN NEXT;
  END LOOP;
END;
$function$;

COMMIT;

-- VERIFY: see docs/sql/0068_paste_and_verify.sql (preflight, body, checks,
-- and role-simulated tests that roll back).
