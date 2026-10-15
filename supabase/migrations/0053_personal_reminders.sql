-- Kinlo · 0053 · reminders for a user's own recurring obligations
-- (renumbered 8 Sep 2026 from its original 0049 — same collision as 0052.)
--
-- New feature on the personal side: rent, utility bills, credit-card
-- payments, EMIs, medicines. Personal Spending (0036) records only what has
-- already happened; nothing in the app can say what is about to.
--
-- Same "belongs to exactly one user, nobody else ever sees it" shape that
-- 0027_expense_drafts and 0036_personal_transactions already established —
-- four user_id = auth.uid() policies, no SECURITY DEFINER helper, no
-- sharing story. Copied deliberately rather than reinvented.
--
-- WHY THIS TABLE IS THE SOURCE OF TRUTH AND THE DEVICE ONLY MIRRORS IT
--   Delivery is an OS-scheduled local notification
--   (lib/reminderScheduler.ts, expo-notifications). That alone would not
--   survive a reinstall or a new phone, and could not back a list UI. This
--   table survives all of it; the device schedule is derived from these
--   rows and re-derived on every launch.
--
--   Deliberately NO pg_cron and NO server-side sweep: this table records
--   intent, it fires nothing. Nothing in the database reaches out.
--
-- WHY next_due_at IS ADVANCED BY THE CLIENT AND NOT BY A FUNCTION HERE
--   1. The device must compute the next occurrence anyway, to hand a date
--      to the OS scheduler. A plpgsql copy would be a SECOND implementation
--      of one rule — lib/balances.ts's header records four separate private
--      balance calculations that were found and removed for exactly that
--      reason. One rule, one implementation, in lib/reminders.ts.
--   2. There is no unattended path. Advancement happens only because a user
--      tapped "Mark done", which originates on the device.
--   3. The calendar edge cases differ between the two languages.
--      '2026-01-31'::timestamptz + INTERVAL '1 month' is 28 Feb; a naive JS
--      setMonth(m+1) is 3 March. Deciding this once, in the language that
--      also talks to the scheduler, is what keeps the notification and the
--      row agreeing.
--   4. SECURITY DEFINER is reserved here (0002/0044/0047) for rules RLS
--      cannot express. This is not one, and the blast radius is a single
--      user's own private data.

