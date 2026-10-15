-- Kinlo · 0051 · flipping a group's simplification mode leaves an activity trail
--
-- Core Functionality Audit 2026-08-31, finding P1 §4.3
-- (docs/Kinlo-Core-Functionality-Audit-2026-08-31.docx).
--
-- set_group_simplification() (0031) re-routes who-owes-whom for every member
-- of a group — its own header says so plainly — but only writes to groups and
-- simplified_settlements. Neither has an emit trigger, so the change is
-- invisible in the activity feed: exactly the "silent balance change, no sign
-- anything moved" problem 0032 was built to eliminate, for a mutation that
-- shipped after 0032 did.
--
-- WHY A NEW EVENT TYPE ON THE EXISTING LOG, NOT A SEPARATE TABLE
--   Unlike 0048's debt_nudges (which needed its own table because the event
--   has neither a transaction_id nor is visible to a non-group-member), this
--   event has a group_id and belongs to a group every affected member is
--   already in. activity_events_select already grants SELECT to any
--   is_group_member(group_id) row — no new policy needed.
--
-- WHY THE FUNCTION EMITS DIRECTLY, NOT A TRIGGER ON groups
--   0032's trigger approach exists to catch direct-table writes that bypass
--   an RPC. groups has no such bypass here: UPDATE groups SET simplify_debts
--   is not part of any other write path, and a trigger firing on every groups
--   UPDATE would also have to filter out rename/category-change columns it
--   has no business commenting on. A direct INSERT inside the one function
--   that ever changes this column is simpler and cannot fire on the wrong
--   column.
--
-- WHY ONLY ON AN ACTUAL CHANGE
--   Same rule 0032's trigger enforces for transactions: calling the RPC with
--   the group's current setting must emit nothing, matching "save without
--   changing anything emits nothing" everywhere else in this log.

ALTER TABLE public.activity_events DROP CONSTRAINT activity_events_type_check;

ALTER TABLE public.activity_events ADD CONSTRAINT activity_events_type_check
  CHECK (event_type IN (
    'expense_created', 'expense_edited', 'expense_voided',
    'settlement_recorded', 'settlement_voided',
    'member_added', 'member_removed',
    'group_simplification_changed'
  ));

CREATE OR REPLACE FUNCTION public.set_group_simplification(
  p_group_id UUID,
  p_simplify BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_old BOOLEAN;
BEGIN
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'group id is required';
  END IF;
  IF p_simplify IS NULL THEN
    RAISE EXCEPTION 'a setting is required';
  END IF;

  -- SECURITY DEFINER bypasses RLS, so this is the only thing stopping a caller
  -- changing how a group they are not in settles up.
  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
  END IF;

  SELECT g.simplify_debts INTO v_old FROM public.groups g WHERE g.id = p_group_id;

  UPDATE public.groups SET simplify_debts = p_simplify WHERE id = p_group_id;

  IF v_old IS DISTINCT FROM p_simplify THEN
    INSERT INTO public.activity_events
      (actor_id, event_type, group_id, payload)
    VALUES (
      auth.uid(),
      'group_simplification_changed',
      p_group_id,
      jsonb_build_object('simplify_debts', jsonb_build_array(v_old, p_simplify))
    );
  END IF;

  PERFORM public.recalculate_group_settlements(p_group_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_group_simplification(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_group_simplification(UUID, BOOLEAN) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.activity_events'::regclass
--     AND conname = 'activity_events_type_check';
--   -> includes 'group_simplification_changed'
--
--   SELECT p.oid::regprocedure::text,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon,
--          has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authed
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'set_group_simplification';
--   -> one row, anon = false, authed = true
--
-- Then exercise it, since a stored body is not a working body — on a REAL
-- group (not a throwaway row: simplify_debts touches every member's stored
-- balance, and a fabricated auth.uid() row would need cleanup across
-- activity_events too):
--   1. Call set_group_simplification on a group with its CURRENT setting
--      (no-op) -> confirm activity_events gets NO new row.
--   2. Call it with the OPPOSITE setting -> confirm exactly one
--      group_simplification_changed row appears, payload.simplify_debts is
--      [old, new], group_id matches, actor_id is the caller.
--   3. Toggle back -> confirm a second row, values reversed.
--   4. Confirm the app's activity screen (app/activity.tsx,
--      lib/activity.ts::describeEvent) does not crash on the new event_type
--      it has never seen before it renders a description for it.
