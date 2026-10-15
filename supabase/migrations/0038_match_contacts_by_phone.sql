-- Kinlo · 0038 · find-friends-from-contacts matching
--
-- Backs the "Sync contacts" onboarding step and Profile toggle
-- (lib/contactsSync.ts) — until now that permission was requested and a
-- yes/no flag was stored, but nothing ever actually matched contacts
-- against Kinlo users. This is that matching step.
--
-- WHY A SECURITY DEFINER FUNCTION, NOT A PLAIN SELECT
--
-- 0002_user_isolation.sql's users_select_related policy only lets you see a
-- user row if you're already connected to them (self, friend, group-mate, or
-- transaction counterparty). That's the correct default, but it means a
-- plain client-side `.select().in('phone_number', [...])` can never find the
-- exact case this feature exists for: a stranger in your phone contacts who
-- has a Kinlo account but no relation to you yet. This function is a
-- narrow, deliberate exception to that boundary — SECURITY DEFINER, same
-- pattern as is_friend_of() etc. — but it returns only id/full_name/
-- avatar_url/phone_number, the same fields AddFriendModal already shows for
-- any friend, and nothing else from the row (no email, no upi_address).
--
-- WHY LAST-10-DIGITS, NOT EXACT STRING MATCH
--
-- Phone numbers are stored exactly as typed at onboarding/profile — no
-- normalization exists anywhere in this codebase today (see
-- app/onboarding/name-setup.tsx, app/(tabs)/profile.tsx). A device contact
-- might read "+91 98765 43210" while the same person signed up as
-- "9876543210". Stripping non-digits and comparing the last 10 (a full
-- Indian mobile number, ignoring any country-code prefix) is the same
-- normalization the client applies to its own contact list before calling
-- this, so both sides compare on equal footing without a schema change or
-- backfill.
--
-- EXCLUSIONS
--
-- Placeholder rows (is_placeholder = true) are friends added manually
-- without a real account — matching them as "on Kinlo" would be false.
-- Existing friends are excluded so this only ever surfaces *new* people to
-- add, not a list that includes everyone already added.

CREATE OR REPLACE FUNCTION public.match_contacts_by_phone(phone_suffixes TEXT[])
RETURNS TABLE (id UUID, full_name TEXT, avatar_url TEXT, phone_number TEXT)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.full_name, u.avatar_url, u.phone_number
  FROM public.users u
  WHERE u.is_placeholder = FALSE
    AND u.id <> auth.uid()
    AND u.phone_number IS NOT NULL
    AND right(regexp_replace(u.phone_number, '\D', '', 'g'), 10) = ANY(phone_suffixes)
    AND NOT public.is_friend_of(u.id)
  LIMIT 200;
$$;

REVOKE ALL ON FUNCTION public.match_contacts_by_phone(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_contacts_by_phone(TEXT[]) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT proname FROM pg_proc WHERE proname = 'match_contacts_by_phone';
--   -> one row
--
--   SELECT has_function_privilege('anon', 'public.match_contacts_by_phone(text[])', 'EXECUTE');
--   -> false  (this is the check kinlo-anon-grant-idiom exists because of —
--      REVOKE ... FROM PUBLIC alone does not revoke anon's default grant)
--
--   SELECT has_function_privilege('authenticated', 'public.match_contacts_by_phone(text[])', 'EXECUTE');
--   -> true
--
-- Functional check (run as an authenticated user, e.g. via the app, since
-- auth.uid() is NULL in the SQL editor):
--   SELECT * FROM public.match_contacts_by_phone(ARRAY['9876543210']);
--   -> returns any real, non-placeholder, non-friend user whose stored
--      phone_number ends in those 10 digits; empty set otherwise.
