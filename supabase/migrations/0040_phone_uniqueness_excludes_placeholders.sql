-- Kinlo · 0040 · phone-number uniqueness applies to real accounts only
--
-- `users_phone_number_key UNIQUE (phone_number)` is table-wide, so a
-- placeholder row occupies a phone number just as strongly as a real
-- account does. Placeholders are created freely by anyone tapping "Add
-- Friend" for someone not on Kinlo yet (AddFriendModal.tsx), which makes
-- that constraint the direct cause of three separate live bugs:
--
-- 1. THE REAL PERSON CANNOT SAVE THEIR OWN NUMBER. When the friend later
--    installs Kinlo and types that same number at onboarding,
--    app/onboarding/name-setup.tsx's UPDATE violates the constraint. The
--    call site never inspects the returned error (supabase-js RETURNS
--    errors rather than throwing, so its try/catch never fires either), so
--    the failure is swallowed whole: the account ends up with
--    phone_number = NULL and onboarding continues as if it saved.
--
-- 2. TWO PEOPLE CANNOT ADD THE SAME OFF-APP FRIEND. If A has already
--    created a placeholder for Bob, C's identical insert violates the
--    constraint. RLS (users_select_related, 0002) hides A's placeholder
--    from C, so C's client can't find it either — C only ever sees
--    "Could not add this friend. Please try again", permanently.
--
-- 3. Consequently 0038/0039's phone matching can't find that person: the
--    number they'd be matched on was never stored on their real row.
--
-- FIX: scope the uniqueness to real accounts. Two real accounts still
-- cannot share a number; placeholders no longer reserve one.
--
-- The second index below additionally stops ONE user creating two
-- placeholders for the same number, while still allowing different users
-- to each hold their own placeholder for that person — which is exactly
-- the distinction the table-wide constraint could not express.
--
-- DELIBERATELY NOT NORMALIZING HERE. Uniqueness stays on the raw string,
-- matching today's behaviour: "+91 98765 43210" and "9876543210" remain
-- two distinct values and could both exist as real accounts. That is a
-- pre-existing gap, not one this migration introduces, and closing it
-- means a data audit plus a decision about which row wins — out of scope
-- for a fix whose job is to stop placeholders squatting numbers. 0038/0039
-- already compare on normalized last-10-digits when *matching*, so
-- lookups are unaffected.
--
-- RUN ONE STATEMENT AT A TIME AND VERIFY EACH. This project's SQL editor
-- has reported "Success" on batched DDL that never persisted.

-- ---------------------------------------------------------------------------
-- PREFLIGHT — run these first, before changing anything
-- ---------------------------------------------------------------------------
-- (a) Confirm the constraint actually exists live under this name:
--       SELECT conname, contype, pg_get_constraintdef(oid)
--       FROM pg_constraint
--       WHERE conrelid = 'public.users'::regclass AND contype = 'u';
--     -> expect a row: users_phone_number_key, UNIQUE (phone_number)
--
-- (b) Confirm no two REAL accounts already share a number (they cannot
--     today, but verify rather than assume — this decides whether step 2
--     can succeed):
--       SELECT phone_number, count(*)
--       FROM public.users
--       WHERE is_placeholder = FALSE AND phone_number IS NOT NULL
--       GROUP BY phone_number HAVING count(*) > 1;
--     -> expect zero rows
--
-- (c) Confirm no single user already holds duplicate placeholders for one
--     number (decides whether step 4 can succeed):
--       SELECT created_by, phone_number, count(*)
--       FROM public.users
--       WHERE is_placeholder = TRUE AND phone_number IS NOT NULL
--       GROUP BY created_by, phone_number HAVING count(*) > 1;
--     -> expect zero rows

-- ---------------------------------------------------------------------------
-- STEP 2 — drop the table-wide constraint
-- ---------------------------------------------------------------------------
ALTER TABLE public.users DROP CONSTRAINT users_phone_number_key;

-- VERIFY: the query from preflight (a) now returns no phone_number row.

-- ---------------------------------------------------------------------------
-- STEP 3 — re-establish uniqueness, real accounts only
-- ---------------------------------------------------------------------------
-- Restores the guarantee that mattered (one real account per number) while
-- leaving placeholders out of it. Run immediately after step 2 — between
-- the two statements nothing enforces it.
CREATE UNIQUE INDEX users_phone_real_uniq
  ON public.users (phone_number)
  WHERE is_placeholder = FALSE AND phone_number IS NOT NULL;

-- VERIFY:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'users' AND indexname = 'users_phone_real_uniq';
--   -> one row

-- ---------------------------------------------------------------------------
-- STEP 4 — stop one user duplicating their own placeholder
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX users_placeholder_phone_per_creator_uniq
  ON public.users (created_by, phone_number)
  WHERE is_placeholder = TRUE AND phone_number IS NOT NULL;

-- VERIFY:
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'users'
--     AND indexname = 'users_placeholder_phone_per_creator_uniq';
--   -> one row

-- ---------------------------------------------------------------------------
-- AFTER — functional check, from the app (auth.uid() is NULL in the editor)
-- ---------------------------------------------------------------------------
--   - As user A, add an off-app friend by phone -> placeholder created.
--   - As user C, add the SAME number as an off-app friend -> must now also
--     succeed (previously failed with a generic error).
--   - Sign up a new account and enter that same number at onboarding ->
--     the number must actually persist on the real row:
--       SELECT id, phone_number, is_placeholder FROM public.users
--       WHERE right(regexp_replace(phone_number,'\D','','g'),10) = '<10 digits>';
--     -> the real (is_placeholder = FALSE) row now carries the number.
