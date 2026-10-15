-- Kinlo · 0027 · an in-progress expense survives losing the app
--
-- Audit finding M2. Expense entry lives entirely in React state
-- (context/ExpenseContext.tsx). Backgrounding the app, a crash, or navigating
-- away loses everything typed so far — and the "Draft" button on the split
-- screen has never had an onPress handler, so the control that appears to
-- prevent this does nothing.
--
-- §11 asks for drafts to be preserved where practical, and — importantly — for
-- a draft never to affect balances. That second half is what shapes this table:
-- a draft is deliberately NOT a transaction. It is opaque JSON in its own
-- table, invisible to every ledger function, every balance query and every
-- screen except the one composing it. Nothing here can reach
-- simplified_settlements.
--
-- WHY A TABLE AND NOT JUST LOCAL STORAGE
--
-- The client writes both. AsyncStorage is the fast path: instant, offline, and
-- it covers the common case of the app being killed. This table covers the
-- cases local storage cannot — a lost or replaced device, or picking up on a
-- second one. Losing a half-composed expense is a small thing; losing it after
-- carefully splitting a restaurant bill nine ways is not.
--
-- The cost is negligible. One row per user, overwritten in place, of roughly a
-- kilobyte. A hundred thousand users is about a hundred megabytes. Writes are
-- debounced to step transitions rather than keystrokes, which is the only part
-- that could have been expensive.
--
-- ONE DRAFT PER USER
--
-- user_id is the primary key, so starting a new expense replaces any previous
-- draft. That matches the app, which composes one expense at a time. If drafts
-- ever need to be per-group or per-friend, this becomes a composite key and a
-- list — but building that now would be inventing a requirement.
--
-- WHY payload IS JSONB AND NOT COLUMNS
--
-- A draft is incomplete by definition: no amount yet, no participants yet,
-- maybe no payer. Modelling it as typed columns would mean every one nullable,
-- and every change to the entry flow becoming a migration. The shape belongs to
-- the client, and the database's only job is to hand back exactly what it was
-- given. It is never parsed here.
--
-- RLS POLICIES ARE IN THIS FILE, NOT A FOLLOW-UP
--
-- The ensure_rls event trigger (see 0013) force-enables row level security on
-- every table created in public. A CREATE TABLE without policies produces a
-- table that returns nothing to authenticated callers and does not error — it
-- just looks permanently empty, which is the worst way for this to fail.

CREATE TABLE IF NOT EXISTS public.expense_drafts (
  user_id    UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  payload    JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.expense_drafts ENABLE ROW LEVEL SECURITY;

-- A draft is private to the person writing it. There is no sharing story here
-- and no reason for one — unlike transactions, a draft involves nobody else
-- until it is posted.
CREATE POLICY expense_drafts_select ON public.expense_drafts FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY expense_drafts_insert ON public.expense_drafts FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY expense_drafts_update ON public.expense_drafts FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY expense_drafts_delete ON public.expense_drafts FOR DELETE
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT c.relrowsecurity,
--          (SELECT count(*) FROM pg_policies p
--            WHERE p.schemaname='public' AND p.tablename='expense_drafts') AS policies
--   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public' AND c.relname='expense_drafts';
--
-- Expect: relrowsecurity true, policies 4. Four is the number that matters —
-- RLS enabled with zero policies is the silent-empty-table failure above.
