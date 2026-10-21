-- Kinlo · 0065 · fix: phone-lookup functions returned varchar into TEXT columns
--
-- 0064 rewrote resolve_user_by_phone and match_contacts_by_phone from LANGUAGE
-- sql to LANGUAGE plpgsql to add rate limiting. A SQL function coerces
-- users.full_name (varchar(100)) to the declared TEXT result column; a plpgsql
-- RETURN QUERY does not, and raises 42804 "structure of query does not match
-- function result type". Caught by the post-apply behaviour test, so both
-- lookups were broken from the moment 0064 committed until this fix.
--
-- Fix: explicit ::text casts. Nothing else changes (same signature, grants,
-- rate limits and matching rules as 0064).

CREATE OR REPLACE FUNCTION public.resolve_user_by_phone(phone_suffix TEXT)
RETURNS TABLE (id UUID, full_name TEXT, phone_number TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT public.hit_rate_limit('phone_lookup', 40, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT u.id, u.full_name::text, u.phone_number::text
  FROM public.users u
  WHERE u.is_placeholder = FALSE
    AND u.id <> auth.uid()
    AND u.phone_number IS NOT NULL
    AND right(regexp_replace(u.phone_number, '\D', '', 'g'), 10) = phone_suffix
  LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.match_contacts_by_phone(phone_suffixes TEXT[])
RETURNS TABLE (id UUID, full_name TEXT, avatar_url TEXT, phone_number TEXT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_suffixes TEXT[] := phone_suffixes[1:5000];
BEGIN
  IF NOT public.hit_rate_limit('contact_match', 20, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  RETURN QUERY
  SELECT u.id, u.full_name::text, u.avatar_url::text, u.phone_number::text
  FROM public.users u
  WHERE u.is_placeholder = FALSE
    AND u.id <> auth.uid()
    AND u.phone_number IS NOT NULL
    AND right(regexp_replace(u.phone_number, '\D', '', 'g'), 10) = ANY(v_suffixes)
    AND NOT public.is_friend_of(u.id)
    AND NOT EXISTS (
      SELECT 1 FROM public.connection_requests cr
      WHERE cr.status = 'pending'
        AND cr.claimant_id = u.id
        AND cr.owner_id = auth.uid()
    )
  LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_user_by_phone(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_user_by_phone(TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.match_contacts_by_phone(TEXT[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.match_contacts_by_phone(TEXT[]) TO authenticated;
