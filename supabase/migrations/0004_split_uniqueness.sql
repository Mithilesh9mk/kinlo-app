-- Kinlo · 0004 · server-side backstop for expense idempotency
--
-- Client side, every money-writing screen mints one idempotency key on mount
-- and reuses it across retries (lib/idempotency.ts). Because that key *is*
-- transactions.id, the primary key already enforces idempotency for the
-- transaction row itself: a retry upserts over the same row instead of
-- creating a second expense. Nothing extra is needed there.
--
-- transaction_splits is the gap. It has no uniqueness guarantee on
-- (transaction_id, user_id), so a retry that got past the transaction upsert
-- could append a *second* split row for the same person on the same expense —
-- which recalculate_group_settlements() would then faithfully count twice,
-- inflating a real debt. Both client call sites now delete-then-insert to
-- avoid this, but client logic is the wrong place for the only guarantee.
--
-- This migration refuses to run if such duplicates already exist rather than
-- silently merging them: they are financial records, and which row is correct
-- is a judgement call, not something a migration should guess at.

BEGIN;

-- ---------------------------------------------------------------------------
-- Guard: stop if the table already violates the constraint we're about to add
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  dup_count INT;
  sample TEXT;
BEGIN
  SELECT COUNT(*) INTO dup_count
  FROM (
    SELECT transaction_id, user_id
    FROM public.transaction_splits
    GROUP BY transaction_id, user_id
    HAVING COUNT(*) > 1
  ) d;

  IF dup_count > 0 THEN
    SELECT string_agg(
             format('tx=%s user=%s copies=%s', transaction_id, user_id, n),
             E'\n  ' ORDER BY n DESC)
      INTO sample
    FROM (
      SELECT transaction_id, user_id, COUNT(*) AS n
      FROM public.transaction_splits
      GROUP BY transaction_id, user_id
      HAVING COUNT(*) > 1
      LIMIT 10
    ) s;

    RAISE EXCEPTION
      'Found % duplicated (transaction_id, user_id) pair(s) in transaction_splits. %',
      dup_count,
      E'\nThese are double-counted debts and must be reviewed by hand before this'
      || E' constraint can be added — do not assume the rows are identical.'
      || E'\nInspect with the query in the comment block at the end of this file.'
      || E'\nFirst 10:\n  ' || sample;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- One split row per person per expense
-- ---------------------------------------------------------------------------
-- A retried write can now only ever overwrite, never accumulate. Also gives
-- the settlement RPCs' JOIN a useful index.
CREATE UNIQUE INDEX IF NOT EXISTS transaction_splits_tx_user_uniq
  ON public.transaction_splits (transaction_id, user_id);

COMMIT;

-- ---------------------------------------------------------------------------
-- If the guard above aborted this migration, inspect the offending rows with:
-- ---------------------------------------------------------------------------
--   SELECT s.transaction_id, s.user_id, s.share_amount,
--          t.description, t.amount AS tx_amount, t.status, t.created_at
--   FROM public.transaction_splits s
--   JOIN public.transactions t ON t.id = s.transaction_id
--   WHERE (s.transaction_id, s.user_id) IN (
--     SELECT transaction_id, user_id
--     FROM public.transaction_splits
--     GROUP BY transaction_id, user_id
--     HAVING COUNT(*) > 1
--   )
--   ORDER BY s.transaction_id, s.user_id;
--
-- Where the duplicate rows carry the SAME share_amount they are retry
-- artefacts and it is safe to keep one:
--
--   DELETE FROM public.transaction_splits a
--   USING public.transaction_splits b
--   WHERE a.ctid > b.ctid
--     AND a.transaction_id = b.transaction_id
--     AND a.user_id        = b.user_id
--     AND a.share_amount   = b.share_amount;
--
-- Where the amounts DIFFER, decide manually which is correct, then re-run
-- this migration and the settlement recalculation for the affected groups.
