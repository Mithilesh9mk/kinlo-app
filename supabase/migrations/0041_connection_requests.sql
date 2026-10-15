-- Kinlo · 0041 · connection requests between a placeholder and a real account
--
-- When A adds an off-app friend, AddFriendModal creates a placeholder row
-- (is_placeholder = TRUE, created_by = A) and every expense A records
-- against that friend points at it. When that friend later installs Kinlo
-- and signs up, nothing today connects the two — they get an unrelated
-- account and A's history stays stranded on the placeholder.
--
-- This table is the handshake that connects them. The merge itself lives in
-- 0042; this migration only records who is asking whom, and what each side
-- has answered.
--
-- WHY TWO SEPARATE RESPONSE COLUMNS, NOT ONE
--
-- Phone numbers are never verified at signup — app/onboarding/login.tsx
-- signs users up with email + password and the number is simply typed in.
-- So "whoever signs up with Bob's number inherits Bob's history" would be
-- an impersonation path: a stranger who knows Bob's number could sign up,
-- accept, and take on A's shared ledger and expense history with Bob.
--
-- Requiring BOTH sides to accept closes the practical version of that: A
-- is shown the new account's name and photo and asked "is this the Bob you
-- added?", so a stranger's claim gets rejected by the one person who
-- actually knows Bob. This is defence by human recognition, not by
-- cryptographic proof — it is materially better than one-sided accept, and
-- it is NOT a substitute for real phone verification if that is ever added.
--
-- WHY THERE IS NO UPDATE POLICY
--
-- Deliberate. If clients could UPDATE this table directly, A could simply
-- set claimant_response = 'accepted' themselves and the two-sided check
-- above would be worth nothing. Responses go exclusively through
-- respond_to_connection_request() below, which writes only the column
-- belonging to the caller. Same reasoning as simplified_settlements in
-- 0002: derived//guarded state gets no client write policy at all.
--
-- WHY A TRIGGER CREATES THESE, NOT APP CODE
--
-- Same choice 0032 made for activity events: the trigger fires on any
-- write that sets a real account's phone number, including ones that never
-- pass through the onboarding screen (Profile edit, a direct fix, a future
-- import), so the requests cannot be silently skipped by a code path that
-- forgot to call an RPC.

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.connection_requests (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The placeholder being claimed. SET NULL, deliberately NOT cascade: the
  -- merge in 0042 deletes the placeholder row, and cascading would erase
  -- the very record proving the connection was agreed to. Nulling instead
  -- keeps owner/claimant/status/merged_at as permanent history.
  placeholder_id     UUID REFERENCES public.users(id) ON DELETE SET NULL,
  -- Who created the placeholder (A) — the person who knows the real friend.
  owner_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  -- The real, newly signed-up account claiming to be that friend (Bob).
  claimant_id        UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  owner_response     TEXT NOT NULL DEFAULT 'pending'
                     CHECK (owner_response    IN ('pending','accepted','denied')),
  claimant_response  TEXT NOT NULL DEFAULT 'pending'
                     CHECK (claimant_response IN ('pending','accepted','denied')),
  -- pending  : still awaiting one or both answers
  -- merged   : both accepted and 0042's claim_placeholder() completed
  -- denied   : at least one side said no
  -- cancelled: superseded — the placeholder was claimed by someone else
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','merged','denied','cancelled')),

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at       TIMESTAMPTZ,
  merged_at          TIMESTAMPTZ,

  CONSTRAINT connection_requests_distinct_parties CHECK (owner_id <> claimant_id)
);

-- At most one LIVE request per (placeholder, claimant). Partial on purpose:
-- a denied row must not block a fresh attempt, since either side is allowed
-- to ask again after a refusal.
CREATE UNIQUE INDEX IF NOT EXISTS connection_requests_live_uniq
  ON public.connection_requests (placeholder_id, claimant_id)
  WHERE status = 'pending';

