-- Kinlo · 0058 · a placeholder merge's paid_by re-point is not a manual edit
--
-- Core Functionality Audit 2026-08-31, finding P2 §4.6 "Placeholder-merge
-- generates misleading edit-noise". claim_placeholder() (0042) re-points
-- transactions.paid_by from the placeholder's id to the claimant's — the
-- same real person, now under one identity — via a plain UPDATE. That
-- UPDATE fires emit_transaction_event() (0032) exactly like a real edit
-- would, so every affected expense gets an "expense_edited … changed who
-- paid" event attributed to whoever tapped accept, even though nobody
-- edited anything: the payer didn't change, only which row represents them.
--
-- WHY SUPPRESS RATHER THAN TAG A NEW EVENT TYPE
--   The audit's own wording asks for this to be "distinguishable from a
--   manual edit". Silence is the strongest form of that — the merge already
--   has its own clear signal (the accept flow's toast, and 0032's own
--   member_added-style events do not fire for this either), so duplicating
--   it as noise on every affected transaction adds nothing a user needs.
--   Introducing a ninth activity_events type instead would mean extending
--   the CHECK constraint again (0051 just did that for a real new kind of
--   event) and teaching lib/activity.ts a new case for something that is,
--   from every user's point of view, not an event at all.
--
-- WHY A SESSION-LOCAL FLAG AND NOT A COLUMN OR AN OUT-OF-BAND TABLE
--   emit_transaction_event() only ever sees the transactions row itself —
--   it has no way to know WHY paid_by changed. set_config(..., true) scopes
--   the flag to the current transaction only (auto-clears on commit or
--   rollback, no cleanup code needed) and claim_placeholder is the only
--   caller that will ever set it, so there is no risk of a stray push
--   leaving it set for some later, unrelated UPDATE in the same connection.
--
-- SCOPE OF THE SUPPRESSION
--   Only the paid_by diff is skipped, and only when the flag is set. If
--   amount/description/category/group_id/split_type also differed in the
--   same UPDATE (never true for claim_placeholder's specific statement,
--   which sets only paid_by), an edit event still fires for those — this
--   does not create a blind spot for a real simultaneous edit, it just
--   never falsely attributes the identity re-point itself as one.
--
-- Both function bodies below are reproduced in full from their live
-- definitions (captured via pg_get_functiondef, diffed before applying)
-- except the two marked additions.

CREATE OR REPLACE FUNCTION public.emit_transaction_event()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor   UUID;
  v_changes JSONB := '{}'::jsonb;
BEGIN
  -- auth.uid() is the person who caused this. It survives into a trigger fired
  -- from inside a SECURITY DEFINER function, because it reads a session
  -- setting rather than the current role. It is NULL for service-role work —
  -- a SQL editor repair, say — and attributing that to the payer is more
  -- useful than refusing to record it.
  v_actor := COALESCE(auth.uid(), NEW.paid_by);

  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.activity_events
      (actor_id, event_type, transaction_id, group_id, payload)
    VALUES (
      v_actor,
      CASE WHEN NEW.type = 'settlement' THEN 'settlement_recorded' ELSE 'expense_created' END,
      NEW.id,
      NEW.group_id,
      jsonb_build_object(
        'amount', NEW.amount,
        'description', NEW.description,
        'category', NEW.category,
        'paid_by', NEW.paid_by
      )
    );
    RETURN NEW;
  END IF;

  -- A void is a distinct event, not an edit.
  IF OLD.status IS DISTINCT FROM 'voided' AND NEW.status = 'voided' THEN
    INSERT INTO public.activity_events
      (actor_id, event_type, transaction_id, group_id, payload)
    VALUES (
      v_actor,
      CASE WHEN NEW.type = 'settlement' THEN 'settlement_voided' ELSE 'expense_voided' END,
      NEW.id,
      NEW.group_id,
      jsonb_build_object('amount', NEW.amount, 'description', NEW.description)
    );
    RETURN NEW;
  END IF;

  -- Otherwise: an edit, but only if something a person would recognise as a
  -- change actually changed. status and updated_at are excluded — the former
  -- is maintained by record_settlement as a display flag, the latter by the
  -- 0028 trigger on every write. Treating either as an edit would fill the log
  -- with events nobody made.
  IF NEW.amount      IS DISTINCT FROM OLD.amount      THEN
    v_changes := v_changes || jsonb_build_object('amount', jsonb_build_array(OLD.amount, NEW.amount));
  END IF;
  IF NEW.description IS DISTINCT FROM OLD.description THEN
    v_changes := v_changes || jsonb_build_object('description', jsonb_build_array(OLD.description, NEW.description));
  END IF;
  IF NEW.category    IS DISTINCT FROM OLD.category    THEN
    v_changes := v_changes || jsonb_build_object('category', jsonb_build_array(OLD.category, NEW.category));
  END IF;
  -- 0058: a placeholder merge re-points paid_by to the same real person's
  -- real account — not a change anyone made to the expense. Suppressed only
  -- while claim_placeholder's session-local flag is set; unset (the normal
  -- case, current_setting(...) returns NULL) behaves exactly as before.
  IF NEW.paid_by     IS DISTINCT FROM OLD.paid_by
     AND current_setting('kinlo.merge_context', true) IS DISTINCT FROM 'true' THEN
    v_changes := v_changes || jsonb_build_object('paid_by', jsonb_build_array(OLD.paid_by, NEW.paid_by));
  END IF;
  IF NEW.group_id    IS DISTINCT FROM OLD.group_id    THEN
    v_changes := v_changes || jsonb_build_object('group_id', jsonb_build_array(OLD.group_id, NEW.group_id));
  END IF;
  IF NEW.split_type  IS DISTINCT FROM OLD.split_type  THEN
    v_changes := v_changes || jsonb_build_object('split_type', jsonb_build_array(OLD.split_type, NEW.split_type));
  END IF;

  IF v_changes <> '{}'::jsonb THEN
    INSERT INTO public.activity_events
      (actor_id, event_type, transaction_id, group_id, payload)
    VALUES (
      v_actor,
      'expense_edited',
      NEW.id,
      NEW.group_id,
      jsonb_build_object('description', NEW.description, 'changes', v_changes)
    );
  END IF;

  RETURN NEW;
END;
$$;

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

  -- 0058: tells emit_transaction_event() the paid_by re-point immediately
  -- below is a merge, not an edit. Local to this transaction only — clears
  -- itself on commit or rollback, no matching "unset" call needed.
  PERFORM set_config('kinlo.merge_context', 'true', true);

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

REVOKE ALL ON FUNCTION public.claim_placeholder(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_placeholder(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT has_function_privilege('anon', oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', oid, 'EXECUTE') AS authed
--   FROM pg_proc WHERE proname = 'claim_placeholder';
--   -> anon=false, authed=true
--
-- Functional test (same throwaway-row technique as 0042's own VERIFY):
--   run a full placeholder-merge happy path (fixed UUIDs, ZZTEST marker),
--   then confirm zero activity_events rows with event_type='expense_edited'
--   AND payload->'changes' ? 'paid_by' for any transaction touched by the
--   merge — while a manual paid_by edit done OUTSIDE a merge (ordinary
--   record_expense call, no set_config) still produces one normally.