CREATE TABLE IF NOT EXISTS public.personal_reminders (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  title             TEXT NOT NULL,

  -- Optional: "take medicine" has no amount. When present it is what
  -- pre-fills the Add-Personal-Expense screen on completion, so it matches
  -- personal_transactions.amount exactly — two money types in one database
  -- is a bug waiting to happen.
  amount            NUMERIC(15, 2) CHECK (amount IS NULL OR amount > 0),
  currency          CHAR(3) NOT NULL DEFAULT 'INR',

  -- Free text 1-40, the same bound and reasoning as 0010 and 0036.
  -- lib/categories.ts stays the single client-side source of category
  -- identity; adding preset ids there needs no migration precisely because
  -- this column accepts any short string.
  category          VARCHAR(40),
  notes             TEXT,

  -- Enumerable and small on purpose. An RRULE string would be more general
  -- but would need an RRULE evaluator on the device to compute the next
  -- occurrence for the OS scheduler; these five cover every obligation this
  -- feature was asked for. TEXT + CHECK rather than a PG enum, so a sixth
  -- value is a one-line constraint change instead of a type migration
  -- (0036's reasoning for `source`).
  recurrence        TEXT NOT NULL DEFAULT 'once'
                      CHECK (recurrence IN ('once','daily','weekly','monthly','yearly')),

  next_due_at       TIMESTAMPTZ NOT NULL,
  last_completed_at TIMESTAMPTZ,
  completed_count   INT NOT NULL DEFAULT 0 CHECK (completed_count >= 0),

  -- The wall-clock zone the user expressed this in. next_due_at is the
  -- authoritative instant and is what the device schedules from; this
  -- records the intent behind it, so "9am wherever I am" stays
  -- implementable later as a client change rather than a data migration.
  -- Inert today: this user base is IST, which has no DST, so absolute and
  -- wall-clock advancement give identical answers. Recorded rather than
  -- inferred, because it cannot be reconstructed after the fact.
  --
  -- No CHECK against pg_timezone_names: that is a catalog view, and a CHECK
  -- constraint cannot reference one (not IMMUTABLE).
  due_time_zone     TEXT NOT NULL DEFAULT 'Asia/Kolkata',

  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','paused','done','archived')),

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT personal_reminders_title_check
    CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  CONSTRAINT personal_reminders_category_check
    CHECK (category IS NULL OR char_length(btrim(category)) BETWEEN 1 AND 40),
  CONSTRAINT personal_reminders_tz_check
    CHECK (char_length(btrim(due_time_zone)) BETWEEN 1 AND 64),

  -- A repeating reminder is never "done" — completing an occurrence rolls
  -- it forward. Only a one-off can retire, and anything can be archived.
  -- This is what stops a client bug silently retiring someone's rent
  -- reminder: the write is refused rather than accepted and forgotten.
  CONSTRAINT personal_reminders_recurring_never_done
    CHECK (recurrence = 'once' OR status <> 'done')
);

-- The only query the app makes: "my active reminders, soonest first" — from
-- the list screen and from the device scheduler alike. Partial, because that
-- query is partial (same pattern as personal_transactions_user_occurred_idx
-- in 0036). A (user_id, status) index is NOT added speculatively; add it if
-- and when an Archived tab ships.
CREATE INDEX IF NOT EXISTS personal_reminders_user_due_idx
  ON public.personal_reminders (user_id, next_due_at)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- RLS POLICIES ARE IN THIS FILE, NOT A FOLLOW-UP
--
-- The ensure_rls event trigger (0013) force-enables row level security on
-- every table created in public. A CREATE TABLE without policies produces a
-- table that returns nothing to authenticated callers and does not error —
-- it just looks permanently empty, which is the worst way for this to fail.
-- ---------------------------------------------------------------------------

ALTER TABLE public.personal_reminders ENABLE ROW LEVEL SECURITY;

-- Private to the person who set it. No sharing story, exactly like
-- personal_transactions — nobody else is party to your rent reminder, so
-- there are no shares_group_with / is_friend_of helpers here, just
-- auth.uid().
CREATE POLICY personal_reminders_select ON public.personal_reminders FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY personal_reminders_insert ON public.personal_reminders FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY personal_reminders_update ON public.personal_reminders FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Unlike personal_transactions — where the app only ever voids, because a
-- screenshot-sourced row is its own audit trail — DELETE here is the
-- ordinary verb. A reminder carries no image, no money moved and no
-- counterparty, so "delete" means delete.
CREATE POLICY personal_reminders_delete ON public.personal_reminders FOR DELETE
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT relrowsecurity FROM pg_class WHERE relname = 'personal_reminders';
--   -> true
--
--   SELECT policyname, cmd FROM pg_policies WHERE tablename = 'personal_reminders'
--   ORDER BY policyname;
--   -> 4 rows: _delete/DELETE, _insert/INSERT, _select/SELECT, _update/UPDATE
--
--   SELECT indexname FROM pg_indexes WHERE tablename = 'personal_reminders';
--   -> personal_reminders_pkey, personal_reminders_user_due_idx
--
--   SELECT conname FROM pg_constraint
--    WHERE conrelid = 'public.personal_reminders'::regclass AND contype = 'c'
--    ORDER BY conname;
--   -> the amount, category, completed_count, recurrence, status, title, tz
--      and recurring_never_done checks
--
-- Deliberately NO updated_at trigger, matching 0036 — the client sets it
-- (lib/reminders.ts, mirroring savePersonalTransaction). Assert it stayed
-- that way:
--   SELECT count(*) FROM pg_trigger
--    WHERE tgrelid = 'public.personal_reminders'::regclass AND NOT tgisinternal;
--   -> 0
--
-- The recurring-never-done guard actually bites:
--   INSERT INTO public.personal_reminders (user_id, title, next_due_at, recurrence, status)
--   VALUES (auth.uid(), 'x', now(), 'monthly', 'done');
--   -> ERROR 23514, personal_reminders_recurring_never_done
--
-- CROSS-USER ISOLATION must be exercised from two real signed-in sessions
-- through supabase-js, NOT in the SQL editor — auth.uid() is NULL there, so
-- every policy evaluates false and the table looks empty to everyone,
-- which proves nothing. User A inserts a reminder; user B selects it and
-- must get zero rows.
