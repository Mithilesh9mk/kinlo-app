-- Kinlo · 0074 · sprout_stats: let friends compare Sprout growth
--
-- Why: Sprout (the growth character, docs/CHARACTER_PLAN.md) is computed on the
-- device from the user's own rows and shown only to them. Owner decision, 23 Nov:
-- friends compare Sprouts. A friend's device cannot derive someone else's points
-- (it cannot read their ledger rows), so the result has to be stored. This adds
-- one tiny table holding exactly four facts per person: total points, stage,
-- blossoms, and whether they chose to show it.
--
-- Who can see what (RLS, SELECT only):
--   * you: your own row, always (including when shown = false);
--   * a friend: your row only while shown = true, where "friend" is the app's
--     one existing rule, is_friend_of() (0002): a friendships row in EITHER
--     direction (rows are directional, there is no status column);
--   * nobody else. Pending connection requests (0038-0043), people who only
--     share a circle, and removed friends see nothing: removing a friend
--     deletes the friendships row and access ends on the next read. Turning
--     "Show Sprout" off hides the row from friends entirely (not even a
--     "hidden" marker is exposed: there is simply no row for them).
--   * There is no block feature in this schema (searched migrations and
--     functions), so there is nothing further to exclude.
-- Nothing financial is stored or returned: no amounts, balances, per-action
-- counts, circle names. Points are a single integer.
--
-- Why SECURITY DEFINER rather than INVOKER: an invoker RPC would need the
-- client role to hold INSERT/UPDATE on sprout_stats, and then a client could
-- write any number straight through the REST API, spoofing points. Instead the
-- client roles get SELECT only (same shape as 0068 for the ledger tables), and
-- the two RPCs below run as the function owner. They take no user id: they use
-- auth.uid() only, so a caller can only ever write their own row. refresh_my_sprout
-- recomputes points server-side from the caller's own rows, so the number is
-- not client-supplied either. Same pattern as 0072 / 0073.
--
-- Points rule, kept IDENTICAL to lib/sprout/model.ts + lib/sprout/stats.ts
-- (change one, change the other):
--   expenses        1  transactions type 'expense', status <> 'voided', paid_by = me
--   settlements     2  type 'settlement', status <> 'voided', paid_by = me
--                      PLUS transaction_splits.user_id = me on such a row
--                      (both sides of a settlement count)
--   friends         2  DISTINCT other users across friendships rows in either
--                      direction (a mutual pair is worth 2, not 4)
--   circles         2  group_members rows for me
--   scans           1  personal_transactions source 'screenshot', status <> 'voided'
--   circles squared 3  circles I am in that have >= 1 non-voided expense and no
--                      simplified_settlements row with me as debtor or creditor
-- Stages: seed 0, sprout 5, sapling 25, tree 80. Blossoms: once points >= 80,
-- floor((points - 80) / 40), capped at 5; 0 below 80.
-- Stored points never go down: the new value is greatest(stored, recomputed),
-- like the client's never-regress stage, so deleting an expense or un-squaring
-- a circle cannot shrink a friend's view of you.
--
-- Rate limits: refresh_my_sprout uses hit_rate_limit (0064) at 60 per hour;
-- when over the limit it quietly returns the stored row instead of erroring
-- (the client refreshes on focus, so an error there would be noise).
-- set_my_sprout_shown is limited to 60 per hour and raises 'rate_limited'.
--
-- Known limits: the server counts are uncapped; the client's friend and
-- circles-squared queries cap at 1000 rows, so a very large account could
-- briefly show a lower local number than the stored one (never the reverse
-- for display, the stored value only rises). Account deletion (0044) removes
-- the friendships rows, which cuts every friend's access; the sprout_stats
-- row itself stays with the anonymised users row until that row is purged.
--
-- Not applied to production without the owner's yes. Run via
-- docs/sql/0074_paste_and_verify.sql, which has preflight, structural checks
-- and rolled-back behaviour tests.

BEGIN;

