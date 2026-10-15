-- Kinlo · 0036 · personal spending, tracked outside the split ledger
--
-- New feature: a user can log a personal expense — typed in, or read off a
-- screenshot of a payment app by an OCR/vision edge function (0037 adds the
-- Storage bucket the image lives in; a later commit adds the function
-- itself). This table is where those rows live.
--
-- WHY A NEW TABLE AND NOT A COLUMN ON transactions
--
-- transactions is shaped around split expenses: payer, participants,
-- transaction_splits, RLS via is_group_member/shares_transaction_with
-- (0002). A personal expense has none of that — one user, no payer-vs-
-- participant distinction, no group. Bolting an "is this personal" flag onto
-- transactions would mean either every personal row fakes a 100%-self split
-- to satisfy machinery that doesn't apply to it, or the group/friend RLS
-- helper functions grow a special case for rows with no group and no
-- participants. Either way, the one table that's supposed to be the split
-- ledger's single source of truth starts carrying rows that were never part
-- of the ledger. A private table with a private RLS story (four
-- user_id = auth.uid() policies, no helper functions, no sharing) is the
-- same shape 0027_expense_drafts.sql already established for "belongs to
-- exactly one user, nobody else needs to see it" — copied here, not
-- reinvented.
--
-- COLUMN NOTES
--
-- amount is NUMERIC(15,2), matching transactions.amount exactly (0001).
-- Two money types with different precision in one database is how rounding
-- bugs get introduced later; there is no reason for this table to differ.
--
-- category is free text with the same 1-40 char bound 0010 put on
-- transactions.category, not an enum — categories are a labelling
-- convenience here for the same reason 0010's header gives for the split
-- side, and inventing a second, incompatible category system (enum here,
-- free text there) would make lib/categories.ts's job of being the one
-- place that defines a category harder for no benefit.
--
-- occurred_at is the date printed on the receipt/screenshot, not the row's
-- insert time — this is what spend-by-month analytics buckets on. Deliberate
-- asymmetry with transactions, which has no equivalent and buckets by
-- created_at: a screenshot of last week's coffee is last week's spending,
-- not today's. Not a bug to reconcile later.
--
-- status mirrors the void-not-delete convention transactions.status already
-- uses (0015): a row is voided, never hard-deleted, because a screenshot's
-- image is kept as this row's audit trail and deleting the row would orphan
-- an unexplainable image. needs_review exists for a future ingestion path
-- (e.g. an OS share-target) that can create a row without a synchronous
-- review screen in front of it — nothing in Phase 1 writes that status, every
-- row the app saves today is 'confirmed'. Analytics must only ever sum
-- status = 'confirmed' rows: an unreviewed model guess is not a real number
-- and must not move anyone's spend total.
--
-- source distinguishes hand-typed entries from screenshot-derived ones. Text
-- with a CHECK, not an enum, so a future 'share' source (the OS share-target
-- path) is a one-line constraint change, not a type migration.
--
-- edited_fields records, per field, whether the user changed it away from
-- what the extractor returned — appended to by the review screen, not
-- computed here. This is deliberately an array of field names rather than a
-- single "was this edited" boolean: a category the user always overrides is
-- a signal that the extractor's category guess is unreliable, and that
-- signal only exists if edits are tracked per-field.
--
-- extraction stores the parser's raw JSON response verbatim, same principle
-- as expense_drafts.payload (0027): the shape belongs to the client/edge
-- function, not the database, and this column exists so a prompt change or a
-- parsing bug can be diagnosed against what the model actually returned,
-- without having to re-call it.
--
-- confidence is the CLAMPED value the edge function computes after
-- sanity-checking the model's self-reported number — never trust a vision
-- model's own confidence claim uncritically. That clamping happens in
-- application code, not here; this column just stores the result.
--
-- RLS POLICIES ARE IN THIS FILE, NOT A FOLLOW-UP
--
-- The ensure_rls event trigger (0013) force-enables row level security on
-- every table created in public. A CREATE TABLE without policies produces a
-- table that returns nothing to authenticated callers and does not error —
-- it just looks permanently empty, which is the worst way for this to fail.

