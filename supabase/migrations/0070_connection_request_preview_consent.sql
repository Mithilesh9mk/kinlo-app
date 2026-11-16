-- Kinlo · 0070 · a claimant sees nothing private until the owner has said yes
--
-- Confirmed by reading the shipped bodies (0041, 0042, 0043). Two read
-- paths leaked to an unverified claimant.
--
-- WHY
--
-- Phone numbers are typed, never verified (0041's header says so, and
-- users_update_self_or_placeholder in 0002 lets anyone set their own). The
-- moment a real account sets a number, 0043's create_connection_requests_
-- for_phone trigger opens a pending request with that account as claimant
-- against EVERY placeholder, created by anyone, whose number has the same
-- last 10 digits. Before this migration the claimant could then, with no one
-- having agreed to anything:
--
--   * preview_placeholder_claim (0042) — checked only that the caller was a
--     party to the request, not its status or the owner's answer, and
--     returned every active/settled expense the placeholder appears on:
--     description, date, total, share, paid, group name. It kept working
--     after the owner DENIED the request.
--   * list_connection_requests (0041) — returned the owner's phone number
--     and the name the owner saved the contact under.
--
-- So typing someone else's number into your own profile was enough to read
-- other people's private shared-expense history with that person, and to
-- learn exactly what they had saved them as. 0041's two-sided accept only
-- protects the MERGE; it never protected this read.
--
-- WHAT CHANGED
--
--   preview_placeholder_claim: when the caller is the CLAIMANT, it returns
--     zero rows unless the request is still pending AND the owner has
--     accepted. It deliberately returns empty rather than raising, so the
--     client stays on its normal path. The owner's preview is unchanged.
--
--   list_connection_requests: on rows where the caller is the claimant and
--     the owner has not accepted, other_phone (the owner's number) and
--     placeholder_name come back NULL. Owner-side rows are unchanged.
--
--   respond_to_connection_request: a claimant may no longer ACCEPT before
--     the owner has. With the preview hidden, an early claimant accept would
--     be blind: the owner's later accept makes both_accepted true and the
--     client merges at once (lib/connections.ts), so the claimant would take
--     on a balance they were never shown — the exact thing the preview
--     exists to prevent. The refusal is a plain RAISE with a message the
--     app can show (it already surfaces RPC errors as error.message). The
--     claimant can still DENY at any time; the owner side is unchanged.
--     Requests a claimant had already accepted before this migration are
--     NOT changed here; the paste-and-verify script reports them and leaves
--     resetting them to the user.
--
-- WHAT IS UNCHANGED (on purpose)
--
--   * Both signatures and every RETURNS TABLE column name, type and order —
--     so CREATE OR REPLACE applies in place and the existing GRANT EXECUTE
--     survives. Changing the return shape would force DROP + CREATE, which
--     silently drops the grant. Grants are re-asserted below anyway, as
--     0043 does.
--   * SECURITY DEFINER, STABLE, search_path = public, pg_temp.
--   * The owner's name and avatar are still returned to the claimant, by
--     product decision: the claimant needs to know who is asking. (This
--     leaves "who saved number X" answerable; accepted trade-off.)
--   * claim_placeholder is not touched; it already requires both accepts.
--
-- ALSO FIXED: 0042 selected g.name, but public.groups has "title", not
-- "name", so preview_placeholder_claim raised "column g.name does not exist"
-- whenever it had a row to return. Now g.title.
--
-- OVERLOADS: each function has exactly one definition in the repo (0041:181,
-- 0041:232, 0042:58), never dropped or redefined since, so there is nothing
-- to drop.

BEGIN;

-- ---------------------------------------------------------------------------
-- preview_placeholder_claim
-- ---------------------------------------------------------------------------
-- Body identical to 0042 except the claimant gate after the party check.
CREATE OR REPLACE FUNCTION public.preview_placeholder_claim(p_request_id UUID)
RETURNS TABLE (
  tx_id            UUID,
  tx_description   TEXT,
  tx_occurred_at   TIMESTAMPTZ,
  tx_total         NUMERIC,
  ph_share         NUMERIC,
  ph_paid          NUMERIC,
  tx_group_name    TEXT
)
LANGUAGE plpgsql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req public.connection_requests%ROWTYPE;
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

  -- 0070: the claimant's phone number is unverified, so they see nothing of
  -- the placeholder's history until the owner has recognised them and said
  -- yes on a still-open request. Empty, not an error, so the client stays on
  -- its normal path. owner_id <> claimant_id is a table CHECK, so this never
  -- affects the owner.
  IF auth.uid() = v_req.claimant_id
     AND NOT (v_req.status = 'pending' AND v_req.owner_response = 'accepted') THEN
    RETURN;
  END IF;

  IF v_req.placeholder_id IS NULL THEN
    RETURN;  -- already merged; nothing left to preview
  END IF;

  RETURN QUERY
  SELECT t.id,
         t.description::TEXT,
         t.created_at,
         t.amount,
         COALESCE(s.share_amount, 0)::NUMERIC,
         -- Explicit payer row when one exists; otherwise the transaction's
         -- own single payer. Mirrors 0021's paid CTE.
         COALESCE(
           p.amount_paid,
           CASE WHEN t.paid_by = v_req.placeholder_id THEN t.amount ELSE 0 END
         )::NUMERIC,
         -- 0070: was g.name in 0042, but public.groups has no "name" column
         -- (it is "title"), so every non-empty preview raised.
         g.title::TEXT
  FROM public.transactions t
  LEFT JOIN public.transaction_splits s
         ON s.transaction_id = t.id AND s.user_id = v_req.placeholder_id
  LEFT JOIN public.transaction_payers p
         ON p.transaction_id = t.id AND p.user_id = v_req.placeholder_id
  LEFT JOIN public.groups g ON g.id = t.group_id
  WHERE t.status IN ('active', 'settled')
    AND (s.user_id IS NOT NULL OR t.paid_by = v_req.placeholder_id)
  ORDER BY t.created_at DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- list_connection_requests
-- ---------------------------------------------------------------------------
-- Body identical to 0041 except other_phone and placeholder_name, which are
-- withheld from a claimant until the owner has accepted.
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
    -- 0070: on a claimant's row, `other` is the owner. Their number, and what
    -- they saved the contact as, stay hidden until the owner has accepted.
    CASE WHEN cr.owner_id = auth.uid() OR cr.owner_response = 'accepted'
         THEN other.phone_number::TEXT END,
    -- What the owner originally saved this person as, so they can recognise
    -- which contact is being claimed.
    CASE WHEN cr.owner_id = auth.uid() OR cr.owner_response = 'accepted'
         THEN ph.full_name::TEXT END,
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
-- respond_to_connection_request
-- ---------------------------------------------------------------------------
-- Body identical to 0041 except the claimant-accept gate after the role is
-- known. Same signature and return shape, so the grant is kept.
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

  -- 0070: the claimant only sees what they would take on once the owner has
  -- accepted (preview_placeholder_claim), so accepting before that would be
  -- accepting blind. Denying is always allowed. The app matches on
  -- 'confirm first' in this message (app/connect/[id].tsx).
  IF NOT v_is_owner AND p_response = 'accepted'
     AND v_req.owner_response <> 'accepted' THEN
    RAISE EXCEPTION 'The person who added you needs to confirm first. You can accept once they have.';
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
-- Grants — unchanged by CREATE OR REPLACE; re-asserted as 0043 does, because
-- REVOKE FROM PUBLIC alone does not remove anon's default EXECUTE.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.preview_placeholder_claim(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_connection_requests()      FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.respond_to_connection_request(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preview_placeholder_claim(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_connection_requests()      TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_connection_request(UUID, TEXT) TO authenticated;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
-- Full preflight, structural checks and rollback-only behaviour tests:
-- docs/sql/0070_paste_and_verify.sql. Quick structural check:
--
--   SELECT p.proname, p.prosecdef, p.proconfig,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
--          has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
--          p.prosrc LIKE '%0070:%'                                     AS new_body
--   FROM pg_proc p
--   WHERE p.pronamespace = 'public'::regnamespace
--     AND p.proname IN ('preview_placeholder_claim', 'list_connection_requests',
--                       'respond_to_connection_request');
--   -> 3 rows: secdef true, search_path=public, pg_temp, auth true, anon false,
--      new_body true