-- Drift guard: refuse to run against a schema this was not written for.
DO $$
BEGIN
  IF to_regclass('public.friendships') IS NULL
     OR to_regclass('public.transactions') IS NULL
     OR to_regclass('public.transaction_splits') IS NULL
     OR to_regclass('public.group_members') IS NULL
     OR to_regclass('public.simplified_settlements') IS NULL
     OR to_regclass('public.personal_transactions') IS NULL THEN
    RAISE EXCEPTION 'ABORT: a table 0074 counts from is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                 WHERE pronamespace = 'public'::regnamespace AND proname = 'is_friend_of'
                   AND pg_get_function_identity_arguments(oid) = 'other_user_id uuid') THEN
    RAISE EXCEPTION 'ABORT: is_friend_of(uuid) missing (0002)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                 WHERE pronamespace = 'public'::regnamespace AND proname = 'hit_rate_limit'
                   AND pg_get_function_identity_arguments(oid) = 'p_action text, p_limit integer, p_window interval') THEN
    RAISE EXCEPTION 'ABORT: hit_rate_limit(text, integer, interval) missing (0064)';
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Table: read-only for clients
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.sprout_stats (
  user_id    UUID PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  points     INT NOT NULL DEFAULT 0 CHECK (points >= 0),
  stage      TEXT NOT NULL DEFAULT 'seed' CHECK (stage IN ('seed', 'sprout', 'sapling', 'tree')),
  blossoms   INT NOT NULL DEFAULT 0 CHECK (blossoms BETWEEN 0 AND 5),
  shown      BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sprout_stats ENABLE ROW LEVEL SECURITY;
-- Default privileges also hand INSERT/UPDATE/DELETE/TRUNCATE/etc. to anon and
-- authenticated on new tables (see 0062, 0067); ALL covers them. Then give back
-- SELECT to signed-in users only.
REVOKE ALL ON public.sprout_stats FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.sprout_stats TO authenticated;

-- is_friend_of() is SECURITY DEFINER and reads only friendships, so this
-- policy cannot recurse into sprout_stats (the 0008 trap).
DROP POLICY IF EXISTS "sprout_stats_select" ON public.sprout_stats;
CREATE POLICY "sprout_stats_select"
  ON public.sprout_stats
  FOR SELECT
  TO authenticated
  USING (
    user_id = (SELECT auth.uid())
    OR (shown AND public.is_friend_of(user_id))
  );

-- ---------------------------------------------------------------------------
-- refresh_my_sprout: recompute the caller's points server-side and store them
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_my_sprout()
RETURNS TABLE (points INT, stage TEXT, blossoms INT, shown BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_me      UUID := auth.uid();
  v_old     INT;
  v_shown   BOOLEAN;
  v_exp     INT;
  v_settle  INT;
  v_friends INT;
  v_circles INT;
  v_scans   INT;
  v_squared INT;
  v_new     INT;
  v_pts     INT;
  v_stage   TEXT;
  v_bl      INT;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = v_me AND u.is_placeholder = FALSE AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;

  -- One refresh at a time per person, so two concurrent calls cannot race the
  -- read-then-write of the stored points.
  PERFORM pg_advisory_xact_lock(hashtextextended('sprout_refresh:' || v_me::text, 0));

  SELECT s.points, s.shown INTO v_old, v_shown
  FROM public.sprout_stats s WHERE s.user_id = v_me;

  IF NOT public.hit_rate_limit('sprout_refresh', 60, INTERVAL '1 hour') THEN
    IF v_old IS NOT NULL THEN
      RETURN QUERY
      SELECT s.points, s.stage, s.blossoms, s.shown
      FROM public.sprout_stats s WHERE s.user_id = v_me;
      RETURN;
    END IF;
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- expenses (weight 1)
  SELECT count(*)::int INTO v_exp
  FROM public.transactions t
  WHERE t.type = 'expense' AND t.status <> 'voided' AND t.paid_by = v_me;

  -- settlements (weight 2): paid by me, plus the debtor split row for me. The
  -- two cases are disjoint, as in lib/sprout/stats.ts.
  SELECT (
    (SELECT count(*) FROM public.transactions t
      WHERE t.type = 'settlement' AND t.status <> 'voided' AND t.paid_by = v_me)
    +
    (SELECT count(*) FROM public.transaction_splits sp
       JOIN public.transactions t ON t.id = sp.transaction_id
      WHERE sp.user_id = v_me AND t.type = 'settlement' AND t.status <> 'voided')
  )::int INTO v_settle;

  -- friends (weight 2): distinct counterparties across both directions
  SELECT count(DISTINCT CASE WHEN f.user_id = v_me THEN f.friend_id ELSE f.user_id END)::int
    INTO v_friends
  FROM public.friendships f
  WHERE f.user_id = v_me OR f.friend_id = v_me;

  -- circles (weight 2): group_members rows
  SELECT count(*)::int INTO v_circles
  FROM public.group_members gm WHERE gm.user_id = v_me;

  -- screenshot scans (weight 1)
  SELECT count(*)::int INTO v_scans
  FROM public.personal_transactions p
  WHERE p.user_id = v_me AND p.source = 'screenshot' AND p.status <> 'voided';

  -- circles squared (weight 3): distinct circles of mine with a live expense
  -- and no open simplified balance involving me
  SELECT count(*)::int INTO v_squared
  FROM (SELECT DISTINCT gm.group_id FROM public.group_members gm WHERE gm.user_id = v_me) g
  WHERE EXISTS (SELECT 1 FROM public.transactions t
                 WHERE t.group_id = g.group_id AND t.type = 'expense' AND t.status <> 'voided')
    AND NOT EXISTS (SELECT 1 FROM public.simplified_settlements ss
                     WHERE ss.group_id = g.group_id
                       AND (ss.debtor_id = v_me OR ss.creditor_id = v_me));

  v_new := v_exp * 1 + v_settle * 2 + v_friends * 2 + v_circles * 2 + v_scans * 1 + v_squared * 3;

  -- Never lowers.
  v_pts := GREATEST(COALESCE(v_old, 0), v_new);

  v_stage := CASE
    WHEN v_pts >= 80 THEN 'tree'
    WHEN v_pts >= 25 THEN 'sapling'
    WHEN v_pts >= 5  THEN 'sprout'
    ELSE 'seed'
  END;
  v_bl := CASE WHEN v_pts >= 80 THEN LEAST(5, (v_pts - 80) / 40) ELSE 0 END;  -- int division = floor

  INSERT INTO public.sprout_stats AS s (user_id, points, stage, blossoms, updated_at)
  VALUES (v_me, v_pts, v_stage, v_bl, now())
  ON CONFLICT (user_id) DO UPDATE
    SET points     = EXCLUDED.points,
        stage      = EXCLUDED.stage,
        blossoms   = EXCLUDED.blossoms,
        updated_at = now();

  RETURN QUERY SELECT v_pts, v_stage, v_bl, COALESCE(v_shown, TRUE);
END;
$$;

-- ---------------------------------------------------------------------------
-- set_my_sprout_shown: the "Show Sprout" flag (hides it from friends when false)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_my_sprout_shown(p_shown BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_me UUID := auth.uid();
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'authentication required' USING ERRCODE = '42501';
  END IF;
  IF p_shown IS NULL THEN
    RAISE EXCEPTION 'invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users u
                 WHERE u.id = v_me AND u.is_placeholder = FALSE AND u.deleted_at IS NULL) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = '42501';
  END IF;
  IF NOT public.hit_rate_limit('sprout_shown', 60, INTERVAL '1 hour') THEN
    RAISE EXCEPTION 'rate_limited';
  END IF;

  -- A first call before any refresh creates a seed row; the next refresh fills
  -- in the real points.
  INSERT INTO public.sprout_stats AS s (user_id, shown, updated_at)
  VALUES (v_me, p_shown, now())
  ON CONFLICT (user_id) DO UPDATE
    SET shown = EXCLUDED.shown, updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants. REVOKE FROM PUBLIC alone does not remove anon's default EXECUTE.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.refresh_my_sprout()            FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_my_sprout_shown(BOOLEAN)   FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.refresh_my_sprout()          TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_sprout_shown(BOOLEAN) TO authenticated;

COMMIT;
