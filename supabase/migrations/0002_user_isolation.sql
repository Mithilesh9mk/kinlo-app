-- Kinlo · 0002 · per-user data isolation
--
-- Goal: a user can only read or write rows they are genuinely party to.
--
-- The boundary is already defined in application code — lib/friendFetcher.ts
-- computes "related users" as (co-group members ∪ transaction counterparties ∪
-- friends). This migration enforces that same boundary in the database, so the
-- rule holds even when the client is bypassed entirely.
--
-- Before: WITH CHECK (auth.uid() IS NOT NULL) on transactions and
-- transaction_splits. Any authenticated account — including a throwaway from
-- signInAnonymously() — could insert a transaction with paid_by set to any
-- user's UUID and a split naming any other user, fabricating debt between two
-- strangers.
--
-- After: writes must be anchored to a group you belong to, or to yourself.
-- Note this also neutralises the anonymous-signup vector without banning
-- anonymous auth outright: a throwaway account shares no groups with anyone, so
-- it has nobody to forge against.
--
-- Idempotent — every policy is dropped before being recreated.

BEGIN;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
-- All SECURITY DEFINER so they can read membership tables without tripping the
-- RLS policies that are themselves defined in terms of these functions. Without
-- that, a policy on group_members that queries group_members recurses forever.
-- search_path is pinned so a caller cannot shadow the tables being read.

CREATE OR REPLACE FUNCTION public.is_group_member(check_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.group_members
    WHERE group_id = check_group_id AND user_id = auth.uid()
  );
$$;

-- Is the given user in any group I am also in?
CREATE OR REPLACE FUNCTION public.shares_group_with(other_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.group_members mine
    JOIN public.group_members theirs ON theirs.group_id = mine.group_id
    WHERE mine.user_id = auth.uid()
      AND theirs.user_id = other_user_id
  );
$$;

-- friendships rows are directional; every read treats them as mutual.
CREATE OR REPLACE FUNCTION public.is_friend_of(other_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.friendships f
    WHERE (f.user_id = auth.uid() AND f.friend_id = other_user_id)
       OR (f.friend_id = auth.uid() AND f.user_id = other_user_id)
  );
$$;

-- Have we ever been on opposite sides of the same expense?
CREATE OR REPLACE FUNCTION public.shares_transaction_with(other_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE (t.paid_by = auth.uid()      AND s.user_id = other_user_id)
       OR (t.paid_by = other_user_id   AND s.user_id = auth.uid())
  );
$$;

-- May I write to this transaction at all? Used by the split policies so the
-- rule lives in exactly one place.
CREATE OR REPLACE FUNCTION public.can_write_transaction(check_transaction_id UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = check_transaction_id
      AND (
        t.paid_by = auth.uid()
        OR (t.group_id IS NOT NULL AND public.is_group_member(t.group_id))
      )
  );
$$;

