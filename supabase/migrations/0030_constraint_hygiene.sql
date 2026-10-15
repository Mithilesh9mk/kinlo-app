-- Kinlo · 0030 · four constraints that say the wrong thing
--
-- None of these is causing a live failure. Each is a place where the schema
-- either claims something it does not enforce, or enforces something nobody
-- intended. Collected into one migration because they are unrelated to each
-- other and individually too small to be worth their own file.
--
-- ---------------------------------------------------------------------------
-- 1 · groups.category is still a hardcoded whitelist
-- ---------------------------------------------------------------------------
-- Migration 0010 removed exactly this pattern from transactions.category, for
-- reasons that apply here word for word: a fixed list in a CHECK means every
-- new category needs a migration, and the UI can offer something the database
-- rejects. It only ever changed one of the two columns.
--
--   groups_category_check: category IN ('trip','home','food','other')
--
-- Same treatment: free text with a sanity bound. The column is widened first,
-- because 0010 taught us what happens otherwise — it set a 1..40 check against
-- a varchar(20) column, so the type silently won and the "flexible" limit was
-- really 20. Widening and re-checking together keeps the two honest.

ALTER TABLE public.groups
  ALTER COLUMN category TYPE character varying(40);

ALTER TABLE public.groups DROP CONSTRAINT IF EXISTS groups_category_check;

ALTER TABLE public.groups
  ADD CONSTRAINT groups_category_check
  CHECK (
    category IS NULL
    OR (char_length(btrim(category)) BETWEEN 1 AND 40)
  );

-- ---------------------------------------------------------------------------
-- 2 · friendships never got the constraints 0001 declared
-- ---------------------------------------------------------------------------
-- 0001 defines the table with:
--
--   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
--   CONSTRAINT friendships_no_self CHECK (user_id <> friend_id)
--
-- Neither exists in production. The block used CREATE TABLE IF NOT EXISTS and
-- the table already existed, so the whole definition was skipped — one of the
-- clearest examples of why a migration file is not evidence of what the
-- database contains. Confirmed absent during the Phase 0.5 capture.
--
-- The backfill runs first so the NOT NULL cannot fail on a legacy row.

UPDATE public.friendships SET created_at = NOW() WHERE created_at IS NULL;

ALTER TABLE public.friendships
  ALTER COLUMN created_at SET NOT NULL;

ALTER TABLE public.friendships DROP CONSTRAINT IF EXISTS friendships_no_self;

ALTER TABLE public.friendships
  ADD CONSTRAINT friendships_no_self CHECK (user_id <> friend_id);

-- If that last statement fails, a row exists where user_id = friend_id — a
-- friendship with oneself. Find it before deciding what to do:
--
--   SELECT * FROM public.friendships WHERE user_id = friend_id;

-- ---------------------------------------------------------------------------
-- 3 · the 1-on-1 ledger has no uniqueness guarantee
-- ---------------------------------------------------------------------------
-- simplified_settlements has UNIQUE (group_id, debtor_id, creditor_id), which
-- does not constrain 1-on-1 rows at all: Postgres treats NULLs as distinct in a
-- unique constraint, so any number of rows can exist for the same pair when
-- group_id IS NULL.
--
-- 0003 knew this and added a partial unique index to cover it. That index does
-- not exist in production — another silent DDL failure, never noticed, found
-- only during the Phase 0.5 capture.
--
-- The invariant has held anyway, because recalculate_pair_settlements deletes
-- both directions before inserting. But that is procedure, not structure: it
-- holds exactly as long as every writer remembers, and there is no reason to
-- rely on memory when the database can simply refuse.
--
-- Creating this fails if duplicates already exist. Check first:
--
--   SELECT debtor_id, creditor_id, count(*) FROM public.simplified_settlements
--   WHERE group_id IS NULL GROUP BY 1,2 HAVING count(*) > 1;
--
-- Expected: zero rows.

CREATE UNIQUE INDEX IF NOT EXISTS simplified_settlements_pair_uniq
  ON public.simplified_settlements (debtor_id, creditor_id)
  WHERE group_id IS NULL;

-- ---------------------------------------------------------------------------
-- 4 · transaction_splits carries the same unique index twice
-- ---------------------------------------------------------------------------
--   transaction_splits_transaction_id_user_id_key   (constraint-backed)
--   transaction_splits_tx_user_uniq                 (0004, standalone)
--
-- Identical columns, identical semantics. 0004 added its own without noticing
-- the table already had one from its original definition, so every split write
-- has been maintaining two identical B-trees ever since.
--
-- The standalone one goes; the constraint-backed one stays, because dropping
-- that would mean dropping the constraint itself and leaves nothing enforcing
-- uniqueness in between.

DROP INDEX IF EXISTS public.transaction_splits_tx_user_uniq;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid IN ('public.groups'::regclass, 'public.friendships'::regclass)
--   ORDER BY conname;
--   -> groups_category_check uses char_length, not a value list
--   -> friendships_no_self is present
--
--   SELECT indexname FROM pg_indexes
--   WHERE schemaname='public'
--     AND indexname IN ('simplified_settlements_pair_uniq','transaction_splits_tx_user_uniq');
--   -> exactly one row: simplified_settlements_pair_uniq
--
--   SELECT is_nullable FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='friendships' AND column_name='created_at';
--   -> NO
