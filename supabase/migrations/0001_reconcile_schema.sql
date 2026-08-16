-- Kinlo · 0001 · reconcile schema with what the app actually writes
--
-- The app and supabase_schema.sql disagree in ways that make writes fail:
--   * transactions.status CHECK allows ('pending','settled','disputed'), but the
--     app writes 'active' (expense/split.tsx) and 'voided' (friend/[id].tsx).
--   * the app inserts transactions.type = 'expense'; no such column is declared.
--   * friendships is read/written by AddFriendModal + friendFetcher but is not
--     declared anywhere.
--   * AddFriendModal inserts users rows for friends who have no auth account,
--     which a hard FK to auth.users forbids.
--
-- Everything here is idempotent, so it is safe to run against a database that
-- already has some of it. Run supabase/preflight.sql first.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Placeholder users
-- ---------------------------------------------------------------------------
-- A friend added by phone has no auth account yet, so users.id cannot require a
-- matching auth.users row. Track which rows are placeholders and who created
-- them: 0002 uses created_by to scope visibility so placeholders are not a way
-- to enumerate the user table.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.users(id) ON DELETE SET NULL;

-- Drop the hard auth.users dependency if it is still present. Real accounts are
-- still keyed by their auth uid; placeholders simply have no auth row until the
-- person signs up and gets claimed.
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

-- Backfill: anything already lacking an auth account is a placeholder.
UPDATE public.users u
SET is_placeholder = TRUE
WHERE NOT EXISTS (SELECT 1 FROM auth.users a WHERE a.id = u.id)
  AND u.is_placeholder IS DISTINCT FROM TRUE;

-- ---------------------------------------------------------------------------
-- 2. transactions: the columns and values the app actually uses
-- ---------------------------------------------------------------------------

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS type VARCHAR(20) NOT NULL DEFAULT 'expense';

DO $$
BEGIN
  -- Widen status to the full set the app writes. 'active' becomes the default
  -- because that is what expense/split.tsx sends on every new expense.
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

-- Voided rows must stay out of every balance calculation, and settle-up needs
-- to find a group's live rows fast.
CREATE INDEX IF NOT EXISTS transactions_group_status_idx
  ON public.transactions (group_id, status);
CREATE INDEX IF NOT EXISTS transactions_paid_by_idx
  ON public.transactions (paid_by);

-- ---------------------------------------------------------------------------
-- 3. friendships — used by AddFriendModal and friendFetcher, never declared
-- ---------------------------------------------------------------------------
-- Rows are directional (user_id added friend_id) but every read treats the
-- relationship as mutual, so both directions are accepted on read in 0002.

CREATE TABLE IF NOT EXISTS public.friendships (
  user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  friend_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, friend_id),
  CONSTRAINT friendships_no_self CHECK (user_id <> friend_id)
);

CREATE INDEX IF NOT EXISTS friendships_friend_id_idx ON public.friendships (friend_id);

ALTER TABLE public.friendships ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. simplified_settlements
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. Remove the abandoned webhook trigger
-- ---------------------------------------------------------------------------
-- fix_webhook_trigger.sql already dropped this in favour of client-side
-- recalculation; 0003 replaces both with an atomic RPC. Dropping it here means
-- a fresh environment built from migrations never recreates it.

DROP TRIGGER IF EXISTS on_transaction_splits_change ON public.transaction_splits;
DROP FUNCTION IF EXISTS public.notify_simplify_debts();

COMMIT;