-- Both inbox queries are "my pending requests", one per role.
CREATE INDEX IF NOT EXISTS connection_requests_claimant_pending_idx
  ON public.connection_requests (claimant_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS connection_requests_owner_pending_idx
  ON public.connection_requests (owner_id)    WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- MUST be in the same migration as CREATE TABLE. This project's ensure_rls
-- event trigger force-enables RLS on every new table, and a table with RLS
-- and no policies returns empty rather than erroring — the failure mode 0020
-- documents. Explicit ENABLE anyway so the intent is on the page.
ALTER TABLE public.connection_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS connection_requests_select ON public.connection_requests;

-- Read-only to the two parties. No INSERT policy (the trigger and the
-- reopen RPC are SECURITY DEFINER), no UPDATE policy (see header), no
-- DELETE policy — a request is history and stays.
CREATE POLICY connection_requests_select
  ON public.connection_requests FOR SELECT
  USING (owner_id = auth.uid() OR claimant_id = auth.uid());

-- ---------------------------------------------------------------------------
-- Trigger — create requests when a real account claims a phone number
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_connection_requests_for_phone()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffix TEXT;
BEGIN
  -- Only real accounts trigger a claim. A placeholder gaining a phone
  -- number is just A filling in a detail about their off-app friend.
  IF NEW.is_placeholder IS DISTINCT FROM FALSE OR NEW.phone_number IS NULL THEN
    RETURN NEW;
  END IF;

  -- Don't re-fire when some unrelated column changed.
  -- NOTE: superseded by 0043, which nests this so OLD is never touched on
  -- the INSERT path. Left as-shipped here; this file is already applied.
  IF TG_OP = 'UPDATE' AND OLD.phone_number IS NOT DISTINCT FROM NEW.phone_number THEN
    RETURN NEW;
  END IF;

  -- Same normalization 0038/0039 use: last 10 digits, so a contact saved as
  -- "+91 98765 43210" matches a profile saved as "9876543210". Anything
  -- shorter than a full mobile number is not matched at all rather than
  -- matched loosely.
  v_suffix := right(regexp_replace(NEW.phone_number, '\D', '', 'g'), 10);
  IF length(v_suffix) < 10 THEN
    RETURN NEW;
  END IF;

  -- One request per matching placeholder: several different people may each
  -- have added this same friend, and each of those histories is claimed
  -- separately by its own owner.
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

DROP TRIGGER IF EXISTS users_create_connection_requests ON public.users;
CREATE TRIGGER users_create_connection_requests
  AFTER INSERT OR UPDATE OF phone_number ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.create_connection_requests_for_phone();

-- ---------------------------------------------------------------------------
-- list_connection_requests — the inbox, for whichever side is asking
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER out of necessity, not convenience. The select policy
-- above lets a party read the REQUEST, but rendering it needs the other
-- person's name and photo — and users_select_related (0002) specifically
-- hides that, because the two accounts are not connected yet. That is the
-- exact condition this request exists to resolve, so the display fields
-- have to come through a definer function scoped to the caller's own
-- requests. Returns only name/avatar/phone: enough to recognise a person,
-- nothing more.
--
-- Output columns are deliberately NOT named `id`/`status`/`created_at`.
-- In a RETURNS TABLE function those names are in scope inside the body and
-- collide with the table's own columns; this project has already lost time
-- to a PL/pgSQL name collision that CREATE accepts and only fails at
-- execution.
CREATE OR REPLACE FUNCTION public.list_connection_requests()
RETURNS TABLE (
  request_id       UUID,
  my_role          TEXT,
  request_status   TEXT,
  my_response      TEXT,
  their_response   TEXT,
  other_id         UUID,
  other_name       TEXT,
  other_avatar_url TEXT,
  other_phone      TEXT,
  placeholder_name TEXT,
  requested_at     TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT
    cr.id,
    CASE WHEN cr.owner_id = auth.uid() THEN 'owner' ELSE 'claimant' END,
    cr.status,
    CASE WHEN cr.owner_id = auth.uid() THEN cr.owner_response    ELSE cr.claimant_response END,
    CASE WHEN cr.owner_id = auth.uid() THEN cr.claimant_response ELSE cr.owner_response    END,
    other.id,
    other.full_name::TEXT,
    other.avatar_url::TEXT,
    other.phone_number::TEXT,
    -- What the owner originally saved this person as, so they can recognise
    -- which contact is being claimed.
    ph.full_name::TEXT,
    cr.created_at
  FROM public.connection_requests cr
  JOIN public.users other
    ON other.id = CASE WHEN cr.owner_id = auth.uid() THEN cr.claimant_id ELSE cr.owner_id END
  LEFT JOIN public.users ph ON ph.id = cr.placeholder_id
  WHERE cr.status = 'pending'
    AND auth.uid() IN (cr.owner_id, cr.claimant_id)
  ORDER BY cr.created_at DESC;
$$;

-- ---------------------------------------------------------------------------
-- respond_to_connection_request — the ONLY way a response is recorded
-- ---------------------------------------------------------------------------
-- Writes only the column belonging to the caller, which is what makes the
-- two-sided requirement real rather than decorative. Does NOT perform the
-- merge; it reports whether both sides have now accepted, and the client
-- calls claim_placeholder() (0042) when they have.
-- Output column is `result_status`, not `status`: a RETURNS TABLE column is
-- an in-scope variable inside the body, and this body both reads and writes
-- connection_requests.status. That collision is accepted at CREATE time and
-- only fails when the function actually runs.
CREATE OR REPLACE FUNCTION public.respond_to_connection_request(
  p_request_id UUID,
  p_response   TEXT
)
RETURNS TABLE (result_status TEXT, both_accepted BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req    public.connection_requests%ROWTYPE;
  v_is_owner BOOLEAN;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  IF p_response NOT IN ('accepted','denied') THEN
    RAISE EXCEPTION 'Response must be accepted or denied';
  END IF;

  -- Lock so two simultaneous responses can't both read 'pending' and race.
  SELECT * INTO v_req FROM public.connection_requests
  WHERE id = p_request_id FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That connection request no longer exists';
  END IF;

  IF v_req.status <> 'pending' THEN
    RAISE EXCEPTION 'That connection request has already been resolved';
  END IF;

  IF auth.uid() = v_req.owner_id THEN
    v_is_owner := TRUE;
  ELSIF auth.uid() = v_req.claimant_id THEN
    v_is_owner := FALSE;
  ELSE
    RAISE EXCEPTION 'That connection request is not yours to answer';
  END IF;

  IF v_is_owner THEN
    UPDATE public.connection_requests
       SET owner_response = p_response, responded_at = now()
     WHERE id = p_request_id;
  ELSE
    UPDATE public.connection_requests
       SET claimant_response = p_response, responded_at = now()
     WHERE id = p_request_id;
  END IF;

  -- A single refusal settles it; no point holding the other side waiting.
  UPDATE public.connection_requests
     SET status = 'denied'
   WHERE id = p_request_id
     AND (owner_response = 'denied' OR claimant_response = 'denied');

  SELECT * INTO v_req FROM public.connection_requests WHERE id = p_request_id;

  RETURN QUERY SELECT
    v_req.status,
    (v_req.owner_response = 'accepted' AND v_req.claimant_response = 'accepted');
END;
$$;

-- ---------------------------------------------------------------------------
-- reopen_connection_request — ask again after a refusal
-- ---------------------------------------------------------------------------
-- Creates a FRESH row rather than resetting the denied one, so the refusal
-- stays on the record. Either party may reopen, matching the intent that a
-- request can come from either direction.
CREATE OR REPLACE FUNCTION public.reopen_connection_request(p_request_id UUID)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.connection_requests%ROWTYPE;
  v_new UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in';
  END IF;

  SELECT * INTO v_req FROM public.connection_requests WHERE id = p_request_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'That connection request no longer exists';
  END IF;

  IF auth.uid() NOT IN (v_req.owner_id, v_req.claimant_id) THEN
    RAISE EXCEPTION 'That connection request is not yours';
  END IF;

  IF v_req.status <> 'denied' THEN
    RAISE EXCEPTION 'Only a declined request can be sent again';
  END IF;

  -- The placeholder may have been claimed by someone else in the meantime.
  IF NOT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = v_req.placeholder_id AND is_placeholder = TRUE
  ) THEN
    RAISE EXCEPTION 'That contact has already been connected to an account';
  END IF;

  INSERT INTO public.connection_requests (placeholder_id, owner_id, claimant_id)
  VALUES (v_req.placeholder_id, v_req.owner_id, v_req.claimant_id)
  RETURNING id INTO v_new;

  RETURN v_new;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants — REVOKE FROM PUBLIC alone does NOT remove anon's default EXECUTE
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.respond_to_connection_request(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.reopen_connection_request(UUID)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_connection_requests()                FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_to_connection_request(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.reopen_connection_request(UUID)           TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_connection_requests()                TO authenticated;

-- The trigger function is invoked by the trigger, never called directly.
REVOKE ALL ON FUNCTION public.create_connection_requests_for_phone() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT tablename FROM pg_tables
--   WHERE schemaname='public' AND tablename='connection_requests';
--   -> one row
--
--   SELECT policyname FROM pg_policies
--   WHERE tablename='connection_requests';
--   -> exactly one: connection_requests_select  (no UPDATE/INSERT/DELETE)
--
--   SELECT tgname FROM pg_trigger
--   WHERE tgrelid='public.users'::regclass AND NOT tgisinternal;
--   -> includes users_create_connection_requests
--
--   SELECT
--     has_function_privilege('anon','public.respond_to_connection_request(uuid,text)','EXECUTE') AS anon_respond,
--     has_function_privilege('anon','public.reopen_connection_request(uuid)','EXECUTE')          AS anon_reopen,
--     has_function_privilege('authenticated','public.respond_to_connection_request(uuid,text)','EXECUTE') AS auth_respond;
--   -> false, false, true
--
-- Functional (from the app — auth.uid() is NULL in the SQL editor):
--   - As A, add an off-app friend with a phone number -> placeholder exists.
--   - Sign up a NEW account entering that same number.
--   - SELECT * FROM public.connection_requests;
--     -> one pending row, owner_id = A, claimant_id = the new account.
