-- Kinlo · 0043 · three corrections to the 0038/0041/0042 connection flow
--
-- Found by re-reading the shipped code after 0038–0042 were applied. All
-- three are replacements of existing functions (CREATE OR REPLACE) — 0038,
-- 0041 and 0042 are already live and are not edited.
--
-- ---------------------------------------------------------------------------
-- 1. TRIGGER: OLD must not be touched on the INSERT path
-- ---------------------------------------------------------------------------
-- 0041 wrote the guard as one condition:
--
--   IF TG_OP = 'UPDATE' AND OLD.phone_number IS NOT DISTINCT FROM NEW.phone_number
--
-- Postgres does not guarantee short-circuit evaluation of AND, and OLD is
-- not a usable record during an INSERT. If OLD.phone_number is evaluated on
-- the INSERT path it raises — and since this trigger is AFTER INSERT OR
-- UPDATE OF phone_number on public.users, that would break creating a user
-- row at all, i.e. signup. Nesting the check makes OLD unreachable unless
-- the operation genuinely is an UPDATE. Cheap insurance on a critical path.
--
-- ---------------------------------------------------------------------------
-- 2. match_contacts_by_phone must not suggest someone mid-claim
-- ---------------------------------------------------------------------------
-- A reachable deadlock created by our own two features, no user error:
--
--   a. A adds Bob from contacts before Bob joins
--      -> placeholder row + friendships(A -> placeholder)
--   b. Bob signs up with that number -> 0041's trigger creates a request
--   c. A opens Friends. match_contacts_by_phone excludes only
--      is_friend_of(u.id) — and A is friends with the PLACEHOLDER, not with
--      Bob's real account — so real Bob is suggested under "From your
--      contacts"
--   d. A taps Add -> friendships(A -> real Bob)
--   e. Both accept the request -> claim_placeholder's friendship collision
--      check fires (A is friends with both identities) -> merge REFUSED,
--      permanently, with no UI able to resolve the overlap
--
-- Fix (a): don't suggest someone who already has a pending claim on one of
-- your placeholders. Prevention.
--
-- ---------------------------------------------------------------------------
-- 3. claim_placeholder should RESOLVE friendship overlap, not refuse it
-- ---------------------------------------------------------------------------
-- Fix (b), and the cure for anyone already stuck in the state above, since
-- 0038 and 0042 have both been live.
--
-- 0042 refuses ALL collisions. That is right for splits, payers and group
-- membership — those carry money or ordering, and a wrong de-duplication
-- silently corrupts a balance. A friendship row carries NO money: it is a
-- visibility edge. Collapsing two edges into one cannot change any figure,
-- so it is safe to resolve rather than refuse. The money-bearing collision
-- checks are kept exactly as they were.

-- ---------------------------------------------------------------------------
-- 1. Trigger function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_connection_requests_for_phone()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffix TEXT;
BEGIN
  IF NEW.is_placeholder IS DISTINCT FROM FALSE OR NEW.phone_number IS NULL THEN
    RETURN NEW;
  END IF;

  -- Nested so OLD is never referenced during an INSERT (see header).
  IF TG_OP = 'UPDATE' THEN
    IF OLD.phone_number IS NOT DISTINCT FROM NEW.phone_number THEN
      RETURN NEW;
    END IF;
  END IF;

  v_suffix := right(regexp_replace(NEW.phone_number, '\D', '', 'g'), 10);
  IF length(v_suffix) < 10 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.connection_requests (placeholder_id, owner_id, claimant_id)
  SELECT p.id, p.created_by, NEW.id
  FROM public.users p
  WHERE p.is_placeholder = TRUE
    AND p.created_by IS NOT NULL
    AND p.created_by <> NEW.id
    AND p.phone_number IS NOT NULL
    AND right(regexp_replace(p.phone_number, '\D', '', 'g'), 10) = v_suffix
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Suggestion list
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.match_contacts_by_phone(phone_suffixes TEXT[])
RETURNS TABLE (id UUID, full_name TEXT, avatar_url TEXT, phone_number TEXT)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.full_name, u.avatar_url, u.phone_number
  FROM public.users u
  WHERE u.is_placeholder = FALSE
    AND u.id <> auth.uid()
    AND u.phone_number IS NOT NULL
    AND right(regexp_replace(u.phone_number, '\D', '', 'g'), 10) = ANY(phone_suffixes)
    AND NOT public.is_friend_of(u.id)
    -- Adding them directly right now would create the second friendship
    -- edge that makes the pending merge un-runnable. Let the claim resolve
    -- first; on merge they become a friend anyway, because the
    -- placeholder's own friendship edge is re-pointed to their real account.
    AND NOT EXISTS (
      SELECT 1 FROM public.connection_requests cr
      WHERE cr.status = 'pending'
        AND cr.claimant_id = u.id
        AND cr.owner_id = auth.uid()
    )
  LIMIT 200;
