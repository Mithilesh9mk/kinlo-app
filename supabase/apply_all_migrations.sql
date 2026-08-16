-- =============================================================================
-- Kinlo · one-shot migration for the Supabase SQL Editor
--
-- Combines supabase/preflight.sql (pre-check, converted from psql \echo to
-- plain SELECTs since the dashboard editor doesn't run psql meta-commands)
-- with migrations 0001, 0002, 0003 in order. Safe to run more than once —
-- every statement is idempotent (IF EXISTS / IF NOT EXISTS / DROP+CREATE).
--
-- How to use:
--   1. Run PART A alone first. Look at the "orphan_payer_rows" and "status"/
--      "type" result sets — if orphan_payer_rows > 0, or a status/type value
--      shows up that isn't in the allowed list noted inline, STOP and fix or
--      delete those rows before continuing (ADD CONSTRAINT in 0001 will
--      otherwise fail and abort the whole script).
--   2. If PART A looks clean, select everything below and run PART B.
-- =============================================================================


-- =============================================================================
-- PART A — preflight (read-only, no writes)
-- =============================================================================

-- 1. Tables present in public
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;

-- 2. Is RLS actually enabled on each table?
SELECT relname AS table_name, relrowsecurity AS rls_enabled, relforcerowsecurity AS rls_forced
FROM pg_class
WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
ORDER BY relname;

-- 3. Every live policy right now (before this script changes anything)
SELECT tablename, policyname, cmd, roles, qual AS using_expr, with_check AS check_expr
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd, policyname;

-- 4. Columns on the tables the migrations touch
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('users','transactions','transaction_splits','friendships',
                     'groups','group_members','simplified_settlements')
ORDER BY table_name, ordinal_position;

-- 5. CHECK constraints (app writes status=active/voided, type=expense)
SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relnamespace = 'public'::regnamespace AND con.contype = 'c'
ORDER BY rel.relname, con.conname;

-- 6. Foreign keys — does users.id still require an auth.users row?
--    (AddFriendModal creates placeholder friends with no auth account, so a
--     hard FK here means those inserts are failing in production.)
SELECT rel.relname AS table_name, con.conname, pg_get_constraintdef(con.oid) AS definition
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
WHERE rel.relnamespace = 'public'::regnamespace AND con.contype = 'f'
ORDER BY rel.relname, con.conname;

-- 7. Triggers (0001 expects on_transaction_splits_change to be gone)
SELECT event_object_table AS table_name, trigger_name, action_timing, event_manipulation
FROM information_schema.triggers
WHERE trigger_schema = 'public'
ORDER BY event_object_table, trigger_name;

-- 8. Data that would violate the tightened policies — MUST be 0 before Part B
--    fixes it (0002's transactions_insert/_update policies would otherwise
--    make these rows permanently unwritable by anyone).
SELECT COUNT(*) AS orphan_payer_rows
FROM public.transactions t
WHERE t.group_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.group_members gm
    WHERE gm.group_id = t.group_id AND gm.user_id = t.paid_by
  );

-- Placeholder users (no matching auth account). Expected to be > 0 if the
-- add-a-friend-by-phone flow has ever been used — that's fine, 0001 accounts
-- for it.
SELECT COUNT(*) AS users_without_auth_account
FROM public.users u
WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id);

-- 9. Existing status/type values — 0001 adds CHECK (status IN ('active',
--    'voided','pending','settled','disputed')) and CHECK (type IN ('expense',
--    'settlement')). Any other value here makes that ADD CONSTRAINT fail.
SELECT status, COUNT(*) AS row_count
FROM public.transactions
GROUP BY status
ORDER BY row_count DESC;

SELECT type, COUNT(*) AS row_count
FROM public.transactions
GROUP BY type
ORDER BY row_count DESC;


-- =============================================================================
-- PART B — migrations 0001 → 0003, run only after Part A looks clean
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 0001 · reconcile schema with what the app actually writes
-- -----------------------------------------------------------------------------
BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

DO $$
DECLARE
  fk_name TEXT;
BEGIN
  SELECT con.conname INTO fk_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relnamespace = 'public'::regnamespace
    AND rel.relname = 'users'
    AND con.contype = 'f'
    AND pg_get_constraintdef(con.oid) ILIKE '%auth.users%'
  LIMIT 1;

  IF fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.users DROP CONSTRAINT %I', fk_name);
  END IF;
END $$;

