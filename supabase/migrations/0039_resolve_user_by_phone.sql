-- Kinlo · 0039 · resolve a phone number to a real Kinlo account (Add Friend)
--
-- Companion to 0038_match_contacts_by_phone.sql, deliberately a separate,
-- narrower function rather than reusing that one. 0038 excludes existing
-- friends on purpose — its job is "suggest *new* people to add." This one's
-- job is different: AddFriendModal's add-friend flow (contact picker or
-- manual phone entry) needs to know "does a real account already exist with
-- this phone number" even when the answer is yes and you're already
-- friends (re-adding after an unfriend, a typo that happens to match an
-- existing friend). Reusing 0038 here would silently create a DUPLICATE
-- placeholder account instead of finding the real one — worse than the bug
-- this migration fixes.
--
-- Same reasoning as 0038 for why this must be SECURITY DEFINER at all:
-- users_select_related (0002) correctly hides a stranger's row from a plain
-- client SELECT, which is exactly the case AddFriendModal needs to see
-- through — someone typed by hand or picked from contacts who has a real
-- Kinlo account but no relation to you yet. Before this, that lookup
-- (`.eq('phone_number', ...)`) silently returned nothing for exactly that
-- case, and AddFriendModal fell through to creating a placeholder row with
-- the same phone number as the real account.

CREATE OR REPLACE FUNCTION public.resolve_user_by_phone(phone_suffix TEXT)
RETURNS TABLE (id UUID, full_name TEXT, phone_number TEXT)
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.full_name, u.phone_number
  FROM public.users u
  WHERE u.is_placeholder = FALSE
    AND u.id <> auth.uid()
    AND u.phone_number IS NOT NULL
    AND right(regexp_replace(u.phone_number, '\D', '', 'g'), 10) = phone_suffix
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_user_by_phone(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_user_by_phone(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- VERIFY
-- ---------------------------------------------------------------------------
--   SELECT proname FROM pg_proc WHERE proname = 'resolve_user_by_phone';
--   -> one row
--
--   SELECT
--     has_function_privilege('anon', 'public.resolve_user_by_phone(text)', 'EXECUTE') AS anon_can_call,
--     has_function_privilege('authenticated', 'public.resolve_user_by_phone(text)', 'EXECUTE') AS authenticated_can_call;
--   -> anon_can_call = false, authenticated_can_call = true
--
-- Functional check, from the app (auth.uid() is NULL in the SQL editor):
--   SELECT * FROM public.resolve_user_by_phone('9876543210');
--   -> the real account with that number if one exists, regardless of
--      whether you're already friends with them; empty otherwise.
