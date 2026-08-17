-- Kinlo · 0010 · allow custom expense categories
--
-- TWO PROBLEMS WITH THE OLD CONSTRAINT
--
--   CHECK (category IN ('food','travel','home','other'))
--
-- 1. The picker in expense/details.tsx offers Food, Travel, Home, *Utilities*
--    and Other. 'utilities' is not in the allowed set, so choosing it fails on
--    save — the same shape of bug as the payer one: the UI offers something
--    the database rejects.
--
-- 2. Custom categories are impossible by definition. A fixed whitelist in a
--    CHECK means every new category needs a migration.
--
-- Categories are a labelling convenience, not something the ledger relies on:
-- no balance, settlement or RPC reads them. So a free-text column with a
-- sanity bound is the right level of strictness — reject empty strings and
-- absurd lengths, allow anything reasonable a user types.
--
-- Existing rows are unaffected: every current value is well within the bound.

ALTER TABLE public.transactions DROP CONSTRAINT IF EXISTS transactions_category_check;

ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_category_check
  CHECK (
    category IS NULL
    OR (char_length(btrim(category)) BETWEEN 1 AND 40)
  );
