-- Kinlo · 0066 · recurring expenses (rent, Wi-Fi, subscriptions that repeat)
--
-- A recurring_expenses row is a TEMPLATE: who paid, the exact split, the
-- amount, and how often. It is not an expense and moves no money by itself.
-- The expense is created by the OWNER'S app, through the same record_expense()
-- RPC a hand-entered expense uses, when the owner opens Kinlo on or after the
-- due date (lib/recurringExpenses.ts). There is NO pg_cron and no server-side
-- sweep — the project's standing no-cron decision (PROJECT_STATUS) stands.
-- The honest consequence: an expense appears when the owner next opens the
-- app, not at midnight. The UI says so.
--
-- WHY THE APP CREATES IT AND NOT A DATABASE FUNCTION
--   record_expense() validates participation, rebuilds the ledger and enforces
--   the rules every other expense obeys. Re-implementing that in a second
--   place is the exact failure lib/balances.ts's header warns about. Reusing
--   the RPC means a recurring expense is, by construction, an ordinary one.
--
-- IDEMPOTENCY
--   The client derives the transaction id from (rule id, due date), so two
--   devices, or a retry after a dropped connection, target the SAME row
--   (record_expense upserts on transactions.id). The client also skips a
--   due date whose transaction already exists, so an expense the owner has
--   since edited or voided is never overwritten.
--
-- PRIVACY / DELETION
--   Visible and writable only by its owner (RLS). owner_id references
--   auth.users ON DELETE CASCADE, like rate_limit_events (0064): the
--   delete-account function removes the auth login, which removes the
--   templates. (anonymize_my_account() keeps the public.users row, so a
--   public.users FK would never cascade — hence auth.users.)
--
-- ABUSE
--   At most 20 rules per owner (trigger below). Creating the expenses
--   themselves goes through record_expense() and is bounded like any other.
--
-- VERIFICATION: see the bottom of the file.

CREATE TABLE IF NOT EXISTS public.recurring_expenses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id          UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  description       TEXT NOT NULL,
  amount            NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  category          VARCHAR(40),
  split_type        VARCHAR(10) NOT NULL,
  paid_by           UUID NOT NULL,
  -- [{ "user_id": uuid, "share_amount": number }, ...] exactly as
  -- record_expense() takes it. Kept as the final shares (not a rule), so what
  -- repeats is what the owner saw and approved.
  splits            JSONB NOT NULL,
  group_id          UUID REFERENCES public.groups(id) ON DELETE CASCADE,

  frequency         TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'yearly')),
  -- Day of month the first occurrence fell on, so a rule started on the 31st
  -- returns to the 31st after a short month (same idea as lib/recurrence.ts).
  anchor_day        SMALLINT NOT NULL CHECK (anchor_day BETWEEN 1 AND 31),
  -- Next date an expense is due, as a calendar date (the user base is IST).
  next_due          DATE NOT NULL,
  active            BOOLEAN NOT NULL DEFAULT true,
  -- Consecutive failed attempts (e.g. a participant left the circle). At 5 the
  -- client pauses the rule instead of retrying forever.
  fail_count        INT NOT NULL DEFAULT 0 CHECK (fail_count >= 0),
  last_generated_on DATE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT recurring_expenses_description_check
    CHECK (char_length(btrim(description)) BETWEEN 1 AND 100),
  CONSTRAINT recurring_expenses_category_check
    CHECK (category IS NULL OR char_length(btrim(category)) BETWEEN 1 AND 40),
  CONSTRAINT recurring_expenses_splits_check
    CHECK (jsonb_typeof(splits) = 'array' AND jsonb_array_length(splits) BETWEEN 1 AND 50)
);

CREATE INDEX IF NOT EXISTS recurring_expenses_owner_due_idx
  ON public.recurring_expenses (owner_id, next_due)
  WHERE active;

ALTER TABLE public.recurring_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY recurring_expenses_select ON public.recurring_expenses FOR SELECT
  USING (owner_id = auth.uid());
CREATE POLICY recurring_expenses_insert ON public.recurring_expenses FOR INSERT
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY recurring_expenses_update ON public.recurring_expenses FOR UPDATE
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY recurring_expenses_delete ON public.recurring_expenses FOR DELETE
  USING (owner_id = auth.uid());

REVOKE ALL ON public.recurring_expenses FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recurring_expenses TO authenticated;

-- At most 20 rules per owner.
CREATE OR REPLACE FUNCTION public.recurring_expenses_cap()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (SELECT count(*) FROM public.recurring_expenses WHERE owner_id = NEW.owner_id) >= 20 THEN
    RAISE EXCEPTION 'You can keep up to 20 repeating expenses.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recurring_expenses_cap_trg ON public.recurring_expenses;
CREATE TRIGGER recurring_expenses_cap_trg
  BEFORE INSERT ON public.recurring_expenses
  FOR EACH ROW EXECUTE FUNCTION public.recurring_expenses_cap();

-- ---------------------------------------------------------------------------
-- VERIFICATION — run after applying and review the output.
-- ---------------------------------------------------------------------------
-- 1) RLS on, four policies, no anon access:
--      SELECT relrowsecurity FROM pg_class WHERE oid = 'public.recurring_expenses'::regclass;  -- true
--      SELECT policyname, cmd FROM pg_policies WHERE tablename = 'recurring_expenses' ORDER BY 1; -- 4 rows
--      SELECT grantee, privilege_type FROM information_schema.role_table_grants
--       WHERE table_name = 'recurring_expenses' AND grantee = 'anon';                             -- 0 rows
-- 2) Cap + checks (inside BEGIN … ROLLBACK, with a real auth.users id <uid>):
--      insert 21 rows -> the 21st raises 'You can keep up to 20 repeating expenses.'
--      insert with frequency 'daily' -> check violation