REVOKE ALL ON FUNCTION public.is_group_member(UUID)          FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shares_group_with(UUID)        FROM PUBLIC;
REVOKE ALL ON FUNCTION public.is_friend_of(UUID)             FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shares_transaction_with(UUID)  FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_write_transaction(UUID)    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_group_member(UUID)         TO authenticated;
GRANT EXECUTE ON FUNCTION public.shares_group_with(UUID)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_friend_of(UUID)            TO authenticated;
GRANT EXECUTE ON FUNCTION public.shares_transaction_with(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_transaction(UUID)   TO authenticated;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
-- The old SELECT policy was auth.uid() = id — you could only ever see your own
-- row, which makes friend names, group member lists and payer labels impossible
-- to render. This widens it to exactly the friendFetcher boundary and no more.

DROP POLICY IF EXISTS "Users can view their own profile"    ON public.users;
DROP POLICY IF EXISTS "Users can update their own profile"  ON public.users;
DROP POLICY IF EXISTS "Users can insert their own profile"  ON public.users;
DROP POLICY IF EXISTS "users_select_related"                ON public.users;
DROP POLICY IF EXISTS "users_insert_self_or_placeholder"    ON public.users;
DROP POLICY IF EXISTS "users_update_self_or_placeholder"    ON public.users;

CREATE POLICY "users_select_related"
ON public.users FOR SELECT
USING (
  id = auth.uid()                          -- myself
  OR created_by = auth.uid()               -- placeholder friends I created
  OR public.shares_group_with(id)          -- someone in one of my groups
  OR public.is_friend_of(id)               -- an explicit friend
  OR public.shares_transaction_with(id)    -- a counterparty on a shared expense
);

-- Either claiming your own auth uid, or creating a placeholder for a friend who
-- has not signed up. Placeholders must be stamped with their creator so the
-- SELECT policy above can scope them.
CREATE POLICY "users_insert_self_or_placeholder"
ON public.users FOR INSERT
WITH CHECK (
  id = auth.uid()
  OR (
    auth.uid() IS NOT NULL
    AND is_placeholder = TRUE
    AND created_by = auth.uid()
  )
);

CREATE POLICY "users_update_self_or_placeholder"
ON public.users FOR UPDATE
USING (
  id = auth.uid()
  OR (is_placeholder = TRUE AND created_by = auth.uid())
)
WITH CHECK (
  id = auth.uid()
  OR (is_placeholder = TRUE AND created_by = auth.uid())
);

-- No DELETE policy: profiles are not client-deletable. Account deletion runs
-- server-side so the transaction history stays referentially intact.

-- ---------------------------------------------------------------------------
-- groups
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Groups visible to members"                   ON public.groups;
DROP POLICY IF EXISTS "Groups can be created by authenticated users" ON public.groups;
DROP POLICY IF EXISTS "Groups can be updated by members"            ON public.groups;
DROP POLICY IF EXISTS "groups_select_members"                       ON public.groups;
DROP POLICY IF EXISTS "groups_insert_own"                           ON public.groups;
DROP POLICY IF EXISTS "groups_update_members"                       ON public.groups;
DROP POLICY IF EXISTS "groups_delete_creator"                       ON public.groups;

CREATE POLICY "groups_select_members"
ON public.groups FOR SELECT
USING (public.is_group_member(id) OR created_by = auth.uid());

-- Was WITH CHECK (auth.uid() IS NOT NULL), which let you attribute a group to
-- someone else. You may only create groups in your own name.
CREATE POLICY "groups_insert_own"
ON public.groups FOR INSERT
WITH CHECK (created_by = auth.uid());

CREATE POLICY "groups_update_members"
ON public.groups FOR UPDATE
USING (public.is_group_member(id))
WITH CHECK (public.is_group_member(id));

CREATE POLICY "groups_delete_creator"
ON public.groups FOR DELETE
USING (created_by = auth.uid());

-- ---------------------------------------------------------------------------
-- group_members
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Group members visible to other members"                ON public.group_members;
DROP POLICY IF EXISTS "Users can add themselves or others if they are members" ON public.group_members;
DROP POLICY IF EXISTS "group_members_select"                                  ON public.group_members;
DROP POLICY IF EXISTS "group_members_insert"                                  ON public.group_members;
DROP POLICY IF EXISTS "group_members_delete"                                  ON public.group_members;

CREATE POLICY "group_members_select"
ON public.group_members FOR SELECT
USING (public.is_group_member(group_id));

-- The creator needs to add the first row before any membership exists, so the
-- groups.created_by branch is what bootstraps a brand new group.
CREATE POLICY "group_members_insert"
ON public.group_members FOR INSERT
WITH CHECK (
  public.is_group_member(group_id)
  OR EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = group_id AND g.created_by = auth.uid()
  )
);

CREATE POLICY "group_members_delete"
ON public.group_members FOR DELETE
USING (
  user_id = auth.uid()                     -- leave a group yourself
  OR EXISTS (                              -- or the creator removes someone
    SELECT 1 FROM public.groups g
    WHERE g.id = group_id AND g.created_by = auth.uid()
  )
);

-- ---------------------------------------------------------------------------
-- transactions  — the phantom-expense fix
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Transactions visible to paid_by or group members" ON public.transactions;
DROP POLICY IF EXISTS "Transactions can be inserted by participants"     ON public.transactions;
DROP POLICY IF EXISTS "transactions_select"                              ON public.transactions;
DROP POLICY IF EXISTS "transactions_insert"                              ON public.transactions;
DROP POLICY IF EXISTS "transactions_update"                              ON public.transactions;
DROP POLICY IF EXISTS "transactions_delete"                              ON public.transactions;

CREATE POLICY "transactions_select"
ON public.transactions FOR SELECT
USING (
  paid_by = auth.uid()
  OR (group_id IS NOT NULL AND public.is_group_member(group_id))
  OR EXISTS (
    SELECT 1 FROM public.transaction_splits s
    WHERE s.transaction_id = public.transactions.id AND s.user_id = auth.uid()
  )
);

-- Group-scoped payer rule.
--   * You may always record an expense you paid for yourself.
--   * You may record someone else as payer only inside a group you are both
--     members of — normal "Bob paid for dinner" group entry.
--   * A 1-on-1 expense (group_id IS NULL) must have you as the payer, so nobody
--     can fabricate private debt between two people.
CREATE POLICY "transactions_insert"
ON public.transactions FOR INSERT
WITH CHECK (
  auth.uid() = paid_by
  OR (
    group_id IS NOT NULL
    AND public.is_group_member(group_id)
    AND EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = public.transactions.group_id
        AND gm.user_id = public.transactions.paid_by
    )
  )
);

