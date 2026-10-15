-- Kinlo · 0033 · atomic, idempotent group creation
--
-- app/group/create-members.tsx built a group with two sequential, unguarded
-- client inserts: `groups`, then `group_members`. Nothing disabled the submit
-- button while either was in flight, and errors from either insert were only
-- console.error'd — the screen still showed "Circle created!" and navigated
-- away regardless of whether either write actually succeeded.
--
-- Two concrete failures followed directly from that shape:
--   - A double-tap fired handleCreate twice. Each call ran its own
--     `groups` insert with its own server-generated id, so two rows were
--     created — not a rejected duplicate, because nothing was there to
--     reject it.
--   - If the group insert succeeded but the members insert failed, the user
--     was left in a group with only whichever rows made it in (possibly
--     none), while the app still reported success.
--
-- The rest of the schema already has the fix for this shape of problem —
-- record_expense (0028) takes a client-minted idempotency key that doubles as
-- the row's own primary key, and does the whole write in one transaction.
-- This applies the same pattern to group creation.

CREATE OR REPLACE FUNCTION public.create_group(
  p_group_id   UUID,
  p_title      TEXT,
  p_category   TEXT,
  p_member_ids UUID[]
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

  -- DO NOTHING, not DO UPDATE: unlike an expense, a group is never "edited"
  -- through this call. A retry of the same key should confirm the group
  -- already exists, not silently overwrite its title.
  INSERT INTO public.groups (id, title, category, created_by)
  VALUES (p_group_id, btrim(p_title), COALESCE(p_category, 'other'), me)
  ON CONFLICT (id) DO NOTHING;

  -- array_append(..., me) folds "always add the creator" and "de-dupe if the
  -- creator is also in the picked list" into one insert. Matches the existing
  -- RLS bootstrap comment on group_members_insert (0002): the creator can
  -- always add rows to a group they created.
  INSERT INTO public.group_members (group_id, user_id)
  SELECT p_group_id, u
  FROM unnest(array_append(p_member_ids, me)) AS u
  ON CONFLICT (group_id, user_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION
  public.create_group(UUID, TEXT, TEXT, UUID[])
  FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.create_group(UUID, TEXT, TEXT, UUID[])
  TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT p.oid::regprocedure::text AS signature,
--          has_function_privilege('anon', p.oid, 'EXECUTE') AS anon
--   FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--   WHERE n.nspname = 'public' AND p.proname = 'create_group';
--   -> exactly one row, 4 arguments, anon false
--
-- The function reads auth.uid(), which is NULL for a plain SQL-editor
-- session (it runs as postgres, not as a logged-in user) — calling it
-- directly here would just raise 'authentication required'. Idempotency and
-- the atomic write are verified through the app instead: create a group,
-- double-tap the submit button, and confirm exactly one group and one
-- group_members row per selected member — not two of each.
