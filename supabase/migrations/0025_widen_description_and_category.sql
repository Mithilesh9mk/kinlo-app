-- Kinlo · 0025 · make two columns as wide as the app already assumes
--
-- Both of these are cases where a column type quietly contradicts what the
-- application, or another constraint, says is allowed. Neither fails loudly —
-- one errors at an unhelpful moment, the other silently caps a feature.
--
-- ---------------------------------------------------------------------------
-- 1 · transactions.description  varchar(255) -> text
-- ---------------------------------------------------------------------------
-- app/settle-up.tsx composes a settlement description from several parts:
--
--   You settled ₹418.67 for "<the original expense's description>" with
--   Sarvesh. Remaining balance: ₹0.00 • 18 Aug 2026 at 12:04 (<user's note>)
--
-- The embedded description can itself be up to 255 characters, and the note is
-- unbounded. Postgres does not truncate an over-long varchar — it raises
-- 22001 (string_data_right_truncation) and the whole settlement fails. The user
-- sees a database error while recording a payment that was perfectly valid.
--
-- This is reachable in the current data. Settlements already exist whose
-- descriptions embed an earlier settlement's description, which is how the
-- nesting gets long enough to matter.
--
-- `text` has no length limit and, in Postgres, no storage or performance
-- penalty over varchar — they share an implementation. varchar(n) -> text is
-- a relaxation, so this needs no table rewrite and takes no meaningful lock.
--
-- The client is being shortened in the same change (settle-up.tsx no longer
-- embeds a balance snapshot or a timestamp, and truncates what it quotes), so
-- this is the second line of defence rather than the fix on its own.

ALTER TABLE public.transactions
  ALTER COLUMN description TYPE text;

-- ---------------------------------------------------------------------------
-- 2 · transactions.category  varchar(20) -> varchar(40)
-- ---------------------------------------------------------------------------
-- Migration 0010 replaced the old category whitelist with a length check:
--
--   CHECK (category IS NULL OR char_length(btrim(category)) BETWEEN 1 AND 40)
--
-- but left the column at varchar(20). The narrower of the two wins, so a
-- 25-character category is rejected by the column type before the check it was
-- supposedly measured against is ever consulted — and the error names a type
-- limit the user was never told about.
--
-- 0010's stated intent was 40. This makes the column agree with it.
--
-- Widening a varchar is also a metadata-only change: no rewrite, no lock of
-- consequence.

ALTER TABLE public.transactions
  ALTER COLUMN category TYPE character varying(40);

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT column_name, data_type, character_maximum_length
--   FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'transactions'
--     AND column_name IN ('description', 'category');
--
-- Expect:
--   category     character varying   40
--   description  text                (null)
--
-- The category check constraint is unchanged and still enforces 1..40, so the
-- two now agree instead of the column silently overriding it.