CREATE TABLE IF NOT EXISTS public.personal_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

  amount            NUMERIC(15, 2) NOT NULL CHECK (amount > 0),
  currency          CHAR(3)        NOT NULL DEFAULT 'INR',
  merchant          TEXT,
  description       TEXT,
  category          VARCHAR(40),
  occurred_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  status            TEXT NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('needs_review', 'confirmed', 'voided')),
  source            TEXT NOT NULL DEFAULT 'manual'
                      CHECK (source IN ('manual', 'screenshot')),

  source_image_path TEXT,
  raw_ocr_text      TEXT,
  extraction        JSONB,
  confidence        NUMERIC(3, 2) CHECK (confidence >= 0 AND confidence <= 1),
  edited_fields     TEXT[] NOT NULL DEFAULT '{}',

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT personal_transactions_category_check
    CHECK (category IS NULL OR char_length(btrim(category)) BETWEEN 1 AND 40),
  -- A screenshot-sourced row is meaningless without the image behind it —
  -- that image IS its audit trail. A hand-typed row has no image at all.
  CONSTRAINT personal_transactions_screenshot_has_image
    CHECK (source <> 'screenshot' OR source_image_path IS NOT NULL)
);

-- Powers both the history list (newest first, voided rows excluded) and the
-- analytics window query (occurred_at range scan per user).
CREATE INDEX IF NOT EXISTS personal_transactions_user_occurred_idx
  ON public.personal_transactions (user_id, occurred_at DESC)
  WHERE status <> 'voided';

CREATE INDEX IF NOT EXISTS personal_transactions_user_status_idx
  ON public.personal_transactions (user_id, status);

ALTER TABLE public.personal_transactions ENABLE ROW LEVEL SECURITY;

-- Private to the person who logged it. No sharing story, unlike
-- transactions — nobody else is party to a personal expense, so there are no
-- shares_group_with/is_friend_of-style helper functions here, just
-- auth.uid().
CREATE POLICY personal_transactions_select ON public.personal_transactions FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY personal_transactions_insert ON public.personal_transactions FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY personal_transactions_update ON public.personal_transactions FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- The app itself only ever voids (UPDATE status='voided'), never deletes.
-- This policy exists for the "Delete Account" path in Profile, which has no
-- real backend yet — when it does, it needs a way to actually clear these
-- rows rather than leaving them behind under a deleted user_id.
CREATE POLICY personal_transactions_delete ON public.personal_transactions FOR DELETE
  USING (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT c.relrowsecurity,
--          (SELECT count(*) FROM pg_policies p
--            WHERE p.schemaname='public' AND p.tablename='personal_transactions') AS policies
--   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--   WHERE n.nspname='public' AND c.relname='personal_transactions';
--   -> expect relrowsecurity true, policies 4
--
--   SELECT column_name, data_type, numeric_precision, numeric_scale, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='personal_transactions'
--   ORDER BY ordinal_position;
--   -> amount must read numeric / 15 / 2, matching transactions.amount exactly
--
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname='public' AND tablename='personal_transactions';
--   -> expect the primary key index plus
--      personal_transactions_user_occurred_idx and _user_status_idx
--
-- Ledger isolation — this table must be invisible to the split ledger. Both
-- of the following must return zero rows:
--   SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
--   WHERE n.nspname='public'
--     AND pg_get_functiondef(p.oid) ILIKE '%personal_transactions%';
--
--   SELECT tgname FROM pg_trigger WHERE NOT tgisinternal
--     AND tgrelid = 'public.personal_transactions'::regclass;
--
-- Cross-user isolation has to be exercised from the app, not the SQL editor
-- — auth.uid() is NULL in a SQL-editor session (same caveat as 0035). As two
-- different signed-in users: insert one row as user A, confirm user B's
-- session sees zero rows from `select count(*) from personal_transactions`.