UPDATE public.users u
SET is_placeholder = TRUE
WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id)
  AND u.is_placeholder IS DISTINCT FROM TRUE;

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'expense';

DO $$
BEGIN
  ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
  ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
END $$;

UPDATE public.transactions SET status = 'active' WHERE status IS NULL;

ALTER TABLE public.transactions
  ALTER COLUMN status SET DEFAULT 'active';

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('active', 'voided', 'pending', 'settled', 'disputed'));

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_type_check
  CHECK (type IN ('expense', 'settlement'));

CREATE INDEX IF NOT EXISTS transactions_group_status_idx
  ON public.transactions (group_id, status);
CREATE INDEX IF NOT EXISTS transactions_paid_by_idx
  ON public.transactions (paid_by);

CREATE TABLE IF NOT EXISTS public.friendships (
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  friend_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id),
  CONSTRAINT friendships_no_self CHECK (user_id <> friend_id)
);

CREATE INDEX IF NOT EXISTS friendships_friend_id_idx ON public.friendships (friend_id);

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.simplified_settlements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID REFERENCES public.groups(id) ON DELETE CASCADE,
  debtor_id   UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  creditor_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  amount      NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (group_id, debtor_id, creditor_id)
);

ALTER TABLE public.simplified_settlements ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS simplified_settlements_debtor_idx
  ON public.simplified_settlements (debtor_id);
CREATE INDEX IF NOT EXISTS simplified_settlements_creditor_idx
  ON public.simplified_settlements (creditor_id);

DROP TRIGGER IF EXISTS on_transaction_splits_change ON public.transaction_splits;
DROP FUNCTION IF EXISTS public.notify_simplify_debts();

COMMIT;

-- -----------------------------------------------------------------------------
-- 0002 · per-user data isolation (the RLS / phantom-debt fix)
-- -----------------------------------------------------------------------------
BEGIN;

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

DROP POLICY IF EXISTS "Users can view their own profile"    ON public.users;
DROP POLICY IF EXISTS "Users can update their own profile"  ON public.users;
DROP POLICY IF EXISTS "Users can insert their own profile"  ON public.users;
DROP POLICY IF EXISTS "users_select_related"                ON public.users;
DROP POLICY IF EXISTS "users_insert_self_or_placeholder"    ON public.users;
DROP POLICY IF EXISTS "users_update_self_or_placeholder"    ON public.users;

CREATE POLICY "users_select_related"
ON public.users FOR SELECT
USING (
  id = auth.uid()
  OR created_by = auth.uid()
  OR public.shares_group_with(id)
  OR public.is_friend_of(id)
  OR public.shares_transaction_with(id)
);

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

DROP POLICY IF EXISTS "Group members visible to other members"                ON public.group_members;
DROP POLICY IF EXISTS "Users can add themselves or others if they are members" ON public.group_members;
DROP POLICY IF EXISTS "group_members_select"                                  ON public.group_members;
DROP POLICY IF EXISTS "group_members_insert"                                  ON public.group_members;
DROP POLICY IF EXISTS "group_members_delete"                                  ON public.group_members;

CREATE POLICY "group_members_select"
ON public.group_members FOR SELECT
USING (public.is_group_member(group_id));

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
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.groups g
    WHERE g.id = group_id AND g.created_by = auth.uid()
  )
);

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

CREATE POLICY "transactions_delete"
ON public.transactions FOR DELETE
USING (paid_by = auth.uid());

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

DROP POLICY IF EXISTS "friendships_select" ON public.friendships;
DROP POLICY IF EXISTS "friendships_insert" ON public.friendships;
DROP POLICY IF EXISTS "friendships_delete" ON public.friendships;

CREATE POLICY "friendships_select"
ON public.friendships FOR SELECT
USING (user_id = auth.uid() OR friend_id = auth.uid());

CREATE POLICY "friendships_insert"
ON public.friendships FOR INSERT
WITH CHECK (user_id = auth.uid());

CREATE POLICY "friendships_delete"
ON public.friendships FOR DELETE
USING (user_id = auth.uid() OR friend_id = auth.uid());

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

-- -----------------------------------------------------------------------------
-- 0003 · one atomic source of truth for the ledger
-- -----------------------------------------------------------------------------
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS simplified_settlements_pair_uniq
  ON public.simplified_settlements (debtor_id, creditor_id)
  WHERE group_id IS NULL;

