-- Kinlo · 0035 · any member can remove any member
--
-- There was no UI anywhere in the app for renaming a group, adding a member,
-- removing a member, or leaving one. Renaming and adding already work for any
-- member once a screen exists — group_members_insert (0002) already permits
-- any existing member to add rows, and groups_update_members (0002) already
-- permits any member to update the group row (RLS is row-level, so title and
-- category are as open as anything else on it).
--
-- Removal was the one gap: group_members_delete (0002) only allows removing
-- yourself, or the group's creator removing anyone. An arbitrary member
-- removing a different member was not permitted.
--
-- This widens that, deliberately, through one RPC rather than the RLS policy
-- itself — group_members_delete stays exactly as conservative as it is today
-- for any other/future direct write path, and the new capability exists only
-- through this one vetted entry point, which carries its own explicit
-- membership check. Same shape as set_group_simplification (0031): a
-- SECURITY DEFINER function whose only gate is is_group_member().
--
-- The BEFORE DELETE guard from 0029 still fires on this DELETE regardless of
-- who initiated it — a member with a non-zero net position in the group
-- cannot be removed, member-initiated or not. This function does not (and
-- should not) duplicate that check; it is enforced at the table itself.
--
-- Leaving a group is the same operation with p_member_id = the caller's own
-- id — no separate function needed.

CREATE OR REPLACE FUNCTION public.remove_group_member(
  p_group_id  UUID,
  p_member_id UUID
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_group_id IS NULL OR p_member_id IS NULL THEN
    RAISE EXCEPTION 'group id and member id are required';
  END IF;

  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.group_members
  WHERE group_id = p_group_id AND user_id = p_member_id;
END;
$$;

REVOKE ALL ON FUNCTION public.remove_group_member(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_group_member(UUID, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT p.oid::regprocedure::text AS signature,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'remove_group_member';
--   -> exactly one row, 2 arguments, anon false
--
-- auth.uid() is NULL in a plain SQL-editor session, so calling this directly
-- here would just raise 'not a member of group ...' — exercise it through the
-- app instead: as a non-creator member, remove another member with a zero
-- balance in that group (should succeed), then try one with a non-zero
-- balance (should be refused by the 0029 trigger, not by this function).