$$;

-- ---------------------------------------------------------------------------
-- 3. Merge
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_placeholder(p_request_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req         public.connection_requests%ROWTYPE;
  v_placeholder UUID;
  v_claimant    UUID;
  v_conflict    TEXT;
  r             RECORD;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT * INTO v_req FROM public.connection_requests
  WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That connection request no longer exists';
  END IF;

  IF auth.uid() NOT IN (v_req.owner_id, v_req.claimant_id) THEN
    RAISE EXCEPTION 'That connection request is not yours';
  END IF;

  IF v_req.status = 'merged' THEN
    RETURN;
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'That connection request is no longer open';
  END IF;

  IF v_req.owner_response <> 'accepted' OR v_req.claimant_response <> 'accepted' THEN
    RAISE EXCEPTION 'Both people must accept before the accounts can be connected';
  END IF;

  v_placeholder := v_req.placeholder_id;
  v_claimant    := v_req.claimant_id;

  IF v_placeholder IS NULL THEN
    RAISE EXCEPTION 'That contact has already been connected to an account';
  END IF;

  PERFORM 1 FROM public.users
   WHERE id IN (v_placeholder, v_claimant)
   ORDER BY id
   FOR UPDATE;

  IF NOT EXISTS (
    SELECT 1 FROM public.users WHERE id = v_placeholder AND is_placeholder = TRUE
  ) THEN
    RAISE EXCEPTION 'That contact has already been connected to an account';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.users WHERE id = v_claimant AND is_placeholder = TRUE
  ) THEN
    RAISE EXCEPTION 'A placeholder contact cannot claim another placeholder';
  END IF;

  -- Money-bearing collisions only. The two friendship checks 0042 had here
  -- are gone — they are resolved below instead (see header).
  SELECT CASE
    WHEN EXISTS (
      SELECT 1
      FROM public.transaction_splits a
      JOIN public.transaction_splits b ON b.transaction_id = a.transaction_id
      WHERE a.user_id = v_placeholder AND b.user_id = v_claimant
    ) THEN 'the same expense already lists both this contact and your own account'
    WHEN EXISTS (
      SELECT 1
      FROM public.transaction_payers a
      JOIN public.transaction_payers b ON b.transaction_id = a.transaction_id
      WHERE a.user_id = v_placeholder AND b.user_id = v_claimant
    ) THEN 'the same expense already records both this contact and your own account as payers'
    WHEN EXISTS (
      SELECT 1
      FROM public.group_members a
      JOIN public.group_members b ON b.group_id = a.group_id
      WHERE a.user_id = v_placeholder AND b.user_id = v_claimant
    ) THEN 'you are already a member of a group this contact belongs to'
    ELSE NULL
  END INTO v_conflict;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION
      'These accounts cannot be connected automatically because %. Please resolve that overlap first.',
      v_conflict;
  END IF;

  DELETE FROM public.simplified_settlements
  WHERE debtor_id = v_placeholder OR creditor_id = v_placeholder;

  -- A direct link between the two identities would become a self-friendship.
  DELETE FROM public.friendships
  WHERE (user_id = v_placeholder AND friend_id = v_claimant)
     OR (user_id = v_claimant    AND friend_id = v_placeholder);

  -- Resolve, don't refuse: drop the placeholder-side edge wherever the
  -- claimant already has the equivalent one, so the re-point below cannot
  -- collide with friendships' (user_id, friend_id) primary key. Safe
  -- precisely because a friendship carries no amount.
  DELETE FROM public.friendships f
  WHERE f.friend_id = v_placeholder
    AND EXISTS (
      SELECT 1 FROM public.friendships g
      WHERE g.user_id = f.user_id AND g.friend_id = v_claimant
    );

  DELETE FROM public.friendships f
  WHERE f.user_id = v_placeholder
    AND EXISTS (
      SELECT 1 FROM public.friendships g
      WHERE g.friend_id = f.friend_id AND g.user_id = v_claimant
    );

  -- ON DELETE RESTRICT columns first.
  UPDATE public.transactions       SET paid_by    = v_claimant WHERE paid_by    = v_placeholder;
  UPDATE public.transaction_payers SET user_id    = v_claimant WHERE user_id    = v_placeholder;

  UPDATE public.transaction_splits SET user_id    = v_claimant WHERE user_id    = v_placeholder;
  UPDATE public.group_members      SET user_id    = v_claimant WHERE user_id    = v_placeholder;
  UPDATE public.friendships        SET user_id    = v_claimant WHERE user_id    = v_placeholder;
  UPDATE public.friendships        SET friend_id  = v_claimant WHERE friend_id  = v_placeholder;
  UPDATE public.activity_events    SET actor_id   = v_claimant WHERE actor_id   = v_placeholder;
  UPDATE public.activity_events    SET subject_id = v_claimant WHERE subject_id = v_placeholder;
  UPDATE public.groups             SET created_by = v_claimant WHERE created_by = v_placeholder;
  UPDATE public.users              SET created_by = v_claimant WHERE created_by = v_placeholder;

  UPDATE public.connection_requests
     SET status = 'merged', merged_at = now()
   WHERE id = p_request_id;

  UPDATE public.connection_requests
     SET status = 'cancelled'
   WHERE placeholder_id = v_placeholder
     AND id <> p_request_id
     AND status = 'pending';

  DELETE FROM public.users WHERE id = v_placeholder;

  FOR r IN
    SELECT DISTINCT x.other_id
    FROM (
      SELECT s2.user_id AS other_id
      FROM public.transaction_splits s1
      JOIN public.transactions t        ON t.id = s1.transaction_id AND t.group_id IS NULL
      JOIN public.transaction_splits s2 ON s2.transaction_id = s1.transaction_id
      WHERE s1.user_id = v_claimant AND s2.user_id <> v_claimant
      UNION
      SELECT t.paid_by
      FROM public.transaction_splits s1
      JOIN public.transactions t ON t.id = s1.transaction_id AND t.group_id IS NULL
      WHERE s1.user_id = v_claimant AND t.paid_by <> v_claimant
      UNION
      SELECT s2.user_id
      FROM public.transactions t
      JOIN public.transaction_splits s2 ON s2.transaction_id = t.id
      WHERE t.group_id IS NULL AND t.paid_by = v_claimant AND s2.user_id <> v_claimant
    ) x
    WHERE x.other_id IS NOT NULL
  LOOP
    PERFORM public.admin_rebuild_pair_settlements(v_claimant, r.other_id);
  END LOOP;

  FOR r IN
    SELECT gm.group_id FROM public.group_members gm WHERE gm.user_id = v_claimant
  LOOP
    PERFORM public.admin_rebuild_group_settlements(r.group_id);
  END LOOP;
