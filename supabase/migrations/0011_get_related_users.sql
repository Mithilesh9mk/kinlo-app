-- Kinlo · 0011 · resolve "people I know" in one round trip
--
-- WHY THE APP FEELS SLOW
--
-- lib/friendFetcher.getRelatedUsers() builds the list client-side with a chain
-- of dependent queries: transactions I paid, then the splits on those, then
-- splits naming me, then the payers of those, then my groups, then the members
-- of those groups, then friendships in both directions, then the profiles.
-- Nine sequential round trips, each waiting on the one before.
--
-- Home calls it on every focus — through the balance snapshot, and again for
-- the friend rows. On a phone network that is most of the several seconds
-- before anything appears.
--
-- The same answer is one query if the database does it, because the joins
-- happen where the data already is.
--
-- SECURITY
--
-- SECURITY DEFINER to keep the traversal off the RLS path (the same reason
-- 0008 moved the policy checks into functions). It is not a data leak: it
-- returns exactly the set users_select_related already permits — people you
-- share a group, a friendship, or an expense with, plus placeholder friends
-- you created yourself — and nothing about them beyond what the friend list
-- already shows.

CREATE OR REPLACE FUNCTION public.get_related_users()
RETURNS TABLE (
  id           UUID,
  full_name    TEXT,
  avatar_url   TEXT,
  phone_number TEXT
)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  WITH related AS (
    -- People who owe on something I paid for
    SELECT s.user_id AS other
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE t.paid_by = auth.uid()

    UNION

    -- People who paid for something I owe on
    SELECT t.paid_by
    FROM public.transaction_splits s
    JOIN public.transactions t ON t.id = s.transaction_id
    WHERE s.user_id = auth.uid()

    UNION

    -- Everyone in a group I am in
    SELECT gm2.user_id
    FROM public.group_members gm1
    JOIN public.group_members gm2 ON gm2.group_id = gm1.group_id
    WHERE gm1.user_id = auth.uid()

    UNION

    -- Friendships, which are directional but read as mutual
    SELECT f.friend_id FROM public.friendships f WHERE f.user_id = auth.uid()
    UNION
    SELECT f.user_id   FROM public.friendships f WHERE f.friend_id = auth.uid()

    UNION

    -- Placeholder friends I added who have not signed up yet
    SELECT u.id FROM public.users u WHERE u.created_by = auth.uid()
  )
  SELECT
    u.id,
    u.full_name::TEXT,
    u.avatar_url::TEXT,
    u.phone_number::TEXT
  FROM public.users u
  WHERE u.id IN (SELECT other FROM related WHERE other IS NOT NULL)
    AND u.id <> auth.uid();
$$;

REVOKE ALL ON FUNCTION public.get_related_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_related_users() TO authenticated;