-- Editing and voiding. The committed schema had no UPDATE policy at all, yet
-- nine call sites in the app update these rows — more evidence production had
-- drifted. Same rule as insert, so an edit cannot re-point an expense at a
-- payer outside the group.
CREATE POLICY "transactions_update"
ON public.transactions FOR UPDATE
USING (
  paid_by = auth.uid()
  OR (group_id IS NOT NULL AND public.is_group_member(group_id))
)
WITH CHECK (
  auth.uid() = paid_by
  OR (
    group_id IS NOT NULL
    AND public.is_group_member(group_id)
    AND EXISTS (
      SELECT 1 FROM public.group_members gm
      WHERE gm.group_id = public.transactions.group_id
        AND gm.user_id = public.transactions.paid_by
    )
  )
);

-- Only the payer may hard-delete. Everyone else voids (status = 'voided'),
-- which preserves history for the other party.
CREATE POLICY "transactions_delete"
ON public.transactions FOR DELETE
USING (paid_by = auth.uid());

-- ---------------------------------------------------------------------------
-- transaction_splits
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "Splits visible to participant or group member" ON public.transaction_splits;
DROP POLICY IF EXISTS "Splits can be inserted by participants"        ON public.transaction_splits;
DROP POLICY IF EXISTS "transaction_splits_select"                     ON public.transaction_splits;
DROP POLICY IF EXISTS "transaction_splits_insert"                     ON public.transaction_splits;
DROP POLICY IF EXISTS "transaction_splits_update"                     ON public.transaction_splits;
DROP POLICY IF EXISTS "transaction_splits_delete"                     ON public.transaction_splits;

CREATE POLICY "transaction_splits_select"
ON public.transaction_splits FOR SELECT
USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = public.transaction_splits.transaction_id
      AND (
        t.paid_by = auth.uid()
        OR (t.group_id IS NOT NULL AND public.is_group_member(t.group_id))
      )
  )
);

-- A split is writable only if the parent transaction is writable by you. That
-- single check inherits the group-scoped payer rule above, so splits cannot be
-- used as a side door to name an unrelated user as a debtor.
CREATE POLICY "transaction_splits_insert"
ON public.transaction_splits FOR INSERT
WITH CHECK (public.can_write_transaction(transaction_id));

CREATE POLICY "transaction_splits_update"
ON public.transaction_splits FOR UPDATE
USING (public.can_write_transaction(transaction_id))
WITH CHECK (public.can_write_transaction(transaction_id));

CREATE POLICY "transaction_splits_delete"
ON public.transaction_splits FOR DELETE
USING (public.can_write_transaction(transaction_id));

-- ---------------------------------------------------------------------------
-- friendships
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "friendships_select" ON public.friendships;
DROP POLICY IF EXISTS "friendships_insert" ON public.friendships;
DROP POLICY IF EXISTS "friendships_delete" ON public.friendships;

CREATE POLICY "friendships_select"
ON public.friendships FOR SELECT
USING (user_id = auth.uid() OR friend_id = auth.uid());

-- You may only create friendships that start from you, so nobody can wire two
-- other accounts together and gain visibility through is_friend_of().
CREATE POLICY "friendships_insert"
ON public.friendships FOR INSERT
WITH CHECK (user_id = auth.uid());

CREATE POLICY "friendships_delete"
ON public.friendships FOR DELETE
USING (user_id = auth.uid() OR friend_id = auth.uid());

-- ---------------------------------------------------------------------------
-- simplified_settlements  — readable by the parties, writable only by the RPC
-- ---------------------------------------------------------------------------
-- Deliberately no INSERT/UPDATE/DELETE policy for authenticated users. The
-- ledger is derived data: it must only ever be rewritten atomically from the
-- underlying transactions, which is what 0003's recalculate_settlements() does
-- as SECURITY DEFINER. The app's four client-side delete-then-insert pairs are
-- replaced by calls to that function.

DROP POLICY IF EXISTS "Simplified settlements visible to involved parties or group members"
  ON public.simplified_settlements;
DROP POLICY IF EXISTS "simplified_settlements_select" ON public.simplified_settlements;

CREATE POLICY "simplified_settlements_select"
ON public.simplified_settlements FOR SELECT
USING (
  debtor_id = auth.uid()
  OR creditor_id = auth.uid()
  OR (group_id IS NOT NULL AND public.is_group_member(group_id))
);

COMMIT;