END;
$$;

-- Re-assert grants: CREATE OR REPLACE preserves them, but Supabase's default
-- privileges hand anon EXECUTE on anything newly created, and REVOKE FROM
-- PUBLIC alone does not take that away.
REVOKE ALL ON FUNCTION public.match_contacts_by_phone(TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.claim_placeholder(UUID)         FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_contacts_by_phone(TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_placeholder(UUID)         TO authenticated;
REVOKE ALL ON FUNCTION public.create_connection_requests_for_phone() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   Trigger body now nests the OLD check:
--     SELECT pg_get_functiondef('public.create_connection_requests_for_phone()'::regprocedure)
--            LIKE '%IF TG_OP = ''UPDATE'' THEN%' AS nested_ok;
--     -> true
--
--   Suggestion list excludes pending claims:
--     SELECT pg_get_functiondef('public.match_contacts_by_phone(text[])'::regprocedure)
--            LIKE '%connection_requests%' AS excludes_pending;
--     -> true
--
--   Merge no longer refuses on friendships:
--     SELECT pg_get_functiondef('public.claim_placeholder(uuid)'::regprocedure)
--            LIKE '%already friends with both%' AS still_refuses;
--     -> false
--
--   Grants unchanged:
--     SELECT has_function_privilege('anon','public.claim_placeholder(uuid)','EXECUTE')          AS anon_claim,
--            has_function_privilege('authenticated','public.claim_placeholder(uuid)','EXECUTE') AS auth_claim;
--     -> false, true
--
-- A function that persists is not a function that runs. Exercise the merge
-- and confirm the reconciliation drift sweep reads 0.00 on every pair.