CREATE OR REPLACE FUNCTION public.recalculate_group_settlements(p_group_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  debtor_ids   UUID[];
  debtor_cents BIGINT[];
  cred_ids     UUID[];
  cred_cents   BIGINT[];
  i INT := 1;
  j INT := 1;
  settled BIGINT;
BEGIN
  IF p_group_id IS NULL THEN
    RAISE EXCEPTION 'group id is required';
  END IF;

  IF NOT public.is_group_member(p_group_id) THEN
    RAISE EXCEPTION 'not a member of group %', p_group_id USING ERRCODE = '42501';
  END IF;

  CREATE TEMP TABLE _bal ON COMMIT DROP AS
  SELECT x.uid AS user_id, SUM(x.cents)::BIGINT AS cents
  FROM (
    SELECT t.paid_by AS uid, ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE t.group_id = p_group_id
      AND t.status = 'active'
      AND s.user_id <> t.paid_by
    UNION ALL
    SELECT s.user_id AS uid, -ROUND(s.share_amount * 100)::BIGINT AS cents
    FROM public.transactions t
    JOIN public.transaction_splits s ON s.transaction_id = t.id
    WHERE t.group_id = p_group_id
      AND t.status = 'active'
      AND s.user_id <> t.paid_by
  ) x
  GROUP BY x.uid;

  SELECT array_agg(user_id ORDER BY cents ASC), array_agg(-cents ORDER BY cents ASC)
    INTO debtor_ids, debtor_cents
  FROM _bal WHERE cents <= -1;

  SELECT array_agg(user_id ORDER BY cents DESC), array_agg(cents ORDER BY cents DESC)
    INTO cred_ids, cred_cents
  FROM _bal WHERE cents >= 1;

  DELETE FROM public.simplified_settlements WHERE group_id = p_group_id;

  WHILE i <= COALESCE(array_length(debtor_ids, 1), 0)
    AND j <= COALESCE(array_length(cred_ids, 1), 0)
  LOOP
    settled := LEAST(debtor_cents[i], cred_cents[j]);
    EXIT WHEN settled <= 0;

    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES
      (p_group_id, debtor_ids[i], cred_ids[j], settled / 100.0, NOW());

    debtor_cents[i] := debtor_cents[i] - settled;
    cred_cents[j]   := cred_cents[j] - settled;

    IF debtor_cents[i] = 0 THEN i := i + 1; END IF;
    IF cred_cents[j] = 0 THEN j := j + 1; END IF;
  END LOOP;

  DROP TABLE IF EXISTS _bal;
END;
$$;

CREATE OR REPLACE FUNCTION public.recalculate_pair_settlements(p_other_user UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  me         UUID := auth.uid();
  net_cents  BIGINT;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_other_user IS NULL OR p_other_user = me THEN
    RAISE EXCEPTION 'a distinct counterparty is required';
  END IF;

  SELECT COALESCE(SUM(
    CASE
      WHEN t.paid_by = me            AND s.user_id = p_other_user THEN  ROUND(s.share_amount * 100)::BIGINT
      WHEN t.paid_by = p_other_user  AND s.user_id = me           THEN -ROUND(s.share_amount * 100)::BIGINT
      ELSE 0
    END), 0)
  INTO net_cents
  FROM public.transactions t
  JOIN public.transaction_splits s ON s.transaction_id = t.id
  WHERE t.group_id IS NULL
    AND t.status = 'active'
    AND t.paid_by IN (me, p_other_user)
    AND s.user_id IN (me, p_other_user)
    AND s.user_id <> t.paid_by;

  DELETE FROM public.simplified_settlements
  WHERE group_id IS NULL
    AND ((debtor_id = me AND creditor_id = p_other_user)
      OR (debtor_id = p_other_user AND creditor_id = me));

  IF net_cents >= 1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, p_other_user, me, net_cents / 100.0, NOW());
  ELSIF net_cents <= -1 THEN
    INSERT INTO public.simplified_settlements
      (group_id, debtor_id, creditor_id, amount, updated_at)
    VALUES (NULL, me, p_other_user, (-net_cents) / 100.0, NOW());
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.recalculate_group_settlements(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.recalculate_pair_settlements(UUID)  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.recalculate_group_settlements(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.recalculate_pair_settlements(UUID)  TO authenticated;

COMMIT;


-- =============================================================================
-- PART C — verify (run after Part B) — confirms the new policies are live
-- =============================================================================
SELECT tablename, policyname, cmd, with_check AS check_expr
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, cmd, policyname;
